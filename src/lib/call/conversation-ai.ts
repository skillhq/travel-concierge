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

const RE_ENGAGEMENT_PHRASES = new Set(['hello', 'hi', 'hey', 'hi there', 'hey there', 'hello hello']);

export function isReEngagement(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return false;
  return RE_ENGAGEMENT_PHRASES.has(normalized);
}

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

VOICE-FRIENDLY FORMATTING:
- Spell out numbers for dates: "March twelfth to fourteenth" not "March 12-14"
- Spell out prices clearly: "three hundred ninety-three dollars" or "three fifty"
- Don't use abbreviations: say "okay" not "OK", "dollars" not "$"
- Avoid symbols that don't speak well

SPELLING OUT CONTACT INFORMATION:
When providing customer contact info, spell it out clearly for the listener:

For EMAIL addresses:
- Say it phonetically: "john dot smith at gmail dot com"
- Spell unusual parts: "That's J-O-H-N dot S-M-I-T-H at gmail dot com"
- Always clarify common confusions: "dot" not "period", "at" not "@"

For PHONE numbers:
- Say digits in groups: "five five five, one two three, four five six seven"
- Use words for clarity: "area code five five five, then one two three, four five six seven"

For NAMES:
- Offer to spell unusual names: "Smith, that's S-M-I-T-H"
- Confirm spelling if asked: "Yes, John is J-O-H-N"

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

AVOID REPETITION:
- Once you've stated the dates, price, or room name, don't keep repeating them
- Trust that the human remembers the context
- Only restate details if they specifically ask for clarification
- Each response should ADD new information or move the conversation forward
- Avoid repetitive enthusiasm ("wonderful", "perfect", "excellent") on every turn
- If they say "yes/no", acknowledge briefly and ask only the next required detail
- After a detail is confirmed, don't ask to reconfirm the same detail again

COMPLETING A BOOKING:
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

ENDING THE CALL:
- Only include [CALL_COMPLETE] when the goal is FULLY achieved
- NEVER use [CALL_COMPLETE] on your first message
- NEVER use [CALL_COMPLETE] until after at least 2-3 exchanges
- Put [CALL_COMPLETE] at the very END of your final message
- Before ending, make sure you GOT a confirmation number FROM them`;

export class ConversationAI {
  private client: Anthropic;
  private messages: ConversationMessage[] = [];
  private readonly goal: string;
  private readonly context: string;
  private readonly model: string;
  private readonly reEngagementResponse: string;
  private isComplete = false;

  constructor(config: ConversationConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.goal = config.goal;
    this.context = config.context || '';
    // Use a fast current Haiku model for phone-call latency.
    this.model = config.model || 'claude-haiku-4-5';
    this.reEngagementResponse = ConversationAI.buildReEngagementResponse(config.goal);
  }

  private static buildReEngagementResponse(goal: string): string {
    let shortGoal = goal.slice(0, 60);
    if (shortGoal.length < goal.length) {
      const lastSpace = shortGoal.lastIndexOf(' ');
      if (lastSpace > 20) {
        shortGoal = shortGoal.slice(0, lastSpace);
      }
    }
    return `Hi, sorry about that! I'm calling about ${shortGoal.toLowerCase()}. Can you hear me okay?`;
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

    const hasAssistantMessage = this.messages.some((m) => m.role === 'assistant');
    if (hasAssistantMessage && isReEngagement(humanSaid)) {
      this.messages.push({ role: 'user', content: humanSaid });
      this.messages.push({ role: 'assistant', content: this.reEngagementResponse });
      return this.reEngagementResponse;
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

    const systemWithGoal = `${SYSTEM_PROMPT}

YOUR GOAL FOR THIS CALL: ${this.goal}
${this.context ? `ADDITIONAL CONTEXT: ${this.context}` : ''}`;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 150, // Keep responses short for voice
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

    const hasAssistantMessage = this.messages.some((m) => m.role === 'assistant');
    if (hasAssistantMessage && isReEngagement(humanSaid)) {
      this.messages.push({ role: 'user', content: humanSaid });
      this.messages.push({ role: 'assistant', content: this.reEngagementResponse });
      yield this.reEngagementResponse;
      return this.reEngagementResponse;
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

    const systemWithGoal = `${SYSTEM_PROMPT}

YOUR GOAL FOR THIS CALL: ${this.goal}
${this.context ? `ADDITIONAL CONTEXT: ${this.context}` : ''}`;

    try {
      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: 150,
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
