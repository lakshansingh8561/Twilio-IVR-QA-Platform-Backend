import { classifyInstruction, normalizeTranscript } from './src/services/instructionClassifierService.js';
import { transitionState, STATES, FAILURE_REASONS } from './src/services/ivrStateMachineService.js';
import { maskTestNumber } from './src/models/attemptModel.js';

console.log('=== RUNNING AUTOMATED IVR QA FLOW UNIT TESTS ===\n');

// 1. Test Masking
console.log('1. Testing Test-Number Masking:');
const masked = maskTestNumber('1212132132132132');
console.log(`- Input: 1212132132132132 -> Output: ${masked}`);
if (masked === '************2132') {
  console.log('✅ Masking test PASSED\n');
} else {
  console.error('❌ Masking test FAILED\n');
  process.exit(1);
}

// 2. Test Speech Normalization and Instruction Classification
console.log('2. Testing Instruction Classification:');
const testCases = [
  {
    phrase: "Welcome to the automated verification system. Please enter your 16 digit test number.",
    expected: "REQUEST_16_DIGIT_NUMBER"
  },
  {
    phrase: "Please enter your three digit security code.",
    expected: "REQUEST_3_DIGIT_TEST_CODE"
  },
  {
    phrase: "Enter your CVV now.",
    expected: "REQUEST_3_DIGIT_TEST_CODE"
  },
  {
    phrase: "Incorrect security code. Please try entering your three digit test code again.",
    expected: "INCORRECT_CODE"
  },
  {
    phrase: "Verification successful. Thank you, your test details are verified. Goodbye!",
    expected: "SUCCESS"
  }
];

testCases.forEach((tc, idx) => {
  const res = classifyInstruction(tc.phrase);
  console.log(`[Test ${idx + 1}] Phrase: "${tc.phrase}"`);
  console.log(`  -> Detected: ${res.instructionType} (Confidence: ${(res.confidence * 100).toFixed(0)}%)`);
  if (res.instructionType === tc.expected) {
    console.log(`  ✅ PASSED`);
  } else {
    console.error(`  ❌ FAILED: Expected ${tc.expected}, got ${res.instructionType}`);
    process.exit(1);
  }
});
console.log('');

// 3. Test State Machine Transitions
console.log('3. Testing IVR State Machine Transitions:');

// Step A: Session start with valid 16-digit card
const session1 = {
  state: STATES.CALL_CONNECTED,
  sixteen_digit: '1212132132132132',
  test_candidates: ['001', '002', '003', '004'],
  current_candidate_index: 0,
  target_test_code: '003'
};

const step1 = transitionState(session1, { instructionType: 'REQUEST_16_DIGIT_NUMBER' });
console.log(`Step 1: CALL_CONNECTED + REQUEST_16_DIGIT_NUMBER -> State: ${step1.nextState}, Action: ${step1.action}`);
if (step1.nextState === STATES.NUMBER_VERIFIED && step1.action === 'SEND_16_DIGIT_NUMBER') {
  console.log('✅ Step 1 PASSED');
} else {
  console.error('❌ Step 1 FAILED');
  process.exit(1);
}

// Step B: Number verified -> Code requested
const session2 = { ...session1, state: STATES.NUMBER_VERIFIED };
const step2 = transitionState(session2, { instructionType: 'REQUEST_3_DIGIT_TEST_CODE' });
console.log(`Step 2: NUMBER_VERIFIED + REQUEST_3_DIGIT_TEST_CODE -> State: ${step2.nextState}, Candidate: ${step2.candidateToSend}`);
if (step2.nextState === STATES.TESTING_CODE && step2.candidateToSend === '001') {
  console.log('✅ Step 2 PASSED');
} else {
  console.error('❌ Step 2 FAILED');
  process.exit(1);
}

// Step C: Candidate 001 rejected -> Advance to candidate 002
const session3 = { ...session2, state: STATES.TESTING_CODE, current_candidate_index: 0 };
const step3 = transitionState(session3, { instructionType: 'INCORRECT_CODE' });
console.log(`Step 3: TESTING_CODE (001) + INCORRECT_CODE -> Next Candidate: ${step3.candidateToSend} (Index: ${step3.candidateIndex})`);
if (step3.candidateToSend === '002' && step3.candidateIndex === 1) {
  console.log('✅ Step 3 PASSED');
} else {
  console.error('❌ Step 3 FAILED');
  process.exit(1);
}

// Step D: Candidate 003 accepted -> SUCCESS
const session4 = { ...session2, state: STATES.TESTING_CODE, current_candidate_index: 2 };
const step4 = transitionState(session4, { instructionType: 'SUCCESS' });
console.log(`Step 4: TESTING_CODE (003) + SUCCESS -> State: ${step4.nextState}, Action: ${step4.action}, Terminal: ${step4.isTerminal}`);
if (step4.nextState === STATES.PASSED && step4.action === 'HANGUP' && step4.isTerminal) {
  console.log('✅ Step 4 PASSED');
} else {
  console.error('❌ Step 4 FAILED');
  process.exit(1);
}

// Step E: Candidate exhaustion -> FAILED
const session5 = { ...session2, state: STATES.TESTING_CODE, current_candidate_index: 3 };
const step5 = transitionState(session5, { instructionType: 'INCORRECT_CODE' });
console.log(`Step 5: TESTING_CODE (last candidate) + INCORRECT_CODE -> State: ${step5.nextState}, Reason: ${step5.failureReason}`);
if (step5.nextState === STATES.FAILED && step5.failureReason === FAILURE_REASONS.CANDIDATES_EXHAUSTED) {
  console.log('✅ Step 5 PASSED');
} else {
  console.error('❌ Step 5 FAILED');
  process.exit(1);
}

console.log('\n🎉 ALL AUTOMATED IVR QA FLOW TESTS PASSED SUCCESSFULLY!\n');
