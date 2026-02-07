import { describe, expect, it } from 'vitest';
import { generateDtmfSequence, generateDtmfTone } from '../src/lib/call/audio/dtmf.js';
import { findSentenceBoundary } from '../src/lib/call/conversation-ai.js';

describe('DTMF tone generation', () => {
  it('generates a tone of correct length for default 160ms duration', () => {
    const tone = generateDtmfTone('1');
    // 160ms at 8000 Hz = 1280 samples = 1280 mulaw bytes
    expect(tone.length).toBe(1280);
  });

  it('generates a tone of correct length for custom duration', () => {
    const tone = generateDtmfTone('5', 200);
    // 200ms at 8000 Hz = 1600 samples
    expect(tone.length).toBe(1600);
  });

  it('throws for invalid digit', () => {
    expect(() => generateDtmfTone('X')).toThrow('Invalid DTMF digit: X');
    expect(() => generateDtmfTone('A')).toThrow('Invalid DTMF digit: A');
    expect(() => generateDtmfTone('')).toThrow('Invalid DTMF digit: ');
  });

  it('generates valid output for all 12 DTMF digits', () => {
    const validDigits = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '#'];
    for (const digit of validDigits) {
      const tone = generateDtmfTone(digit);
      expect(tone.length).toBeGreaterThan(0);
      expect(Buffer.isBuffer(tone)).toBe(true);
    }
  });

  it('produces non-silent audio (not all 0xFF mulaw silence)', () => {
    const tone = generateDtmfTone('1');
    const silenceCount = Array.from(tone).filter((b) => b === 0xff).length;
    // At amplitude 0.3 with dual tones, nearly no samples should be silence
    expect(silenceCount / tone.length).toBeLessThan(0.1);
  });
});

describe('DTMF sequence generation', () => {
  it('generates correct length for a single digit', () => {
    const seq = generateDtmfSequence('1');
    // Single tone, no gaps: 1280 bytes
    expect(seq.length).toBe(1280);
  });

  it('generates correct length for multiple digits', () => {
    const seq = generateDtmfSequence('123');
    // 3 tones of 160ms (1280 bytes each) + 2 gaps of 60ms (480 bytes each)
    const expectedLength = 3 * 1280 + 2 * 480;
    expect(seq.length).toBe(expectedLength);
  });

  it('gaps are filled with mulaw silence (0xFF)', () => {
    const seq = generateDtmfSequence('12');
    // Layout: [1280 bytes tone] [480 bytes gap] [1280 bytes tone]
    const gapStart = 1280;
    const gapEnd = 1280 + 480;
    for (let i = gapStart; i < gapEnd; i++) {
      expect(seq[i]).toBe(0xff);
    }
  });

  it('respects custom tone and gap durations', () => {
    const seq = generateDtmfSequence('12', 200, 100);
    // 2 tones of 200ms (1600 bytes) + 1 gap of 100ms (800 bytes)
    expect(seq.length).toBe(2 * 1600 + 800);
  });
});

describe('DTMF marker stripping', () => {
  const DTMF_REGEX = /\[DTMF:[0-9*#]+\]/g;

  it('strips single DTMF marker from text', () => {
    const input = "I'll press 1 for reservations. [DTMF:1]";
    const result = input.replace(DTMF_REGEX, '').trim();
    expect(result).toBe("I'll press 1 for reservations.");
  });

  it('strips multiple DTMF markers', () => {
    const input = 'Pressing star then 0. [DTMF:*] [DTMF:0]';
    const result = input.replace(DTMF_REGEX, '').trim();
    expect(result).toBe('Pressing star then 0.');
  });

  it('strips multi-digit DTMF marker', () => {
    const input = '[DTMF:4523]';
    const result = input.replace(DTMF_REGEX, '').trim();
    expect(result).toBe('');
  });

  it('strips DTMF alongside CALL_COMPLETE', () => {
    const input = "Thanks! [DTMF:1] That's all. [CALL_COMPLETE]";
    const result = input.replace('[CALL_COMPLETE]', '').replace(DTMF_REGEX, '').replace(/\s+/g, ' ').trim();
    expect(result).toBe("Thanks! That's all.");
  });

  it('extracts digits correctly from markers', () => {
    const input = "I'll press 1. [DTMF:1] Then star. [DTMF:*]";
    const matches = [...input.matchAll(/\[DTMF:([0-9*#]+)\]/g)];
    expect(matches).toHaveLength(2);
    expect(matches[0][1]).toBe('1');
    expect(matches[1][1]).toBe('*');
  });
});

describe('DTMF markers and sentence boundary splitting', () => {
  it('[DTMF:1] alone does not trigger a sentence boundary', () => {
    // Important: DTMF markers contain no sentence-ending punctuation followed by space,
    // so they won't be split across streaming chunks
    expect(findSentenceBoundary('[DTMF:1]')).toBe(-1);
  });

  it('[DTMF:1] after a sentence does not cause an extra split', () => {
    // The sentence boundary is at the period+space, not at the DTMF marker
    // "I'll press 1. [DTMF:1]"
    //               ^ boundary at index 14 (past ". ")
    const text = "I'll press 1. [DTMF:1]";
    const boundary = findSentenceBoundary(text);
    expect(boundary).toBe(14); // after ". "
    const chunk = text.slice(0, boundary).trim();
    expect(chunk).toBe("I'll press 1.");
  });

  it('DTMF marker mid-sentence does not split', () => {
    const text = 'Let me press [DTMF:1] for reservations';
    expect(findSentenceBoundary(text)).toBe(-1);
  });
});
