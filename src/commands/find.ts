import type { Command } from 'commander';
import type { CliContext } from '../cli/shared.js';
import { ConciergeClient } from '../lib/concierge-client.js';
import { formatDossier, formatDossierList, formatError, formatVerbose } from '../lib/output.js';
import { isValidUrl } from '../lib/utils/url-parser.js';

interface FindOptions {
  html?: string;
  limit?: string;
  minRating?: string;
  type?: string;
  radiusM?: string;
  enrich?: boolean;
}

export function findCommand(program: Command, getContext: () => CliContext): void {
  program
    .command('find')
    .alias('find-contact')
    .alias('fc')
    .alias('search')
    .alias('s')
    .description('Find contact details for a listing URL or search for places by text query')
    .argument('<query>', 'Listing URL or text search query')
    .option('--html <file>', 'Path to saved HTML file (for URL lookups)')
    .option('-l, --limit <n>', 'Maximum number of results for text search (default: 10, max: 20)')
    .option('--min-rating <n>', 'Minimum rating filter (0-5)')
    .option('--type <type>', 'Place type: lodging, hotel, resort_hotel (default: lodging)')
    .option('--radius-m <meters>', 'Search radius in meters (for coordinate searches)')
    .option('--enrich', 'Enrich multi-result searches with website scraping (slower)')
    .action(async (query: string, options: FindOptions) => {
      const ctx = getContext();
      const client = new ConciergeClient();

      // Auto-detect: URL vs text query
      if (isValidUrl(query)) {
        // --- URL path: delegate to existing findContacts ---
        let html: string | undefined;
        if (options.html) {
          const fs = await import('node:fs');
          try {
            html = fs.readFileSync(options.html, 'utf-8');
            const msg = formatVerbose(`Loaded HTML from ${options.html}`, ctx);
            if (msg) console.log(msg);
          } catch (_error) {
            console.log(formatError(`Failed to read HTML file: ${options.html}`, ctx));
            process.exit(1);
          }
        }

        const verboseMsg = formatVerbose(`Searching for contacts for: ${query}`, ctx);
        if (verboseMsg) console.log(verboseMsg);

        const result = await client.findContacts(query, {
          html,
          verbose: ctx.verbose,
        });

        if (!result.success) {
          console.log(formatError(result.error, ctx));
          process.exit(1);
        }

        console.log(formatDossier(result.data, ctx));
      } else {
        // --- Text query path: use findByQuery ---
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

        const result = await client.findByQuery(query, {
          limit,
          minRating,
          type: options.type,
          radiusMeters,
          enrich: options.enrich,
          verbose: ctx.verbose,
        });

        if (!result.success) {
          console.log(formatError(result.error, ctx));
          process.exit(1);
        }

        const dossiers = result.data;

        if (dossiers.length === 0) {
          console.log(formatError('No results found matching your criteria', ctx));
          process.exit(0);
        }

        // Single result: full dossier view; multi-result: compact list
        if (dossiers.length === 1) {
          console.log(formatDossier(dossiers[0], ctx));
        } else {
          console.log(formatDossierList(dossiers, ctx));
        }
      }
    });
}
