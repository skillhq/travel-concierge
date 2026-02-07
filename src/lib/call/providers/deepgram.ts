/**
 * Deepgram provider for real-time speech-to-text
 */

import { EventEmitter } from 'node:events';
import { createClient, type LiveClient, LiveTranscriptionEvents } from '@deepgram/sdk';

export interface DeepgramConfig {
  apiKey: string;
  language?: string;
  model?: string;
  punctuate?: boolean;
  interimResults?: boolean;
  endpointing?: number;
  /** Minimum confidence threshold (0-1) for final transcripts. Below this, transcripts are dropped. */
  confidenceThreshold?: number;
  /** Keywords to boost recognition of (e.g., common responses like "yes", "no") */
  keywords?: string[];
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

    // Build live transcription options
    const liveOptions: Record<string, unknown> = {
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
    };

    // Add keyword boosting if configured
    // Format: "word:intensifier" where intensifier is an exponential boost factor
    if (this.config.keywords && this.config.keywords.length > 0) {
      liveOptions.keywords = this.config.keywords.map((kw) => `${kw}:2`);
      console.log(`[Deepgram] Keyword boosting enabled for ${this.config.keywords.length} keywords`);
    }

    this.connection = deepgram.listen.live(liveOptions);

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
        const confidence = transcript?.confidence ?? 0;
        const isFinal = data.is_final ?? false;
        const threshold = this.config.confidenceThreshold ?? 0;

        console.log(
          `[Deepgram] Transcript event - text: "${transcript?.transcript || ''}", confidence: ${confidence.toFixed(3)}, is_final: ${isFinal}${threshold > 0 ? `, threshold: ${threshold}` : ''}`,
        );

        if (transcript?.transcript) {
          // Filter out low-confidence final transcripts (likely noise/misrecognition)
          if (isFinal && threshold > 0 && confidence < threshold) {
            console.log(
              `[Deepgram] Dropping low-confidence transcript: "${transcript.transcript}" (${(confidence * 100).toFixed(1)}% < ${(threshold * 100).toFixed(0)}% threshold)`,
            );
            this.emit('unclear_speech', {
              text: transcript.transcript,
              confidence,
            });
            return;
          }

          const result: TranscriptResult = {
            text: transcript.transcript,
            isFinal,
            confidence,
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

// Common conversational keywords to boost recognition accuracy
// Exported for future use when keyword format is verified with Deepgram SDK
export const PHONE_CALL_KEYWORDS = [
  // Affirmatives
  'yes',
  'yeah',
  'yep',
  'sure',
  'okay',
  'ok',
  'correct',
  'right',
  'absolutely',
  'definitely',
  // Negatives
  'no',
  'nope',
  'not',
  // Common responses
  'hello',
  'hi',
  'thanks',
  'thank you',
  'please',
  'sorry',
  'pardon',
  'what',
  'when',
  'where',
  'how',
  // Booking-related
  'booking',
  'reservation',
  'room',
  'night',
  'nights',
  'check-in',
  'checkout',
  'available',
  'confirm',
  'cancel',
  // Dining
  'restaurant',
  'dinner',
  'lunch',
  'table',
  'guests',
  'party',
  'patio',
  // Travel
  'hotel',
  'flight',
  'airport',
  'suite',
  'confirmation',
  // Contact info
  'email',
  'credit card',
  'phone number',
];

/**
 * Create a Deepgram STT instance optimized for phone calls
 */
export function createPhoneCallSTT(apiKey: string): DeepgramSTT {
  return new DeepgramSTT({
    apiKey,
    // Nova-2 phonecall variant - optimized for telephony audio
    model: 'nova-2-phonecall',
    language: 'en-US',
    punctuate: true,
    interimResults: true,
    // 300ms of silence within a phrase to end the utterance (Deepgram default is 300ms)
    // Combined with response debounce for turn timing
    endpointing: 300,
    // Filter out low-confidence transcripts (noise, misrecognition)
    // 65% threshold balances catching real speech vs filtering garbage
    confidenceThreshold: 0.65,
    // Boost common conversational words for better recognition
    keywords: PHONE_CALL_KEYWORDS,
  });
}
