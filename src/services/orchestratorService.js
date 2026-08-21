import 'dotenv/config';
import twilio from 'twilio';
import * as AttemptModel from '../models/attemptModel.js';
import * as PhoneLineModel from '../models/phoneLineModel.js';
import { broadcast } from './websocketService.js';
import { supabase } from '../config/db.js';

import fs from 'fs';
import path from 'path';

// Lazy initialize Twilio client
const getTwilioClient = () => {
  let accountSid = process.env.TWILIO_ACCOUNT_SID;
  let authToken = process.env.TWILIO_AUTH_TOKEN;

  let debugLog = `--- Twilio Auth Debug ---\nInitial env SID: ${accountSid}\nInitial env Token: ${authToken}\n`;
  if (!accountSid || !authToken || accountSid.trim() === '' || authToken.trim() === '' || accountSid === 'undefined' || authToken === 'undefined') {
    try {
      const envPath = path.resolve(process.cwd(), '.env');
      debugLog += `CWD: ${process.cwd()}\nEnv Path: ${envPath}\nExists: ${fs.existsSync(envPath)}\n`;
      if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        const sidMatch = envContent.match(/^TWILIO_ACCOUNT_SID=(.*)$/m);
        const tokenMatch = envContent.match(/^TWILIO_AUTH_TOKEN=(.*)$/m);
        debugLog += `SID Match: ${!!sidMatch}\nToken Match: ${!!tokenMatch}\n`;
        if (sidMatch && sidMatch[1].trim()) accountSid = sidMatch[1].trim();
        if (tokenMatch && tokenMatch[1].trim()) authToken = tokenMatch[1].trim();
        console.log('[DEBUG] Force loaded Twilio credentials from .env file directly.');
      }
    } catch (err) {
      debugLog += `Error: ${err.message}\n`;
      console.error('[DEBUG] Failed to force load .env', err);
    }
  }

  debugLog += `Final SID: ${accountSid}\nFinal Token length: ${authToken ? authToken.length : 0}\n`;
  fs.writeFileSync(path.resolve(process.cwd(), 'debug_twilio.txt'), debugLog);

  return accountSid && authToken && accountSid !== 'undefined' ? twilio(accountSid, authToken) : null;
};

let isCampaignRunning = false;
let workerInterval = null;
let maxRetries = 3;

let campaignLineId = null;

export const isRunning = () => {
  return isCampaignRunning;
};
// second main entry
export const startCampaign = async (phoneNumberId, maxRetriesVal = 3) => {
  if (isCampaignRunning) return;
  isCampaignRunning = true;
  maxRetries = maxRetriesVal;
  campaignLineId = phoneNumberId ? parseInt(phoneNumberId) : null;
  broadcast('campaign_status', { running: true });
  console.log(`[Orchestrator] Campaign started. Selected Line ID: ${campaignLineId || 'All'}`);
  // webhook running in interval
  console.log("Webhook running")
  // Run the orchestrator loop
  workerInterval = setInterval(async () => {
    try {
      console.log("start campaing going to tick")
      await tick();
    } catch (err) {
      console.error('[Orchestrator] Error in worker tick:', err);
    }
  }, 2000);
};

export const stopCampaign = async () => {
  if (!isCampaignRunning) return;
  isCampaignRunning = false;
  campaignLineId = null; // Reset
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
  broadcast('campaign_status', { running: false });
  console.log('[Orchestrator] Campaign stopped.');

  // Hang up all active calls immediately
  await terminateActiveCalls();

  // Cancel any pending attempts so they don't block the next run
  await cancelPendingAttempts();
};

export const cancelPendingAttempts = async () => {
  console.log('[Orchestrator] Canceling pending (queued/retry) attempts...');
  try {
    const { error } = await supabase
      .from('attempts')
      .update({
        status: 'canceled',
        retry_count: 999, // Ensure they are never picked up by checkAndScheduleRetries
        logs: ['[System] Campaign stopped. Attempt canceled.']
      })
      .in('status', ['queued', 'retry']);

    if (error) {
      console.error('[Orchestrator] Failed to cancel pending attempts:', error);
    }
  } catch (err) {
    console.error('[Orchestrator] Error canceling pending attempts:', err);
  }
};

export const terminateActiveCalls = async () => {
  console.log('[Orchestrator] Terminating active calls...');
  try {
    const { data: activeAttempts, error } = await supabase
      .from('attempts')
      .select('*')
      .in('status', ['active', 'in_progress', 'testing_3digit']);

    if (error || !activeAttempts || activeAttempts.length === 0) return;

    for (const attempt of activeAttempts) {
      await AttemptModel.addLog(attempt.id, 'Call manually hung up / aborted by operator.');

      // If it is a real Twilio call, update status to completed to force hang up
      const client = getTwilioClient();
      if (client && attempt.call_sid && !attempt.call_sid.startsWith('MOCK_SID')) {
        try {
          await client.calls(attempt.call_sid).update({ status: 'completed' });
        } catch (err) {
          console.error(`Failed to force hangup Call SID ${attempt.call_sid} on Twilio:`, err.message);
        }
      }

      // Set state to failed/aborted
      await AttemptModel.updateAttemptStatus(attempt.id, 'failed', 0, {
        error: 'Call terminated by operator'
      });
    }
  } catch (err) {
    console.error('[Orchestrator] Error terminating active calls:', err);
  }
};

export const tick = async () => {
  console.log("Tick call going")
  if (!isCampaignRunning) return;

  // 1. Get all phone lines
  const lines = await PhoneLineModel.getAllPhoneLines();
  console.log("Tick Get all phone line number ", lines)
  const idleLines = lines.filter(l => l.status === 'idle' && (!campaignLineId || l.id === campaignLineId));
  console.log("Filter the specific number", idleLines)
  if (idleLines.length === 0) {
    return; // All lines are busy
  }

  // 2. Process attempts for each idle line
  for (const line of idleLines) {
    // Claim the next queued or retry attempt
    console.log("Attempting Different lines")
    const attempt = await AttemptModel.claimNextQueuedAttempt(line.id);
    console.log("fetch attempts:", attempt)
    if (!attempt) {
      // Auto-stop campaign if there are absolutely no active or queued attempts left
      const { count, error } = await supabase
        .from('attempts')
        .select('*', { count: 'exact', head: true })
        .in('status', ['queued', 'active', 'in_progress', 'testing_3digit']);

      if (!error && count === 0) {
        console.log('[Orchestrator] All queues are completely empty. Auto-stopping campaign.');
        await stopCampaign();
      }
      break;
    }

    console.log(`[Orchestrator] Assigning Attempt #${attempt.id} (Code: ${attempt.current_test_code}) to Phone Line ${line.phone_number}`);

    // Place the call
    executeCall(attempt, line);
  }
};

export const executeCall = async (attempt, line) => {
  let host = process.env.SERVER_URL || process.env.RENDER_EXTERNAL_URL || (process.env.RENDER_EXTERNAL_HOSTNAME ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : 'http://localhost:5000');
  if (host && !host.startsWith('http://') && !host.startsWith('https://')) {
    host = `https://${host}`;
  }
  host = host.replace(/\/+$/, '');
  const client = getTwilioClient();

  if (!client) {
    const errMsg = 'Twilio credentials are missing! Please add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN to .env.';
    console.error(`[Orchestrator] ${errMsg}`);
    await AttemptModel.addLog(attempt.id, `FATAL ERROR: ${errMsg}`);
    await AttemptModel.updateAttemptStatus(attempt.id, 'FAILED', 0, { error: errMsg });
    return;
  }

  try {
    const callerNumber = attempt.from_number || line.phone_number;
    await AttemptModel.updateAttemptStatus(attempt.id, 'CALLING');
    await supabase.from('attempts').update({ from_number: callerNumber }).eq('id', attempt.id);

    const call = await client.calls.create({
      url: `${host}/api/call/twiml/${attempt.id}`,
      to: attempt.target_phone_number || attempt.destination_number || '+12495075171',
      from: callerNumber,
      statusCallback: `${host}/api/call/status-callback/${attempt.id}`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
      record: true,
      recordingStatusCallback: `${host}/api/call/recording-callback/${attempt.id}`,
      recordingStatusCallbackMethod: 'POST'
    });

    await AttemptModel.updateCallSid(attempt.id, call.sid);
    await AttemptModel.addLog(attempt.id, `Call placed via Twilio. SID: ${call.sid}`);
  } catch (err) {
    console.error(`[Orchestrator] Twilio Call failed for Attempt #${attempt.id}:`, err);
    await AttemptModel.addLog(attempt.id, `Twilio error: ${err.message}`);
    await AttemptModel.updateAttemptStatus(attempt.id, 'FAILED', 0, { error: err.message });
  }
};
