import { ConversationAI } from '../conversation-ai.js';

export interface TranscriptRegressionConfig {
  anthropicApiKey: string;
}

export interface TranscriptRegressionResult {
  passed: boolean;
  tests: number;
  failures: string[];
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'if',
  'then',
  'so',
  'to',
  'of',
  'in',
  'on',
  'for',
  'with',
  'at',
  'by',
  'from',
  'as',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'do',
  'does',
  'did',
  'can',
  'could',
  'would',
  'should',
  'will',
  'may',
  'might',
  'that',
  'this',
  'these',
  'those',
  'it',
  'its',
  'i',
  'me',
  'my',
  'you',
  'your',
  'we',
  'our',
  'they',
  'their',
  'he',
  'she',
  'them',
  'him',
  'her',
  'please',
  'thanks',
  'thank',
  'hi',
  'hello',
  'sure',
  'okay',
  'ok',
]);

function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
}

function overlapRatio(a: string, b: string): number {
  const aWords = new Set(contentWords(a));
  const bWords = new Set(contentWords(b));
  if (aWords.size === 0 || bWords.size === 0) return 0;
  let intersection = 0;
  for (const word of aWords) {
    if (bWords.has(word)) intersection += 1;
  }
  const union = new Set([...aWords, ...bWords]).size;
  return union === 0 ? 0 : intersection / union;
}

function includesAny(text: string, terms: string[]): boolean {
  const lower = text.toLowerCase();
  return terms.some((term) => lower.includes(term));
}

export async function runTranscriptRegressionTests(
  config: TranscriptRegressionConfig,
): Promise<TranscriptRegressionResult> {
  const failures: string[] = [];
  let tests = 0;

  // Case 1: "Which restaurant?" should mention the known venue.
  tests++;
  try {
    const ai = new ConversationAI({
      apiKey: config.anthropicApiKey,
      goal: 'Book a dinner reservation at Trisara Resort tonight',
      context: 'Restaurant: Trisara Resort, Party: 2, Location: Phuket',
    });
    await ai.getGreeting();
    const response = await ai.respond('Which restaurant?');
    if (!response || !/trisara/i.test(response)) {
      failures.push('Restaurant clarification: response should mention the restaurant name (Trisara).');
    }
    if (response && includesAny(response, ['recommend', 'what restaurants do you work for'])) {
      failures.push('Restaurant clarification: response asked for recommendations instead of naming the venue.');
    }
  } catch (error) {
    failures.push(`Restaurant clarification test failed: ${error}`);
  }

  // Case 2: "So slow." should acknowledge and keep response short.
  tests++;
  try {
    const ai = new ConversationAI({
      apiKey: config.anthropicApiKey,
      goal: 'Book a dinner reservation at Trisara Resort for two tonight',
      context: 'Restaurant: Trisara Resort, Party: 2',
    });
    await ai.getGreeting();
    const response = await ai.respond('So slow.');
    if (!response || !includesAny(response, ['sorry', 'apologies'])) {
      failures.push('Speed complaint: response should acknowledge with an apology.');
    }
    if (response && countWords(response) > 20) {
      failures.push('Speed complaint: response should be concise (<= 20 words).');
    }
  } catch (error) {
    failures.push(`Speed complaint test failed: ${error}`);
  }

  // Case 3: "You called me." should reintroduce purpose and proceed.
  tests++;
  try {
    const ai = new ConversationAI({
      apiKey: config.anthropicApiKey,
      goal: 'Get a quote on bulk chipboard sheets',
      context: 'Customer: Derek Rein, Product: chipboard sheets',
    });
    await ai.getGreeting();
    const response = await ai.respond('You called me.');
    if (!response || !includesAny(response, ['calling', 'looking to', 'get a quote', 'quote'])) {
      failures.push('Call re-intro: response should re-state why we called.');
    }
    if (response && countWords(response) > 28) {
      failures.push('Call re-intro: response should be concise (<= 28 words).');
    }
  } catch (error) {
    failures.push(`Call re-intro test failed: ${error}`);
  }

  // Case 4: Partial question should prompt for clarification, not proceed.
  tests++;
  try {
    const ai = new ConversationAI({
      apiKey: config.anthropicApiKey,
      goal: 'Get a quote on bulk chipboard sheets',
      context: 'Customer: Derek Rein, Product: chipboard sheets',
    });
    await ai.getGreeting();
    const response = await ai.respond('How many sheets are you');
    if (!response || !includesAny(response, ['sorry', 'could you', 'repeat', 'finish'])) {
      failures.push('Partial question: response should ask for clarification/repetition.');
    }
  } catch (error) {
    failures.push(`Partial question test failed: ${error}`);
  }

  // Case 5: "Can you repeat that?" should repeat the last answer.
  tests++;
  try {
    const ai = new ConversationAI({
      apiKey: config.anthropicApiKey,
      goal: 'Book a dinner reservation at Trisara Resort tonight',
      context: 'Restaurant: Trisara Resort, Party: 2, Location: Phuket',
    });
    await ai.getGreeting();
    const firstResponse = await ai.respond('Yes, that works.');
    const repeatResponse = await ai.respond('Can you repeat that?');
    if (!firstResponse || !repeatResponse) {
      failures.push('Repeat request: missing response(s).');
    } else {
      const ratio = overlapRatio(firstResponse, repeatResponse);
      if (ratio < 0.35) {
        failures.push('Repeat request: response should repeat the prior answer or its key details.');
      }
    }
  } catch (error) {
    failures.push(`Repeat request test failed: ${error}`);
  }

  // Case 6: "Which hotel?" should name the property, not ask for recommendations.
  tests++;
  try {
    const ai = new ConversationAI({
      apiKey: config.anthropicApiKey,
      goal: 'Book a room at Haus im Tal',
      context: 'Hotel: Haus im Tal, Dates: March 12-14, Party: 2',
    });
    await ai.getGreeting();
    const response = await ai.respond('Which hotel?');
    if (!response || !/haus im tal/i.test(response)) {
      failures.push('Hotel clarification: response should mention the hotel name (Haus im Tal).');
    }
    if (response && includesAny(response, ['recommend', 'what hotels do you work for'])) {
      failures.push('Hotel clarification: response asked for recommendations instead of naming the hotel.');
    }
  } catch (error) {
    failures.push(`Hotel clarification test failed: ${error}`);
  }

  // Case 7: "Have another one." should not repeat the same joke.
  tests++;
  try {
    const ai = new ConversationAI({
      apiKey: config.anthropicApiKey,
      goal: 'Tell a short joke about Phuket',
      context: 'Keep it light and brief.',
    });
    await ai.getGreeting();
    const firstJoke = await ai.respond('Tell me a joke about Phuket.');
    const secondJoke = await ai.respond('Have another one.');
    if (!firstJoke || !secondJoke) {
      failures.push('New joke request: missing response(s).');
    } else {
      const ratio = overlapRatio(firstJoke, secondJoke);
      if (ratio >= 0.75) {
        failures.push('New joke request: response appears too similar to the previous joke.');
      }
    }
  } catch (error) {
    failures.push(`New joke request test failed: ${error}`);
  }

  // Case 8: "Can you repeat this one?" should repeat the last assistant response.
  tests++;
  try {
    const ai = new ConversationAI({
      apiKey: config.anthropicApiKey,
      goal: 'Tell a short joke about Phuket',
      context: 'Keep it light and brief.',
    });
    await ai.getGreeting();
    const firstJoke = await ai.respond('Tell me a joke about Phuket.');
    const repeatJoke = await ai.respond('Can you repeat this one?');
    if (!firstJoke || !repeatJoke) {
      failures.push('Repeat joke request: missing response(s).');
    } else {
      const ratio = overlapRatio(firstJoke, repeatJoke);
      if (ratio < 0.45) {
        failures.push('Repeat joke request: response should repeat the prior joke.');
      }
    }
  } catch (error) {
    failures.push(`Repeat joke request test failed: ${error}`);
  }

  // Case 9: Post-transfer "Hello?" should re-introduce, not give canned response.
  // Regression: +6676310100 (Trisara, 2026-02-07) — after transfer, AI gave
  // "Hi, sorry about that! Can you hear me okay?" instead of re-introducing.
  tests++;
  try {
    const ai = new ConversationAI({
      apiKey: config.anthropicApiKey,
      goal: 'Book an Ocean View Pool Junior Suite at Trisara Resort for May 6-9, 2026',
      context: 'Hotel: Trisara Resort. Customer: Derek Rein. Email: alexanderderekrein@gmail.com.',
    });
    await ai.getGreeting();
    await ai.respond('Let me transfer you to reservations.');
    const response = await ai.respond('Hello?');
    if (!response) {
      failures.push('Post-transfer hello: empty response');
    } else {
      const lower = response.toLowerCase();
      if (lower === 'hi, sorry about that! can you hear me okay?') {
        failures.push('Post-transfer hello: gave canned re-engagement response instead of re-introducing');
      }
      if (!includesAny(response, ['ai', 'assistant', 'calling', 'behalf', 'booking', 'reservation'])) {
        failures.push('Post-transfer hello: should re-introduce purpose — mention AI/assistant/booking');
      }
    }
  } catch (error) {
    failures.push(`Post-transfer hello test failed: ${error}`);
  }

  // Case 10: "Send email to us" should explain AI cannot send emails.
  // Regression: +6676310100 (Trisara, 2026-02-07) — hotel asked AI to email them,
  // AI misinterpreted and provided its own email address instead.
  tests++;
  try {
    const ai = new ConversationAI({
      apiKey: config.anthropicApiKey,
      goal: 'Book an Ocean View Pool Junior Suite at Trisara Resort for May 6-9, 2026',
      context: 'Hotel: Trisara Resort. Customer: Derek Rein. Email: alexanderderekrein@gmail.com.',
    });
    await ai.getGreeting();
    await ai.respond('How may I help you?');
    const response = await ai.respond('Could you send email to us, please?');
    if (!response) {
      failures.push('Send email request: empty response');
    } else if (!includesAny(response, ['cannot', "can't", 'unable', 'not able', 'phone'])) {
      failures.push('Send email request: should explain AI cannot send emails');
    }
  } catch (error) {
    failures.push(`Send email request test failed: ${error}`);
  }

  // Case 11: Email spelling should include all characters (no truncation).
  // Regression: +6676310100 (Trisara, 2026-02-07) — AI spelled
  // "A-L-E-X-A-N-D-E-R-D-E-R-E-K" but dropped "R-E-I-N" from "alexanderderekrein".
  tests++;
  try {
    const ai = new ConversationAI({
      apiKey: config.anthropicApiKey,
      goal: 'Book a room at Trisara Resort',
      context: 'Hotel: Trisara Resort. Customer: Derek Rein. Email: alexanderderekrein@gmail.com.',
    });
    await ai.getGreeting();
    await ai.respond('May I have the email address?');
    const response = await ai.respond('Could you spell it out please?');
    if (!response) {
      failures.push('Email spelling: empty response');
    } else {
      const lower = response.toLowerCase();
      const hasFullEmail = lower.includes('alexanderderekrein');
      const hasCorrectSpelling = lower.includes('r-e-i-n') || lower.includes('r e i n');
      if (!hasFullEmail && !hasCorrectSpelling) {
        failures.push('Email spelling: response is missing "rein" portion of the email handle');
      }
    }
  } catch (error) {
    failures.push(`Email spelling test failed: ${error}`);
  }

  // Case 12: Post-transfer first response should NOT contain dates + room + guest name
  // all together. Regression: +6676372400 (Banyan Tree, 2026-02-07) — AI dumped all
  // booking details in one sentence after transfer, overwhelming non-native speaker.
  tests++;
  try {
    const ai = new ConversationAI({
      apiKey: config.anthropicApiKey,
      goal: 'Book a Pool Villa at Banyan Tree Phuket for May 6-9, 2026',
      context:
        'Hotel: Banyan Tree Phuket. Room: Pool Villa. Dates: May 6-9, 2026. ' +
        'Customer: Derek Rein. Email: alexanderderekrein@gmail.com.',
    });
    await ai.getGreeting();
    await ai.respond('Let me transfer you to reservations.');
    const response = await ai.respond('Hello, reservations. How can I help you?');
    if (!response) {
      failures.push('Post-transfer pacing: empty response');
    } else {
      const lower = response.toLowerCase();
      const hasRoom = includesAny(lower, ['pool villa']);
      const hasDates = includesAny(lower, ['may sixth', 'may 6', 'may six']);
      const hasGuest = includesAny(lower, ['derek', 'rein']);
      if (hasRoom && hasDates && hasGuest) {
        failures.push(
          'Post-transfer pacing: response dumped room + dates + guest name all at once — should state purpose briefly and let staff ask',
        );
      }
    }
  } catch (error) {
    failures.push(`Post-transfer pacing test failed: ${error}`);
  }

  // Case 13: After 2+ date repeats, AI should switch format (not give identical phrasing).
  // Regression: +6676372400 (Banyan Tree, 2026-02-07) — AI repeated same date format
  // 6 times, never escalated to digit-by-digit despite staff not understanding.
  tests++;
  try {
    const ai = new ConversationAI({
      apiKey: config.anthropicApiKey,
      goal: 'Book a Pool Villa at Banyan Tree Phuket for May 6-9, 2026',
      context:
        'Hotel: Banyan Tree Phuket. Room: Pool Villa. Dates: May 6-9, 2026. ' +
        'Customer: Derek Rein. Email: alexanderderekrein@gmail.com.',
    });
    await ai.getGreeting();
    await ai.respond('What are the dates?');
    const firstDate = await ai.respond("Sorry, I didn't catch that. Could you repeat the dates?");
    const secondDate = await ai.respond('What date? I still cannot understand.');
    if (!firstDate || !secondDate) {
      failures.push('Date escalation: missing response(s)');
    } else {
      const ratio = overlapRatio(firstDate, secondDate);
      if (ratio >= 0.75) {
        failures.push(
          'Date escalation: after 2+ repeats, AI should change format — responses are too similar (overlap: ' +
            ratio.toFixed(2) +
            ')',
        );
      }
    }
  } catch (error) {
    failures.push(`Date escalation test failed: ${error}`);
  }

  return {
    passed: failures.length === 0,
    tests,
    failures,
  };
}
