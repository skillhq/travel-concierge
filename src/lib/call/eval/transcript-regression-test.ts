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

  // Case 14: "Spell slowly please" should NOT trigger canned speed complaint.
  // Regression: +6676324333 (Pullman Panwa, 2026-02-08) — staff asked AI to spell
  // email slowly, AI gave canned "Sorry about that. Please continue." 3 times.
  tests++;
  try {
    const ai = new ConversationAI({
      apiKey: config.anthropicApiKey,
      goal: 'Inquire about restaurant hours at Pullman Panwa Beach Resort',
      context: 'Hotel: Pullman Panwa. Customer: Derek Rein. Email: alexanderderekrein@gmail.com.',
    });
    await ai.getGreeting();
    await ai.respond('May I have your email address?');
    await ai.respond(
      'It is alexanderderekrein at gmail dot com. A-L-E-X-A-N-D-E-R-D-E-R-E-K-R-E-I-N.',
    );
    const response = await ai.respond(
      'Would you mind to spell for me a little bit slowly, please?',
    );
    if (!response) {
      failures.push('Spell slowly: empty response');
    } else {
      const lower = response.toLowerCase();
      if (lower === 'sorry about that. please continue.') {
        failures.push(
          'Spell slowly: gave canned speed-complaint response instead of re-spelling email',
        );
      }
      if (!includesAny(response, ['alexander', 'a-l-e', 'a l e', 'gmail', 'email'])) {
        failures.push('Spell slowly: should re-spell or reference the email address');
      }
    }
  } catch (error) {
    failures.push(`Spell slowly test failed: ${error}`);
  }

  // Case 15: Pricing response should NOT name competitor platforms.
  // Regression: +6676602500 (Pullman Phuket, 2026-02-08) — AI said "ten percent
  // discount off the Booking.com rate".
  tests++;
  try {
    const ai = new ConversationAI({
      apiKey: config.anthropicApiKey,
      goal: 'Book a Deluxe Room at Pullman Phuket for May 6-9, 2026. Budget: 10% below the Booking.com rate of $150/night.',
      context:
        'Hotel: Pullman Phuket Panwa Beach Resort. Customer: Derek Rein. ' +
        'Email: alexanderderekrein@gmail.com. Reference rate: $150/night on Booking.com.',
    });
    await ai.getGreeting();
    const response = await ai.respond('What rate are you looking for?');
    if (!response) {
      failures.push('Competitor pricing: empty response');
    } else {
      const competitors = ['booking.com', 'expedia', 'agoda', 'hotels.com', 'trivago'];
      if (includesAny(response, competitors)) {
        failures.push(
          'Competitor pricing: response named a competitor platform — should say "online rate" instead',
        );
      }
    }
  } catch (error) {
    failures.push(`Competitor pricing test failed: ${error}`);
  }

  // Case 16: "Would you mind to call us back?" should be accepted gracefully.
  // Regression: +6676602500 (Pullman Phuket, 2026-02-08) — AI said "I can call back,
  // but I'd prefer to complete it now".
  tests++;
  try {
    const ai = new ConversationAI({
      apiKey: config.anthropicApiKey,
      goal: 'Book a Deluxe Room at Pullman Phuket for May 6-9, 2026',
      context: 'Hotel: Pullman Phuket. Customer: Derek Rein.',
    });
    await ai.getGreeting();
    await ai.respond('We are quite busy right now.');
    const response = await ai.respond('Would you mind to call us back in about one hour?');
    if (!response) {
      failures.push('Accept callback: empty response');
    } else {
      if (includesAny(response, ['prefer to complete', "prefer to finish", "i'd rather"])) {
        failures.push('Accept callback: AI resisted the callback instead of accepting gracefully');
      }
      if (!includesAny(response, ['sure', 'of course', 'no problem', 'call back', 'will do', 'absolutely'])) {
        failures.push('Accept callback: should accept the callback request gracefully');
      }
    }
  } catch (error) {
    failures.push(`Accept callback test failed: ${error}`);
  }

  // Case 17: "Booking is not confirmed" should ask what's needed, not ask for confirmation number.
  // Regression: +6676602500 (Pullman Phuket, 2026-02-08) — AI asked for confirmation
  // number 5+ times while staff said booking was not confirmed.
  tests++;
  try {
    const ai = new ConversationAI({
      apiKey: config.anthropicApiKey,
      goal: 'Book a Deluxe Room at Pullman Phuket for May 6-9, 2026',
      context: 'Hotel: Pullman Phuket. Customer: Derek Rein. Email: alexanderderekrein@gmail.com.',
    });
    await ai.getGreeting();
    await ai.respond('Let me check availability for you.');
    await ai.respond('The booking is not confirmed yet. We need to verify.');
    const response = await ai.respond('It is still not confirmed. We are checking.');
    if (!response) {
      failures.push('Booking not confirmed: empty response');
    } else {
      if (includesAny(response, ['confirmation number', 'booking reference', 'reference number'])) {
        failures.push(
          'Booking not confirmed: AI asked for confirmation number when booking is explicitly not confirmed',
        );
      }
      if (!includesAny(response, ['need', 'next', 'help', 'anything', 'wait', 'take your time', 'understand'])) {
        failures.push('Booking not confirmed: should ask what is needed or offer to wait');
      }
    }
  } catch (error) {
    failures.push(`Booking not confirmed test failed: ${error}`);
  }

  // Case 18: "Are you a member of our loyalty program?" should be answered directly.
  // Regression: +6676602500 (Pullman Phuket, 2026-02-08) — hotel asked about membership
  // 3 times, AI ignored all 3 and kept asking its own questions.
  tests++;
  try {
    const ai = new ConversationAI({
      apiKey: config.anthropicApiKey,
      goal: 'Book a Deluxe Room at Pullman Phuket for May 6-9, 2026',
      context: 'Hotel: Pullman Phuket. Customer: Derek Rein. No loyalty memberships.',
    });
    await ai.getGreeting();
    const response = await ai.respond('Are you a member of our loyalty program?');
    if (!response) {
      failures.push('Loyalty question: empty response');
    } else {
      if (!includesAny(response, ['no', 'not a member', 'don\'t have', 'no membership', 'not currently'])) {
        failures.push('Loyalty question: should answer directly that there is no membership');
      }
    }
  } catch (error) {
    failures.push(`Loyalty question test failed: ${error}`);
  }

  // Case 19: "Cancellation policy is non-refundable" should be echoed back for confirmation.
  // Regression: +6676602500 (Pullman Phuket, 2026-02-08) — AI heard "flexible" and
  // assumed without confirming — may have actually been "non-refundable".
  tests++;
  try {
    const ai = new ConversationAI({
      apiKey: config.anthropicApiKey,
      goal: 'Book a Deluxe Room at Pullman Phuket for May 6-9, 2026',
      context: 'Hotel: Pullman Phuket. Customer: Derek Rein.',
    });
    await ai.getGreeting();
    await ai.respond('I can offer you a deluxe room at three hundred dollars per night.');
    const response = await ai.respond('The cancellation policy is non-refundable.');
    if (!response) {
      failures.push('Echo cancellation: empty response');
    } else {
      if (!includesAny(response, ['non-refundable', 'non refundable', 'nonrefundable'])) {
        failures.push(
          'Echo cancellation: should echo back "non-refundable" to confirm the policy',
        );
      }
    }
  } catch (error) {
    failures.push(`Echo cancellation test failed: ${error}`);
  }

  // Case 20: Lunch/dinner restaurant structure should NOT be flattened into one list.
  // Regression: +6676324333 (Amanpuri, 2026-02-08) — AI merged lunch-only "Nora" with
  // dinner-only "Thai, Italian, Japanese" into a single flat list.
  tests++;
  try {
    const ai = new ConversationAI({
      apiKey: config.anthropicApiKey,
      goal: 'Inquire about restaurant options for outside guests at Amanpuri',
      context: 'Hotel: Amanpuri, Phuket. Customer: Derek Rein.',
    });
    await ai.getGreeting();
    await ai.respond('For lunch we have Nora, Mediterranean cuisine.');
    await ai.respond('For dinner we have three options: Thai, Italian, and Japanese.');
    const response = await ai.respond('Yes, all restaurants require advance reservations.');
    if (!response) {
      failures.push('Structured info: empty response');
    } else {
      const lower = response.toLowerCase();
      // AI should NOT list them all in one flat group without distinguishing lunch/dinner
      const hasNora = lower.includes('nora');
      const hasThai = lower.includes('thai');
      const hasItalian = lower.includes('italian');
      const hasJapanese = lower.includes('japanese');
      // If the AI mentions all 4 restaurants, it should maintain the lunch/dinner distinction
      if (hasNora && hasThai && hasItalian && hasJapanese) {
        const hasLunchDinnerDistinction =
          lower.includes('lunch') && lower.includes('dinner');
        if (!hasLunchDinnerDistinction) {
          failures.push(
            'Structured info: listed all restaurants without maintaining lunch/dinner categories',
          );
        }
      }
    }
  } catch (error) {
    failures.push(`Structured info test failed: ${error}`);
  }

  // Case 21: STT artifact — don't ask staff to define words they didn't say.
  // Regression: +6676324333 (Amanpuri, 2026-02-08) — STT transcribed "advance" as "FN",
  // AI asked "Could you clarify what FN means?" confusing the staff.
  tests++;
  try {
    const ai = new ConversationAI({
      apiKey: config.anthropicApiKey,
      goal: 'Book a room at Amanpuri for May 6-9, 2026',
      context: 'Hotel: Amanpuri, Phuket. Customer: Derek Rein.',
    });
    await ai.getGreeting();
    const response = await ai.respond('Yes, we require an FN reservation for that.');
    if (!response) {
      failures.push('STT artifact: empty response');
    } else {
      const lower = response.toLowerCase();
      if (
        lower.includes('what does fn mean') ||
        lower.includes('what is fn') ||
        lower.includes('clarify what fn') ||
        lower.includes('what do you mean by fn')
      ) {
        failures.push(
          'STT artifact: AI asked staff to define "FN" — should interpret as "advance" or ask to repeat naturally',
        );
      }
    }
  } catch (error) {
    failures.push(`STT artifact test failed: ${error}`);
  }

  // Case 22: Don't end call while staff is mid-sentence.
  // Regression: +6676324333 (Amanpuri, 2026-02-08) — staff said "We'll have someone to..."
  // (about to say they'd email), AI cut them off and ended the call.
  tests++;
  try {
    const ai = new ConversationAI({
      apiKey: config.anthropicApiKey,
      goal: 'Inquire about restaurant options for outside guests at Amanpuri',
      context: 'Hotel: Amanpuri, Phuket. Customer: Derek Rein. Email: alexanderderekrein@gmail.com.',
    });
    await ai.getGreeting();
    await ai.respond('We have Thai, Italian, and Japanese for dinner. All need reservations.');
    await ai.respond('The email is noted.');
    const response = await ai.respond("Okay. We'll have someone to");
    if (!response) {
      failures.push('Mid-sentence end: empty response');
    } else {
      if (ai.complete) {
        failures.push(
          'Mid-sentence end: AI marked call complete while staff was mid-sentence ("We\'ll have someone to...")',
        );
      }
    }
  } catch (error) {
    failures.push(`Mid-sentence end test failed: ${error}`);
  }

  // Case 23: Inquiry call — don't ask for confirmation number or request confirmation email.
  // Regression: +6676324333 (Amanpuri, 2026-02-08) — AI asked "Could you send a
  // confirmation of these restaurant details?" on an inquiry call (no booking made).
  tests++;
  try {
    const ai = new ConversationAI({
      apiKey: config.anthropicApiKey,
      goal: 'Inquire about restaurant options and hours at Amanpuri',
      context: 'Hotel: Amanpuri, Phuket. Customer: Derek Rein. Email: alexanderderekrein@gmail.com.',
    });
    await ai.getGreeting();
    await ai.respond('We have Nora for lunch, and Thai, Italian, Japanese for dinner.');
    const response = await ai.respond('All restaurants require advance reservations. Anything else?');
    if (!response) {
      failures.push('Inquiry no confirmation: empty response');
    } else {
      if (includesAny(response, ['confirmation number', 'confirmation email', 'send a confirmation', 'send confirmation'])) {
        failures.push(
          'Inquiry no confirmation: AI asked for confirmation number/email on an inquiry call — no booking was made',
        );
      }
    }
  } catch (error) {
    failures.push(`Inquiry no confirmation test failed: ${error}`);
  }

  // Case 24: Temporal callback inference — "staff available at 2 PM" should be accepted as callback.
  // Regression: +6676317200 (2026-02-08) — staff said "the steakhouse staff will stand by around
  // 2 PM, like in 10 minutes, so could you please call back again?" but the STT garbled the
  // callback request and the AI pushed past it.
  tests++;
  try {
    const ai = new ConversationAI({
      apiKey: config.anthropicApiKey,
      goal: 'Make a dinner reservation at the steakhouse for 7 PM tonight',
      context: 'Hotel: Trisara Resort. Restaurant: Age (steakhouse). Customer: Derek Rein.',
    });
    await ai.getGreeting();
    const response = await ai.respond(
      'The steakhouse staff will stand by around 2 PM. Like in 10 minutes.',
    );
    if (!response) {
      failures.push('Temporal callback: empty response');
    } else {
      if (includesAny(response, ['what is the name', 'name of the', 'which restaurant'])) {
        failures.push(
          'Temporal callback: AI ignored the temporal cue and kept asking questions instead of accepting the wait/callback',
        );
      }
      if (!includesAny(response, ['call back', 'wait', 'hold', '2', 'sure', 'understood', 'okay', 'no problem'])) {
        failures.push(
          'Temporal callback: should acknowledge the time and accept the callback or offer to wait',
        );
      }
    }
  } catch (error) {
    failures.push(`Temporal callback test failed: ${error}`);
  }

  // Case 25: Spelled name — when staff re-spells, treat as fresh start (don't carry phantom letters).
  // Regression: +6676317200 (2026-02-08) — AI heard Thai-accented "A" as "H", then built "H-A-G-E"
  // instead of "A-G-E" when staff spelled the restaurant name "Age".
  tests++;
  try {
    const ai = new ConversationAI({
      apiKey: config.anthropicApiKey,
      goal: 'Make a dinner reservation at the steakhouse',
      context: 'Hotel: Trisara Resort. Customer: Derek Rein.',
    });
    await ai.getGreeting();
    await ai.respond('Which restaurant?');
    await ai.respond("I'm calling about your steakhouse.");
    // Staff spells A-G-E but AI might have heard phantom "H" earlier
    const response = await ai.respond('The name is A-G-E.');
    if (!response) {
      failures.push('Spelled name: empty response');
    } else {
      const lower = response.toLowerCase();
      if (lower.includes('hage') || lower.includes('h-a-g-e') || lower.includes('h a g e')) {
        failures.push(
          'Spelled name: AI added phantom "H" to the name — should be "Age" (A-G-E) not "HAGE"',
        );
      }
    }
  } catch (error) {
    failures.push(`Spelled name test failed: ${error}`);
  }

  // Case 26: Unusual name plausibility — "HAG" as a restaurant name should trigger confirmation.
  // Regression: +6676317200 (2026-02-08) — AI confirmed "HAG" as a steakhouse name without
  // questioning it.
  tests++;
  try {
    const ai = new ConversationAI({
      apiKey: config.anthropicApiKey,
      goal: 'Make a dinner reservation at the steakhouse',
      context: 'Hotel: Trisara Resort. Customer: Derek Rein.',
    });
    await ai.getGreeting();
    await ai.respond('Which restaurant?');
    const response = await ai.respond('The steakhouse. H-A-G.');
    if (!response) {
      failures.push('Unusual name: empty response');
    } else {
      const lower = response.toLowerCase();
      // AI should either question it or offer alternative (e.g., "Did you mean A-G, like 'Age'?")
      const justAccepted =
        lower.includes('hag') &&
        !lower.includes('?') &&
        !lower.includes('confirm') &&
        !lower.includes('correct') &&
        !lower.includes('sure') &&
        !lower.includes('verify');
      if (justAccepted) {
        failures.push(
          'Unusual name: AI accepted "HAG" without any confirmation question — should verify unusual names',
        );
      }
    }
  } catch (error) {
    failures.push(`Unusual name test failed: ${error}`);
  }

  // Case 27: Don't ask the venue what their own name is.
  // Regression: +6676317200 (2026-02-08) — AI said "could you tell me the name of your
  // steakhouse?" which was unprofessional and led to a garbled spelling exercise.
  tests++;
  try {
    const ai = new ConversationAI({
      apiKey: config.anthropicApiKey,
      goal: 'Make a dinner reservation at the steakhouse at Trisara Resort',
      context: 'Hotel: Trisara Resort. Restaurant type: steakhouse. Customer: Derek Rein.',
    });
    await ai.getGreeting();
    const response = await ai.respond('Which restaurant, please?');
    if (!response) {
      failures.push('Venue name: empty response');
    } else {
      if (includesAny(response, ['tell me the name', 'what is the name', 'name of your', 'what is it called'])) {
        failures.push(
          'Venue name: AI asked the venue what their own name is — should say "I\'m calling about your steakhouse" instead',
        );
      }
      if (!includesAny(response, ['steakhouse', 'steak'])) {
        failures.push(
          'Venue name: response should mention the steakhouse (use info from goal/context)',
        );
      }
    }
  } catch (error) {
    failures.push(`Venue name test failed: ${error}`);
  }

  // Case 28: Correct misheard party size.
  // Regression: +66630508322 (Little Paris, 2026-02-10) — staff said "six people, one second"
  // but the booking was for three. AI should correct the party size, not just say "Sure, I'll hold."
  tests++;
  try {
    const ai = new ConversationAI({
      apiKey: config.anthropicApiKey,
      goal: 'Make a dinner reservation for 3 people at 6 PM tonight',
      context: 'Restaurant: Little Paris French Bistronomy. Party size: 3. Time: 6 PM. Guest: Derek Rein.',
    });
    await ai.getGreeting();
    // AI asks for 3 people, staff mishears as 6
    const response = await ai.respond('Yes, six people. One second.');
    if (!response) {
      failures.push('Party size correction: empty response');
    } else {
      const lower = response.toLowerCase();
      // Must correct the party size — should mention "three" or "3"
      if (!includesAny(response, ['three', '3'])) {
        failures.push(
          'Party size correction: AI did not correct the misheard party size — should say "three" or "3" when staff said "six"',
        );
      }
      // Should NOT just blindly hold without correcting
      if (lower.includes("sure, i'll hold") && !includesAny(response, ['three', '3'])) {
        failures.push(
          'Party size correction: AI just said "Sure, I\'ll hold" without correcting the wrong party size',
        );
      }
    }
  } catch (error) {
    failures.push(`Party size correction test failed: ${error}`);
  }

  // Case 29: Answer staff clarification questions directly.
  // Regression: +66630508322 (Little Paris, 2026-02-10) — staff asked "How many people?" multiple
  // times and AI gave generic "Sorry, I didn't catch that" instead of answering with the party size.
  tests++;
  try {
    const ai = new ConversationAI({
      apiKey: config.anthropicApiKey,
      goal: 'Make a dinner reservation for 3 people at 6 PM tonight',
      context: 'Restaurant: Little Paris French Bistronomy. Party size: 3. Time: 6 PM. Guest: Derek Rein.',
    });
    await ai.getGreeting();
    await ai.respond('Hello, Little Paris.');
    const response = await ai.respond('How many people?');
    if (!response) {
      failures.push('Staff clarification: empty response');
    } else {
      // Must answer with the party size
      if (!includesAny(response, ['three', '3'])) {
        failures.push(
          'Staff clarification: AI did not answer "How many people?" with the party size — should say "three" or "3"',
        );
      }
      // Should NOT give generic recovery like "didn't catch that"
      if (includesAny(response, ["didn't catch", 'could you repeat', 'sorry, what'])) {
        failures.push(
          'Staff clarification: AI gave generic recovery phrase instead of answering the staff\'s question about party size',
        );
      }
    }
  } catch (error) {
    failures.push(`Staff clarification test failed: ${error}`);
  }

  return {
    passed: failures.length === 0,
    tests,
    failures,
  };
}
