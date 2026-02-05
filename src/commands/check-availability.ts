import type { Command } from 'commander';
import type { CliContext } from '../cli/shared.js';
import { isAgentBrowserInstalled } from '../lib/browser/agent-browser-client.js';
import { checkAvailability } from '../lib/browser/booking-scraper.js';
import { formatAvailabilityResult, formatError, formatVerbose } from '../lib/output.js';

interface CheckAvailabilityOptions {
  checkIn: string;
  checkOut: string;
  guests?: string;
  rooms?: string;
  screenshot?: string;
  headed?: boolean;
}

/**
 * Validate date format (YYYY-MM-DD)
 */
function isValidDateFormat(dateStr: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
}

/**
 * Validate date is not in the past
 */
function isNotPastDate(dateStr: string): boolean {
  const date = new Date(dateStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date >= today;
}

/**
 * Validate checkout is after checkin
 */
function isCheckoutAfterCheckin(checkIn: string, checkOut: string): boolean {
  return new Date(checkOut) > new Date(checkIn);
}

export function checkAvailabilityCommand(program: Command, getContext: () => CliContext): void {
  program
    .command('check-availability')
    .alias('ca')
    .alias('availability')
    .description('Check hotel availability and prices on Booking.com')
    .argument('<query>', 'Hotel name or Booking.com URL')
    .requiredOption('-i, --check-in <date>', 'Check-in date (YYYY-MM-DD)')
    .requiredOption('-o, --check-out <date>', 'Check-out date (YYYY-MM-DD)')
    .option('-g, --guests <n>', 'Number of guests (default: 2)')
    .option('-r, --rooms <n>', 'Number of rooms (default: 1)')
    .option('-s, --screenshot <path>', 'Save screenshot of results')
    .option('--headed', 'Show browser window (for debugging)')
    .action(async (query: string, options: CheckAvailabilityOptions) => {
      const ctx = getContext();

      // Check if agent-browser is installed
      if (!isAgentBrowserInstalled()) {
        console.log(formatError('agent-browser CLI is not installed. Install it to use availability checking.', ctx));
        process.exit(1);
      }

      // Validate dates
      if (!isValidDateFormat(options.checkIn)) {
        console.log(formatError('Check-in date must be in YYYY-MM-DD format', ctx));
        process.exit(1);
      }

      if (!isValidDateFormat(options.checkOut)) {
        console.log(formatError('Check-out date must be in YYYY-MM-DD format', ctx));
        process.exit(1);
      }

      if (!isNotPastDate(options.checkIn)) {
        console.log(formatError('Check-in date cannot be in the past', ctx));
        process.exit(1);
      }

      if (!isCheckoutAfterCheckin(options.checkIn, options.checkOut)) {
        console.log(formatError('Check-out date must be after check-in date', ctx));
        process.exit(1);
      }

      // Parse options
      const guests = options.guests ? parseInt(options.guests, 10) : 2;
      const rooms = options.rooms ? parseInt(options.rooms, 10) : 1;

      if (options.guests && (Number.isNaN(guests) || guests < 1)) {
        console.log(formatError('Guests must be a positive number', ctx));
        process.exit(1);
      }

      if (options.rooms && (Number.isNaN(rooms) || rooms < 1)) {
        console.log(formatError('Rooms must be a positive number', ctx));
        process.exit(1);
      }

      const verboseMsg = formatVerbose(
        `Checking availability for: ${query} (${options.checkIn} to ${options.checkOut})`,
        ctx,
      );
      if (verboseMsg) console.log(verboseMsg);

      // Check availability
      const result = await checkAvailability({
        query,
        checkIn: options.checkIn,
        checkOut: options.checkOut,
        guests,
        rooms,
        screenshot: options.screenshot,
        headed: options.headed,
      });

      if (!result.success) {
        console.log(formatError(result.error, ctx));
        process.exit(1);
      }

      console.log(formatAvailabilityResult(result.data, ctx));
    });
}
