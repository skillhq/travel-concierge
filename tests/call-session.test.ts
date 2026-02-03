/**
 * Tests for CallSession media stream initialization
 * Specifically tests that greeting is spoken AFTER TTS is initialized
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockConversationAi = vi.hoisted(() => ({
  getGreeting: vi.fn().mockResolvedValue('Hello, this is an AI assistant.'),
  respond: vi.fn().mockResolvedValue('Thank you for your response.'),
  instances: [] as any[],
}));

// Mock the providers before importing CallSession
vi.mock('../src/lib/call/providers/deepgram.js', () => {
  return {
    createPhoneCallSTT: vi.fn(() => {
      const emitter = new EventEmitter();
      return Object.assign(emitter, {
        connect: vi.fn().mockResolvedValue(undefined),
        sendAudio: vi.fn(),
        close: vi.fn(),
        connected: true,
      });
    }),
    DeepgramSTT: vi.fn(),
  };
});

vi.mock('../src/lib/call/providers/elevenlabs.js', () => {
  class MockElevenLabsApiError extends Error {
    status: number;
    code?: string;
    provider = 'elevenlabs';
    rawBody: string;
    constructor(status: number, message: string, rawBody: string, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
      this.rawBody = rawBody;
    }
    get isQuotaExceeded(): boolean {
      return this.code === 'quota_exceeded';
    }
  }

  return {
    createPhoneCallTTS: vi.fn(() => {
      const emitter = new EventEmitter();
      return Object.assign(emitter, {
        speak: vi.fn().mockImplementation(async () => {
          emitter.emit('audio', Buffer.from([0x00, 0x01, 0x02]));
          emitter.emit('done');
        }),
        cancel: vi.fn(),
      });
    }),
    ElevenLabsTTS: vi.fn(),
    ElevenLabsApiError: MockElevenLabsApiError,
  };
});

vi.mock('../src/lib/call/providers/twilio.js', () => ({
  hangupCall: vi.fn(),
}));

vi.mock('../src/lib/call/conversation-ai.js', () => {
  class MockConversationAI {
    getGreeting = mockConversationAi.getGreeting;
    respond = mockConversationAi.respond;
    complete = false;
    constructor() {
      mockConversationAi.instances.push(this);
    }
  }
  return {
    ConversationAI: MockConversationAI,
    isLikelyShortAcknowledgement: vi.fn((text: string) => {
      const normalized = text
        .trim()
        .toLowerCase()
        .replace(/[^\w\s]/g, '');
      return ['yes', 'sure', 'true', 'ok', 'okay', 'no'].includes(normalized);
    }),
    extractMostRecentQuestion: vi.fn((text: string) => {
      const idx = text.lastIndexOf('?');
      if (idx === -1) return undefined;
      const start = text.lastIndexOf('.', idx);
      return text.slice(start === -1 ? 0 : start + 1, idx + 1).trim();
    }),
  };
});

vi.mock('../src/lib/call/audio/streaming-decoder.js', () => ({
  createStreamingDecoder: vi.fn(() => {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
      start: vi.fn(),
      write: vi.fn().mockImplementation((chunk: Buffer) => {
        emitter.emit('data', Buffer.from(chunk));
        return true;
      }),
      end: vi.fn().mockImplementation(() => {
        emitter.emit('close');
      }),
      stop: vi.fn().mockImplementation(() => {
        emitter.emit('close');
      }),
      running: true,
    });
  }),
}));

import { CallSession } from '../src/lib/call/call-session.js';
import type { ServerMessage, TwilioMediaMessage } from '../src/lib/call/call-types.js';
import { createPhoneCallSTT } from '../src/lib/call/providers/deepgram.js';
import { createPhoneCallTTS } from '../src/lib/call/providers/elevenlabs.js';

// Create a mock WebSocket
function createMockWebSocket() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1, // OPEN
  });
}

function createStartMessage(callId = 'test-call-id'): TwilioMediaMessage {
  return {
    event: 'start',
    start: {
      streamSid: 'test-stream-sid',
      callSid: 'test-call-sid',
      accountSid: 'test-account-sid',
      customParameters: { callId },
    },
  };
}

describe('CallSession', () => {
  const mockConfig = {
    twilioAccountSid: 'test-sid',
    twilioAuthToken: 'test-token',
    twilioPhoneNumber: '+1234567890',
    deepgramApiKey: 'test-deepgram-key',
    elevenLabsApiKey: 'test-elevenlabs-key',
    elevenLabsVoiceId: 'test-voice-id',
    anthropicApiKey: 'test-anthropic-key',
    serverPort: 3000,
    publicUrl: 'https://test.ngrok.io',
  };

  // Capture console.log to detect errors
  let logMessages: string[] = [];
  const originalLog = console.log;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    logMessages = [];
    mockConversationAi.instances = [];
    mockConversationAi.getGreeting.mockResolvedValue('Hello, this is an AI assistant.');
    mockConversationAi.respond.mockResolvedValue('Thank you for your response.');

    // Intercept console.log to capture error messages
    console.log = (...args: any[]) => {
      const message = args.map((a) => String(a)).join(' ');
      logMessages.push(message);
      originalLog(...args);
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    console.log = originalLog;
  });

  describe('initializeMediaStream', () => {
    it('should NOT fail greeting when STT connect is slow (P1 bug regression test)', async () => {
      // This test verifies the fix for the P1 bug:
      // When STT connect takes longer than the greeting delay (500ms),
      // the greeting should still succeed because TTS should be initialized
      // BEFORE the startMessage is processed.
      //
      // BUG SCENARIO (before fix):
      // 1. initializeMediaStream called with startMessage
      // 2. startMessage processed -> 500ms timer for greeting starts
      // 3. STT connect takes 800ms (still waiting)
      // 4. At 500ms, greeting timer fires, but TTS isn't initialized yet
      // 5. speak() throws "Session not initialized"
      //
      // CORRECT BEHAVIOR (after fix):
      // 1. initializeMediaStream called with startMessage
      // 2. WebSocket handlers attached (for early media capture)
      // 3. STT connect completes
      // 4. TTS initialized
      // 5. THEN startMessage processed -> greeting timer starts
      // 6. Greeting succeeds because TTS is ready

      const session = new CallSession(
        'test-call-id',
        mockConfig,
        '+1987654321',
        'Book a hotel room',
        'Customer: John Smith',
      );

      const mockWs = createMockWebSocket();
      const startMessage = createStartMessage();

      // Make STT connect take 800ms (longer than the 500ms greeting delay)
      const mockSTT = createPhoneCallSTT('test-key');
      (mockSTT.connect as ReturnType<typeof vi.fn>).mockImplementation(() => {
        return new Promise((resolve) => setTimeout(resolve, 800));
      });
      (createPhoneCallSTT as ReturnType<typeof vi.fn>).mockReturnValue(mockSTT);

      // Start initialization (don't await yet)
      const initPromise = session.initializeMediaStream(mockWs as any, startMessage);

      // Advance time to allow all timers to fire and STT to complete
      await vi.advanceTimersByTimeAsync(1500);

      // Wait for initialization to complete
      await initPromise;

      // Check that no "Session not initialized" errors occurred
      const sessionNotInitializedErrors = logMessages.filter(
        (msg) => msg.includes('speak() failed: not initialized') || msg.includes('Session not initialized'),
      );

      // With the bug, we'd see:
      // "[TTS] speak() failed: not initialized (tts: false, ws: true)"
      // "[AI] Greeting error: Error: Session not initialized"
      expect(sessionNotInitializedErrors).toHaveLength(0);
    });

    it('should attach WebSocket handlers before STT connect to capture early media', async () => {
      // This ensures the P1 fix properly attaches handlers early
      // while still processing startMessage after TTS is ready

      const session = new CallSession('test-call-id', mockConfig, '+1987654321', 'Book a hotel room');

      const mockWs = createMockWebSocket();
      let handlersAttachedBeforeSTTConnect = false;
      let sttConnectStarted = false;

      // Track when handlers are attached vs STT connect
      const originalOn = mockWs.on.bind(mockWs);
      mockWs.on = vi.fn((event: string, handler: any) => {
        if (event === 'message' && !sttConnectStarted) {
          handlersAttachedBeforeSTTConnect = true;
        }
        return originalOn(event, handler);
      });

      const mockSTT = createPhoneCallSTT('test-key');
      (mockSTT.connect as ReturnType<typeof vi.fn>).mockImplementation(() => {
        sttConnectStarted = true;
        return Promise.resolve();
      });
      (createPhoneCallSTT as ReturnType<typeof vi.fn>).mockReturnValue(mockSTT);

      await session.initializeMediaStream(mockWs as any);

      // WebSocket handlers should be attached BEFORE STT connect starts
      // This is required to capture early Twilio media frames
      expect(handlersAttachedBeforeSTTConnect).toBe(true);
    });

    it('should ignore transcript echoes while TTS is still speaking', async () => {
      const session = new CallSession('test-call-id', mockConfig, '+1987654321', 'Book a hotel room');

      const mockWs = createMockWebSocket();
      const startMessage = createStartMessage();
      const serverMessages: ServerMessage[] = [];
      session.on('message', (msg) => serverMessages.push(msg));

      const mockSTT = createPhoneCallSTT('test-key');
      (createPhoneCallSTT as ReturnType<typeof vi.fn>).mockReturnValue(mockSTT);

      const mockTTS = createPhoneCallTTS('test-elevenlabs-key', 'voice-id');
      (mockTTS.speak as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        mockTTS.emit('audio', Buffer.from([0x01, 0x02, 0x03]));
        await new Promise((resolve) => setTimeout(resolve, 300));
        mockTTS.emit('done');
      });
      (createPhoneCallTTS as ReturnType<typeof vi.fn>).mockReturnValue(mockTTS);

      await session.initializeMediaStream(mockWs as any, startMessage);
      await vi.advanceTimersByTimeAsync(520); // trigger delayed greeting and begin TTS

      mockSTT.emit('transcript', { text: 'Jennifer.', isFinal: true });
      await vi.advanceTimersByTimeAsync(100);

      const echoedHuman = serverMessages.find(
        (msg) => msg.type === 'transcript' && msg.role === 'human' && msg.text.includes('Jennifer'),
      );
      expect(echoedHuman).toBeUndefined();
    });

    it('should ignore transcript echoes briefly after TTS completes, then accept real speech', async () => {
      const session = new CallSession('test-call-id', mockConfig, '+1987654321', 'Book a hotel room');

      const mockWs = createMockWebSocket();
      const startMessage = createStartMessage();
      const serverMessages: ServerMessage[] = [];
      session.on('message', (msg) => serverMessages.push(msg));

      const mockSTT = createPhoneCallSTT('test-key');
      (createPhoneCallSTT as ReturnType<typeof vi.fn>).mockReturnValue(mockSTT);

      await session.initializeMediaStream(mockWs as any, startMessage);
      await vi.advanceTimersByTimeAsync(900); // greeting completes and suppression window starts

      mockSTT.emit('transcript', { text: 'Hello.', isFinal: true });
      await vi.advanceTimersByTimeAsync(200);

      const immediateEcho = serverMessages.find(
        (msg) => msg.type === 'transcript' && msg.role === 'human' && msg.text.includes('Hello'),
      );
      expect(immediateEcho).toBeUndefined();

      await vi.advanceTimersByTimeAsync(1100); // move past post-TTS suppression
      mockSTT.emit('transcript', { text: 'I need a room.', isFinal: true });
      await vi.advanceTimersByTimeAsync(1200); // debounce + response cycle

      const acceptedHuman = serverMessages.find(
        (msg) => msg.type === 'transcript' && msg.role === 'human' && msg.text.includes('I need a room'),
      );
      expect(acceptedHuman).toBeDefined();
    });

    it('should pass short-ack turn context to ConversationAI based on latest assistant question', async () => {
      const session = new CallSession('test-call-id', mockConfig, '+1987654321', 'Book a hotel room');
      const mockWs = createMockWebSocket();
      const startMessage = createStartMessage();
      const mockSTT = createPhoneCallSTT('test-key');
      (createPhoneCallSTT as ReturnType<typeof vi.fn>).mockReturnValue(mockSTT);

      mockConversationAi.getGreeting.mockResolvedValue(
        'Hi, this is an AI assistant. Would you be able to offer a better direct rate?',
      );
      mockConversationAi.respond.mockResolvedValue('Great, what direct price can you offer?');

      await session.initializeMediaStream(mockWs as any, startMessage);
      await vi.advanceTimersByTimeAsync(1700); // greeting delay + post-TTS suppression window

      mockSTT.emit('transcript', { text: 'Yes.', isFinal: true });
      await vi.advanceTimersByTimeAsync(1200); // debounce + response

      expect(mockConversationAi.respond).toHaveBeenCalled();
      const [humanText, turnContext] = mockConversationAi.respond.mock.calls.at(-1) as [
        string,
        {
          shortAcknowledgement: boolean;
          lastAssistantUtterance?: string;
          lastAssistantQuestion?: string;
        },
      ];
      expect(humanText).toBe('Yes.');
      expect(turnContext.shortAcknowledgement).toBe(true);
      expect(turnContext.lastAssistantQuestion).toContain('Would you be able to offer a better direct rate?');
      expect(turnContext.lastAssistantUtterance).toContain('Would you be able to offer a better direct rate?');
    });
  });
});
