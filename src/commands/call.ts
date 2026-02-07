/**
 * Call command - Make phone calls via the voice call server
 */

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import * as readline from 'node:readline';
import type { Command } from 'commander';
import { WebSocket } from 'ws';
import type { CliContext } from '../cli/shared.js';
import type { ClientMessage, ServerMessage } from '../lib/call/index.js';
import { preflightNgrok } from '../lib/call/providers/local-deps.js';
import { loadConfig } from '../lib/config.js';

const RECORDING_POLL_INTERVAL_MS = 3000;
const RECORDING_POLL_MAX_ATTEMPTS = 20; // 60 seconds max wait

const NGROK_START_TIMEOUT_MS = 20000;
const SERVER_START_TIMEOUT_MS = 25000;
const PUBLIC_WEBHOOK_STABILITY_WINDOW_MS = 25000;
const PUBLIC_WEBHOOK_STABILITY_PROBE_INTERVAL_MS = 2500;

interface ManagedInfraRuntime {
  enabled: boolean;
  ngrok?: ChildProcess;
  server?: ChildProcess;
  logDir?: string;
  ngrokLogPath?: string;
  serverLogPath?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function fetchAndSaveRecording(
  port: number,
  callSid: string,
  logDir: string,
  colors: CliContext['colors'],
): Promise<string | null> {
  console.log(colors.muted('Fetching call recording...'));

  for (let attempt = 0; attempt < RECORDING_POLL_MAX_ATTEMPTS; attempt++) {
    try {
      // First check if recordings are available
      const metaResponse = await fetch(`http://localhost:${port}/recordings/${callSid}`);
      if (!metaResponse.ok) {
        throw new Error(`Server returned ${metaResponse.status}`);
      }

      const meta = (await metaResponse.json()) as { recordings: { sid: string; duration: number }[] };
      if (!meta.recordings || meta.recordings.length === 0 || meta.recordings[0].duration < 0) {
        if (attempt < RECORDING_POLL_MAX_ATTEMPTS - 1) {
          await delay(RECORDING_POLL_INTERVAL_MS);
          continue;
        }
        console.log(colors.warning('No recording available (call may have been too short)'));
        return null;
      }

      // Download the recording
      const downloadResponse = await fetch(`http://localhost:${port}/recordings/${callSid}?download=true`);
      if (!downloadResponse.ok) {
        throw new Error(`Download failed: ${downloadResponse.status}`);
      }

      const audioBuffer = await downloadResponse.arrayBuffer();
      const recordingPath = join(logDir, `recording-${callSid}.wav`);
      writeFileSync(recordingPath, Buffer.from(audioBuffer));

      console.log(colors.success(`Recording saved: ${recordingPath}`));
      return recordingPath;
    } catch (error) {
      if (attempt < RECORDING_POLL_MAX_ATTEMPTS - 1) {
        await delay(RECORDING_POLL_INTERVAL_MS);
        continue;
      }
      const msg = error instanceof Error ? error.message : String(error);
      console.log(colors.warning(`Could not fetch recording: ${msg}`));
      return null;
    }
  }

  return null;
}

function getCliEntryPath(): string {
  if (process.argv[1]) {
    return resolve(process.argv[1]);
  }
  return resolve(process.cwd(), 'dist', 'cli.js');
}

function createInfraLogPaths(
  baseDir?: string,
  phone?: string,
): { logDir: string; ngrokLogPath: string; serverLogPath: string } {
  const sanitizedPhone = phone ? phone.replace(/[^+\dA-Za-z]/g, '') : undefined;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = randomUUID().slice(0, 8);
  const runId = sanitizedPhone ? `${sanitizedPhone}_${timestamp}-${suffix}` : `${timestamp}-${suffix}`;
  const base = baseDir ?? join(homedir(), '.config', 'concierge', 'call-runs');
  const logDir = join(base, runId);
  mkdirSync(logDir, { recursive: true });
  return {
    logDir,
    ngrokLogPath: join(logDir, 'ngrok.log'),
    serverLogPath: join(logDir, 'server.log'),
  };
}

function pipeProcessLogs(processRef: ChildProcess, logPath: string): void {
  const stream = createWriteStream(logPath, { flags: 'a' });
  if (processRef.stdout) {
    processRef.stdout.on('data', (chunk) => stream.write(chunk));
  }
  if (processRef.stderr) {
    processRef.stderr.on('data', (chunk) => stream.write(chunk));
  }
  processRef.on('close', () => {
    stream.end();
  });
}

async function waitForExit(processRef: ChildProcess): Promise<void> {
  if (processRef.exitCode !== null) return;
  await once(processRef, 'exit');
}

async function stopProcess(processRef: ChildProcess | undefined, timeoutMs: number): Promise<void> {
  if (!processRef || processRef.exitCode !== null) return;
  processRef.kill('SIGTERM');
  await Promise.race([waitForExit(processRef), delay(timeoutMs)]);
  if (processRef.exitCode === null) {
    processRef.kill('SIGKILL');
    await waitForExit(processRef);
  }
}

async function isServerReachable(port: number, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://localhost:${port}/health`, {
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForServerReady(port: number, processRef: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processRef.exitCode !== null) {
      throw new Error(`Server process exited early with code ${processRef.exitCode}.`);
    }
    if (await isServerReachable(port, 1200)) {
      return;
    }
    await delay(300);
  }
  throw new Error(`Timed out waiting for local call server on port ${port}.`);
}

async function waitForNgrokPublicUrl(processRef: ChildProcess, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processRef.exitCode !== null) {
      throw new Error(`ngrok process exited early with code ${processRef.exitCode}.`);
    }
    try {
      const response = await fetch('http://127.0.0.1:4040/api/tunnels');
      if (response.ok) {
        const payload = (await response.json()) as {
          tunnels?: Array<{ public_url?: string; proto?: string }>;
        };
        const httpsTunnel = payload.tunnels?.find((tunnel) => tunnel.proto === 'https' && !!tunnel.public_url);
        if (httpsTunnel?.public_url) {
          return httpsTunnel.public_url;
        }
      }
    } catch {
      // Keep polling until timeout.
    }
    await delay(300);
  }
  throw new Error('Timed out waiting for ngrok tunnel URL.');
}

async function startManagedInfra(
  port: number,
  ngrokAuthToken: string | undefined,
  logBaseDir?: string,
  phone?: string,
): Promise<ManagedInfraRuntime & { publicUrl: string }> {
  const runtime: ManagedInfraRuntime = { enabled: true };
  const { logDir, ngrokLogPath, serverLogPath } = createInfraLogPaths(logBaseDir, phone);
  runtime.logDir = logDir;
  runtime.ngrokLogPath = ngrokLogPath;
  runtime.serverLogPath = serverLogPath;

  try {
    const ngrokEnv = { ...process.env };
    if (ngrokAuthToken) {
      ngrokEnv.NGROK_AUTHTOKEN = ngrokAuthToken;
    }
    runtime.ngrok = spawn('ngrok', ['http', String(port), '--log', 'stdout'], {
      env: ngrokEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    pipeProcessLogs(runtime.ngrok, ngrokLogPath);

    const publicUrl = await waitForNgrokPublicUrl(runtime.ngrok, NGROK_START_TIMEOUT_MS);
    runtime.server = spawn(
      process.execPath,
      [getCliEntryPath(), 'server', 'start', '--port', String(port), '--public-url', publicUrl],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    pipeProcessLogs(runtime.server, serverLogPath);
    await waitForServerReady(port, runtime.server, SERVER_START_TIMEOUT_MS);
    await verifyPublicWebhookStability(publicUrl, PUBLIC_WEBHOOK_STABILITY_WINDOW_MS);

    return { ...runtime, publicUrl };
  } catch (error) {
    await stopProcess(runtime.server, 2000);
    await stopProcess(runtime.ngrok, 2000);
    throw error;
  }
}

async function verifyPublicWebhookStability(publicUrl: string, durationMs: number): Promise<void> {
  const deadline = Date.now() + durationMs;
  let probe = 0;

  while (Date.now() < deadline) {
    probe += 1;
    const healthResponse = await fetch(`${publicUrl}/health`);
    if (!healthResponse.ok) {
      throw new Error(`Public webhook stability check failed: ${publicUrl}/health returned ${healthResponse.status}.`);
    }

    const statusResponse = await fetch(`${publicUrl}/twilio/status?callId=preflight-stability-${probe}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'CallSid=CApreflight&CallStatus=ringing',
    });
    if (!statusResponse.ok) {
      throw new Error(
        `Public webhook stability check failed: ${publicUrl}/twilio/status returned ${statusResponse.status}.`,
      );
    }

    await delay(PUBLIC_WEBHOOK_STABILITY_PROBE_INTERVAL_MS);
  }
}

async function stopManagedInfra(runtime: ManagedInfraRuntime): Promise<void> {
  if (!runtime.enabled) return;
  await stopProcess(runtime.server, 3000);
  await stopProcess(runtime.ngrok, 3000);
}

function phoneticSpelling(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w.split('').join('-').toUpperCase())
    .join(' ');
}

interface CallOptions {
  goal: string;
  name: string;
  email: string;
  customerPhone: string;
  context?: string;
  port?: string;
  outputDir?: string;
  interactive: boolean;
  autoInfra: boolean;
}

interface DirectBookingOptions {
  hotel: string;
  checkIn: string;
  checkOut: string;
  room?: string;
  bookingPrice?: string;
  currency?: string;
  discount?: string;
  context?: string;
  port?: string;
  outputDir?: string;
  interactive: boolean;
  autoInfra: boolean;
}

async function executeCall(phone: string, options: CallOptions, ctx: CliContext): Promise<void> {
  const { colors } = ctx;
  const config = loadConfig();
  const port = options.port ? Number.parseInt(options.port, 10) : (config.callServerPort ?? 3000);

  if (Number.isNaN(port) || port < 1 || port > 65535) {
    console.log(colors.error(`Invalid port: ${options.port}`));
    process.exit(1);
  }

  let runtime: ManagedInfraRuntime = { enabled: false };
  const callOutputBase = options.outputDir ?? config.callOutputDir ?? undefined;
  // Log directory for call artifacts (transcript, recording) — set below
  let logDir: string | undefined;

  try {
    let serverReady = await isServerReachable(port, 1000);
    if (!serverReady) {
      if (!options.autoInfra) {
        console.log(colors.error('Call server is not running and auto-infra is disabled.'));
        console.log(colors.info('Start manually with:'));
        console.log(colors.muted('  concierge server start --public-url <ngrok-url>'));
        process.exit(1);
      }

      const ngrokPreflight = await preflightNgrok();
      if (!ngrokPreflight.ok) {
        throw new Error(ngrokPreflight.message);
      }
      console.log(colors.info(`[Preflight] ${ngrokPreflight.message}`));

      console.log(colors.info('Starting managed infrastructure (ngrok + server)...'));
      runtime = await startManagedInfra(port, config.ngrokAuthToken, callOutputBase, phone);
      logDir = runtime.logDir!;
      serverReady = true;

      console.log(colors.highlight('Infrastructure Logs:'));
      if (runtime.serverLogPath) {
        console.log(colors.muted(`  Server: ${runtime.serverLogPath}`));
      }
      if (runtime.ngrokLogPath) {
        console.log(colors.muted(`  Ngrok:  ${runtime.ngrokLogPath}`));
      }
      console.log('');
    }

    if (!serverReady) {
      throw new Error(`Unable to reach call server on port ${port}`);
    }

    // When server was already running, create a standalone log dir
    if (!logDir) {
      logDir = createInfraLogPaths(callOutputBase, phone).logDir;
    }

    console.log(colors.info('Connecting to call server...'));
    console.log(colors.muted(`Call logs: ${logDir}`));
    await runCallOverControlSocket(phone, options, port, ctx, logDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(colors.error(`Call failed: ${message}`));
    process.exitCode = 1;
  } finally {
    await stopManagedInfra(runtime);
  }
}

function runCallOverControlSocket(
  phone: string,
  options: CallOptions,
  port: number,
  ctx: CliContext,
  logDir: string,
): Promise<void> {
  const { colors } = ctx;
  const ws = new WebSocket(`ws://localhost:${port}/control`);

  let callId: string | null = null;
  let callEnded = false;
  let opened = false;
  let done = false;
  let rlInterface: readline.Interface | null = null;
  const transcriptLines: string[] = [];
  const transcriptPath = join(logDir, 'transcript.txt');

  const flushTranscript = () => {
    if (transcriptLines.length > 0) {
      writeFileSync(transcriptPath, `${transcriptLines.join('\n')}\n`);
    }
  };

  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      if (done) return;
      done = true;
      if (rlInterface) {
        rlInterface.close();
        rlInterface = null;
      }
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      process.off('SIGINT', onShutdown);
      process.off('SIGTERM', onShutdown);
    };

    const safeResolve = () => {
      if (!done) {
        cleanup();
      }
      resolve();
    };

    const safeReject = (error: Error) => {
      if (!done) {
        cleanup();
      }
      reject(error);
    };

    ws.on('open', () => {
      opened = true;
      console.log(colors.success('Connected to server'));
      console.log('');
      console.log(colors.highlight('Call Details:'));
      console.log(colors.muted(`  Phone: ${phone}`));
      console.log(colors.muted(`  Goal: ${options.goal}`));
      console.log(colors.muted(`  Customer: ${options.name}`));
      console.log(colors.muted(`  Email: ${options.email}`));
      console.log(colors.muted(`  Customer Phone: ${options.customerPhone}`));
      if (options.context) {
        console.log(colors.muted(`  Context: ${options.context}`));
      }
      console.log('');

      const customerContext = `Customer: ${options.name} (to spell: ${phoneticSpelling(options.name)})
Email: ${options.email}
Phone: ${options.customerPhone}${options.context ? `\n${options.context}` : ''}`;

      const msg: ClientMessage = {
        type: 'initiate_call',
        phoneNumber: phone,
        goal: options.goal,
        context: customerContext,
      };
      ws.send(JSON.stringify(msg));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as ServerMessage;
        switch (msg.type) {
          case 'call_started':
            callId = msg.callId;
            console.log(colors.info(`Call initiated (ID: ${msg.callId})`));
            console.log(colors.muted('Waiting for answer...'));
            break;
          case 'call_ringing':
            console.log(colors.info('Phone ringing...'));
            break;
          case 'call_connected':
            console.log(colors.success('Call connected!'));
            console.log('');
            if (options.interactive) {
              console.log(colors.highlight('Interactive mode - type messages to speak'));
              console.log(colors.muted('Commands: /hangup, /status'));
              console.log('');
              rlInterface = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
                prompt: colors.muted('> '),
              });
              rlInterface.prompt();
              rlInterface.on('line', (line: string) => {
                const input = line.trim();
                if (!input) {
                  rlInterface?.prompt();
                  return;
                }
                if (input === '/hangup') {
                  if (callId) {
                    ws.send(JSON.stringify({ type: 'hangup', callId } satisfies ClientMessage));
                    console.log(colors.info('Hanging up...'));
                  }
                } else if (input === '/status') {
                  console.log(colors.info(`Call ID: ${callId}`));
                } else if (input.startsWith('/')) {
                  console.log(colors.warning(`Unknown command: ${input}`));
                } else if (callId) {
                  ws.send(JSON.stringify({ type: 'speak', callId, text: input } satisfies ClientMessage));
                }
                rlInterface?.prompt();
              });
            } else {
              console.log(colors.highlight('Transcript:'));
              console.log(colors.muted('─'.repeat(50)));
            }
            break;
          case 'transcript':
            if (msg.isFinal) {
              const label = msg.role === 'assistant' ? colors.primary('AI') : colors.secondary('Human');
              console.log(`${label}: ${msg.text}`);
              const rawLabel = msg.role === 'assistant' ? 'AI' : 'Human';
              transcriptLines.push(`${rawLabel}: ${msg.text}`);
              flushTranscript();
            }
            break;
          case 'call_ended': {
            callEnded = true;
            console.log('');
            console.log(colors.muted('─'.repeat(50)));
            console.log(colors.info(`Call ended (status: ${msg.status})`));
            console.log('');
            console.log(colors.highlight('Summary:'));
            console.log(msg.summary);

            // Save transcript with summary to log dir
            transcriptLines.push('─'.repeat(50));
            transcriptLines.push('Summary:');
            transcriptLines.push(msg.summary);
            flushTranscript();
            console.log('');
            console.log(colors.muted(`Transcript saved: ${transcriptPath}`));

            // Fetch and save recording if call was answered (skip for busy/no-answer/failed/canceled)
            const recordableStatuses = new Set(['completed', 'in-progress']);
            if (msg.callSid && recordableStatuses.has(msg.status)) {
              fetchAndSaveRecording(port, msg.callSid, logDir, colors)
                .then(() => safeResolve())
                .catch(() => safeResolve());
            } else {
              safeResolve();
            }
            break;
          }
          case 'error':
            console.log(colors.error(`Error: ${msg.message}`));
            if (!callId) {
              safeReject(new Error(msg.message));
            }
            break;
        }
      } catch {
        console.error(colors.error('Failed to parse server message'));
      }
    });

    ws.on('close', () => {
      if (!callEnded && opened) {
        if (transcriptLines.length > 0) {
          transcriptLines.push('[Call interrupted — connection lost]');
          flushTranscript();
        }
        console.log(colors.warning('Connection closed'));
        if (callId) {
          safeReject(new Error('Lost connection to call server before call ended.'));
          return;
        }
      }
      safeResolve();
    });

    ws.on('error', (err) => {
      if (!opened) {
        safeReject(err instanceof Error ? err : new Error(String(err)));
      } else {
        console.error(colors.error(`Connection error: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

    const onShutdown = () => {
      console.log('');
      if (transcriptLines.length > 0 && !callEnded) {
        transcriptLines.push('[Call interrupted]');
        flushTranscript();
      }
      if (callId && !callEnded && ws.readyState === WebSocket.OPEN) {
        console.log(colors.info('Hanging up...'));
        ws.send(JSON.stringify({ type: 'hangup', callId } satisfies ClientMessage));
        setTimeout(() => safeResolve(), 2000);
      } else {
        safeResolve();
      }
    };
    process.on('SIGINT', onShutdown);
    process.on('SIGTERM', onShutdown);
  });
}

export function callCommand(program: Command, getContext: () => CliContext): void {
  program
    .command('call')
    .description('Make a phone call with AI voice')
    .argument('<phone>', 'Phone number to call (E.164 format preferred, e.g., +1-555-123-4567)')
    .requiredOption('-g, --goal <goal>', 'Goal for the call (e.g., "Book a hotel room for Feb 15")')
    .requiredOption('-n, --name <name>', 'Customer name (e.g., "John Smith")')
    .requiredOption('-e, --email <email>', 'Customer email for confirmations')
    .requiredOption('--customer-phone <customerPhone>', 'Customer phone number for callbacks')
    .option('-c, --context <context>', 'Additional context (e.g., "2 nights, king bed preferred")')
    .option('-p, --port <port>', 'Server port')
    .option('--interactive', 'Interactive mode - type responses manually', false)
    .option('-o, --output-dir <dir>', 'Directory for call logs, transcripts, and recordings')
    .option('--no-auto-infra', 'Do not auto-start ngrok + server when server is unavailable')
    .action(async (phone: string, options: CallOptions) => {
      const ctx = getContext();
      await executeCall(phone, options, ctx);
    });

  program
    .command('direct-booking')
    .description('Book a hotel directly and negotiate a discount (uses customer info from config)')
    .argument('<phone>', 'Hotel phone number to call (E.164 format preferred)')
    .requiredOption('--hotel <name>', 'Hotel name (e.g., "Trisara Resort")')
    .requiredOption('-i, --check-in <date>', 'Check-in date (YYYY-MM-DD)')
    .requiredOption('-o, --check-out <date>', 'Check-out date (YYYY-MM-DD)')
    .option('-r, --room <room>', 'Room type (default: cheapest available room)')
    .option('--booking-price <amount>', 'Reference price from Booking.com (numeric)')
    .option('--currency <code>', 'Currency code for reference price (default: THB)', 'THB')
    .option('--discount <percent>', 'Discount percent to request (default: 10)', '10')
    .option('-c, --context <context>', 'Additional context to pass to the assistant')
    .option('-p, --port <port>', 'Server port')
    .option('--interactive', 'Interactive mode - type responses manually', false)
    .option('--output-dir <dir>', 'Directory for call logs, transcripts, and recordings')
    .option('--no-auto-infra', 'Do not auto-start ngrok + server when server is unavailable')
    .action(async (phone: string, options: DirectBookingOptions) => {
      const ctx = getContext();
      const { colors } = ctx;
      const config = loadConfig();

      if (!config.customerName || !config.customerEmail || !config.customerPhone) {
        console.log(colors.error('Missing customer defaults in config.'));
        console.log(colors.muted('Set: customerName, customerEmail, customerPhone'));
        process.exit(1);
      }

      if (!/^\d{4}-\d{2}-\d{2}$/.test(options.checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(options.checkOut)) {
        console.log(colors.error('Dates must be in YYYY-MM-DD format.'));
        process.exit(1);
      }

      const discountValue = Number.parseFloat(options.discount ?? '10');
      if (Number.isNaN(discountValue) || discountValue <= 0 || discountValue >= 100) {
        console.log(colors.error(`Invalid discount percent: ${options.discount}`));
        process.exit(1);
      }

      const room = options.room?.trim() || 'cheapest available room';
      const currency = (options.currency ?? 'THB').trim().toUpperCase();

      const bookingPrice = options.bookingPrice ? Number.parseFloat(options.bookingPrice) : undefined;
      if (options.bookingPrice && Number.isNaN(bookingPrice)) {
        console.log(colors.error(`Invalid booking price: ${options.bookingPrice}`));
        process.exit(1);
      }

      const goalParts = [
        `Book a room directly at ${options.hotel}`,
        `for ${options.checkIn} to ${options.checkOut}`,
        bookingPrice
          ? `and request ${discountValue}% off the Booking.com rate`
          : 'and request a direct-booking discount',
      ];
      const goal = `${goalParts.join(' ')}.`;

      const negotiation = bookingPrice
        ? `Reference rate: ${currency} ${bookingPrice.toFixed(0)} on Booking.com. Ask for a ${discountValue}% direct-booking discount.`
        : `Ask for the best direct-booking rate and request a ${discountValue}% discount if possible.`;

      const contextLines = [
        `Hotel: ${options.hotel}`,
        `Dates: ${options.checkIn} to ${options.checkOut}`,
        `Room preference: ${room}`,
        negotiation,
        'If discount not possible, ask for value-adds (breakfast, resort credit, upgrade, airport transfer, flexible cancellation).',
        'Confirm final total incl. taxes/fees, cancellation policy, and get a confirmation number.',
        'Request email confirmation.',
      ];

      if (options.context) {
        contextLines.push(`Additional context: ${options.context}`);
      }

      const callOptions: CallOptions = {
        goal,
        name: config.customerName,
        email: config.customerEmail,
        customerPhone: config.customerPhone,
        context: contextLines.join('\n'),
        port: options.port,
        outputDir: options.outputDir,
        interactive: options.interactive,
        autoInfra: options.autoInfra,
      };

      await executeCall(phone, callOptions, ctx);
    });
}
