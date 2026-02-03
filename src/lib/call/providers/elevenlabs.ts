/**
 * ElevenLabs provider for text-to-speech
 */

import { EventEmitter } from 'node:events';
import type { ElevenLabsVoiceSettings } from '../call-types.js';

export interface ElevenLabsConfig {
  apiKey: string;
  voiceId: string;
  modelId?: string;
  voiceSettings?: ElevenLabsVoiceSettings;
}

export interface ElevenLabsTTSPreflightResult {
  ok: boolean;
  provider: 'elevenlabs';
  estimatedNeededChars: number;
  remainingChars?: number;
  characterLimit?: number;
  characterCount?: number;
  message: string;
}

const DEFAULT_VOICE_SETTINGS: ElevenLabsVoiceSettings = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0,
  use_speaker_boost: true,
};

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

export class ElevenLabsApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly provider = 'elevenlabs';
  readonly rawBody: string;

  constructor(status: number, message: string, rawBody: string, code?: string) {
    super(message);
    this.name = 'ElevenLabsApiError';
    this.status = status;
    this.code = code;
    this.rawBody = rawBody;
  }

  get isQuotaExceeded(): boolean {
    return this.code === 'quota_exceeded';
  }
}

/**
 * Conservative estimate of characters a typical call will need for TTS.
 * Used to fail fast before dialing when quota is clearly insufficient.
 */
export function estimateCallTTSCharacters(goal: string, context?: string): number {
  const goalLen = goal.trim().length;
  const contextLen = (context ?? '').trim().length;
  const estimate = 900 + Math.min(700, Math.round(goalLen * 1.8)) + Math.min(800, Math.round(contextLen * 0.8));
  return Math.max(1200, Math.min(3000, estimate));
}

/**
 * Check ElevenLabs subscription budget before initiating a real phone call.
 */
export async function preflightElevenLabsTTSBudget(
  apiKey: string,
  goal: string,
  context?: string,
): Promise<ElevenLabsTTSPreflightResult> {
  const estimatedNeededChars = estimateCallTTSCharacters(goal, context);

  try {
    const response = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
      headers: {
        'xi-api-key': apiKey,
      },
    });

    if (!response.ok) {
      return {
        ok: true,
        provider: 'elevenlabs',
        estimatedNeededChars,
        message: `TTS preflight could not verify quota (HTTP ${response.status}); continuing.`,
      };
    }

    const data = (await response.json()) as Record<string, unknown>;
    const characterLimit = toNumber(data.character_limit ?? data.characterLimit);
    const characterCount = toNumber(data.character_count ?? data.characterCount);
    const remainingCharsRaw = toNumber(data.remaining_characters ?? data.remainingCharacters);
    const remainingChars = remainingCharsRaw ?? (
      characterLimit !== undefined && characterCount !== undefined
        ? Math.max(0, characterLimit - characterCount)
        : undefined
    );

    if (remainingChars === undefined) {
      return {
        ok: true,
        provider: 'elevenlabs',
        estimatedNeededChars,
        characterLimit,
        characterCount,
        message: 'TTS preflight could not determine remaining characters; continuing.',
      };
    }

    if (remainingChars < estimatedNeededChars) {
      return {
        ok: false,
        provider: 'elevenlabs',
        estimatedNeededChars,
        remainingChars,
        characterLimit,
        characterCount,
        message: `TTS preflight failed: ElevenLabs has ~${Math.round(remainingChars)} characters remaining, estimated ~${estimatedNeededChars} needed for this call. Top up credits first.`,
      };
    }

    return {
      ok: true,
      provider: 'elevenlabs',
      estimatedNeededChars,
      remainingChars,
      characterLimit,
      characterCount,
      message: `TTS preflight passed: ~${Math.round(remainingChars)} characters remaining (estimated ~${estimatedNeededChars} needed).`,
    };
  } catch (error) {
    return {
      ok: true,
      provider: 'elevenlabs',
      estimatedNeededChars,
      message: `TTS preflight could not verify quota (${error instanceof Error ? error.message : String(error)}); continuing.`,
    };
  }
}

/**
 * Internal helper to make TTS API request
 */
async function makeTTSRequest(
  config: ElevenLabsConfig,
  text: string,
  signal?: AbortSignal,
): Promise<Response> {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${config.voiceId}/stream`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': config.apiKey,
      },
      body: JSON.stringify({
        text,
        model_id: config.modelId ?? 'eleven_turbo_v2',
        voice_settings: config.voiceSettings ?? DEFAULT_VOICE_SETTINGS,
        // ElevenLabs returns MP3 regardless of output_format requested
        // We convert via ffmpeg, so request high-quality MP3
        output_format: 'mp3_44100_128',
      }),
      signal,
    },
  );

  if (!response.ok) {
    const rawBody = await response.text();
    let code: string | undefined;
    let message = `ElevenLabs API error: ${response.status}`;
    try {
      const parsed = JSON.parse(rawBody) as {
        detail?: { status?: string; message?: string };
      };
      code = parsed.detail?.status;
      if (parsed.detail?.message) {
        message = `ElevenLabs API error (${parsed.detail.status ?? response.status}): ${parsed.detail.message}`;
      }
    } catch {
      if (rawBody) {
        message = `ElevenLabs API error: ${response.status} - ${rawBody}`;
      }
    }
    throw new ElevenLabsApiError(response.status, message, rawBody, code);
  }

  if (!response.body) {
    throw new Error('No response body from ElevenLabs');
  }

  return response;
}

/**
 * Stream text-to-speech from ElevenLabs
 * Returns audio chunks as they become available
 */
export async function* streamTTS(
  config: ElevenLabsConfig,
  text: string,
): AsyncGenerator<Buffer> {
  const response = await makeTTSRequest(config, text);

  // Stream the response
  const reader = response.body!.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield Buffer.from(value);
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Get TTS audio as a single buffer
 */
export async function synthesizeSpeech(
  config: ElevenLabsConfig,
  text: string,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of streamTTS(config, text)) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * ElevenLabs TTS class for streaming synthesis
 */
export class ElevenLabsTTS extends EventEmitter {
  private readonly config: ElevenLabsConfig;
  private abortController: AbortController | null = null;

  constructor(config: ElevenLabsConfig) {
    super();
    this.config = config;
  }

  /**
   * Synthesize text to speech and emit audio chunks
   * Emits 'audio' events with MP3 data (converted to µ-law via ffmpeg in call-session)
   */
  async speak(text: string): Promise<void> {
    this.abortController = new AbortController();

    try {
      const response = await makeTTSRequest(this.config, text, this.abortController.signal);

      const reader = response.body!.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          this.emit('audio', Buffer.from(value));
        }
        this.emit('done');
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        this.emit('cancelled');
      } else {
        this.emit('error', error);
        throw error;
      }
    } finally {
      this.abortController = null;
    }
  }

  /**
   * Cancel ongoing speech synthesis
   */
  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }
}

/**
 * Create an ElevenLabs TTS instance for phone calls
 */
export function createPhoneCallTTS(apiKey: string, voiceId: string): ElevenLabsTTS {
  return new ElevenLabsTTS({
    apiKey,
    voiceId,
    modelId: 'eleven_turbo_v2', // Fastest model
    voiceSettings: {
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0,
      use_speaker_boost: true,
    },
  });
}

/**
 * List available voices
 */
export interface VoiceInfo {
  voice_id: string;
  name: string;
  category: string;
  labels: Record<string, string>;
}

export async function listVoices(apiKey: string): Promise<VoiceInfo[]> {
  const response = await fetch('https://api.elevenlabs.io/v1/voices', {
    headers: {
      'xi-api-key': apiKey,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to list voices: ${response.status}`);
  }

  const data = (await response.json()) as { voices: VoiceInfo[] };
  return data.voices;
}
