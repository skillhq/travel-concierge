import { describe, expect, it } from 'vitest';
import { extractMostRecentQuestion, isLikelyShortAcknowledgement } from '../src/lib/call/conversation-ai.js';

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
