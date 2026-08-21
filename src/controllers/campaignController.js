import twilio from 'twilio';
import * as AttemptModel from '../models/attemptModel.js';
import * as PhoneLineModel from '../models/phoneLineModel.js';
import * as OrchestratorService from '../services/orchestratorService.js';
import fs from 'fs';

// Initialize Twilio client if keys are present
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = accountSid && authToken ? twilio(accountSid, authToken) : null;

// Get dashboard status
export const getDashboardStatus = async (req, res) => {
  try {
    const lines = await PhoneLineModel.getAllPhoneLines();
    const attempts = await AttemptModel.getAttempts();
    const campaignRunning = OrchestratorService.isRunning();

    // Augment busy lines with the target number they are currently calling
    lines.forEach(line => {
      if (line.status === 'busy' && line.current_attempt_id) {
        const activeAttempt = attempts.find(a => a.id === line.current_attempt_id);
        if (activeAttempt) {
          line.target_phone_number = activeAttempt.target_phone_number;
        }
      }
    });

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
    const line = await PhoneLineModel.addPhoneLine(phoneNumber, maxAttempts);
    return res.status(200).json({ message: 'Phone line added/updated', line });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};



// Start IVR Test Campaign (Supports single or multiple 16-digit DTMF values)
export const startTestCodeBruteForce = async (req, res) => {
  const { phoneNumberId, fromPhoneNumber, sixteenDigits, sixteenDigit, testValue, toPhoneNumber, destinationNumber, expectedTestCode, targetTestCode, testCode, maxRetries } = req.body;
  try {
    // 1. Extract array of 16-digit DTMF values
    let valuesList = [];
    const primaryValue = sixteenDigit || testValue;
    if (Array.isArray(sixteenDigits)) {
      valuesList = sixteenDigits.map(v => String(v).replace(/\D/g, '')).filter(v => v.length === 16);
    } else if (typeof sixteenDigits === 'string' && sixteenDigits.trim()) {
      valuesList = sixteenDigits.split(/[\n,\s]+/).map(v => v.replace(/\D/g, '')).filter(v => v.length === 16);
    } else if (primaryValue) {
      const val = String(primaryValue).replace(/\D/g, '');
      if (val.length === 16) valuesList.push(val);
    }

    if (valuesList.length === 0) {
      return res.status(400).json({ error: 'At least one valid 16-digit DTMF value is required.' });
    }

    // Explicit target test code check
    const explicitCode = expectedTestCode || targetTestCode || testCode;
    const validExplicitCode = (explicitCode && /^\d{3}$/.test(String(explicitCode))) ? String(explicitCode) : null;

    // Generate a common IVR test batch ID
    const batchId = `IVR_TEST_${Date.now()}`;

    const destPhone = destinationNumber || toPhoneNumber || '+12495075171';
    const fromPhone = fromPhoneNumber || null;
    let targetLineId = phoneNumberId;
    if (fromPhone) {
      try {
        const lineObj = await PhoneLineModel.addPhoneLine(fromPhone);
        if (lineObj && lineObj.id) {
          targetLineId = lineObj.id;
        }
      } catch (e) {
        console.log('[CampaignController] Auto-register line note:', e.message);
      }
    }

    // Build target list with individual 16-digit values and 3-digit test codes
    const targets = valuesList.map(digitVal => {
      let code = validExplicitCode;
      if (!code) {
        // Generate secret 3-digit target code randomly (001-999)
        const randomNum = Math.floor(Math.random() * 999) + 1;
        code = randomNum.toString().padStart(3, '0');
      }

      return {
        sixteen_digit: digitVal,
        test_value: `${digitVal}:${code}`,
        target_test_code: code,
        current_test_code: '001',
        phone_number: destPhone,
        from_number: fromPhone
      };
    });

    // Also sync Mock IVR config with current target test value & code
    try {
      const mockIvrUrl = process.env.MOCK_IVR_URL || 'http://localhost:5001';
      await fetch(`${mockIvrUrl}/api/mock-ivr/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sixteenDigit: targets[0].sixteen_digit, testCode: targets[0].target_test_code })
      }).catch(() => { });
    } catch (e) { }

    // Ensure no old/stuck queued attempts from previous runs get picked up
    await OrchestratorService.cancelPendingAttempts();

    // Store multiple 16-digit values under the same IVR test batch
    const createdAttempts = await AttemptModel.createAttemptBatch(targets, batchId);

    // Kicks off sequential attempt processing
    OrchestratorService.startCampaign(targetLineId || phoneNumberId, maxRetries);

    return res.status(200).json({
      message: `IVR Test Campaign started successfully with ${targets.length} attempt(s).`,
      batchId,
      targetCount: targets.length,
      attempts: createdAttempts
    });
  } catch (error) {
    console.error('Error starting Test code campaign:', error);
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

// Delete a phone line
export const deletePhoneLine = async (req, res) => {
  const { lineId } = req.params;
  try {
    await PhoneLineModel.deletePhoneLine(parseInt(lineId));
    return res.status(200).json({ message: 'Phone line deleted successfully.' });
  } catch (error) {
    console.error('Error deleting phone line:', error);
    return res.status(500).json({ error: error.message });
  }
};

// Edit/Update a phone line's phone number
export const updatePhoneLine = async (req, res) => {
  const { lineId } = req.params;
  const { phoneNumber } = req.body;

  if (!phoneNumber || !/^\+?[1-9]\d{1,14}$/.test(phoneNumber)) {
    return res.status(400).json({ error: 'Invalid E.164 phone number format.' });
  }

  try {
    const line = await PhoneLineModel.updatePhoneLine(parseInt(lineId), phoneNumber);
    return res.status(200).json({ message: 'Phone line updated successfully.', line });
  } catch (error) {
    console.error('Error updating phone line:', error);
    return res.status(500).json({ error: error.message });
  }
};
