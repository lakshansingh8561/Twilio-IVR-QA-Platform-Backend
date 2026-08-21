// Masking helper for 16-digit synthetic test numbers
export const maskTestNumber = (numberStr) => {
  if (!numberStr) return '';
  const digits = String(numberStr).replace(/\D/g, '');
  if (digits.length <= 4) return digits;
  const last4 = digits.slice(-4);
  return `************${last4}`;
};

// Helper to broadcast attempts with joined phone_number and masked credentials
const broadcastWithPhone = async (attemptId) => {
  const { data: fullAttempt } = await supabase
    .from('attempts')
    .select('*, phone_lines(phone_number)')
    .eq('id', attemptId)
    .single();
    
  if (fullAttempt) {
    const rawCard = fullAttempt.sixteen_digit || (fullAttempt.test_value ? fullAttempt.test_value.split(':')[0] : '');
    const formatted = {
      ...fullAttempt,
      masked_test_number: fullAttempt.masked_test_number || maskTestNumber(rawCard),
      phone_number: fullAttempt.phone_lines ? fullAttempt.phone_lines.phone_number : null
    };
    broadcast('attempt_update', formatted);
    return formatted;
  }
  return null;
};
import { broadcast } from '../services/websocketService.js';
import * as PhoneLineModel from './phoneLineModel.js';

// Generate a unique attempt ID string (e.g., ATT-1700000000000-X7A9B)
export const generateUniqueAttemptId = () => {
  const timestamp = Date.now();
  const randomSuffix = Math.random().toString(36).substring(2, 7).toUpperCase();
  return `ATT-${timestamp}-${randomSuffix}`;
};

// Generate random 3-digit test code (001-999)
export const generateRandomTestCode = () => {
  return String(Math.floor(Math.random() * 999) + 1).padStart(3, '0');
};

// Create a new test attempt
export const createAttempt = async (testValue, targetPhoneNumber, targetTestCode = null, testCandidates = null) => {
    const uniqueAttemptId = generateUniqueAttemptId();
    const sixteenDigit = testValue.includes(':') ? testValue.split(':')[0] : testValue;
    const testCode = targetTestCode || generateRandomTestCode();
    const masked = maskTestNumber(sixteenDigit);
    const candidates = testCandidates || ['001', '002', testCode, '004'];
    const initialLog = `[${new Date().toISOString()}] [CALL_CREATED] Test Session initialized. Attempt ID: ${uniqueAttemptId}, Test Number: ${masked}, Status: QUEUED.`;
    
    const record = {
      attempt_id: uniqueAttemptId,
      sixteen_digit: sixteenDigit,
      masked_test_number: masked,
      target_test_code: testCode,
      current_test_code: candidates[0] || '001',
      test_candidates: candidates,
      current_candidate_index: 0,
      candidate_attempts: [],
      transcriptions: [],
      state: 'CALL_CREATED',
      test_value: `${sixteenDigit}:${candidates[0] || '001'}`,
      target_phone_number: targetPhoneNumber,
      status: 'queued',
      logs: [initialLog]
    };

    let { data, error } = await supabase
      .from('attempts')
      .insert(record)
      .select()
      .single();
    
    if (error) {
      console.warn('⚠️ Standard insert with Milestone 2 columns failed, trying fallback insert:', error.message);
      // Fallback for DB schema without new columns
      const fallbackRecord = {
        test_value: `${sixteenDigit}:001`,
        target_test_code: testCode,
        target_phone_number: targetPhoneNumber,
        status: 'queued',
        logs: [initialLog]
      };

      const fbResult = await supabase
        .from('attempts')
        .insert(fallbackRecord)
        .select()
        .single();
        
      if (fbResult.error) {
        console.error('Error in createAttempt fallback:', fbResult.error);
        throw fbResult.error;
      }
      data = fbResult.data;
    }
    
    broadcast('attempt_update', data);
    return data;
  };

  // Get attempts (with left-joined phone line numbers)
  export const getAttempts = async () => {
    const { data, error } = await supabase
      .from('attempts')
      .select('*, phone_lines(phone_number)')
      .order('updated_at', { ascending: false })
      .limit(1000);
    
    if (error) {
      console.error('Error in getAttempts:', error);
      throw error;
    }

    return (data || []).map(item => ({
      ...item,
      attempt_id: item.attempt_id || `ATT-${item.id}`,
      sixteen_digit: item.sixteen_digit || (item.test_value ? item.test_value.split(':')[0] : null),
      current_test_code: item.current_test_code || (item.test_value && item.test_value.includes(':') ? item.test_value.split(':')[1] : '001'),
      phone_number: item.phone_lines ? item.phone_lines.phone_number : null
    }));
  };

  // Assign attempt to a line
  export const assignAttemptToLine = async (attemptId, lineId) => {
    // Set phone line status to busy
    await PhoneLineModel.updateLineStatus(lineId, 'busy', attemptId);

    // Fetch attempt to get current logs
    const { data: attempt, error: fetchErr } = await supabase
      .from('attempts')
      .select('logs')
      .eq('id', attemptId)
      .single();
    if (fetchErr) throw fetchErr;

    const logMsg = `[${new Date().toISOString()}] Call assigned to line ID ${lineId}.`;
    const newLogs = [...(attempt.logs || []), logMsg];

    // Update attempt status to active/in_progress and link line
    const { data: updatedAttempt, error: attemptErr } = await supabase
      .from('attempts')
      .update({
        status: 'in_progress',
        phone_line_id: lineId,
        updated_at: new Date().toISOString(),
        logs: newLogs
      })
      .eq('id', attemptId)
      .select()
      .single();

    if (attemptErr) throw attemptErr;
    await broadcastWithPhone(updatedAttempt.id);

    return updatedAttempt;
  };

  // Update Call SID for an attempt
  export const updateCallSid = async (attemptId, callSid) => {
    const { data: attempt, error: fetchErr } = await supabase
      .from('attempts')
      .select('logs')
      .eq('id', attemptId)
      .single();
    if (fetchErr) throw fetchErr;

    const logMsg = `[${new Date().toISOString()}] Call initiated. Twilio Call SID: ${callSid}.`;
    const newLogs = [...(attempt.logs || []), logMsg];

    const { data: updatedAttempt, error: attemptErr } = await supabase
      .from('attempts')
      .update({
        call_sid: callSid,
        updated_at: new Date().toISOString(),
        logs: newLogs
      })
      .eq('id', attemptId)
      .select()
      .single();

    if (attemptErr) throw attemptErr;
    await broadcastWithPhone(updatedAttempt.id);
    return updatedAttempt;
  };

  // Find attempt by Call SID or Unique Attempt ID or DB Primary Key
  export const findAttemptByCallSid = async (callSid) => {
    const { data, error } = await supabase
      .from('attempts')
      .select('*')
      .eq('call_sid', callSid)
      .maybeSingle();
    
    if (error) throw error;
    return data;
  };

  // Add a log message to an attempt
  export const addLog = async (attemptId, logMessage) => {
    console.log(`[Attempt #${attemptId}] ${logMessage}`);
    const formattedLog = `[${new Date().toISOString()}] ${logMessage}`;

    const { data: attempt, error: fetchErr } = await supabase
      .from('attempts')
      .select('logs')
      .eq('id', attemptId)
      .single();
    if (fetchErr) throw fetchErr;

    const newLogs = [...(attempt.logs || []), formattedLog];

    const { data: updatedAttempt, error: attemptErr } = await supabase
      .from('attempts')
      .update({
        logs: newLogs,
        updated_at: new Date().toISOString()
      })
      .eq('id', attemptId)
      .select()
      .single();

    if (attemptErr) throw attemptErr;
    await broadcastWithPhone(updatedAttempt.id);
    return updatedAttempt;
  };

  // Add multiple log messages to an attempt at once
  export const addLogs = async (attemptId, logMessagesArray) => {
    if (!logMessagesArray || logMessagesArray.length === 0) return null;
    
    logMessagesArray.forEach(msg => console.log(`[Attempt #${attemptId}] ${msg}`));
    const formattedLogs = logMessagesArray.map(msg => `[${new Date().toISOString()}] ${msg}`);

    const { data: attempt, error: fetchErr } = await supabase
      .from('attempts')
      .select('logs')
      .eq('id', attemptId)
      .single();
    if (fetchErr) throw fetchErr;

    const newLogs = [...(attempt.logs || []), ...formattedLogs];

    const { data: updatedAttempt, error: attemptErr } = await supabase
      .from('attempts')
      .update({
        logs: newLogs,
        updated_at: new Date().toISOString()
      })
      .eq('id', attemptId)
      .select()
      .single();

    if (attemptErr) throw attemptErr;
    await broadcastWithPhone(updatedAttempt.id);
    return updatedAttempt;
  };

  // Update current test code and status
  export const updateCurrentTestCode = async (attemptId, currentTestCode, status = 'testing_3digit') => {
    const { data: attempt } = await supabase.from('attempts').select('*').eq('id', attemptId).single();
    let sixteenDigit = attempt ? (attempt.sixteen_digit || (attempt.test_value ? attempt.test_value.split(':')[0] : '')) : '';
    
    const updateObj = {
      current_test_code: currentTestCode,
      test_value: sixteenDigit ? `${sixteenDigit}:${currentTestCode}` : currentTestCode,
      status: status,
      updated_at: new Date().toISOString()
    };

    let { data: updatedAttempt, error } = await supabase
      .from('attempts')
      .update(updateObj)
      .eq('id', attemptId)
      .select()
      .single();

    if (error) {
      console.warn('⚠️ Standard updateCurrentTestCode failed, trying fallback without current_test_code:', error.message);
      const fallbackObj = {
        test_value: sixteenDigit ? `${sixteenDigit}:${currentTestCode}` : currentTestCode,
        status: status,
        updated_at: new Date().toISOString()
      };
      const fb = await supabase
        .from('attempts')
        .update(fallbackObj)
        .eq('id', attemptId)
        .select()
        .single();
      if (fb.error) throw fb.error;
      updatedAttempt = fb.data;
    }

    if (updatedAttempt) {
      await broadcastWithPhone(updatedAttempt.id);
    }
    return updatedAttempt;
  };

  // Update test value and broadcast
  export const updateTestValue = async (attemptId, newTestValue) => {
    const { data: updatedAttempt, error } = await supabase
      .from('attempts')
      .update({ test_value: newTestValue, updated_at: new Date().toISOString() })
      .eq('id', attemptId)
      .select()
      .single();

    if (error) throw error;
    await broadcastWithPhone(updatedAttempt.id);
    return updatedAttempt;
  };

  // Create a batch of attempts from targets (supporting multiple 16-digit values)
  export const createAttemptBatch = async (targets, batchId) => {
    const recordsToInsert = targets.map((t, idx) => {
      const uniqueAttemptId = generateUniqueAttemptId();
      const sixteenDigit = t.sixteen_digit || (t.test_value ? t.test_value.split(':')[0] : t.card_number || '');
      const testCode = t.target_test_code || generateRandomTestCode();
      const masked = maskTestNumber(sixteenDigit);
      const candidates = t.test_candidates || (t.target_test_code ? ['001', '002', t.target_test_code, '004'] : ['001', '002', '003', '004', '005']);
      const currentCode = candidates[0] || t.current_test_code || '001';

      return {
        attempt_id: uniqueAttemptId,
        sixteen_digit: sixteenDigit,
        masked_test_number: masked,
        target_test_code: testCode,
        current_test_code: currentCode,
        test_candidates: candidates,
        current_candidate_index: 0,
        candidate_attempts: [],
        transcriptions: [],
        state: 'CALL_CREATED',
        target_phone_number: t.phone_number || t.target_phone_number || '+12495075171',
        destination_number: t.phone_number || t.destination_number || t.target_phone_number || '+12495075171',
        from_number: t.from_number || null,
        start_time: new Date().toISOString(),
        test_value: `${sixteenDigit}:${currentCode}`,
        batch_id: batchId,
        status: 'QUEUED',
        logs: [`[${new Date().toISOString()}] [CALL_CREATED] Test Session initialized in batch ${batchId}. Attempt ID: ${uniqueAttemptId}, Test Number: ${masked}, Status: QUEUED.`]
      };
    });

    let { data, error } = await supabase
      .from('attempts')
      .insert(recordsToInsert)
      .select();

    if (error) {
      console.warn('⚠️ Batch insert with Milestone 2 columns failed, trying fallback insert:', error.message);
      // Fallback insert without new columns
      const fallbackRecords = recordsToInsert.map(r => ({
        target_phone_number: r.target_phone_number,
        test_value: r.test_value,
        target_test_code: r.target_test_code,
        batch_id: r.batch_id,
        status: 'queued',
        logs: r.logs
      }));

      const fbResult = await supabase
        .from('attempts')
        .insert(fallbackRecords)
        .select();

      if (fbResult.error) throw fbResult.error;
      data = fbResult.data;
    }

    (data || []).forEach(attempt => broadcast('attempt_update', attempt));
    return data;
  };

  // Claim next queued or retry attempt using PostgreSQL FOR UPDATE SKIP LOCKED
  export const claimNextQueuedAttempt = async (lineId) => {
    // We call the stored procedure to atomically lock and claim an attempt
    const { data: attempt, error: fetchErr } = await supabase
      .rpc('claim_next_attempt', { p_line_id: lineId });

    if (fetchErr) {
      console.warn('⚠️ RPC claim_next_attempt failed or missing. Falling back to non-atomic claim:', fetchErr.message);
      
      // Fallback: standard select and assign (less safe for high concurrency, but ensures system works without SQL script)
      let { data: fbAttempt } = await supabase
        .from('attempts')
        .select('*')
        .eq('status', 'queued')
        .order('id', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (!fbAttempt) {
        const { data: retryAttempt } = await supabase
          .from('attempts')
          .select('*')
          .eq('status', 'retry')
          .order('id', { ascending: true })
          .limit(1)
          .maybeSingle();
        fbAttempt = retryAttempt;
      }

      if (!fbAttempt) return null;
      return await assignAttemptToLine(fbAttempt.id, lineId);
    }

    // Extract single attempt if RPC returned an array
    const claimedAttempt = Array.isArray(attempt) ? attempt[0] : attempt;

    if (!claimedAttempt || !claimedAttempt.id) return null;

    // Fetch the updated attempt details to get full logs etc.
    const { data: fullAttempt } = await supabase
      .from('attempts')
      .select('*')
      .eq('id', claimedAttempt.id)
      .single();

    if (fullAttempt) {
      await broadcastWithPhone(fullAttempt.id);
      return fullAttempt;
    }
    
    return claimedAttempt;
  };

  // Update attempt status and duration
  export const updateAttemptStatus = async (attemptId, status, duration = 0, resultDetails = {}) => {
    const { data: attempt, error: fetchErr } = await supabase
      .from('attempts')
      .select('*')
      .eq('id', attemptId)
      .single();
    if (fetchErr) throw fetchErr;

    const logMsg = `[${new Date().toISOString()}] Status updated to: ${status}.`;
    const newLogs = [...(attempt.logs || []), logMsg];

    const { data: updatedAttempt, error: attemptErr } = await supabase
      .from('attempts')
      .update({
        status: status,
        duration: duration,
        result_details: { ...(attempt.result_details || {}), ...resultDetails },
        updated_at: new Date().toISOString(),
        logs: newLogs
      })
      .eq('id', attemptId)
      .select()
      .single();

    if (attemptErr) throw attemptErr;

    // If completing, failing, or forcing a retry, free the phone line
    if (['completed', 'verified', 'failed', 'retry'].includes(status) && updatedAttempt && updatedAttempt.phone_line_id) {
      const { data: line, error: lineFetchErr } = await supabase
        .from('phone_lines')
        .select('attempts_processed')
        .eq('id', updatedAttempt.phone_line_id)
        .single();
      
      if (!lineFetchErr && line) {
        await PhoneLineModel.updateLineStatus(updatedAttempt.phone_line_id, 'idle', null, {
          attempts_processed: (line.attempts_processed || 0) + 1
        });
      }
    }

    await broadcastWithPhone(updatedAttempt.id);

    return updatedAttempt;
  };

  // Add structured log with category tag
  export const addStructuredLog = async (attemptId, tag, message) => {
    const formatted = `[${new Date().toISOString()}] [${tag}] ${message}`;
    console.log(`[Attempt #${attemptId}] [${tag}] ${message}`);

    const { data: attempt, error: fetchErr } = await supabase
      .from('attempts')
      .select('logs')
      .eq('id', attemptId)
      .single();
    if (fetchErr) return null;

    const newLogs = [...(attempt.logs || []), formatted];

    const { data: updatedAttempt, error: attemptErr } = await supabase
      .from('attempts')
      .update({
        logs: newLogs,
        updated_at: new Date().toISOString()
      })
      .eq('id', attemptId)
      .select()
      .single();

    if (!attemptErr && updatedAttempt) {
      await broadcastWithPhone(updatedAttempt.id);
      return updatedAttempt;
    }
    return null;
  };

  // Record an IVR transcription and classified instruction
  export const recordTranscription = async (attemptId, transcript, instructionType, confidence) => {
    const { data: attempt } = await supabase
      .from('attempts')
      .select('transcriptions, logs')
      .eq('id', attemptId)
      .single();

    if (!attempt) return;

    const transcriptionRecord = {
      transcript,
      instructionType,
      confidence: typeof confidence === 'number' ? Number(confidence.toFixed(2)) : 0.90,
      timestamp: new Date().toISOString()
    };

    const currentList = Array.isArray(attempt.transcriptions) ? attempt.transcriptions : [];
    const updatedList = [...currentList, transcriptionRecord];

    const transcriptLog = `[${new Date().toISOString()}] [IVR_TRANSCRIPT] "${transcript}"`;
    const instructionLog = `[${new Date().toISOString()}] [INSTRUCTION_DETECTED] ${instructionType} (Confidence: ${(transcriptionRecord.confidence * 100).toFixed(0)}%)`;

    const updatedLogs = [...(attempt.logs || []), transcriptLog, instructionLog];

    const { data: updated } = await supabase
      .from('attempts')
      .update({
        transcriptions: updatedList,
        logs: updatedLogs,
        updated_at: new Date().toISOString()
      })
      .eq('id', attemptId)
      .select()
      .single();

    if (updated) {
      await broadcastWithPhone(updated.id);
    }
    return updated;
  };

  // Record a controlled candidate attempt (e.g. Candidate 001 -> INCORRECT)
  export const recordCandidateAttempt = async (attemptId, candidate, result, transcript = '') => {
    const { data: attempt } = await supabase
      .from('attempts')
      .select('candidate_attempts, logs, attempt_id')
      .eq('id', attemptId)
      .single();

    if (!attempt) return;

    const subAttemptId = `${attempt.attempt_id || `ATT-${attemptId}`}-CAND-${candidate}`;
    const attemptRecord = {
      attemptId: subAttemptId,
      candidate: String(candidate),
      result: result, // 'INCORRECT' | 'SUCCESS' | 'PENDING'
      transcript: transcript || '',
      timestamp: new Date().toISOString()
    };

    const currentAttempts = Array.isArray(attempt.candidate_attempts) ? attempt.candidate_attempts : [];
    const updatedAttempts = [...currentAttempts, attemptRecord];

    const tag = result === 'SUCCESS' ? 'TEST_CODE_ACCEPTED' : 'TEST_CODE_REJECTED';
    const resultLog = `[${new Date().toISOString()}] [${tag}] Candidate ${candidate} evaluated as: ${result}.`;

    const updatedLogs = [...(attempt.logs || []), resultLog];

    const { data: updated } = await supabase
      .from('attempts')
      .update({
        candidate_attempts: updatedAttempts,
        current_test_code: candidate,
        logs: updatedLogs,
        updated_at: new Date().toISOString()
      })
      .eq('id', attemptId)
      .select()
      .single();

    if (updated) {
      await broadcastWithPhone(updated.id);
    }
    return updated;
  };

  // Update explicit state machine state
  export const updateSessionState = async (attemptId, state, additionalFields = {}) => {
    const { data: attempt } = await supabase
      .from('attempts')
      .select('logs')
      .eq('id', attemptId)
      .single();

    const stateLog = `[${new Date().toISOString()}] [STATE_TRANSITION] State changed to: ${state}.`;
    const updatedLogs = attempt ? [...(attempt.logs || []), stateLog] : [stateLog];

    const { data: updated } = await supabase
      .from('attempts')
      .update({
        state: state,
        status: state === 'PASSED' ? 'VERIFIED' : (state === 'FAILED' ? 'FAILED' : 'active'),
        ...additionalFields,
        logs: updatedLogs,
        updated_at: new Date().toISOString()
      })
      .eq('id', attemptId)
      .select()
      .single();

    if (updated) {
      await broadcastWithPhone(updated.id);
    }
    return updated;
  };



