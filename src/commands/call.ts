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
      if (!meta.recordings || meta.recordings.length === 0) {
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

function createInfraLogPaths(): { logDir: string; ngrokLogPath: string; serverLogPath: string } {
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const logDir = join(homedir(), '.config', 'concierge', 'call-runs', runId);
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
): Promise<ManagedInfraRuntime & { publicUrl: string }> {
  const runtime: ManagedInfraRuntime = { enabled: true };
  const { logDir, ngrokLogPath, serverLogPath } = createInfraLogPaths();
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

interface CallOptions {
  goal: string;
  name: string;
  email: string;
  customerPhone: string;
  context?: string;
  port?: string;
  interactive: boolean;
  autoInfra: boolean;
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
      process.off('SIGINT', onSigint);
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

      const customerContext = `Customer: ${options.name}
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
            }
            break;
          case 'call_ended':
            callEnded = true;
            console.log('');
            console.log(colors.muted('─'.repeat(50)));
            console.log(colors.info(`Call ended (status: ${msg.status})`));
            console.log('');
            console.log(colors.highlight('Summary:'));
            console.log(msg.summary);

            // Save transcript to log dir
            const transcriptPath = join(logDir, 'transcript.txt');
            writeFileSync(transcriptPath, msg.summary);
            console.log('');
            console.log(colors.muted(`Transcript saved: ${transcriptPath}`));

            // Fetch and save recording if we have a callSid
            if (msg.callSid) {
              fetchAndSaveRecording(port, msg.callSid, logDir, colors)
                .then(() => safeResolve())
                .catch(() => safeResolve());
            } else {
              safeResolve();
            }
            break;
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

    const onSigint = () => {
      console.log('');
      if (callId && !callEnded && ws.readyState === WebSocket.OPEN) {
        console.log(colors.info('Hanging up...'));
        ws.send(JSON.stringify({ type: 'hangup', callId } satisfies ClientMessage));
        setTimeout(() => safeResolve(), 2000);
      } else {
        safeResolve();
      }
    };
    process.on('SIGINT', onSigint);
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
    .option('--no-auto-infra', 'Do not auto-start ngrok + server when server is unavailable')
    .action(async (phone: string, options: CallOptions) => {
      const ctx = getContext();
      const { colors } = ctx;
      const config = loadConfig();
      const port = options.port ? Number.parseInt(options.port, 10) : (config.callServerPort ?? 3000);

      if (Number.isNaN(port) || port < 1 || port > 65535) {
        console.log(colors.error(`Invalid port: ${options.port}`));
        process.exit(1);
      }

      let runtime: ManagedInfraRuntime = { enabled: false };
      // Always create a log directory for call artifacts (transcript, recording)
      const { logDir } = createInfraLogPaths();

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
          runtime = await startManagedInfra(port, config.ngrokAuthToken);
          // Use the managed infra logDir instead
          runtime.logDir = logDir;
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
    });
}
