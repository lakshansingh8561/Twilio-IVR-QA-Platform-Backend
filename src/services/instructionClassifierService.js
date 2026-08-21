/**
 * Instruction Classifier Service
 * Normalizes speech-to-text transcripts and classifies IVR spoken instructions.
 */

// Common speech-to-text word-to-number normalizations
const WORD_NUMBERS = {
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  sixteen: '16',
  'three-digit': '3-digit',
  '16-digit': '16 digit',
  '3-digit': '3 digit'
};

/**
 * Normalizes raw transcript text:
 * - lowercase conversion
 * - removes unnecessary punctuation
 * - normalizes whitespace
 * - replaces common speech variations
 * @param {string} text - Raw speech-to-text input
 * @returns {string} - Clean normalized text
 */
export const normalizeTranscript = (text) => {
  if (!text || typeof text !== 'string') return '';

  let clean = text.toLowerCase();

  // Normalize punctuation and symbols
  clean = clean.replace(/['".,\/#!$%\^&\*;:{}=\-_`~()]/g, ' ');

  // Replace word variations
  Object.keys(WORD_NUMBERS).forEach((word) => {
    const reg = new RegExp(`\\b${word}\\b`, 'gi');
    clean = clean.replace(reg, WORD_NUMBERS[word]);
  });

  // Collapse multiple spaces
  clean = clean.replace(/\s+/g, ' ').trim();

  return clean;
};

// Phrase patterns for instruction classification
const CLASSIFICATION_RULES = [
  {
    type: 'REQUEST_16_DIGIT_NUMBER',
    patterns: [
      /enter (?:your |the )?16 digit (?:test |card |account )?number/i,
      /enter (?:your |the )?16 digit/i,
      /provide (?:your |the )?(?:16 digit |test )?number/i,
      /please enter (?:or say )?(?:your )?(?:16 digit |card )?number/i,
      /welcome .* please enter .* number/i,
      /enter .* 16 digit/i,
      /enter (?:your |the )?card number/i,
      /enter (?:your |the )?test number/i
    ],
    weight: 0.96
  },
  {
    type: 'REQUEST_3_DIGIT_TEST_CODE',
    patterns: [
      /enter (?:your |the )?3 digit (?:test |security )?code/i,
      /enter (?:your |the )?3 digit/i,
      /enter (?:your |the )?cvv/i,
      /enter (?:your |the )?security code/i,
      /please enter (?:your )?three digit/i,
      /please enter (?:your |the )?cvv/i,
      /enter (?:your |the )?test code/i,
      /card (?:number )?accepted .* enter .* code/i,
      /provide (?:your |the )?(?:3 digit |security )?code/i
    ],
    weight: 0.95
  },
  {
    type: 'INCORRECT_CODE',
    patterns: [
      /incorrect (?:test |security )?code/i,
      /invalid (?:3 digit |test |security )?code/i,
      /code (?:is )?incorrect/i,
      /invalid test code/i,
      /wrong code/i,
      /please try entering .* code again/i,
      /entered an invalid/i
    ],
    weight: 0.94
  },
  {
    type: 'SUCCESS',
    patterns: [
      /verification successful/i,
      /test code correct/i,
      /details (?:are )?verified/i,
      /successfully verified/i,
      /thank you .* verified/i,
      /verification passed/i,
      /test completed successfully/i
    ],
    weight: 0.98
  },
  {
    type: 'END_CALL',
    patterns: [
      /thank you .* goodbye/i,
      /goodbye/i,
      /have a great day/i,
      /call completed/i,
      /hanging up/i
    ],
    weight: 0.92
  }
];

/**
 * Classifies an IVR transcript into structured instruction object.
 * @param {string} rawTranscript - Spoken text from the IVR
 * @returns {object} - { instructionType, confidence, transcript, normalizedTranscript }
 */
export const classifyInstruction = (rawTranscript) => {
  const normalized = normalizeTranscript(rawTranscript);

  if (!normalized) {
    return {
      instructionType: 'UNKNOWN',
      confidence: 0.0,
      transcript: rawTranscript || '',
      normalizedTranscript: ''
    };
  }

  for (const rule of CLASSIFICATION_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(normalized) || pattern.test(rawTranscript)) {
        return {
          instructionType: rule.type,
          confidence: rule.weight,
          transcript: rawTranscript,
          normalizedTranscript: normalized
        };
      }
    }
  }

  // Fallback keyword scanning
  if (normalized.includes('16 digit') || normalized.includes('card number') || (normalized.includes('enter') && normalized.includes('number'))) {
    return {
      instructionType: 'REQUEST_16_DIGIT_NUMBER',
      confidence: 0.82,
      transcript: rawTranscript,
      normalizedTranscript: normalized
    };
  }

  if (normalized.includes('cvv') || normalized.includes('security code') || normalized.includes('3 digit') || normalized.includes('test code')) {
    if (normalized.includes('incorrect') || normalized.includes('invalid') || normalized.includes('wrong')) {
      return {
        instructionType: 'INCORRECT_CODE',
        confidence: 0.88,
        transcript: rawTranscript,
        normalizedTranscript: normalized
      };
    }
    return {
      instructionType: 'REQUEST_3_DIGIT_TEST_CODE',
      confidence: 0.85,
      transcript: rawTranscript,
      normalizedTranscript: normalized
    };
  }

  if (normalized.includes('verified') || normalized.includes('successful') || normalized.includes('accepted')) {
    return {
      instructionType: 'SUCCESS',
      confidence: 0.89,
      transcript: rawTranscript,
      normalizedTranscript: normalized
    };
  }

  return {
    instructionType: 'UNKNOWN',
    confidence: 0.40,
    transcript: rawTranscript,
    normalizedTranscript: normalized
  };
};
