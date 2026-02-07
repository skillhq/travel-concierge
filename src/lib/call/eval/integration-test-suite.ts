/**
 * Comprehensive Integration Test Suite
 *
 * Combines all tests into a single suite:
 * 1. Codec tests - verify audio pipeline
 * 2. Turn-taking tests - verify debounce logic
 * 3. Conversation flow tests - verify AI behavior
 * 4. End-to-end pipeline tests - full flow without phone
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConversationAI } from '../conversation-ai.js';
import { testTTSPipeline } from './codec-test.js';
import { type EchoSuppressionTestResult, runAllEchoSuppressionTests } from './echo-suppression-test.js';
import { runAllStreamingChunkTests, type StreamingChunkTestResult } from './streaming-chunk-test.js';
import { runTranscriptRegressionTests } from './transcript-regression-test.js';
import { runAllTurnTakingTests, type TurnTakingTestResult } from './turn-taking-test.js';

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export interface IntegrationTestConfig {
  anthropicApiKey: string;
  deepgramApiKey: string;
  elevenLabsApiKey: string;
  elevenLabsVoiceId: string;
  outputDir?: string;
}

export interface TestSuiteResult {
  timestamp: string;
  duration: number;
  overallPassed: boolean;
  codec: {
    passed: boolean;
    tests: number;
    failures: string[];
  };
  turnTaking: {
    passed: boolean;
    total: number;
    passedCount: number;
    failures: TurnTakingTestResult[];
  };
  streamingChunks: {
    passed: boolean;
    total: number;
    passedCount: number;
    failures: StreamingChunkTestResult[];
  };
  echoSuppression: {
    passed: boolean;
    total: number;
    passedCount: number;
    failures: EchoSuppressionTestResult[];
  };
  transcriptRegression: {
    passed: boolean;
    tests: number;
    failures: string[];
  };
  conversationFlow: {
    passed: boolean;
    tests: number;
    failures: string[];
  };
  aiDisclosure: {
    passed: boolean;
    greeting: string;
    containsDisclosure: boolean;
    hasWrongRole: boolean;
    issues: string[];
  };
  roleConsistency: {
    passed: boolean;
    issues: string[];
    roleReversalPhrases: string[];
  };
  voiceFormatting: {
    passed: boolean;
    issues: string[];
  };
  noRepetition: {
    passed: boolean;
    issues: string[];
  };
  conciseness: {
    passed: boolean;
    issues: string[];
    responses: string[];
    avgWordsPerResponse: number;
    maxWordsPerResponse: number;
    enthusiasmCount: number;
  };
  ivrDtmf: {
    passed: boolean;
    tests: number;
    failures: string[];
  };
}

/**
 * Test 1: Codec Pipeline
 * Verifies ElevenLabs → ffmpeg → µ-law conversion
 */
async function runCodecTests(config: IntegrationTestConfig): Promise<{
  passed: boolean;
  tests: number;
  failures: string[];
}> {
  const testTexts = [
    'Hello.',
    'This is a longer sentence to test the audio conversion pipeline.',
    'Testing numbers: one, two, three, four, five.',
  ];

  const failures: string[] = [];

  for (const text of testTexts) {
    try {
      const result = await testTTSPipeline(text, config.elevenLabsApiKey, config.elevenLabsVoiceId);
      if (!result.success) {
        failures.push(`"${text.substring(0, 30)}...": ${result.errors.join(', ')}`);
      }
    } catch (error) {
      failures.push(`"${text.substring(0, 30)}...": ${error}`);
    }
  }

  return {
    passed: failures.length === 0,
    tests: testTexts.length,
    failures,
  };
}

/**
 * Test 2: Turn-Taking Debounce
 * Verifies transcript accumulation and timing
 */
async function runTurnTakingTests(): Promise<{
  passed: boolean;
  total: number;
  passedCount: number;
  failures: TurnTakingTestResult[];
}> {
  const { passed, failed, results } = await runAllTurnTakingTests();
  const failures = results.filter((r) => !r.passed);

  return {
    passed: failed === 0,
    total: passed + failed,
    passedCount: passed,
    failures,
  };
}

async function runStreamingChunkTests(): Promise<{
  passed: boolean;
  total: number;
  passedCount: number;
  failures: StreamingChunkTestResult[];
}> {
  const { passed, failed, results } = runAllStreamingChunkTests();
  const failures = results.filter((r) => !r.passed);

  return {
    passed: failed === 0,
    total: passed + failed,
    passedCount: passed,
    failures,
  };
}

async function runEchoSuppressionTests(): Promise<{
  passed: boolean;
  total: number;
  passedCount: number;
  failures: EchoSuppressionTestResult[];
}> {
  const { passed, failed, results } = runAllEchoSuppressionTests();
  const failures = results.filter((r) => !r.passed);

  return {
    passed: failed === 0,
    total: passed + failed,
    passedCount: passed,
    failures,
  };
}

/**
 * Test 3: Conversation Flow
 * Tests AI behavior in various scenarios
 */
async function runConversationFlowTests(config: IntegrationTestConfig): Promise<{
  passed: boolean;
  tests: number;
  failures: string[];
}> {
  const failures: string[] = [];

  // Test 1: Greeting doesn't end conversation
  try {
    const ai1 = new ConversationAI({
      apiKey: config.anthropicApiKey,
      goal: 'Book a hotel room',
      context: 'Hotel: Test Hotel, Dates: March 1-3',
    });

    const greeting = await ai1.getGreeting();
    if (ai1.complete) {
      failures.push('Greeting marked conversation complete prematurely');
    }
    if (!greeting || greeting.length < 10) {
      failures.push(`Greeting too short: "${greeting}"`);
    }
  } catch (error) {
    failures.push(`Greeting test failed: ${error}`);
  }

  // Test 2: Normal conversation doesn't end prematurely
  try {
    const ai2 = new ConversationAI({
      apiKey: config.anthropicApiKey,
      goal: 'Get business hours',
      context: 'Business: Test Store',
    });

    await ai2.getGreeting();
    // Store employee responds - AI should ask about hours, not end call
    await ai2.respond('Hello, how can I help you?');

    // The AI should continue the conversation to get the hours
    // It shouldn't mark complete just because someone said hello
    if (ai2.complete) {
      failures.push('Conversation ended prematurely - AI should ask for hours, not end call');
    }
  } catch (error) {
    failures.push(`Conversation flow test failed: ${error}`);
  }

  // Test 3: Conversation can complete properly
  try {
    const ai3 = new ConversationAI({
      apiKey: config.anthropicApiKey,
      goal: 'Confirm a reservation exists',
      context: 'Confirmation number: ABC123',
    });

    await ai3.getGreeting();
    await ai3.respond('Yes, I can confirm that reservation ABC123 is valid.');

    // The AI might mark complete after confirmation
    // This is expected behavior
  } catch (error) {
    failures.push(`Conversation completion test failed: ${error}`);
  }

  return {
    passed: failures.length === 0,
    tests: 3,
    failures,
  };
}

/**
 * Test 4: AI Disclosure and Role
 * Verifies AI discloses it's an AI AND doesn't say "how can I help you"
 */
async function runAIDisclosureTest(config: IntegrationTestConfig): Promise<{
  passed: boolean;
  greeting: string;
  containsDisclosure: boolean;
  hasWrongRole: boolean;
  issues: string[];
}> {
  const ai = new ConversationAI({
    apiKey: config.anthropicApiKey,
    goal: 'Book a hotel room',
    context: 'Customer: John Smith, Hotel: Grand Plaza',
  });

  const greeting = await ai.getGreeting();
  const greetingLower = greeting.toLowerCase();
  const issues: string[] = [];

  // Check for AI disclosure keywords
  const disclosureKeywords = ['ai', 'artificial', 'assistant', 'automated', 'behalf'];
  const containsDisclosure = disclosureKeywords.some((keyword) => greetingLower.includes(keyword));

  if (!containsDisclosure) {
    issues.push('Missing AI disclosure in greeting');
  }

  // Check for wrong role (AI shouldn't ask how it can help - it's the caller!)
  const wrongRolePhrases = [
    'how can i assist',
    'how can i help',
    'how may i help',
    'how may i assist',
    'what can i do for you',
  ];
  const hasWrongRole = wrongRolePhrases.some((phrase) => greetingLower.includes(phrase));

  if (hasWrongRole) {
    issues.push('AI incorrectly asked "how can I help" - AI is the caller seeking help!');
  }

  return {
    passed: containsDisclosure && !hasWrongRole,
    greeting,
    containsDisclosure,
    hasWrongRole,
    issues,
  };
}

/**
 * Test 5: Role Consistency (No Role Reversal)
 * Verifies AI stays in customer role throughout, doesn't switch to hotel employee phrases
 */
async function runRoleConsistencyTest(config: IntegrationTestConfig): Promise<{
  passed: boolean;
  issues: string[];
  responses: string[];
  roleReversalPhrases: string[];
}> {
  const ai = new ConversationAI({
    apiKey: config.anthropicApiKey,
    goal: 'Book a hotel room and get a confirmation number',
    context: 'Customer: Derek Rein, Hotel: Grand Plaza, Dates: March 12-14, Email: derek@example.com',
  });

  const issues: string[] = [];
  const responses: string[] = [];
  const roleReversalPhrases: string[] = [];

  // Phrases that indicate the AI switched to acting like the hotel employee
  const badPhrases = [
    'does this look correct',
    'does this all look correct',
    'does that look correct',
    'let me know if you need anything',
    'please let me know if you need',
    "i've noted",
    'i have noted',
    "i'll note that",
    'anything else i can help you with',
    'is there anything else i can do',
    "i've got that booked",
    'i have that booked',
    'your reservation is confirmed', // AI shouldn't confirm - hotel does
    "you're all set", // Hotel says this, not caller
  ];

  // Simulate a quick agreement conversation
  const greeting = await ai.getGreeting();
  responses.push(greeting);

  const r1 = await ai.respond('Mhmm. Sure, we can do that.');
  responses.push(r1 || '');

  const r2 = await ai.respond('Yes, that works. Go ahead.');
  responses.push(r2 || '');

  const r3 = await ai.respond('Okay, done. Anything else?');
  responses.push(r3 || '');

  // Check all responses for role reversal phrases
  for (const text of responses) {
    const textLower = text.toLowerCase();
    for (const phrase of badPhrases) {
      if (textLower.includes(phrase)) {
        roleReversalPhrases.push(`"${phrase}" found in: "${text.substring(0, 80)}..."`);
        issues.push(`Role reversal detected: AI used hotel-employee phrase "${phrase}"`);
      }
    }
  }

  return {
    passed: issues.length === 0,
    issues,
    responses,
    roleReversalPhrases,
  };
}

/**
 * Test 6: Voice-Friendly Formatting
 * Verifies dates and numbers are spelled out for voice
 */
async function runVoiceFormattingTest(config: IntegrationTestConfig): Promise<{
  passed: boolean;
  issues: string[];
  responses: string[];
}> {
  const ai = new ConversationAI({
    apiKey: config.anthropicApiKey,
    goal: 'Book a hotel room for March 12-14',
    context: 'Customer: John Smith, Hotel: Grand Plaza, Dates: March 12-14, Price: $393',
  });

  const issues: string[] = [];
  const responses: string[] = [];

  // Get greeting and first response
  const greeting = await ai.getGreeting();
  responses.push(greeting);

  const response = await ai.respond('Sure, what dates are you looking at?');
  responses.push(response || '');

  // Check all responses for formatting issues
  for (const text of responses) {
    // Check for numeric date ranges (should be spelled out)
    if (/\d+-\d+/.test(text)) {
      issues.push(`Contains numeric date range: "${text.match(/\d+-\d+/)?.[0]}"`);
    }

    // Check for $ symbol (should say "dollars")
    if (/\$\d+/.test(text)) {
      issues.push(`Contains $ symbol: "${text.match(/\$\d+/)?.[0]}"`);
    }
  }

  return {
    passed: issues.length === 0,
    issues,
    responses,
  };
}

/**
 * Test 6: No Repetition
 * Verifies AI doesn't keep repeating the same information
 */
async function runNoRepetitionTest(config: IntegrationTestConfig): Promise<{
  passed: boolean;
  issues: string[];
  responses: string[];
}> {
  const ai = new ConversationAI({
    apiKey: config.anthropicApiKey,
    goal: 'Book a hotel room',
    context: 'Hotel: Test Hotel, Room: Deluxe Suite, Dates: March 15-17, Price: $500',
  });

  const issues: string[] = [];
  const responses: string[] = [];

  // Simulate a conversation
  const greeting = await ai.getGreeting();
  responses.push(greeting);

  const r1 = await ai.respond('Yes, we have that room available.');
  responses.push(r1 || '');

  const r2 = await ai.respond('The rate is four fifty per night.');
  responses.push(r2 || '');

  // Count how many times key phrases appear across all responses
  const allText = responses.join(' ').toLowerCase();

  // Check for excessive repetition of specific details
  const hotelMentions = (allText.match(/test hotel/g) || []).length;
  const dateMentions = (allText.match(/march (15|fifteen)/g) || []).length;

  if (hotelMentions > 2) {
    issues.push(`Hotel name repeated ${hotelMentions} times (max 2)`);
  }

  if (dateMentions > 2) {
    issues.push(`Dates repeated ${dateMentions} times (max 2)`);
  }

  return {
    passed: issues.length === 0,
    issues,
    responses,
  };
}

/**
 * Test 7: Conciseness and Redundant Follow-ups
 * Uses a real booking flow where the AI often becomes too wordy.
 */
async function runConcisenessTest(config: IntegrationTestConfig): Promise<{
  passed: boolean;
  issues: string[];
  responses: string[];
  avgWordsPerResponse: number;
  maxWordsPerResponse: number;
  enthusiasmCount: number;
}> {
  const ai = new ConversationAI({
    apiKey: config.anthropicApiKey,
    goal: 'Book a room directly, share email for payment link, and get confirmation details',
    context:
      'Hotel: Haus im Tal, Dates: March 12-14, Online rate: $393, Guest: Derek Rein, Email: alexanderderekrein@gmail.com',
  });

  const issues: string[] = [];
  const responses: string[] = [];

  const greeting = await ai.getGreeting();
  responses.push(greeting);

  const scriptedTurns = [
    'Sure.',
    'Yes.',
    'Yes.',
    'I need to email you a premium link. Does that work?',
    'Can you spell out the email again?',
    'Okay. Perfect.',
    'Yes.',
  ];

  let emailSpellingResponse = '';

  for (const human of scriptedTurns) {
    const response = await ai.respond(human);
    if (!response) break;
    responses.push(response);
    if (human.toLowerCase().includes('spell out the email')) {
      emailSpellingResponse = response;
    }
  }

  const wordCounts = responses.map(countWords);
  const avgWordsPerResponse =
    wordCounts.length > 0 ? wordCounts.reduce((sum, count) => sum + count, 0) / wordCounts.length : 0;
  const maxWordsPerResponse = wordCounts.length > 0 ? Math.max(...wordCounts) : 0;

  if (maxWordsPerResponse > 45) {
    issues.push(`Response too long (${maxWordsPerResponse} words). Target is <= 45 for phone pacing.`);
  }
  if (avgWordsPerResponse > 28) {
    issues.push(`Average response too long (${avgWordsPerResponse.toFixed(1)} words). Target is <= 28.`);
  }

  const allTextLower = responses.join(' ').toLowerCase();
  const enthusiasmMatches = allTextLower.match(/\b(wonderful|excellent|perfect|fantastic|amazing)\b/g) || [];
  const enthusiasmCount = enthusiasmMatches.length;
  if (enthusiasmCount > 2) {
    issues.push(`Too much enthusiasm filler (${enthusiasmCount} matches). Keep acknowledgements brief.`);
  }

  const redundantReconfirmPhrases =
    allTextLower.match(/just to confirm|final price|for march|confirmation number/g) || [];
  if (redundantReconfirmPhrases.length > 4) {
    issues.push(`Likely over-reconfirmation (${redundantReconfirmPhrases.length} repeated confirmation phrases).`);
  }

  if (emailSpellingResponse) {
    if (!/gmail dot com|at gmail dot com/i.test(emailSpellingResponse)) {
      issues.push('When asked to spell the email again, response did not clearly repeat the email.');
    }
    if (/that works|works perfectly|final price|just to confirm/i.test(emailSpellingResponse)) {
      issues.push('Email spelling response included stale/redundant confirmation language.');
    }
  } else {
    issues.push('Did not capture an answer to "Can you spell out the email again?"');
  }

  return {
    passed: issues.length === 0,
    issues,
    responses,
    avgWordsPerResponse,
    maxWordsPerResponse,
    enthusiasmCount,
  };
}

/**
 * Test 8: IVR DTMF Navigation
 * Verifies AI produces [DTMF:X] markers when faced with an IVR menu
 */
async function runIvrDtmfTests(config: IntegrationTestConfig): Promise<{
  passed: boolean;
  tests: number;
  failures: string[];
}> {
  const failures: string[] = [];
  let tests = 0;

  // Test 1: AI should emit DTMF marker when hearing a standard IVR menu
  tests++;
  try {
    const ai = new ConversationAI({
      apiKey: config.anthropicApiKey,
      goal: 'Book a hotel room',
      context: 'Hotel: Hilton Garden Inn. Customer: Bob Wilson.',
    });

    await ai.getGreeting();
    const response = await ai.respond(
      'Thank you for calling Hilton Garden Inn. For reservations, press 1. For an existing reservation, press 2. For the front desk, press 3.',
    );

    if (!response) {
      failures.push('IVR menu: AI returned empty response');
    } else if (!/\[DTMF:[0-9*#]+\]/.test(response)) {
      failures.push(`IVR menu: AI did not emit a DTMF marker. Response: "${response.substring(0, 100)}"`);
    } else {
      // Should press 1 for reservations (our goal is booking)
      const match = response.match(/\[DTMF:([0-9*#]+)\]/);
      if (match && match[1] !== '1') {
        failures.push(
          `IVR menu: AI pressed ${match[1]} but should press 1 for reservations. Response: "${response.substring(0, 100)}"`,
        );
      }
    }
  } catch (error) {
    failures.push(`IVR menu test failed: ${error}`);
  }

  // Test 2: AI should emit DTMF:0 for operator when no clear option matches
  tests++;
  try {
    const ai = new ConversationAI({
      apiKey: config.anthropicApiKey,
      goal: 'Ask about lost and found items',
      context: 'Hotel: Grand Plaza.',
    });

    await ai.getGreeting();
    const response = await ai.respond(
      'Welcome to Grand Plaza. Press 1 for reservations. Press 2 for billing. Press 3 for events.',
    );

    if (!response) {
      failures.push('IVR no-match: AI returned empty response');
    } else if (!/\[DTMF:[0-9*#]+\]/.test(response)) {
      failures.push(`IVR no-match: AI did not emit a DTMF marker. Response: "${response.substring(0, 100)}"`);
    }
    // We don't enforce which digit — 0 for operator is suggested but the AI may choose to wait
  } catch (error) {
    failures.push(`IVR no-match test failed: ${error}`);
  }

  // Test 3: DTMF markers should be stripped from conversation history
  tests++;
  try {
    const ai = new ConversationAI({
      apiKey: config.anthropicApiKey,
      goal: 'Book a hotel room',
      context: 'Hotel: Marriott. Customer: Jane Doe.',
    });

    await ai.getGreeting();
    await ai.respond('For reservations, press 1. For front desk, press 2.');

    const history = ai.getHistory();
    const assistantMessages = history.filter((m) => m.role === 'assistant');
    const hasDtmfInHistory = assistantMessages.some((m) => /\[DTMF:[0-9*#]+\]/.test(m.content));
    if (hasDtmfInHistory) {
      failures.push('DTMF markers should be stripped from conversation history but were found');
    }
  } catch (error) {
    failures.push(`DTMF history stripping test failed: ${error}`);
  }

  return {
    passed: failures.length === 0,
    tests,
    failures,
  };
}

/**
 * Run the complete integration test suite
 */
export async function runIntegrationTestSuite(config: IntegrationTestConfig): Promise<TestSuiteResult> {
  const startTime = Date.now();

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║       COMPREHENSIVE INTEGRATION TEST SUITE                  ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  // Run all test categories
  console.log('🔊 Running Codec Tests...');
  const codecResult = await runCodecTests(config);
  console.log(
    `   ${codecResult.passed ? '✅' : '❌'} ${codecResult.tests - codecResult.failures.length}/${codecResult.tests} passed\n`,
  );

  console.log('🔄 Running Turn-Taking Tests...');
  const turnTakingResult = await runTurnTakingTests();
  console.log(
    `   ${turnTakingResult.passed ? '✅' : '❌'} ${turnTakingResult.passedCount}/${turnTakingResult.total} passed\n`,
  );

  console.log('🧩 Running Streaming Chunk Tests...');
  const streamingChunkResult = await runStreamingChunkTests();
  console.log(
    `   ${streamingChunkResult.passed ? '✅' : '❌'} ${streamingChunkResult.passedCount}/${streamingChunkResult.total} passed\n`,
  );

  console.log('🔇 Running Echo Suppression Tests...');
  const echoSuppressionResult = await runEchoSuppressionTests();
  console.log(
    `   ${echoSuppressionResult.passed ? '✅' : '❌'} ${echoSuppressionResult.passedCount}/${echoSuppressionResult.total} passed\n`,
  );

  console.log('📝 Running Transcript Regression Tests...');
  const transcriptRegressionResult = await runTranscriptRegressionTests({
    anthropicApiKey: config.anthropicApiKey,
  });
  console.log(
    `   ${transcriptRegressionResult.passed ? '✅' : '❌'} ${transcriptRegressionResult.tests - transcriptRegressionResult.failures.length}/${transcriptRegressionResult.tests} passed\n`,
  );

  console.log('💬 Running Conversation Flow Tests...');
  const conversationResult = await runConversationFlowTests(config);
  console.log(
    `   ${conversationResult.passed ? '✅' : '❌'} ${conversationResult.tests - conversationResult.failures.length}/${conversationResult.tests} passed\n`,
  );

  console.log('🤖 Running AI Disclosure & Role Test...');
  const disclosureResult = await runAIDisclosureTest(config);
  console.log(
    `   ${disclosureResult.passed ? '✅' : '❌'} Disclosure: ${disclosureResult.containsDisclosure ? 'yes' : 'no'}, Wrong role: ${disclosureResult.hasWrongRole ? 'YES (bad)' : 'no (good)'}\n`,
  );

  console.log('🔄 Running Role Consistency Test...');
  const roleResult = await runRoleConsistencyTest(config);
  console.log(
    `   ${roleResult.passed ? '✅' : '❌'} ${roleResult.issues.length === 0 ? 'AI stayed in customer role' : `Role reversals: ${roleResult.roleReversalPhrases.length}`}\n`,
  );

  console.log('🗣️  Running Voice Formatting Test...');
  const voiceResult = await runVoiceFormattingTest(config);
  console.log(
    `   ${voiceResult.passed ? '✅' : '❌'} ${voiceResult.issues.length === 0 ? 'Dates/numbers properly spelled out' : voiceResult.issues.join(', ')}\n`,
  );

  console.log('🔁 Running No Repetition Test...');
  const repetitionResult = await runNoRepetitionTest(config);
  console.log(
    `   ${repetitionResult.passed ? '✅' : '❌'} ${repetitionResult.issues.length === 0 ? 'No excessive repetition' : repetitionResult.issues.join(', ')}\n`,
  );

  console.log('✂️  Running Conciseness Test...');
  const concisenessResult = await runConcisenessTest(config);
  console.log(
    `   ${concisenessResult.passed ? '✅' : '❌'} avg words: ${concisenessResult.avgWordsPerResponse.toFixed(1)}, max: ${concisenessResult.maxWordsPerResponse}, filler words: ${concisenessResult.enthusiasmCount}\n`,
  );

  console.log('📞 Running IVR DTMF Navigation Tests...');
  const ivrDtmfResult = await runIvrDtmfTests(config);
  console.log(
    `   ${ivrDtmfResult.passed ? '✅' : '❌'} ${ivrDtmfResult.tests - ivrDtmfResult.failures.length}/${ivrDtmfResult.tests} passed\n`,
  );

  const duration = Date.now() - startTime;
  const overallPassed =
    codecResult.passed &&
    turnTakingResult.passed &&
    streamingChunkResult.passed &&
    echoSuppressionResult.passed &&
    transcriptRegressionResult.passed &&
    conversationResult.passed &&
    disclosureResult.passed &&
    roleResult.passed &&
    voiceResult.passed &&
    repetitionResult.passed &&
    concisenessResult.passed &&
    ivrDtmfResult.passed;

  const result: TestSuiteResult = {
    timestamp: new Date().toISOString(),
    duration,
    overallPassed,
    codec: codecResult,
    turnTaking: turnTakingResult,
    streamingChunks: streamingChunkResult,
    echoSuppression: echoSuppressionResult,
    transcriptRegression: transcriptRegressionResult,
    conversationFlow: conversationResult,
    aiDisclosure: disclosureResult,
    roleConsistency: roleResult,
    voiceFormatting: voiceResult,
    noRepetition: repetitionResult,
    conciseness: concisenessResult,
    ivrDtmf: ivrDtmfResult,
  };

  // Print summary
  console.log('╔════════════════════════════════════════════════════════════╗');
  if (overallPassed) {
    console.log('║  ✅ ALL INTEGRATION TESTS PASSED                            ║');
  } else {
    console.log('║  ❌ SOME INTEGRATION TESTS FAILED                           ║');
  }
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  Codec:           ${codecResult.passed ? '✅ PASS' : '❌ FAIL'}                                 ║`);
  console.log(
    `║  Turn-Taking:     ${turnTakingResult.passed ? '✅ PASS' : '❌ FAIL'}                                 ║`,
  );
  console.log(
    `║  Streaming Chunks:${streamingChunkResult.passed ? '✅ PASS' : '❌ FAIL'}                                 ║`,
  );
  console.log(
    `║  Echo Suppress:   ${echoSuppressionResult.passed ? '✅ PASS' : '❌ FAIL'}                                 ║`,
  );
  console.log(
    `║  Transcript Reg:  ${transcriptRegressionResult.passed ? '✅ PASS' : '❌ FAIL'}                                 ║`,
  );
  console.log(
    `║  Conversation:    ${conversationResult.passed ? '✅ PASS' : '❌ FAIL'}                                 ║`,
  );
  console.log(
    `║  AI Disclosure:   ${disclosureResult.passed ? '✅ PASS' : '❌ FAIL'}                                 ║`,
  );
  console.log(`║  Role Consistency:${roleResult.passed ? '✅ PASS' : '❌ FAIL'}                                 ║`);
  console.log(`║  Voice Format:    ${voiceResult.passed ? '✅ PASS' : '❌ FAIL'}                                 ║`);
  console.log(
    `║  No Repetition:   ${repetitionResult.passed ? '✅ PASS' : '❌ FAIL'}                                 ║`,
  );
  console.log(
    `║  Conciseness:     ${concisenessResult.passed ? '✅ PASS' : '❌ FAIL'}                                 ║`,
  );
  console.log(`║  IVR DTMF:        ${ivrDtmfResult.passed ? '✅ PASS' : '❌ FAIL'}                                 ║`);
  console.log(`║  Duration:        ${(duration / 1000).toFixed(1)}s                                  ║`);
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  // Print failures if any
  if (!overallPassed) {
    console.log('FAILURES:\n');

    if (!codecResult.passed) {
      console.log('Codec failures:');
      for (const f of codecResult.failures) {
        console.log(`  - ${f}`);
      }
      console.log('');
    }

    if (!turnTakingResult.passed) {
      console.log('Turn-taking failures:');
      for (const f of turnTakingResult.failures) {
        console.log(`  - ${f.testName}: transcript="${f.transcript}" (expected "${f.expectedTranscript}")`);
      }
      console.log('');
    }

    if (!streamingChunkResult.passed) {
      console.log('Streaming chunk failures:');
      for (const f of streamingChunkResult.failures) {
        console.log(`  - ${f.testName}: chunk="${f.firstChunk}" (expected "${f.expectedFirstChunk}")`);
      }
      console.log('');
    }

    if (!echoSuppressionResult.passed) {
      console.log('Echo suppression failures:');
      for (const f of echoSuppressionResult.failures) {
        console.log(`  - ${f.testName}: decision="${f.decision}" (expected "${f.expectedDecision}")`);
      }
      console.log('');
    }

    if (!transcriptRegressionResult.passed) {
      console.log('Transcript regression failures:');
      for (const f of transcriptRegressionResult.failures) {
        console.log(`  - ${f}`);
      }
      console.log('');
    }

    if (!conversationResult.passed) {
      console.log('Conversation flow failures:');
      for (const f of conversationResult.failures) {
        console.log(`  - ${f}`);
      }
      console.log('');
    }

    if (!disclosureResult.passed) {
      console.log('AI disclosure/role failures:');
      for (const f of disclosureResult.issues) {
        console.log(`  - ${f}`);
      }
      console.log(`  Greeting was: "${disclosureResult.greeting}"`);
      console.log('');
    }

    if (!roleResult.passed) {
      console.log('Role consistency failures (AI switched to hotel employee role):');
      for (const f of roleResult.roleReversalPhrases) {
        console.log(`  - ${f}`);
      }
      console.log('  Responses:');
      for (let i = 0; i < roleResult.responses.length; i++) {
        console.log(`    ${i + 1}. "${roleResult.responses[i].substring(0, 100)}..."`);
      }
      console.log('');
    }

    if (!voiceResult.passed) {
      console.log('Voice formatting failures:');
      for (const f of voiceResult.issues) {
        console.log(`  - ${f}`);
      }
      console.log('  Responses:');
      for (let i = 0; i < voiceResult.responses.length; i++) {
        console.log(`    ${i + 1}. "${voiceResult.responses[i].substring(0, 80)}..."`);
      }
      console.log('');
    }

    if (!repetitionResult.passed) {
      console.log('Repetition failures:');
      for (const f of repetitionResult.issues) {
        console.log(`  - ${f}`);
      }
      console.log('');
    }

    if (!concisenessResult.passed) {
      console.log('Conciseness failures:');
      for (const f of concisenessResult.issues) {
        console.log(`  - ${f}`);
      }
      console.log('  Responses:');
      for (let i = 0; i < concisenessResult.responses.length; i++) {
        console.log(`    ${i + 1}. "${concisenessResult.responses[i].substring(0, 100)}..."`);
      }
      console.log('');
    }

    if (!ivrDtmfResult.passed) {
      console.log('IVR DTMF navigation failures:');
      for (const f of ivrDtmfResult.failures) {
        console.log(`  - ${f}`);
      }
      console.log('');
    }
  }

  // Save results if output dir specified
  if (config.outputDir) {
    if (!existsSync(config.outputDir)) {
      mkdirSync(config.outputDir, { recursive: true });
    }
    const resultFile = join(config.outputDir, `integration_${Date.now()}.json`);
    writeFileSync(resultFile, JSON.stringify(result, null, 2));
    console.log(`Results saved to: ${resultFile}`);
  }

  return result;
}
