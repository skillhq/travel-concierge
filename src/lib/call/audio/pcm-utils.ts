/**
 * PCM audio buffer utilities
 */

export interface AudioFormat {
  sampleRate: number;
  channels: number;
  bitDepth: number;
}

// Twilio's audio format: 8kHz mono µ-law
export const TWILIO_FORMAT: AudioFormat = {
  sampleRate: 8000,
  channels: 1,
  bitDepth: 8,
};

// Deepgram preferred format: 16kHz mono 16-bit PCM
export const DEEPGRAM_FORMAT: AudioFormat = {
  sampleRate: 16000,
  channels: 1,
  bitDepth: 16,
};

/**
 * Resample 16-bit PCM audio using linear interpolation
 * @param pcm - Input PCM buffer (16-bit little-endian)
 * @param fromRate - Source sample rate
 * @param toRate - Target sample rate
 * @returns Resampled PCM buffer
 */
export function resamplePcm(pcm: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) return pcm;

  const ratio = fromRate / toRate;
  const inputSamples = pcm.length / 2;
  const outputSamples = Math.floor(inputSamples / ratio);
  const output = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    const srcIndex = i * ratio;
    const srcIndexFloor = Math.floor(srcIndex);
    const fraction = srcIndex - srcIndexFloor;

    const sample1 = pcm.readInt16LE(srcIndexFloor * 2);
    const sample2Index = Math.min(srcIndexFloor + 1, inputSamples - 1) * 2;
    const sample2 = pcm.readInt16LE(sample2Index);

    // Linear interpolation
    const interpolated = Math.round(sample1 + (sample2 - sample1) * fraction);
    output.writeInt16LE(interpolated, i * 2);
  }

  return output;
}

/**
 * Upsample 8kHz to 16kHz using linear interpolation
 */
export function upsample8kTo16k(pcm: Buffer): Buffer {
  return resamplePcm(pcm, 8000, 16000);
}

/**
 * Downsample 16kHz to 8kHz
 */
export function downsample16kTo8k(pcm: Buffer): Buffer {
  return resamplePcm(pcm, 16000, 8000);
}

/**
 * Downsample 24kHz to 8kHz
 */
export function downsample24kTo8k(pcm: Buffer): Buffer {
  return resamplePcm(pcm, 24000, 8000);
}

/**
 * Downsample 44.1kHz to 8kHz
 */
export function downsample44kTo8k(pcm: Buffer): Buffer {
  return resamplePcm(pcm, 44100, 8000);
}

/**
 * Convert stereo PCM to mono by averaging channels
 */
export function stereoToMono(pcm: Buffer): Buffer {
  const mono = Buffer.alloc(pcm.length / 2);
  for (let i = 0; i < mono.length / 2; i++) {
    const left = pcm.readInt16LE(i * 4);
    const right = pcm.readInt16LE(i * 4 + 2);
    mono.writeInt16LE(Math.round((left + right) / 2), i * 2);
  }
  return mono;
}

/**
 * Normalize audio to a target peak level
 * @param pcm - 16-bit PCM buffer
 * @param targetPeak - Target peak (0-1, default 0.9)
 */
export function normalizePcm(pcm: Buffer, targetPeak = 0.9): Buffer {
  // Find current peak
  let peak = 0;
  for (let i = 0; i < pcm.length / 2; i++) {
    const sample = Math.abs(pcm.readInt16LE(i * 2));
    if (sample > peak) peak = sample;
  }

  if (peak === 0) return pcm;

  // Calculate gain
  const targetAmplitude = Math.round(32767 * targetPeak);
  const gain = targetAmplitude / peak;

  // Apply gain
  const output = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length / 2; i++) {
    const sample = pcm.readInt16LE(i * 2);
    const amplified = Math.round(sample * gain);
    // Clamp to 16-bit range
    const clamped = Math.max(-32768, Math.min(32767, amplified));
    output.writeInt16LE(clamped, i * 2);
  }

  return output;
}

/**
 * Apply a simple low-pass filter to reduce aliasing before downsampling
 */
export function lowPassFilter(pcm: Buffer, cutoffRatio = 0.4): Buffer {
  const output = Buffer.alloc(pcm.length);
  const alpha = cutoffRatio;

  let prevSample = pcm.readInt16LE(0);
  output.writeInt16LE(prevSample, 0);

  for (let i = 1; i < pcm.length / 2; i++) {
    const sample = pcm.readInt16LE(i * 2);
    const filtered = Math.round(alpha * sample + (1 - alpha) * prevSample);
    output.writeInt16LE(filtered, i * 2);
    prevSample = filtered;
  }

  return output;
}

/**
 * Calculate RMS (root mean square) level of audio
 * Returns value from 0-1
 */
export function calculateRms(pcm: Buffer): number {
  let sum = 0;
  const samples = pcm.length / 2;

  for (let i = 0; i < samples; i++) {
    const sample = pcm.readInt16LE(i * 2) / 32768;
    sum += sample * sample;
  }

  return Math.sqrt(sum / samples);
}

/**
 * Check if audio buffer contains silence (below threshold)
 */
export function isSilence(pcm: Buffer, threshold = 0.01): boolean {
  return calculateRms(pcm) < threshold;
}

/**
 * Concatenate multiple PCM buffers
 */
export function concatenatePcm(buffers: Buffer[]): Buffer {
  return Buffer.concat(buffers);
}
