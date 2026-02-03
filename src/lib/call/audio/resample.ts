/**
 * Audio resampling utilities for streaming conversion
 * Converts 24kHz PCM to 8kHz µ-law in real-time
 */

// µ-law encoding table (linear 16-bit to 8-bit µ-law)
const LINEAR_TO_MULAW: Uint8Array = new Uint8Array(65536);

// Bias and max for µ-law
const MULAW_BIAS = 0x84;
const MULAW_MAX = 0x7fff;

function linearToMulawSample(sample: number): number {
  const sign = sample < 0 ? 0x00 : 0x80;
  if (sample < 0) sample = -sample;
  if (sample > MULAW_MAX) sample = MULAW_MAX;
  sample += MULAW_BIAS;

  let exponent = 7;
  for (let mask = 0x4000; !(sample & mask) && exponent > 0; mask >>= 1) {
    exponent--;
  }

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

// Initialize lookup table
for (let i = 0; i < 65536; i++) {
  const sample = i < 32768 ? i : i - 65536;
  LINEAR_TO_MULAW[i] = linearToMulawSample(sample);
}

/**
 * Convert a single PCM sample to µ-law
 */
export function pcmSampleToMulaw(sample: number): number {
  const index = sample < 0 ? sample + 65536 : sample;
  return LINEAR_TO_MULAW[index];
}

/**
 * Streaming resampler: converts 24kHz 16-bit PCM to 8kHz µ-law
 * Uses simple decimation (takes every 3rd sample) - not audiophile quality but fast
 */
export class StreamingResampler {
  private remainder: Buffer = Buffer.alloc(0);

  /**
   * Process a chunk of 24kHz PCM and return 8kHz µ-law
   * @param pcm24k - 16-bit little-endian PCM at 24kHz
   * @returns µ-law audio at 8kHz
   */
  process(pcm24k: Buffer): Buffer {
    // Combine with any leftover bytes from previous chunk
    const input = Buffer.concat([this.remainder, pcm24k]);

    // Each input sample is 2 bytes (16-bit)
    // We need 3 samples of input (6 bytes) to produce 1 sample of output
    // (24000 / 8000 = 3)
    const inputSamples = Math.floor(input.length / 2);
    const outputSamples = Math.floor(inputSamples / 3);

    const output = Buffer.alloc(outputSamples);

    for (let i = 0; i < outputSamples; i++) {
      // Read every 3rd sample from input
      const inputOffset = i * 3 * 2; // 3 samples * 2 bytes
      const sample = input.readInt16LE(inputOffset);

      // Convert to µ-law
      output[i] = pcmSampleToMulaw(sample);
    }

    // Save any remaining bytes for next chunk
    const consumedBytes = outputSamples * 3 * 2;
    this.remainder = input.slice(consumedBytes);

    return output;
  }

  /**
   * Flush any remaining audio
   */
  flush(): Buffer {
    if (this.remainder.length >= 2) {
      // Process what we have left
      const sample = this.remainder.readInt16LE(0);
      this.remainder = Buffer.alloc(0);
      return Buffer.from([pcmSampleToMulaw(sample)]);
    }
    this.remainder = Buffer.alloc(0);
    return Buffer.alloc(0);
  }

  /**
   * Reset the resampler state
   */
  reset(): void {
    this.remainder = Buffer.alloc(0);
  }
}

/**
 * Simple one-shot conversion: 24kHz PCM to 8kHz µ-law
 */
export function pcm24kToMulaw8k(pcm24k: Buffer): Buffer {
  const resampler = new StreamingResampler();
  const main = resampler.process(pcm24k);
  const tail = resampler.flush();
  return Buffer.concat([main, tail]);
}
