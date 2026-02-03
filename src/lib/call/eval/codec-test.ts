/**
 * Codec Integration Test
 *
 * Verifies that the audio pipeline produces valid µ-law audio:
 * 1. ElevenLabs TTS → MP3 (always, regardless of output_format)
 * 2. ffmpeg streaming decoder → µ-law 8kHz
 * 3. Validate µ-law format and duration
 *
 * This catches regressions like:
 * - Wrong codec (sending MP3 as µ-law)
 * - Sample rate mismatches
 * - Truncated audio
 */

import { createStreamingDecoder } from '../audio/streaming-decoder.js';

export interface CodecTestResult {
  success: boolean;
  inputFormat: string;
  inputSize: number;
  outputFormat: string;
  outputSize: number;
  expectedDurationMs: number;
  actualDurationMs: number;
  durationMatchesExpected: boolean;
  isValidMulaw: boolean;
  errors: string[];
}

/**
 * Validate that data looks like valid µ-law audio
 * µ-law has specific characteristics:
 * - Single byte per sample
 * - Values distributed across 0-255 range (compressed)
 * - 8kHz sample rate
 */
export function validateMulawFormat(data: Buffer): { valid: boolean; reason?: string } {
  if (data.length < 100) {
    return { valid: false, reason: 'Audio too short (< 100 bytes)' };
  }

  // Check byte value distribution
  const histogram = new Array(256).fill(0);
  for (let i = 0; i < data.length; i++) {
    histogram[data[i]]++;
  }

  // Count how many different byte values are used
  const uniqueValues = histogram.filter(count => count > 0).length;

  // µ-law should have a wide distribution of values (voice uses many levels)
  // Raw MP3 data has very different patterns (frame headers, sync words)
  if (uniqueValues < 20) {
    return { valid: false, reason: `Too few unique byte values (${uniqueValues}), likely wrong format` };
  }

  // Check for MP3 signature in first bytes (common mistake)
  // MP3 frame sync: 0xFF followed by 0xFB, 0xFA, or 0xF3 (not 0xFF which is µ-law silence)
  const header = data.slice(0, 4);
  if (header[0] === 0xff && header[1] !== 0xff && (header[1] & 0xe0) === 0xe0) {
    return { valid: false, reason: `Data starts with MP3 frame header (0xFF ${header[1].toString(16).toUpperCase()})` };
  }
  if (header.slice(0, 3).toString() === 'ID3') {
    return { valid: false, reason: 'Data starts with ID3 tag (MP3 metadata)' };
  }

  // µ-law silence is typically 0x7F or 0xFF
  // Check that we have some non-silence samples
  const silenceCount = histogram[0x7f] + histogram[0xff];
  const silenceRatio = silenceCount / data.length;
  if (silenceRatio > 0.95) {
    return { valid: false, reason: 'Audio is >95% silence' };
  }

  return { valid: true };
}

/**
 * Test the streaming decoder with known MP3 input
 */
export async function testStreamingDecoder(
  mp3Data: Buffer,
  expectedDurationMs: number,
  toleranceMs: number = 500,
): Promise<CodecTestResult> {
  const result: CodecTestResult = {
    success: false,
    inputFormat: 'mp3',
    inputSize: mp3Data.length,
    outputFormat: 'mulaw_8000',
    outputSize: 0,
    expectedDurationMs,
    actualDurationMs: 0,
    durationMatchesExpected: false,
    isValidMulaw: false,
    errors: [],
  };

  // Check input is actually MP3
  const header = mp3Data.slice(0, 4);
  const isMP3 = (header[0] === 0xff && (header[1] & 0xe0) === 0xe0) ||
                header.slice(0, 3).toString() === 'ID3';
  if (!isMP3) {
    result.errors.push('Input does not appear to be MP3 format');
    return result;
  }

  // Create decoder
  const decoder = createStreamingDecoder();
  const mulawChunks: Buffer[] = [];

  decoder.on('data', (mulaw: Buffer) => {
    mulawChunks.push(mulaw);
  });

  const decoderDone = new Promise<void>((resolve, reject) => {
    decoder.on('close', resolve);
    decoder.on('error', reject);
  });

  // Start decoder and feed MP3 data
  decoder.start();

  // Feed in chunks (simulating streaming)
  const CHUNK_SIZE = 1024;
  for (let i = 0; i < mp3Data.length; i += CHUNK_SIZE) {
    const chunk = mp3Data.slice(i, i + CHUNK_SIZE);
    decoder.write(chunk);
    // Small delay to simulate streaming
    await new Promise(r => setTimeout(r, 1));
  }

  decoder.end();
  await decoderDone;

  // Analyze output
  const mulawData = Buffer.concat(mulawChunks);
  result.outputSize = mulawData.length;
  result.actualDurationMs = (mulawData.length / 8000) * 1000; // 8kHz

  // Validate µ-law format
  const validation = validateMulawFormat(mulawData);
  result.isValidMulaw = validation.valid;
  if (!validation.valid) {
    result.errors.push(`Invalid µ-law: ${validation.reason}`);
  }

  // Check duration matches expected
  const durationDiff = Math.abs(result.actualDurationMs - expectedDurationMs);
  result.durationMatchesExpected = durationDiff <= toleranceMs;
  if (!result.durationMatchesExpected) {
    result.errors.push(
      `Duration mismatch: expected ${expectedDurationMs}ms, got ${result.actualDurationMs.toFixed(0)}ms (diff: ${durationDiff.toFixed(0)}ms)`,
    );
  }

  result.success = result.isValidMulaw && result.durationMatchesExpected;
  return result;
}

/**
 * Test the full TTS pipeline
 */
export async function testTTSPipeline(
  text: string,
  apiKey: string,
  voiceId: string,
): Promise<CodecTestResult> {
  // Estimate expected duration (~150ms per word)
  const wordCount = text.split(/\s+/).length;
  const expectedDurationMs = wordCount * 150 + 500; // +500ms buffer

  // Get TTS audio
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': apiKey,
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        output_format: 'mp3_44100_128',
      }),
    },
  );

  if (!response.ok) {
    const error = await response.text();
    return {
      success: false,
      inputFormat: 'error',
      inputSize: 0,
      outputFormat: 'error',
      outputSize: 0,
      expectedDurationMs,
      actualDurationMs: 0,
      durationMatchesExpected: false,
      isValidMulaw: false,
      errors: [`ElevenLabs API error: ${response.status} - ${error}`],
    };
  }

  // Collect MP3 data
  const chunks: Buffer[] = [];
  const reader = response.body!.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  const mp3Data = Buffer.concat(chunks);

  // Test the decoder
  return testStreamingDecoder(mp3Data, expectedDurationMs, 2000); // 2s tolerance
}
