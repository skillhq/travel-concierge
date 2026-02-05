import { createRequire } from 'node:module';
import { Command } from 'commander';
import kleur from 'kleur';
import { callCommand } from '../commands/call.js';
import { checkAvailabilityCommand } from '../commands/check-availability.js';
import { configCommand } from '../commands/config.js';
import { findContactCommand } from '../commands/find-contact.js';
import { searchCommand } from '../commands/search.js';
import { serverCommand } from '../commands/server.js';
import type { CliColors, CliContext } from './shared.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

function createColors(): CliColors {
  return {
    primary: kleur.cyan,
    secondary: kleur.magenta,
    success: kleur.green,
    error: kleur.red,
    warning: kleur.yellow,
    info: kleur.blue,
    muted: kleur.gray,
    highlight: kleur.bold,
  };
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name('concierge')
    .description('Find contact details for accommodation listings (Airbnb, Booking.com, VRBO, Expedia)')
    .version(pkg.version);

  // Global options
  program.option('--json', 'Output as JSON').option('-v, --verbose', 'Verbose output');

  // Create shared context
  const getContext = (): CliContext => {
    const opts = program.opts();
    return {
      colors: createColors(),
      json: opts.json ?? false,
      verbose: opts.verbose ?? false,
    };
  };

  // Register commands
  findContactCommand(program, getContext);
  configCommand(program, getContext);
  serverCommand(program, getContext);
  callCommand(program, getContext);
  searchCommand(program, getContext);
  checkAvailabilityCommand(program, getContext);

  return program;
}
