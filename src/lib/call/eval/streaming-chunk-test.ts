import { findSentenceBoundary } from '../conversation-ai.js';

export interface StreamingChunkTestCase {
  id: string;
  name: string;
  text: string;
  expectedFirstChunk: string | null;
}

export interface StreamingChunkTestResult {
  testId: string;
  testName: string;
  passed: boolean;
  firstChunk: string | null;
  expectedFirstChunk: string | null;
}

function getFirstChunk(text: string): string | null {
  const boundary = findSentenceBoundary(text);
  if (boundary === -1) return null;
  const chunk = text.slice(0, boundary).trim();
  return chunk.length > 0 ? chunk : null;
}

export const STREAMING_CHUNK_TEST_CASES: StreamingChunkTestCase[] = [
  {
    id: 'sentence-boundary',
    name: 'Sentence boundary splits at punctuation + space',
    text: 'Hello there. How are you?',
    expectedFirstChunk: 'Hello there.',
  },
  {
    id: 'question-boundary',
    name: 'Question mark boundary splits correctly',
    text: 'Are you open? We can book now.',
    expectedFirstChunk: 'Are you open?',
  },
  {
    id: 'comma-boundary-long',
    name: 'Comma boundary for long buffers',
    text: 'We are interested in a reservation, for next Tuesday evening.',
    expectedFirstChunk: 'We are interested in a reservation,',
  },
  {
    id: 'comma-boundary-short',
    name: 'Comma boundary not used for short buffers',
    text: 'Yes, please.',
    expectedFirstChunk: null,
  },
  {
    id: 'no-punctuation',
    name: 'No punctuation yields no boundary',
    text: 'This should not split even though it keeps going without punctuation',
    expectedFirstChunk: null,
  },
  {
    id: 'punctuation-no-space',
    name: 'Punctuation without space does not split',
    text: 'Thanks!Please hold while I check.',
    expectedFirstChunk: null,
  },
];

export function runStreamingChunkTest(testCase: StreamingChunkTestCase): StreamingChunkTestResult {
  const firstChunk = getFirstChunk(testCase.text);
  const passed = firstChunk === testCase.expectedFirstChunk;

  return {
    testId: testCase.id,
    testName: testCase.name,
    passed,
    firstChunk,
    expectedFirstChunk: testCase.expectedFirstChunk,
  };
}

export function runAllStreamingChunkTests(): {
  passed: number;
  failed: number;
  results: StreamingChunkTestResult[];
} {
  const results: StreamingChunkTestResult[] = [];
  let passed = 0;
  let failed = 0;

  for (const testCase of STREAMING_CHUNK_TEST_CASES) {
    const result = runStreamingChunkTest(testCase);
    results.push(result);
    if (result.passed) {
      passed++;
    } else {
      failed++;
    }
  }

  return { passed, failed, results };
}
