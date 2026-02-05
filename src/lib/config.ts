import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import JSON5 from 'json5';
import type { ConciergeConfig } from './concierge-client-types.js';

const OLD_CONFIG_DIR = join(homedir(), '.config', 'travel-concierge');
const CONFIG_DIR = join(homedir(), '.config', 'concierge');

// Migration: move old config dir to new location
function migrateConfigIfNeeded(): void {
  if (existsSync(OLD_CONFIG_DIR) && !existsSync(CONFIG_DIR)) {
    renameSync(OLD_CONFIG_DIR, CONFIG_DIR);
    console.log('Migrated config from ~/.config/travel-concierge to ~/.config/concierge');
  }
}

// Run migration at module load time
migrateConfigIfNeeded();

const CONFIG_FILE = join(CONFIG_DIR, 'config.json5');

const DEFAULT_CONFIG: ConciergeConfig = {
  timeoutMs: 30000,
  callServerPort: 3000,
  elevenLabsVoiceId: 'EXAVITQu4vr4xnSDxMaL', // Rachel voice
};

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function loadConfig(): ConciergeConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      const content = readFileSync(CONFIG_FILE, 'utf-8');
      const parsed = JSON5.parse(content) as Partial<ConciergeConfig>;
      return { ...DEFAULT_CONFIG, ...parsed };
    }
  } catch {
    // Ignore parse errors, use defaults
  }
  return { ...DEFAULT_CONFIG };
}

export function saveConfig(config: ConciergeConfig): void {
  // Ensure directory exists
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }

  // Pretty print with comments
  const content = JSON5.stringify(config, null, 2);
  writeFileSync(CONFIG_FILE, content, 'utf-8');
}

export function getConfigValue<K extends keyof ConciergeConfig>(key: K): ConciergeConfig[K] | undefined {
  const config = loadConfig();
  return config[key];
}

export function setConfigValue<K extends keyof ConciergeConfig>(key: K, value: ConciergeConfig[K]): void {
  const config = loadConfig();
  config[key] = value;
  saveConfig(config);
}

export function deleteConfigValue<K extends keyof ConciergeConfig>(key: K): void {
  const config = loadConfig();
  delete config[key];
  saveConfig(config);
}

export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}
