import { type EchoSuppressionDecision, getEchoSuppressionDecision } from '../echo-suppression.js';

export interface EchoSuppressionTestCase {
  id: string;
  name: string;
  params: {
    isSpeaking: boolean;
    suppressSttUntilMs: number;
    transcriptEndMs?: number;
    nowMs: number;
  };
  expectedDecision: EchoSuppressionDecision;
}

export interface EchoSuppressionTestResult {
  testId: string;
  testName: string;
  passed: boolean;
  decision: EchoSuppressionDecision;
  expectedDecision: EchoSuppressionDecision;
}

const BASE_TIME_MS = 1_000_000;

export const ECHO_SUPPRESSION_TEST_CASES: EchoSuppressionTestCase[] = [
  {
    id: 'ignore-while-speaking',
    name: 'Ignore transcripts while speaking',
    params: {
      isSpeaking: true,
      suppressSttUntilMs: BASE_TIME_MS - 1000,
      nowMs: BASE_TIME_MS,
    },
    expectedDecision: 'speaking',
  },
  {
    id: 'ignore-during-suppression',
    name: 'Ignore transcripts during suppression window',
    params: {
      isSpeaking: false,
      suppressSttUntilMs: BASE_TIME_MS + 500,
      nowMs: BASE_TIME_MS,
    },
    expectedDecision: 'suppressed',
  },
  {
    id: 'ignore-overlap-by-timing',
    name: 'Ignore transcripts that overlap by word timing',
    params: {
      isSpeaking: false,
      suppressSttUntilMs: BASE_TIME_MS + 300,
      transcriptEndMs: BASE_TIME_MS + 100,
      nowMs: BASE_TIME_MS + 600,
    },
    expectedDecision: 'overlap',
  },
  {
    id: 'overlap-takes-precedence',
    name: 'Overlap decision has precedence over speaking/suppression',
    params: {
      isSpeaking: true,
      suppressSttUntilMs: BASE_TIME_MS + 300,
      transcriptEndMs: BASE_TIME_MS + 100,
      nowMs: BASE_TIME_MS + 200,
    },
    expectedDecision: 'overlap',
  },
  {
    id: 'allow-normal-transcript',
    name: 'Allow transcripts outside suppression window',
    params: {
      isSpeaking: false,
      suppressSttUntilMs: BASE_TIME_MS - 100,
      transcriptEndMs: BASE_TIME_MS - 50,
      nowMs: BASE_TIME_MS,
    },
    expectedDecision: null,
  },
];

export function runEchoSuppressionTest(testCase: EchoSuppressionTestCase): EchoSuppressionTestResult {
  const decision = getEchoSuppressionDecision(testCase.params);
  const passed = decision === testCase.expectedDecision;

  return {
    testId: testCase.id,
    testName: testCase.name,
    passed,
    decision,
    expectedDecision: testCase.expectedDecision,
  };
}

export function runAllEchoSuppressionTests(): {
  passed: number;
  failed: number;
  results: EchoSuppressionTestResult[];
} {
  const results: EchoSuppressionTestResult[] = [];
  let passed = 0;
  let failed = 0;

  for (const testCase of ECHO_SUPPRESSION_TEST_CASES) {
    const result = runEchoSuppressionTest(testCase);
    results.push(result);
    if (result.passed) {
      passed++;
    } else {
      failed++;
    }
  }

  return { passed, failed, results };
}
