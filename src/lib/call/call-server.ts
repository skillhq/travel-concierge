/**
 * Call server - HTTP + WebSocket server for voice calls
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { CallSession } from './call-session.js';
import type { CallConfig, CallState, CallStatus, ClientMessage, ServerMessage } from './call-types.js';
import { preflightDeepgramSTT } from './providers/deepgram.js';
import { preflightElevenLabsTTSBudget } from './providers/elevenlabs.js';
import { preflightFfmpeg } from './providers/local-deps.js';
import {
  formatPhoneNumber,
  generateErrorTwiml,
  generateMediaStreamsTwiml,
  getCallRecordings,
  getCallStatus,
  initiateCall,
  parseWebhookBody,
  preflightTwilioCallSetup,
  validateWebhookSignature,
} from './providers/twilio.js';

// Maximum request body size (1MB)
const MAX_BODY_SIZE = 1024 * 1024;
// Maximum lengths for call request fields
const MAX_PHONE_LENGTH = 20;
const MAX_GOAL_LENGTH = 1000;
const MAX_CONTEXT_LENGTH = 5000;
const TERMINAL_CALL_STATUSES = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled']);
const STATUS_RECONCILE_INTERVAL_MS = 10000;
const PUBLIC_WEBHOOK_PREFLIGHT_TIMEOUT_MS = 6000;

export interface CallServerOptions {
  port: number;
  publicUrl: string;
  config: CallConfig;
}

export interface CallServerEvents {
  started: () => void;
  stopped: () => void;
  call_started: (callId: string) => void;
  call_ended: (callId: string, state: CallState) => void;
  error: (error: Error) => void;
}

export class CallServer extends EventEmitter {
  private server: Server | null = null;
  private controlWss: WebSocketServer | null = null;
  private mediaWss: WebSocketServer | null = null;
  private readonly options: CallServerOptions;
  private readonly sessions: Map<string, CallSession> = new Map();
  private readonly controlClients: Set<WebSocket> = new Set();
  private statusReconcileTimer: NodeJS.Timeout | null = null;

  private isPreflightCallId(callId: string | null): boolean {
    return !!callId && callId.startsWith('preflight-');
  }

  constructor(options: CallServerOptions) {
    super();
    this.options = options;
  }

  private timestamp(): string {
    return new Date().toISOString();
  }

  private log(message: string): void {
    console.log(`[${this.timestamp()}] ${message}`);
  }

  private warn(message: string): void {
    console.warn(`[${this.timestamp()}] ${message}`);
  }

  private error(message: string, error?: unknown): void {
    if (error !== undefined) {
      console.error(`[${this.timestamp()}] ${message}`, error);
    } else {
      console.error(`[${this.timestamp()}] ${message}`);
    }
  }

  /**
   * Start the server
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Create HTTP server
        this.server = createServer((req, res) => this.handleHttpRequest(req, res));

        // Create WebSocket servers
        this.controlWss = new WebSocketServer({ noServer: true });
        this.mediaWss = new WebSocketServer({ noServer: true });

        // Handle WebSocket upgrades
        this.server.on('upgrade', (request, socket, head) => {
          const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
          const pathname = url.pathname;
          this.log(`[Server] WebSocket upgrade request: ${pathname}`);

          if (pathname === '/control') {
            this.log('[Server] Handling /control WebSocket upgrade');
            this.controlWss?.handleUpgrade(request, socket, head, (ws) => {
              this.handleControlConnection(ws);
            });
          } else if (pathname.startsWith('/media-stream')) {
            // Twilio doesn't pass query params in WebSocket URL - callId comes in 'start' event
            this.log('[Server] Handling /media-stream WebSocket upgrade');
            this.mediaWss?.handleUpgrade(request, socket, head, (ws) => {
              this.handleMediaStreamConnection(ws);
            });
          } else {
            this.log(`[Server] Unknown WebSocket path: ${pathname}, destroying socket`);
            socket.destroy();
          }
        });

        this.server.listen(this.options.port, () => {
          this.log(`Call server listening on port ${this.options.port}`);
          this.log(`Public URL: ${this.options.publicUrl}`);
          this.startStatusReconcileLoop();
          this.emit('started');
          resolve();
        });

        this.server.on('error', (err) => {
          this.emit('error', err);
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    if (this.statusReconcileTimer) {
      clearInterval(this.statusReconcileTimer);
      this.statusReconcileTimer = null;
    }

    // End all active calls
    for (const session of this.sessions.values()) {
      await session.hangup();
    }
    this.sessions.clear();

    // Close control clients
    for (const client of this.controlClients) {
      client.close();
    }
    this.controlClients.clear();

    // Close WebSocket servers
    this.controlWss?.close();
    this.mediaWss?.close();

    // Close HTTP server
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          this.emit('stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Handle HTTP requests
   */
  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const method = req.method ?? 'GET';

    // CORS headers for local development
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Route requests
    if (method === 'GET' && url.pathname === '/health') {
      this.handleHealthCheck(res);
    } else if (method === 'GET' && url.pathname === '/status') {
      this.handleStatusCheck(res);
    } else if (method === 'POST' && url.pathname === '/call') {
      this.handleCallRequest(req, res);
    } else if ((method === 'POST' || method === 'GET') && url.pathname === '/twilio/voice') {
      this.handleTwilioVoice(req, res, url);
    } else if ((method === 'POST' || method === 'GET') && url.pathname === '/twilio/status') {
      this.handleTwilioStatus(req, res, url);
    } else if (method === 'GET' && url.pathname.startsWith('/status/')) {
      this.handleCallStatusCheck(res, url.pathname.split('/').pop() ?? '');
    } else if (method === 'GET' && url.pathname.startsWith('/recordings/')) {
      this.handleRecordingsRequest(
        res,
        url.pathname.split('/').pop() ?? '',
        url.searchParams.get('download') === 'true',
      );
    } else {
      this.warn(`[HTTP] Unhandled request ${method} ${url.pathname}`);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  }

  /**
   * Health check endpoint
   */
  private handleHealthCheck(res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  }

  /**
   * Server status endpoint
   */
  private handleStatusCheck(res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'running',
        activeCalls: this.sessions.size,
        controlClients: this.controlClients.size,
        publicUrl: this.options.publicUrl,
      }),
    );
  }

  /**
   * Call status endpoint
   */
  private handleCallStatusCheck(res: ServerResponse, callId: string): void {
    const session = this.sessions.get(callId);
    if (session) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(session.getState()));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Call not found' }));
    }
  }

  /**
   * Get recordings for a call (returns metadata or audio)
   * GET /recordings/:callSid - returns JSON with recording metadata
   * GET /recordings/:callSid?download=true - returns audio/wav
   */
  private async handleRecordingsRequest(res: ServerResponse, callSid: string, shouldDownload: boolean): Promise<void> {
    if (!callSid) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing callSid' }));
      return;
    }

    const actualCallSid = callSid;

    try {
      const recordings = await getCallRecordings(this.options.config, actualCallSid);

      if (!shouldDownload) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ recordings }));
        return;
      }

      // Download mode - fetch and return the first recording's audio
      if (recordings.length === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No recordings found' }));
        return;
      }

      const recording = recordings[0];
      const { twilioAccountSid, twilioAuthToken } = this.options.config;
      const authHeader = `Basic ${Buffer.from(`${twilioAccountSid}:${twilioAuthToken}`).toString('base64')}`;

      const audioResponse = await fetch(recording.url, {
        headers: { Authorization: authHeader },
      });

      if (!audioResponse.ok) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Failed to download recording: ${audioResponse.status}` }));
        return;
      }

      const audioBuffer = await audioResponse.arrayBuffer();
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Content-Disposition': `attachment; filename="recording-${actualCallSid}.wav"`,
        'Content-Length': audioBuffer.byteLength,
      });
      res.end(Buffer.from(audioBuffer));
    } catch (error) {
      this.error(`[Recordings] Failed to fetch recordings for ${actualCallSid}`, error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to fetch recordings' }));
    }
  }

  /**
   * Initiate a new call via HTTP
   */
  private async handleCallRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body = '';
    let bodySize = 0;

    req.on('data', (chunk: Buffer) => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY_SIZE) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body too large' }));
        req.destroy();
        return;
      }
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const data = JSON.parse(body) as { phoneNumber: string; goal: string; context?: string };

        // Input validation
        if (!data.phoneNumber || typeof data.phoneNumber !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'phoneNumber is required' }));
          return;
        }
        if (!data.goal || typeof data.goal !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'goal is required' }));
          return;
        }
        if (data.phoneNumber.length > MAX_PHONE_LENGTH) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'phoneNumber too long' }));
          return;
        }
        if (data.goal.length > MAX_GOAL_LENGTH) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'goal too long' }));
          return;
        }
        if (data.context && data.context.length > MAX_CONTEXT_LENGTH) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'context too long' }));
          return;
        }

        const callId = await this.initiateCallInternal(data.phoneNumber, data.goal, data.context);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ callId, status: 'initiating' }));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Internal server error';
        const statusCode = message.toLowerCase().includes('preflight') ? 400 : 500;
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
      }
    });
  }

  /**
   * Twilio voice webhook - returns TwiML for Media Streams
   */
  private handleTwilioVoice(req: IncomingMessage, res: ServerResponse, url: URL): void {
    let body = '';
    let bodySize = 0;

    req.on('data', (chunk: Buffer) => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY_SIZE) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body too large' }));
        req.destroy();
        return;
      }
      body += chunk.toString();
    });

    req.on('end', () => {
      // Validate Twilio webhook signature
      const signature = req.headers['x-twilio-signature'] as string | undefined;
      const webhookUrl = `${this.options.publicUrl}${req.url}`;
      const params = parseWebhookBody(body);
      const callId = url.searchParams.get('callId');

      this.log(
        `[Twilio] /voice webhook received callId=${callId ?? 'missing'} signature=${signature ? 'present' : 'missing'}`,
      );

      if (
        signature &&
        !validateWebhookSignature(
          this.options.config,
          signature,
          webhookUrl,
          params as unknown as Record<string, string>,
        )
      ) {
        this.warn('[Twilio] Invalid webhook signature');
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid signature' }));
        return;
      }

      if (!callId || !this.sessions.has(callId)) {
        if (!this.isPreflightCallId(callId)) {
          this.warn(`[Twilio] /voice webhook has unknown callId=${callId ?? 'missing'}`);
        }
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        res.end(generateErrorTwiml('Sorry, this call cannot be connected. Please try again later.'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(generateMediaStreamsTwiml(this.options.config, callId));
    });
  }

  /**
   * Twilio status callback
   */
  private handleTwilioStatus(req: IncomingMessage, res: ServerResponse, url: URL): void {
    let body = '';
    let bodySize = 0;

    req.on('data', (chunk: Buffer) => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY_SIZE) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body too large' }));
        req.destroy();
        return;
      }
      body += chunk.toString();
    });

    req.on('end', () => {
      // Validate Twilio webhook signature
      const signature = req.headers['x-twilio-signature'] as string | undefined;
      const webhookUrl = `${this.options.publicUrl}${req.url}`;
      const params = parseWebhookBody(body);

      if (
        signature &&
        !validateWebhookSignature(
          this.options.config,
          signature,
          webhookUrl,
          params as unknown as Record<string, string>,
        )
      ) {
        this.warn('[Twilio] Invalid webhook signature');
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid signature' }));
        return;
      }

      const callId = url.searchParams.get('callId');
      const webhook = params;
      const session = callId ? this.sessions.get(callId) : null;
      const status = webhook.CallStatus;

      this.log(
        `[Twilio] /status callback callId=${callId ?? 'missing'} status=${status ?? 'unknown'} callSid=${
          webhook.CallSid ?? 'unknown'
        }`,
      );

      if (session) {
        switch (status) {
          case 'ringing':
            session.updateStatus('ringing');
            this.broadcastToControl({ type: 'call_ringing', callId: session.callId });
            break;
          case 'in-progress':
            // Keep status in sync for cases where media stream never starts.
            session.updateStatus('in-progress');
            break;
          case 'completed':
          case 'busy':
          case 'failed':
          case 'no-answer':
          case 'canceled':
            session.endFromProviderStatus(status);
            break;
        }
      } else if (callId) {
        if (!this.isPreflightCallId(callId)) {
          this.warn(`[Twilio] /status callback for unknown callId=${callId}`);
        }
      }

      if (status && TERMINAL_CALL_STATUSES.has(status) && !session && !this.isPreflightCallId(callId)) {
        this.warn(`[Twilio] Terminal status received without active session: ${status}`);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received: true }));
    });
  }

  /**
   * Handle control WebSocket connection
   */
  private handleControlConnection(ws: WebSocket): void {
    this.log('[Control] Client connected');
    this.controlClients.add(ws);

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString()) as ClientMessage;
        await this.handleControlMessage(ws, msg);
      } catch (err) {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: err instanceof Error ? err.message : 'Invalid message',
          } as ServerMessage),
        );
      }
    });

    ws.on('close', () => {
      this.log('[Control] Client disconnected');
      this.controlClients.delete(ws);
    });

    ws.on('error', (err) => {
      this.error('[Control] Error:', err);
      this.controlClients.delete(ws);
    });
  }

  /**
   * Handle control messages from clients
   */
  private async handleControlMessage(ws: WebSocket, msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case 'initiate_call': {
        // initiateCallInternal broadcasts call_started to all control clients,
        // so we don't need to send it directly to avoid duplicate events
        await this.initiateCallInternal(msg.phoneNumber, msg.goal, msg.context);
        break;
      }

      case 'speak': {
        const session = this.sessions.get(msg.callId);
        if (session) {
          await session.speak(msg.text);
        } else {
          ws.send(
            JSON.stringify({
              type: 'error',
              callId: msg.callId,
              message: 'Call not found',
            } as ServerMessage),
          );
        }
        break;
      }

      case 'hangup': {
        const session = this.sessions.get(msg.callId);
        if (session) {
          await session.hangup();
        }
        break;
      }
    }
  }

  /**
   * Handle media stream WebSocket connection
   * Twilio sends callId in the 'start' event's customParameters, not in the URL
   */
  private handleMediaStreamConnection(ws: WebSocket): void {
    this.log('[Media] Stream WebSocket connected, waiting for start event...');
    this.log(`[Media] Active sessions: ${[...this.sessions.keys()].join(', ')}`);

    let sessionInitialized = false;

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        // Handle the 'start' event to get callId from customParameters
        if (msg.event === 'start' && !sessionInitialized) {
          const callId = msg.start?.customParameters?.callId;
          this.log(`[Media] Received start event, callId: ${callId}`);

          if (!callId) {
            this.error('[Media] No callId in start event customParameters');
            ws.close(1008, 'Missing callId');
            return;
          }

          const session = this.sessions.get(callId);
          if (!session) {
            this.error(`[Media] No session found for call ${callId}`);
            ws.close(1008, 'Call not found');
            return;
          }

          sessionInitialized = true;
          this.log('[Media] Found session, initializing media stream...');
          session
            .initializeMediaStream(ws, msg)
            .then(() => {
              this.log('[Media] Media stream initialized successfully');
            })
            .catch((err) => {
              this.error('[Media] Failed to initialize:', err);
              // Clean up session on initialization failure
              this.sessions.delete(callId);
              this.emit('error', err instanceof Error ? err : new Error(String(err)));
              ws.close(1011, 'Failed to initialize');
            });
        }
      } catch (err) {
        this.error('[Media] Error parsing message:', err);
      }
    });

    ws.on('close', () => {
      this.log('[Media] WebSocket closed');
    });

    ws.on('error', (err) => {
      this.error('[Media] WebSocket error:', err);
    });
  }

  /**
   * Internal method to initiate a call
   */
  private async initiateCallInternal(phoneNumber: string, goal: string, context?: string): Promise<string> {
    const [ffmpegPreflight, twilioPreflight, deepgramPreflight, elevenLabsPreflight] = await Promise.all([
      preflightFfmpeg(),
      preflightTwilioCallSetup(this.options.config),
      preflightDeepgramSTT(this.options.config.deepgramApiKey),
      preflightElevenLabsTTSBudget(this.options.config.elevenLabsApiKey, goal, context),
    ]);

    const failedPreflight = [ffmpegPreflight, twilioPreflight, deepgramPreflight, elevenLabsPreflight].find(
      (result) => !result.ok,
    );
    if (failedPreflight) {
      throw new Error(failedPreflight.message);
    }

    this.log(`[Preflight] ${ffmpegPreflight.message}`);
    this.log(`[Preflight] ${twilioPreflight.message}`);
    this.log(`[Preflight] ${deepgramPreflight.message}`);
    this.log(`[Preflight] ${elevenLabsPreflight.message}`);

    const publicWebhookPreflight = await this.preflightPublicWebhook();
    if (!publicWebhookPreflight.ok) {
      throw new Error(publicWebhookPreflight.message);
    }
    this.log(`[Preflight] ${publicWebhookPreflight.message}`);

    const callId = randomUUID();
    const formattedNumber = formatPhoneNumber(phoneNumber);

    // Create session
    const session = new CallSession(callId, this.options.config, formattedNumber, goal, context);

    // Forward session events to control clients
    session.on('message', (msg: ServerMessage) => {
      this.broadcastToControl(msg);
    });

    session.on('ended', (state: CallState) => {
      this.sessions.delete(callId);
      this.emit('call_ended', callId, state);
    });

    this.sessions.set(callId, session);

    // Initiate call via Twilio
    try {
      const result = await initiateCall(this.options.config, formattedNumber, callId);
      session.setCallSid(result.callSid);

      this.emit('call_started', callId);
      this.broadcastToControl({
        type: 'call_started',
        callId,
        callSid: result.callSid,
      });

      return callId;
    } catch (err) {
      this.sessions.delete(callId);
      throw err;
    }
  }

  /**
   * Broadcast message to all control clients
   */
  private broadcastToControl(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const client of this.controlClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  /**
   * Get a session by call ID
   */
  getSession(callId: string): CallSession | undefined {
    return this.sessions.get(callId);
  }

  /**
   * Get all active sessions
   */
  getActiveSessions(): Map<string, CallSession> {
    return new Map(this.sessions);
  }

  /**
   * Check if server is running
   */
  get isRunning(): boolean {
    return this.server !== null;
  }

  private startStatusReconcileLoop(): void {
    if (this.statusReconcileTimer) {
      clearInterval(this.statusReconcileTimer);
    }
    this.statusReconcileTimer = setInterval(() => {
      this.reconcileStatusesWithProvider().catch((err) => {
        this.warn(`[Twilio] Status reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, STATUS_RECONCILE_INTERVAL_MS);
  }

  private async reconcileStatusesWithProvider(): Promise<void> {
    if (this.sessions.size === 0) return;

    for (const session of this.sessions.values()) {
      const state = session.getState();
      const callSid = state.callSid;
      if (!callSid) continue;
      if (TERMINAL_CALL_STATUSES.has(state.status)) continue;

      const providerStatus = await getCallStatus(this.options.config, callSid);
      const normalized = providerStatus as
        | 'queued'
        | 'ringing'
        | 'in-progress'
        | 'completed'
        | 'busy'
        | 'failed'
        | 'no-answer'
        | 'canceled';

      if (normalized === 'ringing' && state.status !== 'ringing') {
        session.updateStatus('ringing');
        this.broadcastToControl({ type: 'call_ringing', callId: state.callId });
      } else if (normalized === 'in-progress' && state.status !== 'in-progress') {
        session.updateStatus('in-progress');
      } else if (
        normalized === 'completed' ||
        normalized === 'busy' ||
        normalized === 'failed' ||
        normalized === 'no-answer' ||
        normalized === 'canceled'
      ) {
        const terminalStatus: CallStatus = normalized;
        this.log(`[Twilio] Reconciled terminal status callId=${state.callId} status=${terminalStatus}`);
        session.endFromProviderStatus(terminalStatus);
      }
    }
  }

  private async preflightPublicWebhook(): Promise<{ ok: boolean; message: string }> {
    const publicUrl = this.options.publicUrl.replace(/\/+$/, '');
    if (!publicUrl.startsWith('https://') && !publicUrl.startsWith('http://')) {
      return {
        ok: false,
        message: `Public webhook preflight failed: invalid publicUrl "${this.options.publicUrl}".`,
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PUBLIC_WEBHOOK_PREFLIGHT_TIMEOUT_MS);
    const preflightCallId = `preflight-${randomUUID().slice(0, 8)}`;

    try {
      const healthResponse = await fetch(`${publicUrl}/health`, {
        method: 'GET',
        signal: controller.signal,
      });
      if (!healthResponse.ok) {
        return {
          ok: false,
          message: `Public webhook preflight failed: ${publicUrl}/health returned HTTP ${healthResponse.status}.`,
        };
      }

      const voiceResponse = await fetch(`${publicUrl}/twilio/voice?callId=${encodeURIComponent(preflightCallId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'CallSid=CApreflight&CallStatus=ringing',
        signal: controller.signal,
      });
      if (!voiceResponse.ok) {
        return {
          ok: false,
          message: `Public webhook preflight failed: ${publicUrl}/twilio/voice returned HTTP ${voiceResponse.status}.`,
        };
      }

      const statusResponse = await fetch(`${publicUrl}/twilio/status?callId=${encodeURIComponent(preflightCallId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'CallSid=CApreflight&CallStatus=ringing',
        signal: controller.signal,
      });
      if (!statusResponse.ok) {
        return {
          ok: false,
          message: `Public webhook preflight failed: ${publicUrl}/twilio/status returned HTTP ${statusResponse.status}.`,
        };
      }

      return {
        ok: true,
        message: `Public webhook preflight passed: ${publicUrl} is reachable for Twilio voice and status callbacks.`,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        message: `Public webhook preflight failed: could not reach ${publicUrl} (${detail}).`,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Create and configure a call server
 */
export function createCallServer(config: CallConfig, port: number, publicUrl: string): CallServer {
  return new CallServer({
    port,
    publicUrl,
    config,
  });
}
