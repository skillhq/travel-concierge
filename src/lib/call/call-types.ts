/**
 * Type definitions for the voice call system
 */

// Call status states
export type CallStatus = 'initiating' | 'ringing' | 'in-progress' | 'completed' | 'failed' | 'busy' | 'no-answer';

// Call configuration
export interface CallConfig {
  twilioAccountSid: string;
  twilioAuthToken: string;
  twilioPhoneNumber: string;
  deepgramApiKey: string;
  elevenLabsApiKey: string;
  elevenLabsVoiceId: string;
  anthropicApiKey: string; // For AI conversation
  serverPort: number;
  publicUrl: string; // ngrok URL
}

// Validate call config has all required fields
export function validateCallConfig(config: Partial<CallConfig>): config is CallConfig {
  return !!(
    config.twilioAccountSid &&
    config.twilioAuthToken &&
    config.twilioPhoneNumber &&
    config.deepgramApiKey &&
    config.elevenLabsApiKey &&
    config.elevenLabsVoiceId &&
    config.anthropicApiKey &&
    config.serverPort &&
    config.publicUrl
  );
}

// Call request from Claude
export interface CallRequest {
  phoneNumber: string;
  goal: string;
  context?: string;
}

// Call state
export interface CallState {
  callId: string;
  callSid?: string; // Twilio call SID
  phoneNumber: string;
  goal: string;
  context?: string;
  status: CallStatus;
  startedAt: Date;
  endedAt?: Date;
  transcript: TranscriptEntry[];
  summary?: string;
}

// Transcript entry
export interface TranscriptEntry {
  role: 'assistant' | 'human';
  text: string;
  timestamp: Date;
  isFinal: boolean;
}

// WebSocket messages: Server → Client
export type ServerMessage =
  | { type: 'call_started'; callId: string; callSid?: string }
  | { type: 'call_ringing'; callId: string }
  | { type: 'call_connected'; callId: string }
  | { type: 'transcript'; callId: string; text: string; role: 'assistant' | 'human'; isFinal: boolean }
  | { type: 'call_ended'; callId: string; summary: string; status: CallStatus }
  | { type: 'error'; callId?: string; message: string };

// WebSocket messages: Client → Server
export type ClientMessage =
  | { type: 'initiate_call'; phoneNumber: string; goal: string; context?: string }
  | { type: 'speak'; callId: string; text: string }
  | { type: 'hangup'; callId: string };

// Twilio Media Stream message types
export interface TwilioMediaMessage {
  event: 'connected' | 'start' | 'media' | 'stop' | 'mark';
  sequenceNumber?: string;
  streamSid?: string;
  start?: {
    streamSid: string;
    accountSid: string;
    callSid: string;
    tracks: string[];
    customParameters: Record<string, string>;
    mediaFormat: {
      encoding: string;
      sampleRate: number;
      channels: number;
    };
  };
  media?: {
    track: 'inbound' | 'outbound';
    chunk: string;
    timestamp: string;
    payload: string; // base64 encoded audio
  };
  mark?: {
    name: string;
  };
  stop?: {
    accountSid: string;
    callSid: string;
  };
}

// Twilio webhook callback types
export interface TwilioVoiceWebhook {
  CallSid: string;
  AccountSid: string;
  From: string;
  To: string;
  CallStatus: 'queued' | 'ringing' | 'in-progress' | 'completed' | 'busy' | 'failed' | 'no-answer';
  ApiVersion: string;
  Direction: 'inbound' | 'outbound-api' | 'outbound-dial';
  ForwardedFrom?: string;
  CallerName?: string;
  ParentCallSid?: string;
  Duration?: string;
  CallDuration?: string;
}

// ElevenLabs voice settings
export interface ElevenLabsVoiceSettings {
  stability: number;
  similarity_boost: number;
  style?: number;
  use_speaker_boost?: boolean;
}

// Audio chunk for streaming
export interface AudioChunk {
  data: Buffer;
  timestamp: number;
}
