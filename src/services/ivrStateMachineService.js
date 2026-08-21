/**
 * IVR State Machine Service
 * Formalizes the 11-step IVR state machine decision layer for automated QA.
 */

export const STATES = {
  CALL_CREATED: 'CALL_CREATED',
  CALL_CONNECTED: 'CALL_CONNECTED',
  WAITING_FOR_NUMBER_REQUEST: 'WAITING_FOR_NUMBER_REQUEST',
  NUMBER_REQUEST_DETECTED: 'NUMBER_REQUEST_DETECTED',
  SENDING_TEST_NUMBER: 'SENDING_TEST_NUMBER',
  WAITING_FOR_NUMBER_RESULT: 'WAITING_FOR_NUMBER_RESULT',
  NUMBER_VERIFIED: 'NUMBER_VERIFIED',
  WAITING_FOR_CODE_REQUEST: 'WAITING_FOR_CODE_REQUEST',
  CODE_REQUEST_DETECTED: 'CODE_REQUEST_DETECTED',
  TESTING_CODE: 'TESTING_CODE',
  CODE_REJECTED: 'CODE_REJECTED',
  CODE_ACCEPTED: 'CODE_ACCEPTED',
  PASSED: 'PASSED',
  FAILED: 'FAILED',
  CALL_COMPLETED: 'CALL_COMPLETED'
};

export const FAILURE_REASONS = {
  INVALID_TEST_NUMBER: 'INVALID_TEST_NUMBER',
  CANDIDATES_EXHAUSTED: 'CANDIDATES_EXHAUSTED',
  TIMEOUT: 'TIMEOUT',
  UNKNOWN_INSTRUCTION: 'UNKNOWN_INSTRUCTION',
  CALL_DROPPED: 'CALL_DROPPED',
  SYSTEM_ERROR: 'SYSTEM_ERROR'
};

/**
 * Validates a 16-digit synthetic test number against session expectations.
 * @param {string} testNumber - The 16-digit test number
 * @returns {boolean}
 */
export const validateTestNumber = (testNumber) => {
  if (!testNumber) return false;
  const digitsOnly = String(testNumber).replace(/\D/g, '');
  return digitsOnly.length === 16;
};

/**
 * Evaluates the next state and action given the current session state and classified instruction.
 * @param {object} session - The current test session / attempt record
 * @param {object} classification - { instructionType, confidence, transcript }
 * @returns {object} - { nextState, action, candidateToSend, isTerminal, failureReason, failureMessage }
 */
export const transitionState = (session, classification) => {
  const currentState = session.state || STATES.CALL_CREATED;
  const { instructionType } = classification || { instructionType: 'UNKNOWN' };

  const candidateList = session.test_candidates || (session.target_test_code ? [session.target_test_code] : ['001', '002', '003', '004', '005']);
  const currentIndex = typeof session.current_candidate_index === 'number' ? session.current_candidate_index : 0;
  const currentCandidate = candidateList[currentIndex] || candidateList[0] || '001';

  // 1. Initial State / Waiting for 16-digit request
  if (currentState === STATES.CALL_CREATED || currentState === STATES.CALL_CONNECTED || currentState === STATES.WAITING_FOR_NUMBER_REQUEST) {
    if (instructionType === 'REQUEST_16_DIGIT_NUMBER' || instructionType === 'UNKNOWN') {
      const rawNumber = session.sixteen_digit || (session.test_value ? session.test_value.split(':')[0] : '');
      
      if (!validateTestNumber(rawNumber)) {
        return {
          nextState: STATES.FAILED,
          action: 'HANGUP',
          isTerminal: true,
          failureReason: FAILURE_REASONS.INVALID_TEST_NUMBER,
          failureMessage: 'Synthetic 16-digit test number was invalid or rejected.'
        };
      }

      return {
        nextState: STATES.NUMBER_VERIFIED,
        action: 'SEND_16_DIGIT_NUMBER',
        testNumber: rawNumber,
        isTerminal: false
      };
    }
  }

  // 2. Number Verified / Waiting for 3-digit Code Request
  if (currentState === STATES.NUMBER_VERIFIED || currentState === STATES.WAITING_FOR_CODE_REQUEST || currentState === STATES.CODE_REQUEST_DETECTED) {
    if (instructionType === 'REQUEST_3_DIGIT_TEST_CODE' || instructionType === 'UNKNOWN' || instructionType === 'INCORRECT_CODE') {
      return {
        nextState: STATES.TESTING_CODE,
        action: 'SEND_TEST_CODE',
        candidateToSend: currentCandidate,
        candidateIndex: currentIndex,
        isTerminal: false
      };
    }
  }

  // 3. Testing Code Phase
  if (currentState === STATES.TESTING_CODE || currentState === STATES.CODE_REJECTED) {
    // Expected Success
    if (instructionType === 'SUCCESS') {
      return {
        nextState: STATES.PASSED,
        action: 'HANGUP',
        matchedCandidate: currentCandidate,
        isTerminal: true,
        successMessage: `QA Test PASSED. Candidate ${currentCandidate} was verified.`
      };
    }

    // Code was Rejected -> Advance to next candidate
    if (instructionType === 'INCORRECT_CODE' || instructionType === 'REQUEST_3_DIGIT_TEST_CODE' || instructionType === 'UNKNOWN') {
      const nextIndex = currentIndex + 1;

      if (nextIndex >= candidateList.length) {
        return {
          nextState: STATES.FAILED,
          action: 'HANGUP',
          isTerminal: true,
          failureReason: FAILURE_REASONS.CANDIDATES_EXHAUSTED,
          failureMessage: `Exhausted all ${candidateList.length} configured test candidates without acceptance.`
        };
      }

      const nextCandidate = candidateList[nextIndex];
      return {
        nextState: STATES.TESTING_CODE,
        action: 'SEND_NEXT_TEST_CODE',
        candidateToSend: nextCandidate,
        candidateIndex: nextIndex,
        rejectedCandidate: currentCandidate,
        isTerminal: false
      };
    }
  }

  // Fallback
  return {
    nextState: currentState,
    action: 'WAIT_FOR_PROMPT',
    isTerminal: false
  };
};
