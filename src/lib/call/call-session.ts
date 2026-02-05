/**
 * Call session management
 * Handles a single phone call with audio streaming, transcription, and synthesis
 */

import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { mulawToPcm } from './audio/mulaw.js';
import { calculateRms } from './audio/pcm-utils.js';
import { createStreamingDecoder, type StreamingDecoder } from './audio/streaming-decoder.js';
import type {
  CallConfig,
  CallState,
  CallStatus,
  ServerMessage,
  TranscriptEntry,
  TwilioMediaMessage,
} from './call-types.js';
import { ConversationAI, extractMostRecentQuestion, isLikelyShortAcknowledgement } from './conversation-ai.js';
import { createPhoneCallSTT, type DeepgramSTT, type TranscriptResult } from './providers/deepgram.js';
import { createPhoneCallTTS, ElevenLabsApiError, type ElevenLabsTTS } from './providers/elevenlabs.js';
import { hangupCall } from './providers/twilio.js';

export interface CallSessionEvents {
  message: (msg: ServerMessage) => void;
  ended: (state: CallState) => void;
}

// Configurable timing constants
const GREETING_DELAY_MS = 250;
const CALL_COMPLETION_DELAY_MS = 3000;
const POST_TTS_STT_SUPPRESSION_MS = 900;
const PRE_GREETING_IDLE_MS = 700;
const MAX_BUFFERED_STT_CHUNKS = 500;
const PRE_GREETING_VAD_RMS_THRESHOLD = 0.015;
const PRE_GREETING_VAD_MIN_CONSECUTIVE_CHUNKS = 2;
const MAX_GREETING_DEFERRAL_MS = 2000;
const TTS_EMPTY_AUDIO_MAX_RETRIES = 1;
const TTS_EMPTY_AUDIO_RETRY_DELAY_MS = 200;
const TTS_DECODER_FLUSH_GRACE_MS = 250;

export class CallSession extends EventEmitter {
  readonly callId: string;
  private readonly config: CallConfig;
  private state: CallState;
  private stt: DeepgramSTT | null = null;
  private tts: ElevenLabsTTS | null = null;
  private mediaWs: WebSocket | null = null;
  private streamSid: string | null = null;
  private audioQueue: Buffer[] = [];
  private isPlaying = false;
  private isSpeaking = false;
  private conversationAI: ConversationAI;
  private isProcessingResponse = false; // Prevent overlapping responses
  private decoder: StreamingDecoder | null = null; // ffmpeg MP3 → µ-law
  private decoderGeneration = 0; // Track decoder generations to avoid race conditions
  private sessionStartTime: number = Date.now(); // For timestamps
  private responseDebounceTimer: NodeJS.Timeout | null = null; // Debounce rapid transcripts
  private pendingTranscript: string = ''; // Accumulated transcript before responding
  private hangupTimer: NodeJS.Timeout | null = null; // Timer for delayed hangup
  private greetingTimer: NodeJS.Timeout | null = null; // Timer for delayed initial greeting
  private cleanedUp = false; // Prevent multiple cleanup calls
  private endedEmitted = false;
  private suppressSttUntilMs = 0; // Prevent echo from AI audio being transcribed as human speech
  private sttTimelineStartMs = 0; // Wall-clock anchor for Deepgram word timestamps
  private greetingStarted = false;
  private lastInboundTranscriptAtMs = 0;
  private lastInboundAudioActivityAtMs = 0;
  private consecutiveInboundSpeechChunks = 0;
  private callConnectedAtMs = 0;
  private bufferedSttAudio: Buffer[] = [];
  private greetingPrefetchPromise: Promise<string | null> | null = null;

  // Event handler references for cleanup
  private sttHandlers: { event: string; handler: (...args: any[]) => void }[] = [];
  private ttsHandlers: { event: string; handler: (...args: any[]) => void }[] = [];
  private mediaWsHandlers: { event: string; handler: (...args: any[]) => void }[] = [];

  /** Log with timestamp showing ms since session start */
  private log(message: string): void {
    const elapsed = Date.now() - this.sessionStartTime;
    console.log(`[${elapsed.toString().padStart(6)}ms] ${message}`);
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  private isElevenLabsQuotaExceeded(error: unknown): boolean {
    if (error instanceof ElevenLabsApiError) {
      return error.isQuotaExceeded;
    }
    const text = this.formatError(error).toLowerCase();
    return text.includes('quota_exceeded');
  }

  private getTTSOperatorMessage(error: unknown): string {
    if (this.isElevenLabsQuotaExceeded(error)) {
      return 'ElevenLabs quota exceeded: TTS cannot generate audio. Top up ElevenLabs credits and retry the call.';
    }
    return `TTS failed: ${this.formatError(error)}`;
  }

  private isEmptyTtsAudioError(error: unknown): boolean {
    const message = this.formatError(error).toLowerCase();
    return message.includes('tts produced no audio output');
  }

  constructor(callId: string, config: CallConfig, phoneNumber: string, goal: string, context?: string) {
    super();
    this.callId = callId;
    this.config = config;
    this.state = {
      callId,
      phoneNumber,
      goal,
      context,
      status: 'initiating',
      startedAt: new Date(),
      transcript: [],
    };

    // Initialize conversation AI
    this.conversationAI = new ConversationAI({
      apiKey: config.anthropicApiKey,
      goal,
      context,
    });
  }

  /**
   * Initialize the session when Twilio media stream connects
   * @param ws - WebSocket connection
   * @param startMessage - The 'start' event message from Twilio (already received by server)
   */
  async initializeMediaStream(ws: WebSocket, startMessage?: TwilioMediaMessage): Promise<void> {
    this.log(`[Session ${this.callId}] Initializing media stream...`);
    this.mediaWs = ws;

    // IMPORTANT: Attach WebSocket handlers FIRST, before awaiting STT connection.
    // This ensures we don't drop Twilio media frames that arrive during Deepgram startup.
    let mediaMessageCount = 0;
    const wsMessageHandler = (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString()) as TwilioMediaMessage;

        // Log every message type received (for debugging)
        if (msg.event === 'media') {
          mediaMessageCount++;
          if (mediaMessageCount <= 5 || mediaMessageCount % 100 === 0) {
            this.log(`[Twilio] Media #${mediaMessageCount}, track: ${msg.media?.track}`);
          }
        } else {
          this.log(`[Twilio] Event: ${msg.event}`);
        }

        this.handleTwilioMessage(msg);
      } catch (err) {
        this.log(`[Twilio] Parse error: ${err}`);
      }
    };

    const wsCloseHandler = () => {
      this.handleMediaStreamClose();
    };

    const wsErrorHandler = (err: Error) => {
      this.log(`[Twilio] WebSocket error: ${err}`);
    };

    ws.on('message', wsMessageHandler);
    ws.on('close', wsCloseHandler);
    ws.on('error', wsErrorHandler);

    this.mediaWsHandlers = [
      { event: 'message', handler: wsMessageHandler },
      { event: 'close', handler: wsCloseHandler },
      { event: 'error', handler: wsErrorHandler },
    ];

    // NOTE: Do NOT process startMessage here. It must be processed AFTER TTS is ready,
    // because the 'start' event triggers a delayed greeting that requires TTS.
    // See end of this method.

    // Initialize STT
    this.log('[STT] Connecting to Deepgram...');
    this.stt = createPhoneCallSTT(this.config.deepgramApiKey);

    // Store event handlers for cleanup
    const sttTranscriptHandler = (result: TranscriptResult) => {
      this.handleTranscript(result);
    };
    const sttErrorHandler = (err: Error) => this.log(`[STT] Error: ${err.message}`);
    const sttOpenHandler = () => this.log('[STT] Deepgram connected');
    const sttCloseHandler = () => this.log('[STT] Deepgram disconnected');

    this.stt.on('transcript', sttTranscriptHandler);
    this.stt.on('error', sttErrorHandler);
    this.stt.on('open', sttOpenHandler);
    this.stt.on('close', sttCloseHandler);

    this.sttHandlers = [
      { event: 'transcript', handler: sttTranscriptHandler },
      { event: 'error', handler: sttErrorHandler },
      { event: 'open', handler: sttOpenHandler },
      { event: 'close', handler: sttCloseHandler },
    ];

    this.connectSttInBackground();

    // Initialize TTS with streaming conversion
    this.log('[TTS] Setting up ElevenLabs (streaming mode)...');
    this.tts = createPhoneCallTTS(this.config.elevenLabsApiKey, this.config.elevenLabsVoiceId);

    let ttsChunks = 0;
    let ttsBytes = 0;

    // Store event handlers for cleanup
    const ttsAudioHandler = (chunk: Buffer, requestId?: number) => {
      if (requestId !== undefined && requestId !== this.decoderGeneration) {
        return;
      }
      ttsChunks++;
      ttsBytes += chunk.length;
      if (ttsChunks === 1) {
        this.log(`[TTS] First audio chunk: ${chunk.length} bytes`);
      }
      // ElevenLabs returns MP3 (regardless of output_format requested!)
      // Stream through ffmpeg decoder to convert to µ-law
      if (this.decoder?.running) {
        this.decoder.write(chunk);
      }
    };

    const ttsDoneHandler = (requestId?: number) => {
      if (requestId !== undefined && requestId !== this.decoderGeneration) {
        return;
      }
      this.log(`[TTS] Stream complete: ${ttsChunks} chunks, ${ttsBytes} bytes total, flushing decoder`);
      // Signal end of input to ffmpeg - it will flush remaining audio
      this.decoder?.end();
    };

    const ttsErrorHandler = (err: Error, requestId?: number) => {
      if (requestId !== undefined && requestId !== this.decoderGeneration) {
        return;
      }
      this.log(`[TTS] Error: ${this.formatError(err)}`);
    };

    this.tts.on('audio', ttsAudioHandler);
    this.tts.on('done', ttsDoneHandler);
    this.tts.on('error', ttsErrorHandler);

    this.ttsHandlers = [
      { event: 'audio', handler: ttsAudioHandler },
      { event: 'done', handler: ttsDoneHandler },
      { event: 'error', handler: ttsErrorHandler },
    ];

    this.log('[TTS] Ready (streaming)');

    // Process the start message AFTER TTS is ready.
    // The 'start' event triggers a delayed greeting that requires TTS to be initialized.
    // WebSocket handlers were attached early to capture media frames during STT connect,
    // but the startMessage must be processed here to ensure greeting works.
    if (startMessage) {
      this.log('[Session] Processing initial start message');
      this.handleTwilioMessage(startMessage);
    }
  }

  /**
   * Handle incoming Twilio media stream messages
   */
  private handleTwilioMessage(msg: TwilioMediaMessage): void {
    switch (msg.event) {
      case 'connected':
        this.log('[Twilio] Media stream connected');
        break;

      case 'start':
        if (msg.start) {
          this.streamSid = msg.start.streamSid;
          this.state.callSid = msg.start.callSid;
          this.callConnectedAtMs = Date.now();
          this.log(`[Session] Stream started - streamSid: ${this.streamSid}`);
          this.updateStatus('in-progress');
          this.emitMessage({ type: 'call_connected', callId: this.callId });

          this.prefetchGreeting();

          // Send AI-generated greeting after a short delay to ensure audio is ready.
          // If the remote party speaks first (common with IVRs), we delay greeting.
          this.scheduleInitialGreeting(GREETING_DELAY_MS);
        }
        break;

      case 'media':
        if (msg.media?.payload) {
          // Convert mulaw to PCM and send to STT (accept any track for now)
          const mulaw = Buffer.from(msg.media.payload, 'base64');
          const pcm = mulawToPcm(mulaw);
          if (!this.greetingStarted && !this.isSpeaking) {
            this.trackInboundSpeechActivity(pcm);
          }
          if (this.stt?.connected) {
            this.stt.sendAudio(pcm);
          } else {
            if (this.bufferedSttAudio.length >= MAX_BUFFERED_STT_CHUNKS) {
              this.bufferedSttAudio.shift();
            }
            this.bufferedSttAudio.push(pcm);
          }
        }
        break;

      case 'stop':
        this.handleMediaStreamClose();
        break;

      case 'mark':
        // Audio playback marker - can be used for timing
        if (msg.mark?.name === 'audio_done') {
          this.isPlaying = false;
          this.flushAudioQueue();
        }
        break;
    }
  }

  // How long to wait after final transcript before responding (ms)
  // This allows the human to pause mid-sentence without being interrupted
  // 1000ms = 1 second of silence before AI responds
  private static readonly RESPONSE_DEBOUNCE_MS = 1000;

  /**
   * Handle transcription results from Deepgram
   */
  private handleTranscript(result: TranscriptResult): void {
    const text = result.text.trim();
    if (!text) return;

    // IVRs often speak immediately after answer; avoid talking over them.
    if (!this.greetingStarted) {
      this.lastInboundTranscriptAtMs = Date.now();
    }

    const transcriptEndMs = this.getTranscriptEndTimestampMs(result);
    if (transcriptEndMs !== undefined && transcriptEndMs <= this.suppressSttUntilMs) {
      this.log(`[STT] Ignoring likely overlap transcript by word timing: "${result.text}"`);
      return;
    }

    // Prevent AI voice playback/echo from being treated as human speech.
    // This intentionally drops barge-in during playback to avoid self-transcription loops.
    if (this.isSpeaking || Date.now() < this.suppressSttUntilMs) {
      this.log(`[STT] Ignoring likely echo while AI audio is active: "${text}"`);
      return;
    }

    // Emit interim transcript events (for UI feedback)
    // But DON'T add to state.transcript yet - wait for debounce to combine segments
    this.emitMessage({
      type: 'transcript',
      callId: this.callId,
      text,
      role: 'human',
      isFinal: result.isFinal,
    });

    // For final transcripts, use debouncing to combine segments and avoid interrupting
    if (result.isFinal) {
      // Cancel any pending response timer
      if (this.responseDebounceTimer) {
        clearTimeout(this.responseDebounceTimer);
        this.log(`[Turn] More speech detected, extending wait...`);
      }

      // Accumulate transcript segments
      if (this.pendingTranscript) {
        this.pendingTranscript += ` ${text}`;
      } else {
        this.pendingTranscript = text;
      }
      this.log(`[Turn] Accumulated: "${this.pendingTranscript}"`);

      // If already processing a response, don't queue another
      if (this.isProcessingResponse) {
        this.log(`[Turn] AI still speaking, will respond after`);
        return;
      }

      // Start debounce timer - wait for more speech or timeout
      this.log(`[Turn] Waiting ${CallSession.RESPONSE_DEBOUNCE_MS}ms for more speech...`);
      this.responseDebounceTimer = setTimeout(() => {
        this.responseDebounceTimer = null;
        const fullTranscript = this.pendingTranscript.trim();
        this.pendingTranscript = '';

        if (fullTranscript && !this.isProcessingResponse) {
          // NOW add the combined transcript to state
          const entry: TranscriptEntry = {
            role: 'human',
            text: fullTranscript,
            timestamp: new Date(),
            isFinal: true,
          };
          this.state.transcript.push(entry);

          this.log(`[Turn] Silence confirmed, responding to: "${fullTranscript}"`);
          this.generateAIResponse(fullTranscript);
        }
      }, CallSession.RESPONSE_DEBOUNCE_MS);
    }
  }

  private trackInboundSpeechActivity(pcm: Buffer): void {
    const rms = calculateRms(pcm);
    if (rms >= PRE_GREETING_VAD_RMS_THRESHOLD) {
      this.consecutiveInboundSpeechChunks++;
      if (this.consecutiveInboundSpeechChunks >= PRE_GREETING_VAD_MIN_CONSECUTIVE_CHUNKS) {
        this.lastInboundAudioActivityAtMs = Date.now();
      }
    } else {
      this.consecutiveInboundSpeechChunks = 0;
    }
  }

  private scheduleInitialGreeting(delayMs: number): void {
    if (this.greetingStarted || this.cleanedUp) return;
    if (this.greetingTimer) {
      clearTimeout(this.greetingTimer);
    }

    this.greetingTimer = setTimeout(() => {
      this.greetingTimer = null;
      this.sendInitialGreeting().catch((err) => {
        this.log(`[AI] Greeting error: ${this.formatError(err)}`);
      });
    }, delayMs);
  }

  private connectSttInBackground(): void {
    void (async () => {
      if (!this.stt) return;

      try {
        await this.stt.connect();
        if (this.cleanedUp || !this.stt) return;

        this.log('[STT] Connection established');
        this.sttTimelineStartMs = Date.now();

        if (this.bufferedSttAudio.length > 0) {
          this.log(`[STT] Flushing ${this.bufferedSttAudio.length} buffered audio chunk(s)`);
          for (const pcm of this.bufferedSttAudio) {
            this.stt.sendAudio(pcm);
          }
          this.bufferedSttAudio = [];
        }
      } catch (err) {
        if (this.cleanedUp) return;
        const message = this.formatError(err);
        this.log(`[STT] Connection failed: ${message}`);
        this.emitMessage({
          type: 'error',
          callId: this.callId,
          message: `STT connection failed: ${message}`,
        });
      }
    })();
  }

  private prefetchGreeting(): void {
    if (this.greetingPrefetchPromise) return;
    this.greetingPrefetchPromise = this.conversationAI
      .getGreeting()
      .then((greeting) => greeting.trim() || null)
      .catch((err) => {
        this.log(`[AI] Greeting prefetch failed: ${this.formatError(err)}`);
        return null;
      });
  }

  private async sendInitialGreeting(): Promise<void> {
    if (this.greetingStarted || this.cleanedUp) return;

    const lastInboundActivityAtMs = Math.max(this.lastInboundTranscriptAtMs, this.lastInboundAudioActivityAtMs);
    if (lastInboundActivityAtMs) {
      const elapsed = Date.now() - lastInboundActivityAtMs;
      const callElapsed = this.callConnectedAtMs ? Date.now() - this.callConnectedAtMs : 0;
      if (elapsed < PRE_GREETING_IDLE_MS) {
        if (callElapsed >= MAX_GREETING_DEFERRAL_MS) {
          this.log('[AI] Greeting deferral timeout reached; proceeding');
        } else {
          this.log(`[AI] Deferring greeting; remote speech detected ${elapsed}ms ago`);
          this.scheduleInitialGreeting(PRE_GREETING_IDLE_MS - elapsed);
          return;
        }
      }
    }

    if (this.pendingTranscript || this.state.transcript.some((entry) => entry.role === 'human') || this.isProcessingResponse) {
      this.log('[AI] Skipping initial greeting because remote party spoke first');
      this.greetingStarted = true;
      return;
    }

    this.greetingStarted = true;

    try {
      this.log('[AI] Generating greeting...');
      const prefetchedGreeting = this.greetingPrefetchPromise ? await this.greetingPrefetchPromise : null;
      const greeting = prefetchedGreeting ?? (await this.conversationAI.getGreeting());
      this.log(`[AI] Greeting: "${greeting}"`);
      await this.speak(greeting);
    } catch (err) {
      const message = this.formatError(err);
      this.log(`[AI] Greeting error: ${message}`);
      this.emitMessage({
        type: 'error',
        callId: this.callId,
        message: this.isElevenLabsQuotaExceeded(err)
          ? this.getTTSOperatorMessage(err)
          : `Greeting generation failed: ${message}`,
      });
      if (this.isElevenLabsQuotaExceeded(err)) {
        await this.hangup();
        return;
      }

      // Fallback to basic greeting.
      const fallback = `Hello! I'm calling about: ${this.state.goal}`;
      this.speak(fallback).catch((fallbackErr) => {
        const fallbackMessage = this.getTTSOperatorMessage(fallbackErr);
        this.log(`[AI] Fallback error: ${fallbackMessage}`);
        this.emitMessage({
          type: 'error',
          callId: this.callId,
          message: fallbackMessage,
        });
      });
    }
  }

  private getTranscriptEndTimestampMs(result: TranscriptResult): number | undefined {
    if (!this.sttTimelineStartMs || !result.words || result.words.length === 0) {
      return undefined;
    }
    const maxWordEndSeconds = result.words.reduce((max, word) => Math.max(max, word.end), 0);
    return this.sttTimelineStartMs + Math.round(maxWordEndSeconds * 1000);
  }

  /**
   * Generate and speak AI response to human speech
   */
  private async generateAIResponse(humanSaid: string): Promise<void> {
    if (this.conversationAI.complete) {
      this.log('[AI] Conversation already complete, ignoring');
      return;
    }

    this.isProcessingResponse = true;
    const responseStart = Date.now();

    try {
      this.log(`[AI] Generating response to: "${humanSaid}"`);
      const lastAssistantUtterance = this.getLastAssistantUtterance();
      const shortAcknowledgement = isLikelyShortAcknowledgement(humanSaid);
      const lastAssistantQuestion = lastAssistantUtterance
        ? extractMostRecentQuestion(lastAssistantUtterance)
        : undefined;
      const response = await this.conversationAI.respond(humanSaid, {
        shortAcknowledgement,
        lastAssistantUtterance,
        lastAssistantQuestion,
      });
      this.log(`[AI] Response ready (${Date.now() - responseStart}ms, ${response?.length || 0} chars)`);

      if (response === null) {
        // Conversation is complete
        this.log('[AI] Conversation complete');
        await this.hangup();
        return;
      }

      this.log(`[TTS] Speaking: "${response.substring(0, 50)}..."`);
      await this.speak(response);
      this.log(`[TTS] Speech complete (${Date.now() - responseStart}ms total)`);

      // Check if AI marked conversation complete (handled internally)
      if (this.conversationAI.complete) {
        this.log(`[AI] Marked complete, ending call in ${CALL_COMPLETION_DELAY_MS}ms`);
        // Give a moment for the final response to be spoken
        // Clear any existing hangup timer first
        if (this.hangupTimer) {
          clearTimeout(this.hangupTimer);
        }
        this.hangupTimer = setTimeout(() => {
          this.hangupTimer = null;
          if (!this.cleanedUp) {
            this.hangup().catch((err) => this.log(`[Hangup] Error: ${err}`));
          }
        }, CALL_COMPLETION_DELAY_MS);
      }
    } catch (err) {
      const message = this.formatError(err);
      this.log(`[AI] Response error: ${message}`);
      this.emitMessage({
        type: 'error',
        callId: this.callId,
        message: this.isElevenLabsQuotaExceeded(err)
          ? this.getTTSOperatorMessage(err)
          : `AI response failed: ${message}`,
      });
      if (this.isElevenLabsQuotaExceeded(err)) {
        await this.hangup();
        return;
      }
      // Try to recover with a fallback
      try {
        await this.speak("I'm sorry, could you repeat that?");
      } catch (fallbackErr) {
        const fallbackMessage = this.getTTSOperatorMessage(fallbackErr);
        this.log(`[AI] Fallback response failed: ${fallbackMessage}`);
        this.emitMessage({
          type: 'error',
          callId: this.callId,
          message: fallbackMessage,
        });
      }
    } finally {
      this.isProcessingResponse = false;
    }
  }

  private getLastAssistantUtterance(): string | undefined {
    for (let i = this.state.transcript.length - 1; i >= 0; i--) {
      const entry = this.state.transcript[i];
      if (entry.role === 'assistant' && entry.text.trim()) {
        return entry.text.trim();
      }
    }
    return undefined;
  }

  /**
   * Speak text using TTS
   */
  async speak(text: string): Promise<void> {
    this.log(`[TTS] speak() called: "${text.substring(0, 50)}..."`);
    if (!this.tts || !this.mediaWs) {
      this.log(`[TTS] speak() failed: not initialized (tts: ${!!this.tts}, ws: ${!!this.mediaWs})`);
      throw new Error('Session not initialized');
    }

    // Cancel any ongoing speech
    if (this.isSpeaking) {
      this.tts.cancel();
      this.decoder?.stop();
    }

    // Reset streaming state
    this.audioQueue = [];

    for (let attempt = 0; attempt <= TTS_EMPTY_AUDIO_MAX_RETRIES; attempt++) {
      this.isSpeaking = true;

      // Increment generation to track which decoder is current
      this.decoderGeneration++;
      const currentGeneration = this.decoderGeneration;

      // Start ffmpeg decoder to convert MP3 → µ-law
      // (ElevenLabs always returns MP3 regardless of output_format requested)
      this.decoder = createStreamingDecoder();
      let resolveFirstChunk: (() => void) | null = null;
      const firstChunkPromise = new Promise<void>((resolve) => {
        resolveFirstChunk = resolve;
      });

      let decoderChunks = 0;
      let decoderBytes = 0;
      this.decoder.on('data', (mulaw: Buffer) => {
        // Only process data if this is still the current decoder
        if (currentGeneration !== this.decoderGeneration) return;

        decoderChunks++;
        decoderBytes += mulaw.length;
        if (decoderChunks === 1) {
          this.log(`[Decoder] First chunk: ${mulaw.length} bytes, first 4 bytes: ${mulaw.slice(0, 4).toString('hex')}`);
          resolveFirstChunk?.();
          resolveFirstChunk = null;
        }
        if (decoderChunks % 10 === 0) {
          this.log(`[Decoder] ${decoderChunks} chunks, ${decoderBytes} bytes total`);
        }
        // Send µ-law directly to Twilio as it's decoded
        this.sendAudioToTwilio(mulaw);
      });

      this.decoder.on('close', () => {
        // Only update isSpeaking if this is the current decoder
        if (currentGeneration === this.decoderGeneration) {
          this.log('[Decoder] Closed, speech complete');
          this.isSpeaking = false;
          this.suppressSttUntilMs = Date.now() + POST_TTS_STT_SUPPRESSION_MS;
        }
      });

      this.decoder.on('error', (err) => {
        this.log(`[Decoder] Error: ${err}`);
      });

      this.decoder.start();

      try {
        // Start TTS
        await this.tts.speak(text, currentGeneration);
        if (decoderChunks === 0) {
          // The decoder can lag behind the TTS "done" signal slightly; wait briefly before declaring empty output.
          await Promise.race([
            firstChunkPromise,
            new Promise((resolve) => setTimeout(resolve, TTS_DECODER_FLUSH_GRACE_MS)),
          ]);
          if (decoderChunks === 0) {
            throw new Error('TTS produced no audio output (decoder emitted 0 chunks)');
          }
        }

        // Add to transcript only after TTS succeeds.
        const entry: TranscriptEntry = {
          role: 'assistant',
          text,
          timestamp: new Date(),
          isFinal: true,
        };
        this.state.transcript.push(entry);

        // Emit transcript event only when audio was actually produced.
        this.emitMessage({
          type: 'transcript',
          callId: this.callId,
          text,
          role: 'assistant',
          isFinal: true,
        });
        return;
      } catch (err) {
        // Ensure we don't leave a stalled decoder when synthesis fails.
        if (currentGeneration === this.decoderGeneration) {
          this.decoder?.stop();
          this.isSpeaking = false;
        }

        const canRetry = this.isEmptyTtsAudioError(err) && attempt < TTS_EMPTY_AUDIO_MAX_RETRIES;
        if (!canRetry) {
          throw err;
        }

        const retryCount = attempt + 1;
        this.log(`[TTS] Empty audio output, retrying synthesis (${retryCount}/${TTS_EMPTY_AUDIO_MAX_RETRIES})`);
        this.tts.cancel();
        await new Promise((resolve) => setTimeout(resolve, TTS_EMPTY_AUDIO_RETRY_DELAY_MS));
      }
    }
    throw new Error('TTS failed after retry attempts');
  }

  /**
   * Send queued audio to Twilio
   */
  private flushAudioQueue(): void {
    if (!this.mediaWs || !this.streamSid || this.isPlaying || this.audioQueue.length === 0) {
      return;
    }

    this.log(`[Audio] Flushing ${this.audioQueue.length} chunks to Twilio`);
    this.isPlaying = true;

    // Send all queued audio
    let totalBytes = 0;
    while (this.audioQueue.length > 0) {
      const audio = this.audioQueue.shift();
      if (audio) {
        this.sendAudioToTwilio(audio);
        totalBytes += audio.length;
      }
    }

    this.log(`[Audio] Sent ${totalBytes} bytes total`);

    // Send mark to know when audio is done
    this.sendMarkToTwilio('audio_done');
  }

  /**
   * Send audio data to Twilio media stream
   */
  private sendAudioToTwilio(mulaw: Buffer): void {
    if (!this.mediaWs || !this.streamSid) {
      return;
    }

    const msg = {
      event: 'media',
      streamSid: this.streamSid,
      media: {
        payload: mulaw.toString('base64'),
      },
    };

    try {
      this.mediaWs.send(JSON.stringify(msg));
    } catch (err) {
      this.log(`[Audio] Send error: ${err}`);
    }
  }

  /**
   * Send a mark event to track audio playback
   */
  private sendMarkToTwilio(name: string): void {
    if (!this.mediaWs || !this.streamSid) return;

    const msg = {
      event: 'mark',
      streamSid: this.streamSid,
      mark: { name },
    };

    try {
      this.mediaWs.send(JSON.stringify(msg));
    } catch (err) {
      console.error('[Media WS] Mark error:', err);
    }
  }

  /**
   * Hang up the call
   */
  async hangup(): Promise<void> {
    this.log('[Session] Hanging up...');
    if (this.state.callSid) {
      try {
        await hangupCall(this.config, this.state.callSid);
      } catch (err) {
        this.log(`[Hangup] Error: ${err}`);
      }
    }

    this.cleanup();
    this.updateStatus('completed');
    this.emitEnded();
  }

  endFromProviderStatus(status: CallStatus): void {
    if (this.endedEmitted) return;
    this.log(`[Session] Ending from provider status: ${status}`);
    this.updateStatus(status);
    this.cleanup();
    this.emitEnded();
  }

  /**
   * Handle media stream close
   */
  private handleMediaStreamClose(): void {
    this.cleanup();

    if (this.state.status === 'in-progress') {
      this.updateStatus('completed');
    }

    this.emitEnded();
  }

  /**
   * Clean up resources
   */
  private cleanup(): void {
    if (this.cleanedUp) return;
    this.cleanedUp = true;

    // Clear timers
    if (this.responseDebounceTimer) {
      clearTimeout(this.responseDebounceTimer);
      this.responseDebounceTimer = null;
    }
    if (this.hangupTimer) {
      clearTimeout(this.hangupTimer);
      this.hangupTimer = null;
    }
    if (this.greetingTimer) {
      clearTimeout(this.greetingTimer);
      this.greetingTimer = null;
    }

    // Stop decoder
    if (this.decoder) {
      this.decoder.stop();
      this.decoder = null;
    }

    // Remove STT event listeners and close
    if (this.stt) {
      for (const { event, handler } of this.sttHandlers) {
        this.stt.removeListener(event, handler);
      }
      this.stt.close();
      this.stt = null;
    }
    this.sttHandlers = [];

    // Remove TTS event listeners and cancel
    if (this.tts) {
      for (const { event, handler } of this.ttsHandlers) {
        this.tts.removeListener(event, handler);
      }
      this.tts.cancel();
      this.tts = null;
    }
    this.ttsHandlers = [];

    // Remove WebSocket event listeners
    if (this.mediaWs) {
      for (const { event, handler } of this.mediaWsHandlers) {
        this.mediaWs.removeListener(event, handler);
      }
      this.mediaWs = null;
    }
    this.mediaWsHandlers = [];

    this.streamSid = null;
    this.bufferedSttAudio = [];
    this.state.endedAt = new Date();
  }

  /**
   * Update call status
   */
  updateStatus(status: CallStatus): void {
    this.state.status = status;
  }

  /**
   * Set the Twilio call SID
   */
  setCallSid(callSid: string): void {
    this.state.callSid = callSid;
  }

  /**
   * Emit a server message
   */
  private emitMessage(msg: ServerMessage): void {
    this.emit('message', msg);
  }

  /**
   * Emit ended event
   */
  private emitEnded(): void {
    if (this.endedEmitted) return;
    this.endedEmitted = true;

    const summary = this.generateSummary();
    this.state.summary = summary;

    this.emitMessage({
      type: 'call_ended',
      callId: this.callId,
      summary,
      status: this.state.status,
    });

    this.emit('ended', this.state);
  }

  /**
   * Generate a conversation summary
   */
  private generateSummary(): string {
    if (this.state.transcript.length === 0) {
      return 'No conversation recorded.';
    }

    const lines = this.state.transcript.map((t) => `${t.role === 'assistant' ? 'AI' : 'Human'}: ${t.text}`);

    return lines.join('\n');
  }

  /**
   * Get current state
   */
  getState(): CallState {
    return { ...this.state };
  }
}
