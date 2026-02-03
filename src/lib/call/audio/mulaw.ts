/**
 * µ-law (mulaw) audio codec utilities
 * Twilio sends/receives 8kHz mulaw audio
 */

// µ-law to linear PCM lookup table
const MULAW_TO_LINEAR: Int16Array = new Int16Array(256);
const LINEAR_TO_MULAW: Uint8Array = new Uint8Array(65536);

// Bias for µ-law encoding
const MULAW_BIAS = 0x84;
const MULAW_MAX = 0x7fff;

// Initialize lookup tables
function initTables(): void {
  // Build mulaw to linear table
  // µ-law decoding: bytes are stored inverted, so we must invert first
  for (let i = 0; i < 256; i++) {
    // Step 1: Invert all bits (µ-law convention)
    const mulaw = ~i & 0xff;

    // Step 2: Extract components from inverted byte
    const sign = mulaw & 0x80;      // Bit 7 = sign
    const exponent = (mulaw >> 4) & 0x07;  // Bits 4-6 = exponent
    const mantissa = mulaw & 0x0f;  // Bits 0-3 = mantissa

    // Step 3: Decode to linear
    // Formula: ((mantissa << 4) + bias) << (exponent + 1) - bias
    let sample = ((mantissa << 4) + MULAW_BIAS) << (exponent + 1);
    sample -= MULAW_BIAS;

    // Step 4: Apply sign
    MULAW_TO_LINEAR[i] = sign ? -sample : sample;
  }

  // Build linear to mulaw table (16-bit signed to 8-bit mulaw)
  for (let i = 0; i < 65536; i++) {
    const sample = i < 32768 ? i : i - 65536; // Convert to signed
    LINEAR_TO_MULAW[i] = linearToMulawSample(sample);
  }
}

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

// Initialize on load
initTables();

/**
 * Convert µ-law encoded buffer to 16-bit PCM
 * @param mulaw - Buffer containing µ-law audio
 * @returns Buffer containing 16-bit little-endian PCM
 */
export function mulawToPcm(mulaw: Buffer): Buffer {
  const pcm = Buffer.alloc(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i++) {
    const sample = MULAW_TO_LINEAR[mulaw[i]];
    pcm.writeInt16LE(sample, i * 2);
  }
  return pcm;
}

/**
 * Convert 16-bit PCM to µ-law encoded buffer
 * @param pcm - Buffer containing 16-bit little-endian PCM
 * @returns Buffer containing µ-law audio
 */
export function pcmToMulaw(pcm: Buffer): Buffer {
  const mulaw = Buffer.alloc(pcm.length / 2);
  for (let i = 0; i < mulaw.length; i++) {
    const sample = pcm.readInt16LE(i * 2);
    // Convert signed 16-bit to unsigned index for lookup
    const index = sample < 0 ? sample + 65536 : sample;
    mulaw[i] = LINEAR_TO_MULAW[index];
  }
  return mulaw;
}

/**
 * Convert µ-law to 32-bit float PCM (for Web Audio API compatibility)
 * @param mulaw - Buffer containing µ-law audio
 * @returns Float32Array with samples normalized to [-1, 1]
 */
export function mulawToFloat32(mulaw: Buffer): Float32Array {
  const float32 = new Float32Array(mulaw.length);
  for (let i = 0; i < mulaw.length; i++) {
    float32[i] = MULAW_TO_LINEAR[mulaw[i]] / 32768;
  }
  return float32;
}

/**
 * Convert base64-encoded µ-law to PCM
 * @param base64 - Base64-encoded µ-law audio
 * @returns Buffer containing 16-bit little-endian PCM
 */
export function base64MulawToPcm(base64: string): Buffer {
  const mulaw = Buffer.from(base64, 'base64');
  return mulawToPcm(mulaw);
}

/**
 * Convert PCM to base64-encoded µ-law
 * @param pcm - Buffer containing 16-bit little-endian PCM
 * @returns Base64-encoded µ-law audio
 */
export function pcmToBase64Mulaw(pcm: Buffer): string {
  const mulaw = pcmToMulaw(pcm);
  return mulaw.toString('base64');
}
