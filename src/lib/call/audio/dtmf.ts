/**
 * DTMF tone generator for IVR navigation
 * Generates dual-frequency sine waves encoded as µ-law for Twilio
 */

import { pcmToMulaw } from './mulaw.js';

const SAMPLE_RATE = 8000;
const AMPLITUDE = 0.3; // Conservative to avoid mulaw clipping

// Standard DTMF frequency pairs (row, col)
const DTMF_FREQUENCIES: Record<string, [number, number]> = {
  '1': [697, 1209],
  '2': [697, 1336],
  '3': [697, 1477],
  '4': [770, 1209],
  '5': [770, 1336],
  '6': [770, 1477],
  '7': [852, 1209],
  '8': [852, 1336],
  '9': [852, 1477],
  '0': [941, 1336],
  '*': [941, 1209],
  '#': [941, 1477],
};

/**
 * Generate a single DTMF tone as µ-law audio
 * @param digit - The digit to generate (0-9, *, #)
 * @param durationMs - Tone duration in milliseconds (default 160ms)
 * @returns Buffer of µ-law encoded audio
 */
export function generateDtmfTone(digit: string, durationMs = 160): Buffer {
  const freqs = DTMF_FREQUENCIES[digit];
  if (!freqs) {
    throw new Error(`Invalid DTMF digit: ${digit}`);
  }

  const [rowFreq, colFreq] = freqs;
  const numSamples = Math.floor((SAMPLE_RATE * durationMs) / 1000);
  const pcm = Buffer.alloc(numSamples * 2); // 16-bit PCM = 2 bytes per sample

  for (let i = 0; i < numSamples; i++) {
    const sample =
      AMPLITUDE *
      (Math.sin((2 * Math.PI * rowFreq * i) / SAMPLE_RATE) + Math.sin((2 * Math.PI * colFreq * i) / SAMPLE_RATE));
    // Clamp to 16-bit range and write
    const clamped = Math.max(-1, Math.min(1, sample));
    pcm.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }

  return pcmToMulaw(pcm);
}

/**
 * Generate a sequence of DTMF tones with gaps between them
 * @param digits - String of digits to generate (e.g. "123")
 * @param toneDurationMs - Duration of each tone (default 160ms)
 * @param gapMs - Silence between tones (default 60ms)
 * @returns Buffer of µ-law encoded audio for the full sequence
 */
export function generateDtmfSequence(digits: string, toneDurationMs = 160, gapMs = 60): Buffer {
  const gapSamples = Math.floor((SAMPLE_RATE * gapMs) / 1000);
  // Silence in µ-law is 0xFF (positive zero)
  const silence = Buffer.alloc(gapSamples, 0xff);

  const parts: Buffer[] = [];
  for (let i = 0; i < digits.length; i++) {
    if (i > 0) {
      parts.push(silence);
    }
    parts.push(generateDtmfTone(digits[i], toneDurationMs));
  }

  return Buffer.concat(parts);
}
