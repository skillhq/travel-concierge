import { describe, expect, it } from 'vitest';
import {
  ConversationAI,
  extractMostRecentQuestion,
  isLikelyShortAcknowledgement,
} from '../src/lib/call/conversation-ai.js';

describe('conversation turn context helpers', () => {
  it('detects short acknowledgement phrases', () => {
    expect(isLikelyShortAcknowledgement('Yes.')).toBe(true);
    expect(isLikelyShortAcknowledgement('Sure')).toBe(true);
    expect(isLikelyShortAcknowledgement('true')).toBe(true);
    expect(isLikelyShortAcknowledgement('Yes, that works')).toBe(false);
    expect(isLikelyShortAcknowledgement('The rate is three ninety')).toBe(false);
  });

  it('extracts the most recent assistant question', () => {
    const utterance =
      'Great! I found your room on Booking.com for three hundred ninety-three dollars. Would you be able to offer a better direct rate?';
    expect(extractMostRecentQuestion(utterance)).toBe('Would you be able to offer a better direct rate?');
    expect(extractMostRecentQuestion('Thanks for confirming.')).toBeUndefined();
  });
});

describe('respondToUnclearSpeech', () => {
  function createAI() {
    return new ConversationAI({
      apiKey: 'test-key',
      goal: 'Book a room',
      context: 'Hotel: Test Hotel',
    });
  }

  it('returns the canned unclear speech response', () => {
    const ai = createAI();
    const response = ai.respondToUnclearSpeech();
    expect(response).toBe("Sorry, I didn't catch that. Could you say that again?");
  });

  it('adds [unclear speech] and response to conversation history', () => {
    const ai = createAI();
    ai.respondToUnclearSpeech();
    const history = ai.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({ role: 'user', content: '[unclear speech]' });
    expect(history[1]).toEqual({
      role: 'assistant',
      content: "Sorry, I didn't catch that. Could you say that again?",
    });
  });

  it('preserves history continuity for subsequent turns', () => {
    const ai = createAI();
    // Simulate an unclear speech exchange
    ai.respondToUnclearSpeech();
    const history = ai.getHistory();
    expect(history).toHaveLength(2);
    // Conversation should not be marked complete
    expect(ai.complete).toBe(false);
    // History should allow further messages (user + assistant alternating)
    expect(history[history.length - 1].role).toBe('assistant');
  });
});
