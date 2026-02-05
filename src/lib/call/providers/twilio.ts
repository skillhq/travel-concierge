/**
 * Twilio provider for phone calls
 */

import Twilio from 'twilio';
import type { CallConfig, TwilioVoiceWebhook } from '../call-types.js';

export interface TwilioCallResult {
  callSid: string;
  status: string;
}

export interface TwilioPreflightResult {
  ok: boolean;
  provider: 'twilio';
  accountStatus?: string;
  fromNumberVerified?: boolean;
  message: string;
}

/**
 * Preflight check for Twilio call readiness.
 * Verifies credentials, account status, and that the configured from number exists on the account.
 */
export async function preflightTwilioCallSetup(config: CallConfig): Promise<TwilioPreflightResult> {
  const client = Twilio(config.twilioAccountSid, config.twilioAuthToken);
  const formattedFrom = formatPhoneNumber(config.twilioPhoneNumber);

  try {
    const account = await client.api.v2010.accounts(config.twilioAccountSid).fetch();
    const accountStatus = account.status;

    if (accountStatus && accountStatus !== 'active') {
      return {
        ok: false,
        provider: 'twilio',
        accountStatus,
        message: `Twilio preflight failed: account status is "${accountStatus}".`,
      };
    }

    const ownedNumbers = await client.incomingPhoneNumbers.list({
      phoneNumber: formattedFrom,
      limit: 1,
    });
    const fromNumberVerified = ownedNumbers.length > 0;

    if (!fromNumberVerified) {
      return {
        ok: false,
        provider: 'twilio',
        accountStatus,
        fromNumberVerified,
        message: `Twilio preflight failed: configured from-number ${formattedFrom} was not found on this Twilio account.`,
      };
    }

    return {
      ok: true,
      provider: 'twilio',
      accountStatus,
      fromNumberVerified,
      message: `Twilio preflight passed: account active and from-number ${formattedFrom} is configured.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      provider: 'twilio',
      message: `Twilio preflight failed: ${message}`,
    };
  }
}

/**
 * Initiate an outbound call via Twilio
 */
export async function initiateCall(config: CallConfig, toNumber: string, callId: string): Promise<TwilioCallResult> {
  const client = Twilio(config.twilioAccountSid, config.twilioAuthToken);

  // TwiML URL for the call - points to our webhook that returns Media Streams TwiML
  const twimlUrl = `${config.publicUrl}/twilio/voice?callId=${encodeURIComponent(callId)}`;

  // Status callback URL
  const statusCallbackUrl = `${config.publicUrl}/twilio/status?callId=${encodeURIComponent(callId)}`;

  const call = await client.calls.create({
    to: toNumber,
    from: config.twilioPhoneNumber,
    url: twimlUrl,
    method: 'POST',
    statusCallback: statusCallbackUrl,
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    statusCallbackMethod: 'POST',
    // Wait up to 120 seconds for answer (default ~60s is too short for hold lines)
    timeout: 120,
  });

  return {
    callSid: call.sid,
    status: call.status,
  };
}

/**
 * Generate TwiML for Media Streams connection
 */
export function generateMediaStreamsTwiml(config: CallConfig, callId: string): string {
  const wsUrl = `${config.publicUrl.replace('https://', 'wss://').replace('http://', 'ws://')}/media-stream?callId=${encodeURIComponent(callId)}`;

  // Using template literal for TwiML - cleaner than string concatenation
  // track="inbound_track" is REQUIRED to receive the caller's audio for STT
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(wsUrl)}" track="inbound_track">
      <Parameter name="callId" value="${escapeXml(callId)}" />
    </Stream>
  </Connect>
</Response>`;
}

/**
 * Generate TwiML to say something and hang up (for errors)
 */
export function generateErrorTwiml(message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${escapeXml(message)}</Say>
  <Hangup />
</Response>`;
}

/**
 * Hang up an active call
 */
export async function hangupCall(config: CallConfig, callSid: string): Promise<void> {
  const client = Twilio(config.twilioAccountSid, config.twilioAuthToken);

  await client.calls(callSid).update({
    status: 'completed',
  });
}

/**
 * Get call status
 */
export async function getCallStatus(config: CallConfig, callSid: string): Promise<string> {
  const client = Twilio(config.twilioAccountSid, config.twilioAuthToken);
  const call = await client.calls(callSid).fetch();
  return call.status;
}

/**
 * Parse Twilio webhook body
 */
export function parseWebhookBody(body: string | Record<string, string>): TwilioVoiceWebhook {
  if (typeof body === 'string') {
    // Parse URL-encoded body
    const params = new URLSearchParams(body);
    const result: Record<string, string> = {};
    for (const [key, value] of params) {
      result[key] = value;
    }
    return result as unknown as TwilioVoiceWebhook;
  }
  return body as unknown as TwilioVoiceWebhook;
}

/**
 * Validate Twilio webhook signature (optional but recommended for production)
 */
export function validateWebhookSignature(
  config: CallConfig,
  signature: string,
  url: string,
  params: Record<string, string>,
): boolean {
  return Twilio.validateRequest(config.twilioAuthToken, signature, url, params);
}

/**
 * Format phone number to E.164 format
 */
export function formatPhoneNumber(phone: string): string {
  // Remove all non-digit characters except leading +
  let cleaned = phone.replace(/[^\d+]/g, '');

  // Ensure it starts with +
  if (!cleaned.startsWith('+')) {
    // Assume US number if no country code
    if (cleaned.length === 10) {
      cleaned = `+1${cleaned}`;
    } else if (cleaned.length === 11 && cleaned.startsWith('1')) {
      cleaned = `+${cleaned}`;
    } else {
      cleaned = `+${cleaned}`;
    }
  }

  return cleaned;
}

/**
 * Escape XML special characters
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
