import type { Command } from 'commander';
import type { CliContext } from '../cli/shared.js';
import type { ConciergeConfig } from '../lib/concierge-client-types.js';
import { deleteConfigValue, getConfigPath, loadConfig, setConfigValue } from '../lib/config.js';

const VALID_KEYS: (keyof ConciergeConfig)[] = [
  'googlePlacesApiKey',
  'instagramSessionId',
  'timeoutMs',
  'twilioAccountSid',
  'twilioAuthToken',
  'twilioPhoneNumber',
  'deepgramApiKey',
  'elevenLabsApiKey',
  'elevenLabsVoiceId',
  'ngrokAuthToken',
  'callServerPort',
  'anthropicApiKey',
];

export function configCommand(program: Command, getContext: () => CliContext): void {
  const config = program.command('config').description('Manage configuration');

  // Show config
  config
    .command('show')
    .description('Show current configuration')
    .action(() => {
      const ctx = getContext();
      const current = loadConfig();

      if (ctx.json) {
        console.log(JSON.stringify(current, null, 2));
        return;
      }

      const { colors } = ctx;
      console.log('');
      console.log(colors.highlight('Configuration'));
      console.log(colors.muted(`Path: ${getConfigPath()}`));
      console.log('');

      for (const key of VALID_KEYS) {
        const value = current[key];
        if (value !== undefined) {
          // Mask sensitive values
          const displayValue =
            key.toLowerCase().includes('key') || key.toLowerCase().includes('session')
              ? maskValue(String(value))
              : String(value);
          console.log(`  ${colors.primary(key)}: ${displayValue}`);
        } else {
          console.log(`  ${colors.primary(key)}: ${colors.muted('(not set)')}`);
        }
      }
      console.log('');
    });

  // Set config value
  config
    .command('set')
    .description('Set a configuration value')
    .argument('<key>', `Configuration key (${VALID_KEYS.join(', ')})`)
    .argument('<value>', 'Value to set')
    .action((key: string, value: string) => {
      const ctx = getContext();

      if (!VALID_KEYS.includes(key as keyof ConciergeConfig)) {
        console.log(ctx.colors.error(`Invalid key: ${key}`));
        console.log(ctx.colors.muted(`Valid keys: ${VALID_KEYS.join(', ')}`));
        process.exit(1);
      }

      const typedKey = key as keyof ConciergeConfig;

      // Type coercion for numeric values
      let typedValue: string | number = value;
      if (typedKey === 'timeoutMs' || typedKey === 'callServerPort') {
        typedValue = Number.parseInt(value, 10);
        if (Number.isNaN(typedValue)) {
          console.log(ctx.colors.error(`Invalid number: ${value}`));
          process.exit(1);
        }
      }

      setConfigValue(typedKey, typedValue as ConciergeConfig[typeof typedKey]);

      if (ctx.json) {
        console.log(JSON.stringify({ success: true, key, value: typedValue }));
      } else {
        console.log(ctx.colors.success(`Set ${key}`));
      }
    });

  // Unset config value
  config
    .command('unset')
    .description('Remove a configuration value')
    .argument('<key>', 'Configuration key to remove')
    .action((key: string) => {
      const ctx = getContext();

      if (!VALID_KEYS.includes(key as keyof ConciergeConfig)) {
        console.log(ctx.colors.error(`Invalid key: ${key}`));
        console.log(ctx.colors.muted(`Valid keys: ${VALID_KEYS.join(', ')}`));
        process.exit(1);
      }

      deleteConfigValue(key as keyof ConciergeConfig);

      if (ctx.json) {
        console.log(JSON.stringify({ success: true, key, deleted: true }));
      } else {
        console.log(ctx.colors.success(`Removed ${key}`));
      }
    });

  // Get config path
  config
    .command('path')
    .description('Show configuration file path')
    .action(() => {
      const ctx = getContext();
      if (ctx.json) {
        console.log(JSON.stringify({ path: getConfigPath() }));
      } else {
        console.log(getConfigPath());
      }
    });
}

function maskValue(value: string): string {
  if (value.length <= 8) {
    return '****';
  }
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}
