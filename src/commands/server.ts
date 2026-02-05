/**
 * Server command - Start/stop/status the call server
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import type { CliContext } from '../cli/shared.js';
import { type CallConfig, createCallServer, validateCallConfig } from '../lib/call/index.js';
import { loadConfig } from '../lib/config.js';

const PID_FILE = join(homedir(), '.config', 'concierge', 'server.pid');

export function serverCommand(program: Command, getContext: () => CliContext): void {
  const server = program.command('server').description('Manage the voice call server');

  // Start server
  server
    .command('start')
    .description('Start the voice call server')
    .option('-p, --port <port>', 'Server port')
    .option('--public-url <url>', 'Public URL (ngrok URL)')
    .action(async (options: { port?: string; publicUrl?: string }) => {
      const ctx = getContext();
      const { colors } = ctx;
      const config = loadConfig();
      const port = options.port ? Number.parseInt(options.port, 10) : (config.callServerPort ?? 3000);

      // Validate port number
      if (Number.isNaN(port) || port < 1 || port > 65535) {
        console.log(colors.error(`Invalid port number: ${options.port}. Must be between 1 and 65535.`));
        process.exit(1);
      }

      // Check if already running
      if (existsSync(PID_FILE)) {
        const pid = readFileSync(PID_FILE, 'utf-8').trim();
        try {
          process.kill(Number(pid), 0);
          console.log(colors.warning(`Server already running (PID: ${pid})`));
          console.log(colors.muted('Use "concierge server stop" to stop it first'));
          return;
        } catch {
          // Process not running, clean up stale PID file
          unlinkSync(PID_FILE);
        }
      }

      // Validate config
      const callConfig: Partial<CallConfig> = {
        twilioAccountSid: config.twilioAccountSid,
        twilioAuthToken: config.twilioAuthToken,
        twilioPhoneNumber: config.twilioPhoneNumber,
        deepgramApiKey: config.deepgramApiKey,
        elevenLabsApiKey: config.elevenLabsApiKey,
        elevenLabsVoiceId: config.elevenLabsVoiceId,
        anthropicApiKey: config.anthropicApiKey,
        serverPort: port,
        publicUrl: options.publicUrl ?? '',
      };

      // Check for missing config
      const missing: string[] = [];
      if (!callConfig.twilioAccountSid) missing.push('twilioAccountSid');
      if (!callConfig.twilioAuthToken) missing.push('twilioAuthToken');
      if (!callConfig.twilioPhoneNumber) missing.push('twilioPhoneNumber');
      if (!callConfig.deepgramApiKey) missing.push('deepgramApiKey');
      if (!callConfig.elevenLabsApiKey) missing.push('elevenLabsApiKey');
      if (!callConfig.elevenLabsVoiceId) missing.push('elevenLabsVoiceId');
      if (!callConfig.anthropicApiKey) missing.push('anthropicApiKey');
      if (!callConfig.publicUrl) missing.push('publicUrl (use --public-url or set ngrokAuthToken)');

      if (missing.length > 0) {
        console.log(colors.error('Missing required configuration:'));
        for (const key of missing) {
          console.log(colors.muted(`  - ${key}`));
        }
        console.log('');
        console.log(colors.info('Set them with:'));
        console.log(colors.muted('  concierge config set <key> <value>'));
        process.exit(1);
      }

      if (!validateCallConfig(callConfig)) {
        console.log(colors.error('Invalid configuration'));
        process.exit(1);
      }

      console.log(colors.info('Starting voice call server...'));
      console.log(colors.muted(`Port: ${port}`));
      console.log(colors.muted(`Public URL: ${callConfig.publicUrl}`));

      try {
        const callServer = createCallServer(callConfig, port, callConfig.publicUrl);

        // Save PID
        writeFileSync(PID_FILE, String(process.pid));

        await callServer.start();

        console.log('');
        console.log(colors.success('Server started successfully!'));
        console.log('');
        console.log(colors.highlight('Endpoints:'));
        console.log(colors.muted(`  Health:    http://localhost:${port}/health`));
        console.log(colors.muted(`  Status:    http://localhost:${port}/status`));
        console.log(colors.muted(`  Control:   ws://localhost:${port}/control`));
        console.log('');
        console.log(colors.info('Press Ctrl+C to stop'));

        // Handle shutdown
        const shutdown = async () => {
          console.log('');
          console.log(colors.info('Shutting down...'));
          await callServer.stop();
          if (existsSync(PID_FILE)) {
            unlinkSync(PID_FILE);
          }
          process.exit(0);
        };

        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);

        // Keep process running
        await new Promise(() => {});
      } catch (err) {
        if (existsSync(PID_FILE)) {
          unlinkSync(PID_FILE);
        }
        console.log(colors.error(`Failed to start server: ${err instanceof Error ? err.message : 'Unknown error'}`));
        process.exit(1);
      }
    });

  // Stop server
  server
    .command('stop')
    .description('Stop the voice call server')
    .action(() => {
      const ctx = getContext();
      const { colors } = ctx;

      if (!existsSync(PID_FILE)) {
        console.log(colors.warning('Server is not running'));
        return;
      }

      const pid = readFileSync(PID_FILE, 'utf-8').trim();
      try {
        process.kill(Number(pid), 'SIGTERM');
        console.log(colors.success(`Server stopped (PID: ${pid})`));
      } catch {
        console.log(colors.warning('Server process not found, cleaning up'));
      }

      unlinkSync(PID_FILE);
    });

  // Server status
  server
    .command('status')
    .description('Check server status')
    .action(async () => {
      const ctx = getContext();
      const { colors } = ctx;
      const config = loadConfig();
      const port = config.callServerPort ?? 3000;

      if (!existsSync(PID_FILE)) {
        if (ctx.json) {
          console.log(JSON.stringify({ running: false }));
        } else {
          console.log(colors.warning('Server is not running'));
        }
        return;
      }

      const pid = readFileSync(PID_FILE, 'utf-8').trim();

      // Check if process is alive
      let processRunning = false;
      try {
        process.kill(Number(pid), 0);
        processRunning = true;
      } catch {
        // Process not running
      }

      if (!processRunning) {
        if (ctx.json) {
          console.log(JSON.stringify({ running: false, stalePid: pid }));
        } else {
          console.log(colors.warning('Server process not found (stale PID file)'));
          console.log(colors.muted('Run "concierge server stop" to clean up'));
        }
        return;
      }

      // Try to get status from server
      try {
        const response = await fetch(`http://localhost:${port}/status`);
        const status = (await response.json()) as {
          activeCalls: number;
          controlClients: number;
          publicUrl: string;
        };

        if (ctx.json) {
          console.log(JSON.stringify({ running: true, pid, ...status }));
        } else {
          console.log(colors.success('Server is running'));
          console.log(colors.muted(`  PID: ${pid}`));
          console.log(colors.muted(`  Port: ${port}`));
          console.log(colors.muted(`  Active calls: ${status.activeCalls}`));
          console.log(colors.muted(`  Control clients: ${status.controlClients}`));
          console.log(colors.muted(`  Public URL: ${status.publicUrl}`));
        }
      } catch {
        if (ctx.json) {
          console.log(JSON.stringify({ running: true, pid, reachable: false }));
        } else {
          console.log(colors.success(`Server process running (PID: ${pid})`));
          console.log(colors.warning('  Unable to reach HTTP endpoint'));
        }
      }
    });
}
