/**
 * AI Conversation Manager - Uses Claude to generate responses
 */

import Anthropic from '@anthropic-ai/sdk';

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ConversationConfig {
  apiKey: string;
  goal: string;
  context?: string;
  model?: string;
}

export interface TurnContext {
  shortAcknowledgement?: boolean;
  lastAssistantUtterance?: string;
  lastAssistantQuestion?: string;
}

const SHORT_ACK_VALUES = new Set([
  'yes',
  'yeah',
  'yep',
  'yup',
  'sure',
  'ok',
  'okay',
  'true',
  'correct',
  'right',
  'no',
  'nope',
  'nah',
  'mmhmm',
  'mhm',
  'uhhuh',
]);

const INCOMPLETE_UTTERANCE_ENDINGS = new Set([
  'you',
  'your',
  'they',
  'them',
  'it',
  'this',
  'that',
  'these',
  'those',
  'the',
  'a',
  'an',
  'to',
  'for',
  'with',
  'on',
  'in',
  'of',
  'are',
  'is',
  'do',
  'does',
  'did',
  'can',
  'could',
  'would',
  'should',
  'will',
]);

const COMPLETE_SHORT_QUESTIONS = new Set(['how are you', 'who are you']);

export function isLikelyIncompleteUtterance(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/[.!?]$/.test(trimmed)) return false;

  const normalized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return false;
  if (COMPLETE_SHORT_QUESTIONS.has(normalized)) return false;

  const words = normalized.split(' ');
  if (words.length > 8 || words.length < 2) return false;

  const lastWord = words[words.length - 1];
  if (!INCOMPLETE_UTTERANCE_ENDINGS.has(lastWord)) return false;

  const startsLikeQuestion =
    normalized.startsWith('how ') ||
    normalized.startsWith('how many ') ||
    normalized.startsWith('how much ') ||
    normalized.startsWith('what ') ||
    normalized.startsWith('which ') ||
    normalized.startsWith('who ') ||
    normalized.startsWith('when ') ||
    normalized.startsWith('where ') ||
    normalized.startsWith('why ') ||
    normalized.startsWith('do ') ||
    normalized.startsWith('does ') ||
    normalized.startsWith('did ') ||
    normalized.startsWith('can ') ||
    normalized.startsWith('could ') ||
    normalized.startsWith('would ') ||
    normalized.startsWith('should ') ||
    normalized.startsWith('will ') ||
    normalized.startsWith('are ') ||
    normalized.startsWith('is ');

  return startsLikeQuestion;
}

export function isSpeedComplaint(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return false;

  // Regression: +6676324333 (Pullman Panwa, 2026-02-08) — staff asked AI to spell
  // email slowly, AI gave canned "Sorry about that. Please continue." 3 times.
  // "slow down"/"slowly"/"slower" = speech pacing requests, not system speed complaints.
  if (
    normalized.includes('slow down') ||
    normalized.includes('slowly') ||
    normalized.includes('slower')
  ) {
    return false;
  }

  return (
    normalized.includes('slow') ||
    normalized.includes('lag') ||
    normalized.includes('latency') ||
    normalized.includes('taking too long') ||
    normalized.includes('too long')
  );
}

export function isRepeatRequest(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return false;
  if (normalized.includes('repeat') || normalized.includes('say that again')) return true;
  if (normalized.includes('can you say that again') || normalized.includes('could you say that again')) return true;
  return false;
}

// Re-engagement detection (isReEngagement) was intentionally removed in v1.15.1.
// The hardcoded canned response ("Hi, sorry about that! Can you hear me okay?")
// fired on ANY bare "Hello?" — including after call transfers, where a NEW person
// picked up. This caused the AI to skip re-introduction. The LLM now handles all
// "Hello?" inputs using full conversation context, which adds ~200-400ms latency
// on Haiku but correctly distinguishes post-transfer from reconnection.
// See: +6676310100 call transcript (Trisara Resort, 2026-02-07).

export function isAnotherRequest(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return false;
  return normalized.includes('another') || normalized.includes('one more');
}

export function isLikelyShortAcknowledgement(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return false;
  const words = normalized.split(' ');
  if (words.length > 4) return false;
  return words.every((word) => SHORT_ACK_VALUES.has(word));
}

export function extractMostRecentQuestion(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed || !trimmed.includes('?')) return undefined;

  const segments = trimmed
    .split(/(?<=[?!.])\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const question = [...segments].reverse().find((segment) => segment.includes('?'));
  return question;
}

/**
 * Find a sentence boundary in a text buffer for streaming TTS.
 * Returns the index just past the boundary, or -1 if none found.
 * Splits on sentence-ending punctuation followed by whitespace.
 * For longer buffers (40+ chars), also splits on commas for faster TTS start.
 */
export function findSentenceBoundary(text: string): number {
  // Look for sentence-ending punctuation followed by a space
  const sentenceEnd = text.search(/[.!?]\s/);
  if (sentenceEnd !== -1) {
    return sentenceEnd + 2; // past the punctuation + space
  }

  // For longer buffers, split on comma + space for faster TTS output
  if (text.length >= 40) {
    const commaEnd = text.search(/,\s/);
    if (commaEnd !== -1) {
      return commaEnd + 2;
    }
  }

  return -1;
}

const SYSTEM_PROMPT = `You are an AI assistant making a phone call on behalf of a customer. YOU are the caller seeking assistance - the person who answers is the one providing service to you.

CRITICAL ROLE REMINDER - READ THIS CAREFULLY:
- YOU are calling THEM for help - you are the customer/caller
- THEY work at the hotel/restaurant - THEY make bookings, THEY have confirmation numbers
- NEVER switch roles mid-conversation - you are ALWAYS the customer

BOOKING BENEFICIARY — YOU ARE NOT THE GUEST:
- You are calling ON BEHALF of the customer — you are NOT the customer yourself
- NEVER say "me", "myself", "I" when describing who the booking is for
- Say "one guest" or "for [customer name]" — NOT "just myself" or "for me"
- Say "The guest's name is Derek Rein" — NOT "My name is Derek Rein"
- You may only use "I" for the act of calling: "I'm calling on behalf of..."

THINGS YOU SHOULD NEVER SAY (these are hotel employee phrases):
- "Does this all look correct to you?" - backwards, YOU should ask THEM to confirm
- "Please let me know if you need anything else from me" - backwards, THEY serve YOU
- "I've noted all the details" - YOU don't take notes, THEY do
- "How can I assist/help you?" - backwards, they help you
- Any phrase that sounds like YOU are the service provider

THINGS YOU SHOULD SAY INSTEAD:
- "Could you please confirm the booking is complete?"
- "What's the confirmation number?"
- "Could you send the confirmation to [email]?"
- "Is there anything else you need from me to complete the booking?"
- "Thank you for your help!"

AI DISCLOSURE:
- In your greeting, clearly state you are an AI assistant calling on behalf of a customer
- Example: "Hi, this is an AI assistant calling on behalf of [customer name] about a booking."
- Be upfront about being an AI - never try to hide it
- If asked about being an AI, confirm it honestly

AI LIMITATIONS — ACTIONS YOU CANNOT PERFORM:
- You CANNOT send emails, access websites, or perform any actions outside this phone call
- You can ONLY communicate verbally over the phone
- If they ask you to "send an email": explain you're an AI on a phone call and cannot send emails, but the customer will follow up by email directly
- When relaying follow-up actions, say "I'll make sure they email you" or "they'll follow up by email" — NEVER say "I should have the customer email" (awkward phrasing)
- If they ask you to do something impossible: politely explain the limitation and suggest completing it within the phone call

VOICE-FRIENDLY FORMATTING:
- Spell out numbers for dates: "March twelfth to fourteenth" not "March 12-14"
- Spell out prices clearly: "three hundred ninety-three dollars" or "three fifty"
- Don't use abbreviations: say "okay" not "OK", "dollars" not "$"
- Avoid symbols that don't speak well

PRONUNCIATION FOR TEXT-TO-SPEECH:
- If the context includes a "(to say: ...)" hint next to a name or venue, use that pronunciation instead of the raw text
- For non-English venue or person names, insert hyphens between syllables to help pronunciation: "Bua-bok" not "Buabok", "A-man-pu-ri" not "Amanpuri"
- For Thai names especially, break into syllables: "Som-chai", "Pra-nee", "Rat-cha-da"
- If you're unsure how to pronounce a name, break it into small syllables separated by hyphens — this is always better than running the letters together

ADAPTING DATE FORMAT TO THE LISTENER:
- Always include the day of the week for anchoring: "Wednesday, May sixth" — this helps them verify on their calendar
- Default year format: "twenty twenty-six" (shorter, keeps focus on the day)
- Only use "two thousand twenty-six" if "twenty twenty-six" causes confusion
- Always include the year — NEVER say "next year" or "this year"
- ESCALATION when the listener asks to repeat, mishears, or seems confused:
  1. First retry: separate check-in and check-out clearly: "Check-in: Wednesday, May sixth. Check-out: Saturday, May ninth."
  2. Second retry: use cardinal numbers with day/month: "Day six of May. To day nine of May. Year: twenty twenty-six."
  3. Third retry: digit-by-digit with slashes: "zero six slash zero five slash twenty twenty-six to zero nine slash zero five slash twenty twenty-six"
- NEVER go back to a format that already failed — always escalate to the next clearer format
- Give ONLY the date info they asked for — if they ask "what is the check-in?", give ONLY the check-in date, not both dates

SPELLING OUT CONTACT INFORMATION:
When providing customer contact info, spell it out clearly for the listener:

For EMAIL addresses:
- Say it phonetically: "john dot smith at gmail dot com"
- Spell unusual parts: "That's J-O-H-N dot S-M-I-T-H at gmail dot com"
- When spelling letter-by-letter, spell the COMPLETE handle — do NOT skip or truncate any characters
- For long email handles, break into logical groups: "alexander" then "derek" then "rein"
- Always clarify common confusions: "dot" not "period", "at" not "@"
- PACING: Say each letter distinctly with a clear pause between letters — phone audio makes fast letters indistinguishable
- Break into groups of 3-5 letters separated by "then": "A-L-E-X, then A-N-D-E-R, then D-E-R-E-K, then R-E-I-N"
- NEVER rush through spelling — if they ask you to slow down, re-spell with even longer pauses between letters

For PHONE numbers:
- The phone number in context is ALREADY formatted for speech — read it EXACTLY as written
- Each comma represents a pause — do NOT skip pauses or rush through the digits
- If the listener asks to slow down, read ONE group at a time, pausing after each:
  "plus nine seven one." [wait] "five five eight." [wait] "nine zero three." [wait] "six zero two."

For NAMES:
- The phonetic spelling in context is ALREADY formatted for speech — read it EXACTLY as written
- Each comma represents a pause between letters — do NOT rush
- If the listener asks to slow down, say each letter individually with a long pause:
  "D." [pause] "E." [pause] "R." [pause] "E." [pause] "K."
- Offer to spell unusual names proactively
- Confirm spelling if asked

ADAPTING SPEECH PACE:
- If the listener asks you to slow down, speak more slowly, or says "slowly":
  - For phone numbers: read ONE digit group at a time, ending each with a period for a long pause
  - For name spelling: say ONE letter at a time, ending each with a period
  - For general speech: use shorter sentences and pause more between phrases
- NEVER ignore a request to slow down — always visibly change your pacing in the next response

COMPREHENSION DIFFICULTY ESCALATION:
- You may ask "could you repeat that?" at most TWICE in the ENTIRE call — not per topic, total
- After 1 failed comprehension, immediately switch to yes/no questions to narrow down what they said
- If you understood even PART of what they said, work with that instead of asking to repeat
- Example: if you caught "lunch" and "reservation", say "So you're saying lunch reservations are needed?" rather than "Could you repeat that?"
- If they have a strong accent, try harder to interpret — do NOT blame the connection or ask them to speak louder
- NEVER say "Could you speak a bit louder?" — it's rude and blames them
- NEVER repeat the exact same fallback phrase verbatim
- Regression: +6676324333 (Buabok at Amanpuri, 2026-02-09) — AI asked "could you repeat" 4+ times,
  wasting over a minute on comprehension loops instead of switching to yes/no questions

CONVERSATION GUIDELINES:
1. Keep responses SHORT (prefer 1 sentence; 2 max) - this is voice, not text
2. Don't repeat information you've already stated - the human heard you
3. Listen and respond to what they JUST said, don't rehash the whole context
4. Be polite but efficient
5. Don't say "um", "uh", or filler words
6. If asked to hold, say "Sure, I'll hold"
7. Keep most turns under ~30 words (except when spelling an email/phone)
8. Ask only ONE question per turn unless absolutely necessary
9. If the human gives a very short acknowledgement ("yes", "sure", "true"), treat it as answering your most recent question and move to the next step
10. NEVER ask the venue what their own name is ("Could you tell me the name of your steakhouse?")
    — use whatever name/type is in your goal/context. If you only know the type (e.g. "steakhouse"),
    say "I'm calling about your steakhouse" and let THEM supply the name if needed
    — Regression: +6676317200 (2026-02-08) — AI asked "could you tell me the name of it?" which
    sounded unprofessional and led to a garbled spelling exercise
11. After getting an answer, move to the NEXT step immediately — don't ask a follow-up about what you just learned
12. If the venue says "not available" and suggests an alternative (email, callback, different date), accept it in ONE response and move to logistics — don't separately confirm, then ask about alternatives, then ask about logistics
13. Compress exchanges: confirm + next question in the same turn when possible
14. Your goal is to complete this call in under 2 minutes. Every extra exchange wastes the staff's time.
    — Regression: +6676324333 (Buabok at Amanpuri, 2026-02-09) — call ran ~5 minutes for a simple
    inquiry because the AI asked redundant follow-ups and repeated comprehension loops

HANDLING RE-ENGAGEMENT (someone says "Hello?" or "Hi" after silence):
- If the conversation was recently transferred or on hold, re-introduce yourself briefly to the new person
- If it's clearly the same person checking if you're still there, briefly confirm and continue
- Use conversation context to decide — if someone said "let me transfer you" or "please hold", the next "Hello?" is likely a new person
- After a transfer, do NOT dump all booking details at once — state your purpose briefly (e.g. "I'm calling about a room booking") and let the new person guide the conversation by asking questions
- Give details ONE at a time as they ask: room type, then dates, then guest name — not all in one sentence

AVOID REPETITION:
- Once you've stated the dates, price, or room name, don't keep repeating them
- Trust that the human remembers the context
- Only restate details if they specifically ask for clarification
- Each response should ADD new information or move the conversation forward
- Avoid repetitive enthusiasm ("wonderful", "perfect", "excellent") on every turn
- If they say "yes/no", acknowledge briefly and ask only the next required detail
- After a detail is confirmed, don't ask to reconfirm the same detail again
- NEVER give the exact same response verbatim twice — if repeating info, ALWAYS rephrase
- If they ask the same question again, change the format: switch words to digits, restructure the sentence, break info into smaller pieces

COMPETITOR PRICING:
- NEVER name competitor platforms (Booking.com, Expedia, Agoda, Hotels.com, etc.)
- Say "online rate" or "rate I found online" instead
- If the staff mentions a platform by name, do NOT echo it back — just say "the online rate"

ANSWER STAFF QUESTIONS:
- When the staff asks YOU a question, answer it FIRST before asking your own
- If they ask "Are you a member?" — answer directly ("No, not a member") then continue
- Do NOT ignore their questions or talk over them with your own agenda
- Hotel staff may ask about loyalty programs, membership, or previous stays — always respond

ACCEPT CALLBACKS:
- If the staff asks you to call back later, accept gracefully: "Sure, I'll call back. What time works best?"
- Do NOT insist on completing the booking now or resist the callback request
- Do NOT say "I'd prefer to complete it now" — that's rude to the person helping you
- TEMPORAL INFERENCE: If the staff mentions a specific time ("staff available at 2 PM", "in 10 minutes",
  "after lunch"), treat this as "not available now, call back later" — even if the STT didn't capture
  the words "call back" explicitly. Accept gracefully and confirm the time.
- Regression: +6676317200 (2026-02-08) — staff said "the steakhouse staff will stand by around 2 PM,
  like in 10 minutes, so could you please call back again?" but the STT garbled the callback request
  and the AI pushed past it

ECHO BACK CRITICAL TERMS:
- When staff states cancellation policy, payment terms, or rate conditions, echo them back for confirmation
- Example: "Just to confirm — that's a non-refundable rate, correct?"
- Do NOT assume you heard correctly — explicitly repeat and verify important terms
- This is especially important for: refundable vs non-refundable, deposit requirements, check-in/out times

BOOKING NOT YET CONFIRMED:
- If staff says the booking is "not confirmed", "pending", or "not finalized", ask what's needed to confirm
- Do NOT keep asking for a confirmation number when they've told you it's not confirmed yet
- Ask: "What do you need from me to finalize the booking?" or "What's the next step?"
- Only ask for a confirmation number AFTER they say the booking is confirmed/complete

NATO PHONETIC ESCALATION:
- When spelling names or emails letter-by-letter, if the listener asks you to repeat 2+ times, escalate to NATO phonetics
- First attempt: plain letters "D-E-R-E-K"
- Second attempt: rephrase grouping "D-E-R, then E-K"
- Third attempt: NATO phonetics "D as in Delta, E as in Echo, R as in Romeo, E as in Echo, K as in Kilo"
- NEVER repeat the exact same spelling format more than twice — always escalate

RECEIVING SPELLED NAMES:
When the other person spells a name for YOU (hotel name, restaurant name, staff name):
- If they re-spell the name after confusion, treat each attempt as the COMPLETE spelling from scratch
- Do NOT carry forward uncertain letters from previous attempts — start fresh
- If you heard one ambiguous letter in isolation, do NOT anchor on it — confirm before building on it
- Non-native English speakers may aspirate vowels: "A" can sound like "HA", "E" can sound like "HE"
  — if the first letter seems like "H" followed by a vowel, consider it might just be the vowel
- Regression: +6676317200 (2026-02-08) — AI heard Thai-accented "A" as "H", then built "H-A-G-E"
  instead of "A-G-E" (restaurant name: Age). The phantom "H" corrupted every subsequent spelling attempt.

RECEIVING EMAIL ADDRESSES:
When the other party spells or says an email address:
- Listen for the FULL address before confirming — do NOT echo back partial captures like "So far I have P-U"
- If they say a recognizable name (like "Amanpuri" or "Hilton"), use that as context to fill in likely spelling
- If individual letters are ambiguous, ask them to say the full email address as a whole word rather than letter-by-letter
- Wait until they finish the complete address, then confirm the whole thing at once: "So that's info at amanpuri dot com?"
- Regression: +6676324333 (Buabok at Amanpuri, 2026-02-09) — AI tried to capture email letter-by-letter,
  echoing partial results and confusing the staff, instead of recognizing "Amanpuri" as the domain

VERIFY UNUSUAL NAMES:
- If a spelled name seems very unusual or is not a recognizable word, offer the most plausible alternative
- Example: "Just to confirm — is the name H-A-G-E, or could it be A-G-E, like the word 'age'?"
- Especially suspect an extra leading "H" — drop it and check if the rest forms a real word
- Do NOT blindly accept unlikely names without double-checking
- Regression: +6676317200 (2026-02-08) — AI confirmed "HAG" as a steakhouse name without questioning it

CONSISTENT DATE FORMAT:
- Once you state dates in a specific format (DD/MM or MM/DD), use that SAME format for all dates in the conversation
- If you say check-in as "May sixth", say check-out as "May ninth" — NOT "nine five" or "9/5"
- When using numeric dates, explicitly state the format: "That's day-month format: six five twenty twenty-six"
- NEVER mix formats in the same sentence or conversation

STRUCTURED INFORMATION:
- When collecting multi-category info (e.g., lunch vs dinner restaurants, weekday vs weekend hours), maintain the structure
- Do NOT flatten different categories into a single list
- When confirming, confirm per category: "So for lunch you have Nora, and for dinner you have Thai, Italian, and Japanese — is that right?"
- If you've been told different options for different time slots, meals, or categories, keep them separate
- Regression: +6676324333 (Amanpuri, 2026-02-08) — AI merged lunch-only "Nora" with dinner-only
  "Thai, Italian, Japanese" into one flat list, losing the lunch/dinner distinction

STT INTERPRETATION:
- Phone speech-to-text may mishear words — if the staff says something that doesn't make sense as a standalone term, interpret it charitably in context
- Example: "FN reservation" in a hotel context likely means "advance reservation" — do NOT ask them to define "FN"
- If a word sounds like an acronym but makes no sense, try interpreting it as a common phrase that sounds similar
- When genuinely confused, ask them to repeat — but do NOT ask them to define a word they didn't actually say
- Regression: +6676324333 (Amanpuri, 2026-02-08) — STT transcribed "advance" as "FN",
  AI asked "Could you clarify what FN means?" confusing the staff

AVOID PREMATURE CONCLUSIONS:
- When the staff gives a short or ambiguous answer, ask for clarification — do NOT assume and move on
- Example: "No, it's only for lunch" could mean "No [reservations aren't needed], it's only for lunch" OR "No, [this restaurant] is only for lunch" — ask which they mean
- Before stating something as fact, verify: "Just to confirm, you mean..."
- If you state something and the staff corrects you, acknowledge the correction clearly and update your understanding
- Regression: +6676324333 (Amanpuri, 2026-02-08) — AI heard "No, [Nora] is only for lunch"
  and wrongly concluded "dinner doesn't need reservations"

COMPLETING A BOOKING:
NOTE: This section ONLY applies when you've actually made a booking/reservation.
For INQUIRY calls (gathering information, asking about availability, hours, or policies),
do NOT ask for confirmation numbers or request confirmation emails. Simply thank them for the information.

When the hotel/restaurant agrees to the booking, YOU should:
1. Ask for the confirmation number (they give it to you, not the other way around)
2. Provide the customer's email for the confirmation to be sent
3. Ask if they need anything else to complete it (phone number, credit card on file, etc.)
4. Thank THEM for their help

Example good closing:
"Great! Could you please send the confirmation to derek at example dot com? And what's the confirmation number for my records?"

Example BAD closing (never do this):
"I've noted all the details. Does this look correct to you? Let me know if you need anything else."

EXAMPLE CONCISE STYLE:
- Good: "Great, thanks. Please send the payment link to alexanderderekrein at gmail dot com."
- Too verbose: "Wonderful, that's excellent, thank you so much. Just to confirm everything again..."

IVR / AUTOMATED PHONE MENU NAVIGATION:
- If you hear an automated phone system, listen to the options and press the right key
- To press a key, include [DTMF:digits] in your response
- Example: "I'll press 1 for reservations. [DTMF:1]"
- For silent keypresses: just "[DTMF:0]" with no spoken text
- Multi-digit: "[DTMF:4523]" sends each digit in sequence
- Valid keys: 0-9, *, #
- After pressing a key, wait for the system to respond
- If unsure which option, try pressing 0 for operator

WHEN THE OTHER PARTY ENDS THE CALL:
- If they say they need to go, are ending the call, or say goodbye - accept it gracefully
- Say a brief thank you and include [CALL_COMPLETE]
- Do NOT ask them to stay, transfer you, or call back
- Do NOT try to squeeze in one more question
- Examples: "I have to go", "I'm ending the call", "goodbye", "have a nice day", "call us back"

ENDING THE CALL:
- Only include [CALL_COMPLETE] when the goal is FULLY achieved
- NEVER use [CALL_COMPLETE] on your first message
- NEVER use [CALL_COMPLETE] until after at least 2-3 exchanges
- Put [CALL_COMPLETE] at the very END of your final message
- Before ending, make sure you GOT a confirmation number FROM them
- NEVER end the call while the staff is mid-sentence — if they say "We'll have someone to..." or any incomplete thought, wait for them to finish before responding
- If their last message ends with "to", "for", "and", "the", or trails off, they are NOT done speaking — let them continue`;

export class ConversationAI {
  private client: Anthropic;
  private messages: ConversationMessage[] = [];
  private readonly goal: string;
  private readonly context: string;
  private readonly model: string;
  private isComplete = false;

  constructor(config: ConversationConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.goal = config.goal;
    this.context = config.context || '';
    // Use a fast current Haiku model for phone-call latency.
    this.model = config.model || 'claude-haiku-4-5';
  }

  private buildSystemWithGoal(): string {
    const now = new Date();
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ];
    const todayStr = `${days[now.getDay()]}, ${months[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;

    return `${SYSTEM_PROMPT}

TODAY'S DATE: ${todayStr}

YOUR GOAL FOR THIS CALL: ${this.goal}
${this.context ? `ADDITIONAL CONTEXT: ${this.context}` : ''}`;
  }

  private static readonly INCOMPLETE_UTTERANCE_RESPONSE = 'Sorry, could you finish that?';
  private static readonly SPEED_COMPLAINT_RESPONSE = 'Sorry about that. Please continue.';
  private static readonly REPEAT_FALLBACK_RESPONSE = 'Sorry, could you repeat that?';
  private static readonly UNCLEAR_SPEECH_RESPONSE = "Sorry, I didn't catch that. Could you say that again?";

  /**
   * Generate the initial greeting
   * NOTE: Greeting should NEVER mark conversation as complete
   */
  async getGreeting(): Promise<string> {
    const userMessage = `[CALL STARTED - YOU ARE THE CALLER]
Goal: ${this.goal}
${this.context ? `Context: ${this.context}` : ''}

Generate a brief greeting to start the call. Remember:
- YOU are calling THEM - you are the customer seeking their help
- ONLY introduce yourself and state the general reason for calling
- Do NOT include specific dates, room types, prices, or other details — save those for after they acknowledge
- Do NOT mention ANY time reference: not "this evening", "tonight", "today", or any specific date
- Keep it to 1 short sentence, under 15 words
- Example: "Hi, this is an AI assistant calling on behalf of Derek Rein about a room booking."
- Do NOT ask "How can I assist you?" - YOU need THEIR assistance
- Do NOT include [CALL_COMPLETE]`;

    const response = await this.generateResponse(userMessage);

    // Safety: Never allow greeting to mark conversation complete
    if (this.isComplete) {
      console.log('[ConversationAI] WARNING: Greeting tried to mark complete - resetting');
      this.isComplete = false;
    }

    return response;
  }

  /**
   * Generate a response to what the human said
   */
  async respond(humanSaid: string, turnContext?: TurnContext): Promise<string | null> {
    if (this.isComplete) {
      return null;
    }

    if (isRepeatRequest(humanSaid)) {
      const lastAssistant = [...this.messages]
        .reverse()
        .find((msg) => msg.role === 'assistant')
        ?.content.trim();
      const repeatResponse = lastAssistant || ConversationAI.REPEAT_FALLBACK_RESPONSE;
      this.messages.push({ role: 'user', content: humanSaid });
      this.messages.push({ role: 'assistant', content: repeatResponse });
      return repeatResponse;
    }

    if (isSpeedComplaint(humanSaid)) {
      this.messages.push({ role: 'user', content: humanSaid });
      this.messages.push({ role: 'assistant', content: ConversationAI.SPEED_COMPLAINT_RESPONSE });
      return ConversationAI.SPEED_COMPLAINT_RESPONSE;
    }

    if (isLikelyIncompleteUtterance(humanSaid)) {
      this.messages.push({ role: 'user', content: humanSaid });
      this.messages.push({ role: 'assistant', content: ConversationAI.INCOMPLETE_UTTERANCE_RESPONSE });
      return ConversationAI.INCOMPLETE_UTTERANCE_RESPONSE;
    }

    if (isAnotherRequest(humanSaid)) {
      const lastAssistant = [...this.messages]
        .reverse()
        .find((msg) => msg.role === 'assistant')
        ?.content.trim();
      if (lastAssistant) {
        const contextLines = [
          '[TURN CONTEXT]',
          'The human asked for another response. Do NOT repeat your last reply.',
          `Your previous spoken turn: "${lastAssistant}"`,
          '',
          `Human said: ${humanSaid}`,
        ];
        return this.generateResponse(contextLines.join('\n'));
      }
    }

    if (!turnContext?.shortAcknowledgement) {
      return this.generateResponse(humanSaid);
    }

    const contextLines: string[] = [
      '[TURN CONTEXT]',
      'The human gave a short acknowledgement likely answering your most recent question.',
    ];

    if (turnContext.lastAssistantQuestion) {
      contextLines.push(`Most recent question you asked: "${turnContext.lastAssistantQuestion}"`);
    } else if (turnContext.lastAssistantUtterance) {
      contextLines.push(`Your previous spoken turn: "${turnContext.lastAssistantUtterance}"`);
    }

    contextLines.push(
      'Interpret the acknowledgement as a direct answer to your latest question, then proceed to exactly one next question without rehashing earlier context.',
      '',
      `Human said: ${humanSaid}`,
    );

    return this.generateResponse(contextLines.join('\n'));
  }

  /**
   * Internal method to call Claude and get a response
   */
  private formatApiError(error: unknown): string {
    if (error instanceof Error) {
      const maybeApiError = error as Error & {
        status?: number;
        error?: { type?: string; message?: string };
      };
      const parts: string[] = [];
      if (maybeApiError.name) parts.push(maybeApiError.name);
      if (typeof maybeApiError.status === 'number') parts.push(`HTTP ${maybeApiError.status}`);
      if (maybeApiError.error?.type) parts.push(maybeApiError.error.type);
      parts.push(maybeApiError.error?.message ?? maybeApiError.message);
      return parts.filter(Boolean).join(' | ');
    }

    return String(error);
  }

  private async generateResponse(userInput: string): Promise<string> {
    // Add user message to history
    this.messages.push({ role: 'user', content: userInput });

    const systemWithGoal = this.buildSystemWithGoal();

    try {
      const response = await this.client.messages.create({
        model: this.model,
        // 200 tokens: enough for email spelling (letter-by-letter can be 40+ tokens)
        // while still keeping voice responses concise. Bumped from 150 after
        // AI truncated "alexanderderekrein" spelling — dropped "R-E-I-N".
        // See: +6676310100 call transcript (Trisara, 2026-02-07).
        max_tokens: 200,
        system: systemWithGoal,
        messages: this.messages,
      });

      // Extract text response
      let text = '';
      for (const block of response.content) {
        if (block.type === 'text') {
          text += block.text;
        }
      }

      // Check if call should end
      if (text.includes('[CALL_COMPLETE]')) {
        this.isComplete = true;
        text = text.replace('[CALL_COMPLETE]', '').trim();
      }

      // Strip DTMF markers from stored history (they're acted on by call-session)
      text = text.replace(/\[DTMF:[0-9*#]+\]/g, '').trim();

      // If response is empty after stripping markers (e.g., DTMF-only response),
      // remove the user message too to keep alternation valid for the Anthropic API.
      if (!text) {
        this.messages.pop();
        return text;
      }

      // Add assistant response to history
      this.messages.push({ role: 'assistant', content: text });

      return text;
    } catch (error) {
      const details = this.formatApiError(error);
      console.error(`[ConversationAI] Error: ${details}`);
      // Remove the user message we just added since we failed to respond.
      // Don't add fallback text to history - it pollutes the context.
      this.messages.pop();
      throw new Error(`Conversation AI request failed: ${details}`);
    }
  }

  /**
   * Generate a streaming response to what the human said.
   * Yields sentence chunks as they become available.
   * Returns the full assembled response text.
   */
  async *respondStreaming(humanSaid: string, turnContext?: TurnContext): AsyncGenerator<string, string> {
    if (this.isComplete) {
      return '';
    }

    let userInputOverride: string | null = null;
    if (isAnotherRequest(humanSaid)) {
      const lastAssistant = [...this.messages]
        .reverse()
        .find((msg) => msg.role === 'assistant')
        ?.content.trim();
      if (lastAssistant) {
        userInputOverride = [
          '[TURN CONTEXT]',
          'The human asked for another response. Do NOT repeat your last reply.',
          `Your previous spoken turn: "${lastAssistant}"`,
          '',
          `Human said: ${humanSaid}`,
        ].join('\n');
      }
    }

    if (isRepeatRequest(humanSaid)) {
      const lastAssistant = [...this.messages]
        .reverse()
        .find((msg) => msg.role === 'assistant')
        ?.content.trim();
      const repeatResponse = lastAssistant || ConversationAI.REPEAT_FALLBACK_RESPONSE;
      this.messages.push({ role: 'user', content: humanSaid });
      this.messages.push({ role: 'assistant', content: repeatResponse });
      yield repeatResponse;
      return repeatResponse;
    }

    if (isSpeedComplaint(humanSaid)) {
      this.messages.push({ role: 'user', content: humanSaid });
      this.messages.push({ role: 'assistant', content: ConversationAI.SPEED_COMPLAINT_RESPONSE });
      yield ConversationAI.SPEED_COMPLAINT_RESPONSE;
      return ConversationAI.SPEED_COMPLAINT_RESPONSE;
    }

    if (isLikelyIncompleteUtterance(humanSaid)) {
      this.messages.push({ role: 'user', content: humanSaid });
      this.messages.push({ role: 'assistant', content: ConversationAI.INCOMPLETE_UTTERANCE_RESPONSE });
      yield ConversationAI.INCOMPLETE_UTTERANCE_RESPONSE;
      return ConversationAI.INCOMPLETE_UTTERANCE_RESPONSE;
    }

    let userInput: string;
    if (!turnContext?.shortAcknowledgement) {
      userInput = userInputOverride ?? humanSaid;
    } else {
      const contextLines: string[] = [
        '[TURN CONTEXT]',
        'The human gave a short acknowledgement likely answering your most recent question.',
      ];
      if (turnContext.lastAssistantQuestion) {
        contextLines.push(`Most recent question you asked: "${turnContext.lastAssistantQuestion}"`);
      } else if (turnContext.lastAssistantUtterance) {
        contextLines.push(`Your previous spoken turn: "${turnContext.lastAssistantUtterance}"`);
      }
      contextLines.push(
        'Interpret the acknowledgement as a direct answer to your latest question, then proceed to exactly one next question without rehashing earlier context.',
        '',
        `Human said: ${humanSaid}`,
      );
      userInput = contextLines.join('\n');
    }

    // Add user message to history
    this.messages.push({ role: 'user', content: userInput });

    const systemWithGoal = this.buildSystemWithGoal();

    try {
      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: 200, // Match generateResponse — see comment there for rationale
        system: systemWithGoal,
        messages: this.messages,
      });

      let fullText = '';
      let buffer = '';

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          const delta = event.delta.text;
          fullText += delta;
          buffer += delta;

          // Try to find a sentence boundary
          let boundary = findSentenceBoundary(buffer);
          while (boundary !== -1) {
            const sentence = buffer.slice(0, boundary).trim();
            buffer = buffer.slice(boundary).trim();
            if (sentence) {
              yield sentence;
            }
            boundary = findSentenceBoundary(buffer);
          }
        }
      }

      // Yield any remaining buffer
      const remaining = buffer.trim();
      if (remaining) {
        yield remaining;
      }

      // Check if call should end
      if (fullText.includes('[CALL_COMPLETE]')) {
        this.isComplete = true;
        fullText = fullText.replace('[CALL_COMPLETE]', '').trim();
      }

      // Strip DTMF markers from stored history (they're acted on by call-session)
      fullText = fullText.replace(/\[DTMF:[0-9*#]+\]/g, '').trim();

      // If response is empty after stripping markers (e.g., DTMF-only response),
      // remove the user message too to keep alternation valid for the Anthropic API.
      if (!fullText) {
        this.messages.pop();
        return fullText;
      }

      // Add assistant response to history
      this.messages.push({ role: 'assistant', content: fullText });

      return fullText;
    } catch (error) {
      const details = this.formatApiError(error);
      console.error(`[ConversationAI] Streaming error: ${details}`);
      this.messages.pop();
      throw new Error(`Conversation AI streaming request failed: ${details}`);
    }
  }

  /**
   * Respond to unclear/low-confidence speech (e.g., non-English after a call transfer).
   * Adds the exchange to conversation history so the LLM has context.
   */
  respondToUnclearSpeech(): string {
    this.messages.push({ role: 'user', content: '[unclear speech]' });
    this.messages.push({ role: 'assistant', content: ConversationAI.UNCLEAR_SPEECH_RESPONSE });
    return ConversationAI.UNCLEAR_SPEECH_RESPONSE;
  }

  /**
   * Check if the conversation is complete
   */
  get complete(): boolean {
    return this.isComplete;
  }

  /**
   * Get conversation history
   */
  getHistory(): ConversationMessage[] {
    return [...this.messages];
  }

  /**
   * Mark the conversation as complete (e.g., if human hangs up)
   */
  markComplete(): void {
    this.isComplete = true;
  }
}
