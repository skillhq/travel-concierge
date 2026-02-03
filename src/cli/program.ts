import { Command } from 'commander';
import kleur from 'kleur';
import { callCommand } from '../commands/call.js';
import { configCommand } from '../commands/config.js';
import { findContactCommand } from '../commands/find-contact.js';
import { serverCommand } from '../commands/server.js';
import type { CliColors, CliContext } from './shared.js';

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
    .name('travel-concierge')
    .description('Find contact details for accommodation listings (Airbnb, Booking.com, VRBO, Expedia)')
    .version('1.0.0');

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

  return program;
}
