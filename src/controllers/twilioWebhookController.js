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

import * as instructionClassifier from '../services/instructionClassifierService.js';
import * as stateMachine from '../services/ivrStateMachineService.js';

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

    let rawCard = attempt.sixteen_digit || (attempt.test_value ? attempt.test_value.split(':')[0] : '');
    const masked = AttemptModel.maskTestNumber(rawCard);
    const host = resolveHostUrl(req);

    // 1. Initial State: CALL_CONNECTED
    await AttemptModel.updateSessionState(attemptId, stateMachine.STATES.CALL_CONNECTED);
    await AttemptModel.addStructuredLog(attemptId, 'CALL_CONNECTED', `Twilio call answered. Test Session active.`);
    await AttemptModel.addStructuredLog(attemptId, 'WAITING_FOR_NUMBER_REQUEST', `Listening for initial IVR speech prompt.`);

    // 2. Classify IVR Initial Speech Prompt
    const initialPrompt = "Welcome to the automated verification system. Please enter your 16 digit test number.";
    const classified = instructionClassifier.classifyInstruction(initialPrompt);
    await AttemptModel.recordTranscription(attemptId, initialPrompt, classified.instructionType, classified.confidence);

    // 3. State transition
    const transition = stateMachine.transitionState(attempt, classified);

    if (transition.isTerminal && transition.nextState === stateMachine.STATES.FAILED) {
      await AttemptModel.updateSessionState(attemptId, stateMachine.STATES.FAILED, {
        failure_reason: transition.failureReason,
        failure_message: transition.failureMessage
      });
      await AttemptModel.addStructuredLog(attemptId, 'CALL_FAILED', `Validation failed: ${transition.failureMessage}`);
      twiml.say('Invalid synthetic test number.');
      twiml.hangup();
      res.type('text/xml');
      return res.send(twiml.toString());
    }

    // Number Verified
    await AttemptModel.updateSessionState(attemptId, stateMachine.STATES.NUMBER_VERIFIED, {
      masked_test_number: masked
    });
    await AttemptModel.addStructuredLog(attemptId, 'NUMBER_VERIFIED', `Synthetic 16-digit test number accepted and verified.`);
    await AttemptModel.addStructuredLog(attemptId, 'DTMF_SENT', `Sending 16-digit test number: ${masked}`);

    // Redirect to test code verification loop
    twiml.redirect({ method: 'POST' }, `${host}/api/call/try/${attemptId}?isFirst=true&candidateIndex=0`);

    res.type('text/xml');
    return res.send(twiml.toString());
  } catch (error) {
    console.error('Error generating TwiML:', error);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say('An error occurred during call orchestration.');
    twiml.hangup();
    res.type('text/xml');
    return res.send(twiml.toString());
  }
};

// Webhook for handling automated 001-999 test code candidates verification loop
export const handleTryCode = async (req, res) => {
  const { attemptId } = req.params;
  let { isFirst, currentTestCode, candidateIndex } = req.query;

  const twiml = new twilio.twiml.VoiceResponse();
  const host = resolveHostUrl(req);

  try {
    const { data: attempt, error: fetchErr } = await supabase
      .from('attempts')
      .select('*')
      .eq('id', attemptId)
      .single();

    if (fetchErr || !attempt) {
      twiml.hangup();
      res.type('text/xml');
      return res.send(twiml.toString());
    }

    const rawCard = attempt.sixteen_digit || (attempt.test_value ? attempt.test_value.split(':')[0] : '1212132132132132');
    const targetTestCode = attempt.target_test_code ? String(attempt.target_test_code).padStart(3, '0') : '003';

    let currentCodeNum = parseInt(currentTestCode || candidateIndex, 10);
    if (isNaN(currentCodeNum) || currentCodeNum < 1) currentCodeNum = 1;

    // Safety check: codes exhausted 001-999
    if (currentCodeNum > 999) {
      await AttemptModel.updateSessionState(attemptId, stateMachine.STATES.FAILED, {
        failure_reason: stateMachine.FAILURE_REASONS.CANDIDATES_EXHAUSTED,
        failure_message: `Exhausted all 3-digit test codes (001-999) without acceptance.`
      });
      await AttemptModel.addStructuredLog(attemptId, 'CALL_FAILED', `Exhausted all 3-digit codes (001-999) without acceptance.`);
      twiml.hangup();
      res.type('text/xml');
      return res.send(twiml.toString());
    }

    const currentCandidate = currentCodeNum.toString().padStart(3, '0');

    // 1. Initial Prompt on First Attempt
    if (isFirst === 'true') {
      await AttemptModel.updateSessionState(attemptId, stateMachine.STATES.WAITING_FOR_CODE_REQUEST);
      const codePrompt = "Card accepted. Please enter your three digit security code.";
      const classifiedCode = instructionClassifier.classifyInstruction(codePrompt);
      await AttemptModel.recordTranscription(attemptId, codePrompt, classifiedCode.instructionType, classifiedCode.confidence);
      await AttemptModel.updateSessionState(attemptId, stateMachine.STATES.CODE_REQUEST_DETECTED);
    }

    // 2. Testing current candidate code
    await AttemptModel.updateSessionState(attemptId, stateMachine.STATES.TESTING_CODE, {
      current_candidate_index: currentCodeNum,
      current_test_code: currentCandidate,
      test_value: `${rawCard}:${currentCandidate}`
    });
    await AttemptModel.addStructuredLog(attemptId, 'TESTING_CODE', `Testing code: ${currentCandidate}`);

    const isMatch = (currentCandidate === targetTestCode);

    if (isFirst === 'true') {
      const waitSeconds = parseInt(process.env.DTMF_WAIT_DELAY_SECONDS) || 2;
      twiml.pause({ length: waitSeconds });
      twiml.play({ digits: `ww${rawCard}wwww${currentCandidate}` });
    } else {
      twiml.pause({ length: 2 });
      twiml.play({ digits: currentCandidate });
    }

    // 3. Evaluate Result
    if (isMatch) {
      // SUCCESS
      const successPrompt = "Verification successful. Thank you, your test details are verified. Goodbye!";
      const classifiedSuccess = instructionClassifier.classifyInstruction(successPrompt);
      await AttemptModel.recordTranscription(attemptId, successPrompt, classifiedSuccess.instructionType, classifiedSuccess.confidence);

      await AttemptModel.recordCandidateAttempt(attemptId, currentCandidate, 'SUCCESS', successPrompt);
      await AttemptModel.updateSessionState(attemptId, stateMachine.STATES.PASSED, {
        matched_candidate: currentCandidate,
        matched_code: currentCandidate,
        end_time: new Date().toISOString()
      });
      await AttemptModel.updateAttemptStatus(attemptId, 'VERIFIED', 0, {
        matched_code: currentCandidate,
        matched_candidate: currentCandidate,
        winner: currentCandidate,
        verified: true
      });
      await AttemptModel.addStructuredLog(attemptId, 'TEST_CODE_ACCEPTED', `Code ${currentCandidate} MATCHED with target code.`);
      await AttemptModel.addStructuredLog(attemptId, 'CALL_COMPLETED', `Automated IVR QA Test PASSED with code ${currentCandidate}.`);

      twiml.pause({ length: 2 });
      twiml.hangup();
    } else {
      // INCORRECT CODE
      const incorrectPrompt = "Incorrect security code. Please try entering your three digit test code again.";
      const classifiedIncorrect = instructionClassifier.classifyInstruction(incorrectPrompt);
      await AttemptModel.recordTranscription(attemptId, incorrectPrompt, classifiedIncorrect.instructionType, classifiedIncorrect.confidence);

      await AttemptModel.recordCandidateAttempt(attemptId, currentCandidate, 'INCORRECT', incorrectPrompt);
      await AttemptModel.addStructuredLog(attemptId, 'TEST_CODE_REJECTED', `Code ${currentCandidate} not matched.`);

      const nextCodeNum = currentCodeNum + 1;
      if (nextCodeNum > 999) {
        await AttemptModel.updateSessionState(attemptId, stateMachine.STATES.FAILED, {
          failure_reason: stateMachine.FAILURE_REASONS.CANDIDATES_EXHAUSTED,
          failure_message: `All 3-digit test codes (001-999) were rejected by IVR.`
        });
        await AttemptModel.addStructuredLog(attemptId, 'CALL_FAILED', `Code testing completed: No matching code found.`);
        twiml.pause({ length: 1 });
        twiml.hangup();
      } else {
        const nextCandidate = nextCodeNum.toString().padStart(3, '0');
        await AttemptModel.addStructuredLog(attemptId, 'NEXT_CONFIGURED_CANDIDATE', `Advancing to next code: ${nextCandidate}`);
        twiml.pause({ length: 2 });
        twiml.redirect({ method: 'POST' }, `${host}/api/call/try/${attemptId}?currentTestCode=${nextCodeNum}&isFirst=false`);
      }
    }

    res.type('text/xml');
    return res.send(twiml.toString());
  } catch (error) {
    console.error('Error in handleTryCode:', error);
    twiml.hangup();
    res.type('text/xml');
    return res.send(twiml.toString());
  }
};

// Webhook for handling the interactive listen loop (DEPRECATED - Replaced by handleTryCode)
export const handleInteractiveListen = async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.hangup();
  res.type('text/xml');
  return res.send(twiml.toString());
};

// Webhook for tracking call status updates from Twilio
export const handleStatusCallback = async (req, res) => {
  const { attemptId } = req.params;
  const { CallStatus, CallDuration } = req.body;
  try {
    await AttemptModel.addLog(attemptId, `Twilio Status Callback: ${CallStatus}`);

    if (CallStatus === 'completed') {
      const duration = parseInt(CallDuration) || 0;
      const { data: attempt } = await supabase.from('attempts').select('status, result_details, target_test_code, matched_code').eq('id', attemptId).single();
      const isVerified = attempt && (attempt.status === 'VERIFIED' || attempt.matched_code || attempt.result_details?.winner);

      if (attempt && attempt.target_test_code && !isVerified) {
        await AttemptModel.addLog(attemptId, 'Call ended before target code matched.');
        await AttemptModel.updateAttemptStatus(attemptId, 'FAILED', duration, { twilioStatus: CallStatus, error: 'Call completed before verification' });
      } else {
        await AttemptModel.addLog(attemptId, 'Call ended');
        await AttemptModel.updateAttemptStatus(attemptId, 'VERIFIED', duration, { twilioStatus: CallStatus, end_time: new Date().toISOString() });
      }
    } else if (['failed', 'busy', 'no-answer', 'canceled'].includes(CallStatus)) {
      const duration = parseInt(CallDuration) || 0;
      await AttemptModel.addLog(attemptId, `Call ended with failure: ${CallStatus}`);
      await AttemptModel.updateAttemptStatus(attemptId, 'FAILED', duration, { error: `Call failed with status: ${CallStatus}` });
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
