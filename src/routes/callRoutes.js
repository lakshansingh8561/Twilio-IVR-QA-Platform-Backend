import express from 'express';
const router = express.Router();
import * as CampaignController from '../controllers/campaignController.js';
import * as TwilioWebhookController from '../controllers/twilioWebhookController.js';
import * as AuthController from '../controllers/authController.js';
import authMiddleware from '../middleware/authMiddleware.js';

// Auth routes
router.post('/auth/login', AuthController.login);
router.post('/auth/register', AuthController.register);

// Dashboard metrics & status
router.get('/status', authMiddleware, CampaignController.getDashboardStatus);

// Phone line registration, editing & deleting
router.post('/line', authMiddleware, CampaignController.addPhoneLine);
router.put('/line/:lineId', authMiddleware, CampaignController.updatePhoneLine);
router.delete('/line/:lineId', authMiddleware, CampaignController.deletePhoneLine);

// Campaign & Call controls
router.post('/start', authMiddleware, CampaignController.startTestCodeBruteForce);
router.post('/trigger', authMiddleware, CampaignController.startTestCodeBruteForce);
router.post('/campaign/start-test-code', authMiddleware, CampaignController.startTestCodeBruteForce);
router.post('/campaign/stop', authMiddleware, CampaignController.stopCampaign);

// Debug control
router.post('/debug/clear-lines', async (req, res) => {
  const { supabase } = await import('../config/db.js');
  await supabase.from('phone_lines').update({ status: 'idle', current_attempt_id: null }).neq('id', 0);
  await supabase.from('attempts').update({ status: 'failed' }).in('status', ['active', 'queued']);
  import('../services/orchestratorService.js').then(module => module.stopCampaign());
  res.json({ message: 'Lines and stuck attempts cleared.' });
});

// Twilio dynamic TwiML response (Must remain public for Twilio)
router.post('/twiml/:attemptId', TwilioWebhookController.getTwiML);
router.get('/twiml/:attemptId', TwilioWebhookController.getTwiML);
router.post('/:attemptId/answer', TwilioWebhookController.getTwiML);

// Twilio webhook status callback
router.post('/status-callback/:attemptId', TwilioWebhookController.handleStatusCallback);
router.post('/:attemptId/status', TwilioWebhookController.handleStatusCallback);

// Twilio webhook recording callback
router.post('/recording-callback/:attemptId', TwilioWebhookController.handleRecordingCallback);
router.post('/:attemptId/recording', TwilioWebhookController.handleRecordingCallback);

// Recording Audio Stream Proxy (Secure Playback)
router.get('/recording-audio/:attemptId', TwilioWebhookController.streamRecordingAudio);
router.get('/:attemptId/recording-audio', TwilioWebhookController.streamRecordingAudio);

// Twilio webhook interactive listen callback (DEPRECATED)
router.post('/listen/:attemptId', TwilioWebhookController.handleInteractiveListen);

// Live interactive DTMF modal input handler
router.post('/:attemptId/send-dtmf', TwilioWebhookController.handleInteractiveDtmf);
router.post('/send-dtmf/:attemptId', TwilioWebhookController.handleInteractiveDtmf);

// Twilio webhook continuous try loop
router.post('/try/:attemptId', TwilioWebhookController.handleTryCode);

export default router;
