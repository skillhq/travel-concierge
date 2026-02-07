import type { Command } from 'commander';
import type { CliContext } from '../cli/shared.js';
import { FlightQueueClient } from '../lib/flightqueue-client.js';
import type { FlightQueueData } from '../lib/flightqueue-types.js';
import { formatError, formatVerbose } from '../lib/output.js';

function formatWaitTimeLevel(level: string): string {
  switch (level) {
    case 'fast':
      return 'Fast';
    case 'moderate':
      return 'Moderate';
    case 'busy':
      return 'Busy';
    case 'very_busy':
      return 'Very Busy';
    default:
      return 'Unknown';
  }
}

function formatFlightQueueData(data: FlightQueueData, ctx: CliContext): string {
  if (ctx.json) {
    return JSON.stringify(data, null, 2);
  }

  const { colors } = ctx;
  const lines: string[] = [];

  // Header
  lines.push('');
  lines.push(colors.highlight('═══════════════════════════════════════════════════════════'));
  lines.push(colors.highlight(`  AIRPORT WAIT TIMES: ${data.airport.code}`));
  lines.push(colors.highlight('═══════════════════════════════════════════════════════════'));
  lines.push('');

  // Airport Info
  lines.push(colors.primary('▸ Airport Information'));
  lines.push(`  ${colors.muted('Code:')} ${data.airport.code}`);
  lines.push(`  ${colors.muted('Name:')} ${data.airport.name}`);
  if (data.airport.city) {
    lines.push(`  ${colors.muted('City:')} ${data.airport.city}`);
  }
  if (data.airport.country) {
    lines.push(`  ${colors.muted('Country:')} ${data.airport.country}`);
  }
  lines.push('');

  // Wait Times
  lines.push(colors.primary('▸ Current Wait Times'));

  // Security
  const securityColor =
    data.security.level === 'fast'
      ? colors.success
      : data.security.level === 'moderate'
        ? colors.warning
        : colors.error;
  const securityTime = data.security.minutes ? `${data.security.minutes} min` : 'N/A';
  lines.push(
    `  ${colors.muted('Security:')} ${securityColor(formatWaitTimeLevel(data.security.level))} (${securityTime})`,
  );

  // Immigration
  const immigrationColor =
    data.immigration.level === 'fast'
      ? colors.success
      : data.immigration.level === 'moderate'
        ? colors.warning
        : colors.error;
  const immigrationTime = data.immigration.minutes ? `${data.immigration.minutes} min` : 'N/A';
  lines.push(
    `  ${colors.muted('Immigration:')} ${immigrationColor(formatWaitTimeLevel(data.immigration.level))} (${immigrationTime})`,
  );

  if (data.trafficScore !== null) {
    lines.push(`  ${colors.muted('Traffic Score:')} ${data.trafficScore}`);
  }
  lines.push('');

  // Recommended Arrival
  if (data.recommendedArrival.domestic || data.recommendedArrival.international) {
    lines.push(colors.primary('▸ Recommended Arrival'));
    if (data.recommendedArrival.domestic) {
      lines.push(`  ${colors.muted('Domestic:')} ${data.recommendedArrival.domestic} min before departure`);
    }
    if (data.recommendedArrival.international) {
      lines.push(`  ${colors.muted('International:')} ${data.recommendedArrival.international} min before departure`);
    }
    lines.push('');
  }

  // Footer
  lines.push(colors.muted(`Source: ${data.url}`));
  lines.push(colors.muted(`Fetched: ${data.fetchedAt}`));
  lines.push('');

  return lines.join('\n');
}

export function flightqueueCommand(program: Command, getContext: () => CliContext): void {
  program
    .command('flightqueue')
    .alias('fq')
    .alias('queue')
    .description('Get airport wait times from FlightQueue.com')
    .argument('<airport>', 'Airport code (e.g., HKT) or city name (e.g., Phuket)')
    .action(async (airport: string) => {
      const ctx = getContext();

      const client = new FlightQueueClient({ verbose: ctx.verbose });

      const verboseMsg = formatVerbose(`Looking up wait times for: ${airport}`, ctx);
      if (verboseMsg) console.log(verboseMsg);

      const result = await client.getWaitTimes(airport);

      if (!result.success) {
        console.log(formatError(result.error, ctx));
        process.exit(1);
      }

      console.log(formatFlightQueueData(result.data, ctx));
    });
}
