import type { Command } from 'commander';
import type { CliContext } from '../cli/shared.js';
import { isGoplacesInstalled, searchWithDetails } from '../lib/goplaces.js';
import { formatError, formatSearchResults } from '../lib/output.js';

interface SearchOptions {
  limit?: string;
  minRating?: string;
  type?: string;
  radiusM?: string;
}

export function searchCommand(program: Command, getContext: () => CliContext): void {
  program
    .command('search')
    .alias('s')
    .description('Search for accommodations using Google Places')
    .argument('<location>', 'Location to search (text query or "lat,lng" coordinates)')
    .option('-l, --limit <n>', 'Maximum number of results (default: 10, max: 20)')
    .option('--min-rating <n>', 'Minimum rating filter (0-5)')
    .option('--type <type>', 'Place type: lodging, hotel, resort_hotel (default: lodging)')
    .option('--radius-m <meters>', 'Search radius in meters (for coordinate searches)')
    .action(async (location: string, options: SearchOptions) => {
      const ctx = getContext();

      // Check if goplaces is installed
      if (!isGoplacesInstalled()) {
        console.log(formatError('goplaces CLI is not installed. No other providers are currently supported.', ctx));
        process.exit(1);
      }

      // Parse options
      const limit = options.limit ? parseInt(options.limit, 10) : 10;
      const minRating = options.minRating ? parseFloat(options.minRating) : undefined;
      const radiusMeters = options.radiusM ? parseInt(options.radiusM, 10) : undefined;

      // Validate options
      if (options.limit && (Number.isNaN(limit) || limit < 1 || limit > 20)) {
        console.log(formatError('Limit must be between 1 and 20', ctx));
        process.exit(1);
      }

      if (options.minRating && (Number.isNaN(minRating!) || minRating! < 0 || minRating! > 5)) {
        console.log(formatError('Minimum rating must be between 0 and 5', ctx));
        process.exit(1);
      }

      if (options.radiusM && (Number.isNaN(radiusMeters!) || radiusMeters! < 1)) {
        console.log(formatError('Radius must be a positive number', ctx));
        process.exit(1);
      }

      // Search for places
      const result = await searchWithDetails(location, {
        limit,
        minRating,
        type: options.type,
        radiusMeters,
      });

      if (!result.success) {
        console.log(formatError(result.error, ctx));
        process.exit(1);
      }

      if (result.data.length === 0) {
        console.log(formatError('No accommodations found matching your criteria', ctx));
        process.exit(0);
      }

      console.log(formatSearchResults(result.data, ctx));
    });
}
