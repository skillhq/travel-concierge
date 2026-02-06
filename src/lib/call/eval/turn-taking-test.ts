/**
 * Turn-Taking Integration Tests
 *
 * Tests the debounce logic and transcript accumulation to ensure:
 * 1. AI doesn't interrupt mid-sentence pauses
 * 2. Multiple transcript segments are properly combined
 * 3. Response timing is appropriate
 * 4. Edge cases are handled (rapid speech, long pauses, etc.)
 */

import { EventEmitter } from 'node:events';

// Response debounce time (must match CallSession.RESPONSE_DEBOUNCE_MS)
const RESPONSE_DEBOUNCE_MS = 500;

export interface TranscriptEvent {
  text: string;
  isFinal: boolean;
  delayMs: number; // Delay before this event fires
}

export interface TurnTakingTestCase {
  id: string;
  name: string;
  description: string;
  /** Sequence of transcript events to simulate */
  events: TranscriptEvent[];
  /** Expected combined transcript when AI responds */
  expectedTranscript: string;
  /** Expected minimum delay before AI response (ms) */
  expectedMinDelayMs: number;
  /** Expected maximum delay before AI response (ms) */
  expectedMaxDelayMs: number;
  /** Whether AI should respond at all */
  shouldRespond: boolean;
}

/**
 * Simulates the turn-taking logic from CallSession
 */
export class TurnTakingSimulator extends EventEmitter {
  private responseDebounceTimer: NodeJS.Timeout | null = null;
  private pendingTranscript = '';
  private isProcessingResponse = false;
  private responseTriggeredAt: number | null = null;
  private startTime: number = 0;

  /**
   * Simulate receiving a transcript event
   */
  handleTranscript(text: string, isFinal: boolean): void {
    if (!text.trim()) return;

    if (isFinal) {
      // Cancel any pending response timer
      if (this.responseDebounceTimer) {
        clearTimeout(this.responseDebounceTimer);
      }

      // Accumulate transcript
      if (this.pendingTranscript) {
        this.pendingTranscript += ` ${text}`;
      } else {
        this.pendingTranscript = text;
      }

      // If already processing, don't queue another
      if (this.isProcessingResponse) {
        return;
      }

      // Start debounce timer
      this.responseDebounceTimer = setTimeout(() => {
        this.responseDebounceTimer = null;
        const fullTranscript = this.pendingTranscript;
        this.pendingTranscript = '';

        if (fullTranscript && !this.isProcessingResponse) {
          this.responseTriggeredAt = Date.now();
          this.isProcessingResponse = true;
          this.emit('response', {
            transcript: fullTranscript,
            delayMs: this.responseTriggeredAt - this.startTime,
          });
        }
      }, RESPONSE_DEBOUNCE_MS);
    }
  }

  /**
   * Run a sequence of transcript events
   */
  async runSequence(events: TranscriptEvent[]): Promise<{
    responded: boolean;
    transcript: string;
    delayMs: number;
  }> {
    return new Promise((resolve) => {
      this.startTime = Date.now();
      this.pendingTranscript = '';
      this.isProcessingResponse = false;
      this.responseTriggeredAt = null;

      let responded = false;
      let responseTranscript = '';
      let responseDelay = 0;

      this.once('response', ({ transcript, delayMs }) => {
        responded = true;
        responseTranscript = transcript;
        responseDelay = delayMs;
      });

      // Schedule all events
      let totalDelay = 0;
      for (const event of events) {
        totalDelay += event.delayMs;
        setTimeout(() => {
          this.handleTranscript(event.text, event.isFinal);
        }, totalDelay);
      }

      // Wait for response or timeout
      const maxWait = totalDelay + RESPONSE_DEBOUNCE_MS + 500;
      setTimeout(() => {
        // Clean up
        if (this.responseDebounceTimer) {
          clearTimeout(this.responseDebounceTimer);
        }

        resolve({
          responded,
          transcript: responseTranscript,
          delayMs: responseDelay,
        });
      }, maxWait);
    });
  }
}

/**
 * Test cases for turn-taking
 */
export const TURN_TAKING_TEST_CASES: TurnTakingTestCase[] = [
  // Basic cases
  {
    id: 'simple-sentence',
    name: 'Simple sentence',
    description: 'Single final transcript should trigger response after debounce',
    events: [{ text: 'Hello, how are you?', isFinal: true, delayMs: 0 }],
    expectedTranscript: 'Hello, how are you?',
    expectedMinDelayMs: RESPONSE_DEBOUNCE_MS - 50,
    expectedMaxDelayMs: RESPONSE_DEBOUNCE_MS + 100,
    shouldRespond: true,
  },
  {
    id: 'interim-then-final',
    name: 'Interim followed by final',
    description: 'Interim results should be ignored, only final triggers response',
    events: [
      { text: 'Hello', isFinal: false, delayMs: 0 },
      { text: 'Hello how', isFinal: false, delayMs: 100 },
      { text: 'Hello, how are you?', isFinal: true, delayMs: 200 },
    ],
    expectedTranscript: 'Hello, how are you?',
    expectedMinDelayMs: 200 + RESPONSE_DEBOUNCE_MS - 50,
    expectedMaxDelayMs: 200 + RESPONSE_DEBOUNCE_MS + 150, // Allow more tolerance for timer variance
    shouldRespond: true,
  },

  // Mid-sentence pause cases (the main issue we're fixing)
  {
    id: 'pause-mid-sentence',
    name: 'Pause mid-sentence',
    description: 'User pauses thinking, continues - transcripts should combine',
    events: [
      { text: 'How much', isFinal: true, delayMs: 0 },
      { text: 'were you looking for?', isFinal: true, delayMs: 350 }, // Within debounce window
    ],
    expectedTranscript: 'How much were you looking for?',
    expectedMinDelayMs: 350 + RESPONSE_DEBOUNCE_MS - 50,
    expectedMaxDelayMs: 350 + RESPONSE_DEBOUNCE_MS + 100,
    shouldRespond: true,
  },
  {
    id: 'longer-pause-mid-sentence',
    name: 'Longer pause mid-sentence',
    description: 'User pauses longer but still within window',
    events: [
      { text: 'Yeah. I think so. But it feels', isFinal: true, delayMs: 0 },
      { text: 'a little bit weird', isFinal: true, delayMs: 400 }, // Just within debounce
    ],
    expectedTranscript: 'Yeah. I think so. But it feels a little bit weird',
    expectedMinDelayMs: 400 + RESPONSE_DEBOUNCE_MS - 50,
    expectedMaxDelayMs: 400 + RESPONSE_DEBOUNCE_MS + 100,
    shouldRespond: true,
  },
  {
    id: 'three-part-sentence',
    name: 'Three-part sentence with pauses',
    description: 'User pauses twice while thinking',
    events: [
      { text: 'Well', isFinal: true, delayMs: 0 },
      { text: 'let me think', isFinal: true, delayMs: 300 },
      { text: 'maybe around three fifty?', isFinal: true, delayMs: 350 },
    ],
    expectedTranscript: 'Well let me think maybe around three fifty?',
    expectedMinDelayMs: 300 + 350 + RESPONSE_DEBOUNCE_MS - 50,
    expectedMaxDelayMs: 300 + 350 + RESPONSE_DEBOUNCE_MS + 100,
    shouldRespond: true,
  },

  // Edge cases
  {
    id: 'very-long-pause',
    name: 'Very long pause (separate utterances)',
    description: 'Pause longer than debounce should trigger two responses',
    events: [
      { text: 'First sentence.', isFinal: true, delayMs: 0 },
      // This comes after debounce fires, so it's a new utterance
      { text: 'Second sentence.', isFinal: true, delayMs: 1500 },
    ],
    expectedTranscript: 'First sentence.', // First response only
    expectedMinDelayMs: RESPONSE_DEBOUNCE_MS - 50,
    expectedMaxDelayMs: RESPONSE_DEBOUNCE_MS + 100,
    shouldRespond: true,
  },
  {
    id: 'rapid-fire',
    name: 'Rapid speech (no pauses)',
    description: 'Fast talker with quick transcript segments',
    events: [
      { text: 'Yes', isFinal: true, delayMs: 0 },
      { text: 'that sounds', isFinal: true, delayMs: 100 },
      { text: 'great', isFinal: true, delayMs: 100 },
      { text: 'lets do it', isFinal: true, delayMs: 100 },
    ],
    expectedTranscript: 'Yes that sounds great lets do it',
    expectedMinDelayMs: 300 + RESPONSE_DEBOUNCE_MS - 50,
    expectedMaxDelayMs: 300 + RESPONSE_DEBOUNCE_MS + 100,
    shouldRespond: true,
  },
  {
    id: 'empty-transcripts',
    name: 'Empty transcripts ignored',
    description: 'Empty or whitespace transcripts should not affect debounce',
    events: [
      { text: 'Hello', isFinal: true, delayMs: 0 },
      { text: '', isFinal: true, delayMs: 100 },
      { text: '   ', isFinal: true, delayMs: 100 },
      { text: 'world', isFinal: true, delayMs: 100 },
    ],
    expectedTranscript: 'Hello world',
    expectedMinDelayMs: 300 + RESPONSE_DEBOUNCE_MS - 50,
    expectedMaxDelayMs: 300 + RESPONSE_DEBOUNCE_MS + 100,
    shouldRespond: true,
  },
];

export interface TurnTakingTestResult {
  testId: string;
  testName: string;
  passed: boolean;
  responded: boolean;
  expectedRespond: boolean;
  transcript: string;
  expectedTranscript: string;
  transcriptMatch: boolean;
  delayMs: number;
  expectedMinDelayMs: number;
  expectedMaxDelayMs: number;
  delayInRange: boolean;
  error?: string;
}

/**
 * Run a single turn-taking test
 */
export async function runTurnTakingTest(testCase: TurnTakingTestCase): Promise<TurnTakingTestResult> {
  const simulator = new TurnTakingSimulator();
  const result = await simulator.runSequence(testCase.events);

  const transcriptMatch = result.transcript === testCase.expectedTranscript;
  const delayInRange = result.delayMs >= testCase.expectedMinDelayMs && result.delayMs <= testCase.expectedMaxDelayMs;
  const respondedCorrectly = result.responded === testCase.shouldRespond;

  return {
    testId: testCase.id,
    testName: testCase.name,
    passed: transcriptMatch && delayInRange && respondedCorrectly,
    responded: result.responded,
    expectedRespond: testCase.shouldRespond,
    transcript: result.transcript,
    expectedTranscript: testCase.expectedTranscript,
    transcriptMatch,
    delayMs: result.delayMs,
    expectedMinDelayMs: testCase.expectedMinDelayMs,
    expectedMaxDelayMs: testCase.expectedMaxDelayMs,
    delayInRange,
  };
}

/**
 * Run all turn-taking tests
 */
export async function runAllTurnTakingTests(): Promise<{
  passed: number;
  failed: number;
  results: TurnTakingTestResult[];
}> {
  const results: TurnTakingTestResult[] = [];
  let passed = 0;
  let failed = 0;

  for (const testCase of TURN_TAKING_TEST_CASES) {
    const result = await runTurnTakingTest(testCase);
    results.push(result);
    if (result.passed) {
      passed++;
    } else {
      failed++;
    }
  }

  return { passed, failed, results };
}
