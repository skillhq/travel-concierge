/**
 * Deepgram provider for real-time speech-to-text
 */

import { createClient, LiveTranscriptionEvents, type LiveClient } from '@deepgram/sdk';
import { EventEmitter } from 'node:events';

export interface DeepgramConfig {
  apiKey: string;
  language?: string;
  model?: string;
  punctuate?: boolean;
  interimResults?: boolean;
  endpointing?: number;
}

export interface TranscriptResult {
  text: string;
  isFinal: boolean;
  confidence: number;
  words?: Array<{
    word: string;
    start: number;
    end: number;
    confidence: number;
  }>;
}

export interface DeepgramEvents {
  transcript: (result: TranscriptResult) => void;
  error: (error: Error) => void;
  close: () => void;
  open: () => void;
}

export interface DeepgramPreflightResult {
  ok: boolean;
  provider: 'deepgram';
  status?: number;
  message: string;
}

/**
 * Preflight check for Deepgram STT readiness.
 * Validates API key and basic control-plane reachability.
 */
export async function preflightDeepgramSTT(apiKey: string): Promise<DeepgramPreflightResult> {
  try {
    const response = await fetch('https://api.deepgram.com/v1/projects', {
      method: 'GET',
      headers: {
        Authorization: `Token ${apiKey}`,
      },
    });

    if (response.ok) {
      return {
        ok: true,
        provider: 'deepgram',
        status: response.status,
        message: 'Deepgram preflight passed: API key accepted.',
      };
    }

    const body = await response.text();
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        provider: 'deepgram',
        status: response.status,
        message: `Deepgram preflight failed: invalid or unauthorized API key (${response.status}).`,
      };
    }

    return {
      ok: false,
      provider: 'deepgram',
      status: response.status,
      message: `Deepgram preflight failed: HTTP ${response.status}${body ? ` - ${body}` : ''}`,
    };
  } catch (error) {
    return {
      ok: false,
      provider: 'deepgram',
      message: `Deepgram preflight failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Real-time speech-to-text using Deepgram
 */
export class DeepgramSTT extends EventEmitter {
  private connection: LiveClient | null = null;
  private readonly config: DeepgramConfig;
  private isConnected = false;

  constructor(config: DeepgramConfig) {
    super();
    this.config = config;
  }

  /**
   * Connect to Deepgram's real-time transcription service
   */
  async connect(): Promise<void> {
    const deepgram = createClient(this.config.apiKey);

    this.connection = deepgram.listen.live({
      model: this.config.model ?? 'nova-2',
      language: this.config.language ?? 'en-US',
      punctuate: this.config.punctuate ?? true,
      interim_results: this.config.interimResults ?? true,
      endpointing: this.config.endpointing ?? 300,
      // Optimized for phone audio
      encoding: 'linear16',
      sample_rate: 8000,
      channels: 1,
      smart_format: true,
    });

    return new Promise((resolve, reject) => {
      if (!this.connection) {
        reject(new Error('Failed to create Deepgram connection'));
        return;
      }

      this.connection.on(LiveTranscriptionEvents.Open, () => {
        this.isConnected = true;
        this.emit('open');
        resolve();
      });

      this.connection.on(LiveTranscriptionEvents.Transcript, (data) => {
        // Log raw Deepgram response for debugging
        const transcript = data.channel?.alternatives?.[0];
        console.log(`[Deepgram] Transcript event - text: "${transcript?.transcript || ''}", confidence: ${transcript?.confidence || 0}, is_final: ${data.is_final}`);

        if (transcript && transcript.transcript) {
          const result: TranscriptResult = {
            text: transcript.transcript,
            isFinal: data.is_final ?? false,
            confidence: transcript.confidence ?? 0,
            words: transcript.words?.map((w: { word: string; start: number; end: number; confidence: number }) => ({
              word: w.word,
              start: w.start,
              end: w.end,
              confidence: w.confidence,
            })),
          };
          this.emit('transcript', result);
        }
      });

      this.connection.on(LiveTranscriptionEvents.Error, (error) => {
        console.error('[Deepgram] Error event:', error);
        this.emit('error', error instanceof Error ? error : new Error(String(error)));
      });

      this.connection.on(LiveTranscriptionEvents.Close, () => {
        console.log(`[Deepgram] Connection closed. Total bytes sent: ${this.audioBytesSent}`);
        this.isConnected = false;
        this.emit('close');
      });

      // Log other events for debugging
      this.connection.on(LiveTranscriptionEvents.Metadata, (data) => {
        console.log('[Deepgram] Metadata event:', JSON.stringify(data));
      });

      this.connection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
        console.log('[Deepgram] UtteranceEnd event');
      });

      // Timeout for connection
      setTimeout(() => {
        if (!this.isConnected) {
          // Clean up on timeout
          if (this.connection) {
            try {
              this.connection.requestClose();
            } catch {
              // Ignore close errors
            }
            this.connection = null;
          }
          reject(new Error('Deepgram connection timeout'));
        }
      }, 10000);
    });
  }

  private audioBytesSent = 0;

  /**
   * Send audio data to Deepgram for transcription
   * @param audio - 16-bit PCM audio at 8kHz
   */
  sendAudio(audio: Buffer): void {
    if (!this.connection || !this.isConnected) {
      return;
    }

    try {
      // Create a copy of the buffer data to avoid issues with pooled buffers
      // Using Uint8Array.from creates a new ArrayBuffer with copied data
      const copy = new Uint8Array(audio.length);
      copy.set(audio);
      this.connection.send(copy.buffer);
      this.audioBytesSent += audio.length;
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Signal end of audio (for final transcript)
   */
  finalize(): void {
    if (!this.connection || !this.isConnected) {
      return;
    }

    try {
      // Send keep-alive to flush any pending audio
      this.connection.keepAlive();
    } catch {
      // Ignore errors when finalizing
    }
  }

  /**
   * Close the Deepgram connection
   */
  close(): void {
    if (this.connection) {
      try {
        this.connection.requestClose();
      } catch {
        // Ignore close errors
      }
      this.connection = null;
      this.isConnected = false;
    }
  }

  /**
   * Check if connected
   */
  get connected(): boolean {
    return this.isConnected;
  }
}

/**
 * Create a Deepgram STT instance optimized for phone calls
 */
export function createPhoneCallSTT(apiKey: string): DeepgramSTT {
  return new DeepgramSTT({
    apiKey,
    model: 'nova-2-phonecall', // Optimized for phone audio
    language: 'en-US',
    punctuate: true,
    interimResults: true,
    // 800ms of silence within a phrase to end the utterance
    // Combined with 1000ms response debounce = ~1.8s total before AI responds
    // This allows for natural thinking pauses without interruption
    endpointing: 800,
  });
}
