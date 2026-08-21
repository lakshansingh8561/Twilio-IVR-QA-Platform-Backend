import 'dotenv/config';
import twilio from 'twilio';
import * as AttemptModel from '../models/attemptModel.js';
import * as OrchestratorService from '../services/orchestratorService.js';
import * as transcriptionService from '../services/transcriptionService.js';
import { supabase } from '../config/db.js';
import fs from 'fs';
import path from 'path';

// Lazy initialize Twilio client
const getTwilioClient = () => {
  let accountSid = process.env.TWILIO_ACCOUNT_SID;
  let authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken || accountSid.trim() === '' || authToken.trim() === '') {
    try {
      const envPath = path.resolve(process.cwd(), '.env');
      if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        const sidMatch = envContent.match(/^TWILIO_ACCOUNT_SID=(.*)$/m);
        const tokenMatch = envContent.match(/^TWILIO_AUTH_TOKEN=(.*)$/m);
        if (sidMatch && sidMatch[1].trim()) accountSid = sidMatch[1].trim();
        if (tokenMatch && tokenMatch[1].trim()) authToken = tokenMatch[1].trim();
      }
    } catch (err) {
      console.error('[DEBUG] Failed to force load .env', err);
    }
  }

  return accountSid && authToken ? twilio(accountSid, authToken) : null;
};

// Get dashboard status
export const getDashboardStatus = async (req, res) => {
  try {
    const lines = await AttemptModel.getAllPhoneLines();
    const attempts = await AttemptModel.getAttempts();
    const campaignRunning = OrchestratorService.isRunning();
    return res.status(200).json({ lines, attempts, campaignRunning });
  } catch (error) {
    console.error('Error fetching dashboard status:', error);
    return res.status(500).json({ error: error.message });
  }
};

// Initialize a phone line
export const addPhoneLine = async (req, res) => {
  const { phoneNumber, maxAttempts } = req.body;

  // Security: Validate phone number format (E.164)
  if (!phoneNumber || !/^\+?[1-9]\d{1,14}$/.test(phoneNumber)) {
    return res.status(400).json({ error: 'Invalid E.164 phone number format.' });
  }

  try {
    const line = await AttemptModel.addPhoneLine(phoneNumber, maxAttempts);
    return res.status(200).json({ message: 'Phone line added/updated', line });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// Trigger an outbound call (Milestone 1 Core Flow)
export const triggerCall = async (req, res) => {
  const { testValue, phoneNumberId, toPhoneNumber } = req.body;
  console.log("CALL START", "Test Value: ", testValue, "PhoneNumberID: ", phoneNumberId, "ToPhoneNumber: ", toPhoneNumber)
  // Security: Validate digits to prevent injection or invalid requests
  if (!testValue || !/^\d{1,16}$/.test(testValue)) {
    return res.status(400).json({ error: 'Test value must be a sequence of up to 16 numeric digits.' });
  }
  if (!phoneNumberId || isNaN(parseInt(phoneNumberId))) {
    return res.status(400).json({ error: 'Invalid phone line ID.' });
  }
  if (toPhoneNumber && !/^\+?[1-9]\d{1,14}$/.test(toPhoneNumber)) {
    return res.status(400).json({ error: 'Invalid target phone number format.' });
  }

  try {
    // 1. Create a persistent test attempt
    console.log("CALL START Attempt")
    const attempt = await AttemptModel.createAttempt(testValue, toPhoneNumber || '+1234567890');
    console.log("CALL START Attempt", "Attempt: ", attempt)
    // 2. Fetch/Validate the phone line
    const lines = await AttemptModel.getAllPhoneLines();
    console.log("CALL START PhoneLineModel", "Lines: ", lines)
    const line = lines.find(l => l.id === parseInt(phoneNumberId)) || lines[0];
    console.log("CALL START PhoneLineModel", "Line: ", line)

    if (!line) {
      console.log("CALL START No line configured")
      return res.status(400).json({ error: 'No phone line configured.' });
    }

    // Assign attempt to line
    const updatedAttempt = await AttemptModel.assignAttemptToLine(attempt.id, line.id);
    console.log("CALL START Attempt Assigned", "Updated Attempt: ", updatedAttempt)

    // Base callback URL
    const host = process.env.SERVER_URL || `${req.protocol}://${req.get('host')}`;

    // 3. Initiate Twilio outbound call
    const client = getTwilioClient();
    console.log("CALL START Twilio Client", "Client: ", client)
    if (!client) {
      // Mock execution if Twilio details are not configured yet
      console.log('Twilio credentials missing. Running in mock/simulation mode.');
      await AttemptModel.addLog(attempt.id, 'Running in Mock Mode. Simulating call...');

      // Simulate call progression in a timeout for verification
      setTimeout(async () => {
        await AttemptModel.updateCallSid(attempt.id, `MOCK_SID_${Date.now()}`);
        await AttemptModel.addLog(attempt.id, 'Mock Call Answered. Simulating wait...');

        setTimeout(async () => {
          await AttemptModel.addLog(attempt.id, `Mock DTMF Sent: ${testValue}`);
          await AttemptModel.updateAttemptStatus(attempt.id, 'completed', 15, { note: 'Mock successful run' });
        }, 3000);
      }, 1500);

      return res.status(200).json({
        message: 'Call initiated in mock simulation mode.',
        attempt: updatedAttempt
      });
    }
    console.log("Twilio Call Params:", {
      url: `${host}/api/call/twiml/${attempt.id}`,
      to: toPhoneNumber || '+1234567890', // Default fictitious/test IVR number
      from: line.phone_number,
      statusCallback: `${host}/api/call/status-callback/${attempt.id}`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
      record: true,
      recordingStatusCallback: `${host}/api/call/recording-callback/${attempt.id}`,
      recordingStatusCallbackMethod: 'POST',
    });
    // Real Twilio Outbound Call
    const call = await client.calls.create({
      url: `${host}/api/call/twiml/${attempt.id}`,
      to: toPhoneNumber || '+1234567890', // Default fictitious/test IVR number
      from: line.phone_number,
      statusCallback: `${host}/api/call/status-callback/${attempt.id}`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
      record: true,
      recordingStatusCallback: `${host}/api/call/recording-callback/${attempt.id}`,
      recordingStatusCallbackMethod: 'POST'
    });
    console.log("CALL START Call", "Call: ", call)
    // Update Call SID
    await AttemptModel.updateCallSid(attempt.id, call.sid);
    console.log("CALL START Call SID", "Updated Attempt: ", updatedAttempt)
    return res.status(200).json({
      message: 'Twilio call initiated successfully.',
      attempt: { ...updatedAttempt, call_sid: call.sid }
    });
  } catch (error) {
    console.error('Error placing outbound call:', error);
    return res.status(500).json({ error: error.message });
  }
};

// Start campaign from JSON targets

// Main starting point
export const startCampaign = async (req, res) => {
  try {
    const targets = JSON.parse(fs.readFileSync(new URL('../config/test_targets.json', import.meta.url)));
    const batchId = `batch-${Date.now()}`;

    // Load batch into database
    await AttemptModel.createAttemptBatch(targets, batchId);

    // Start orchestrator loop
    OrchestratorService.startCampaign();

    return res.status(200).json({ message: 'Campaign started successfully.', batchId });
  } catch (error) {
    console.error('Error starting campaign:', error);
    return res.status(500).json({ error: error.message });
  }
};

// Stop campaign
export const stopCampaign = async (req, res) => {
  try {
    OrchestratorService.stopCampaign();
    return res.status(200).json({ message: 'Campaign stopped successfully.' });
  } catch (error) {
    console.error('Error stopping campaign:', error);
    return res.status(500).json({ error: error.message });
  }
};





