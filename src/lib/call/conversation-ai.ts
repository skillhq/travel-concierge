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
- Example: "Hi, this is an AI assistant calling on behalf of [customer name]. I'm hoping to book a room at your hotel."
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
  private isComplete = false;

  constructor(config: ConversationConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.goal = config.goal;
    this.context = config.context || '';
    // Use a fast current Haiku model for phone-call latency.
    this.model = config.model || 'claude-haiku-4-5';
  }

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
- Introduce yourself as an AI assistant calling on behalf of a customer
- State your general purpose (e.g., "I'm calling about booking a room")
- Do NOT ask "How can I assist you?" - YOU need THEIR assistance
- Do NOT include [CALL_COMPLETE]
- Keep it to 1 sentence when possible (2 max), ideally under 30 words`;

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
  async respond(humanSaid: string): Promise<string | null> {
    if (this.isComplete) {
      return null;
    }

    return this.generateResponse(humanSaid);
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
