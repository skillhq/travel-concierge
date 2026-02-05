import { spawnSync } from 'node:child_process';
import type { Result } from '../concierge-client-types.js';

export interface SnapshotElement {
  ref: string;
  role: string;
  name: string;
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  elements: SnapshotElement[];
  raw: string;
}

/**
 * Check if agent-browser CLI is installed
 */
export function isAgentBrowserInstalled(): boolean {
  const result = spawnSync('which', ['agent-browser'], { stdio: 'pipe' });
  return result.status === 0;
}

const SESSION_NAME = 'concierge';
let useHeadedMode = false;

/**
 * Set whether to use headed mode for browser automation
 */
export function setHeadedMode(headed: boolean): void {
  useHeadedMode = headed;
}

/**
 * Run agent-browser command and get output
 */
function runAgentBrowser(args: string[], timeout = 30000): Result<string> {
  const baseArgs = ['--session', SESSION_NAME];
  // Add --headed for 'open' command if headed mode is enabled
  if (useHeadedMode && args[0] === 'open') {
    baseArgs.push('--headed');
  }
  const result = spawnSync('agent-browser', [...baseArgs, ...args], {
    stdio: 'pipe',
    encoding: 'utf-8',
    timeout,
  });

  if (result.error) {
    return { success: false, error: `Failed to run agent-browser: ${result.error.message}` };
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || result.stdout?.trim() || 'Unknown error';
    return { success: false, error: `agent-browser failed: ${stderr}` };
  }

  return { success: true, data: result.stdout };
}

/**
 * Open a URL in the browser
 */
export function openUrl(url: string): Result<string> {
  return runAgentBrowser(['open', url], 60000);
}

/**
 * Take a snapshot of the current page (interactive elements)
 */
export function snapshot(): Result<BrowserSnapshot> {
  const result = runAgentBrowser(['snapshot', '-i'], 30000);
  if (!result.success) return result;

  // Parse snapshot output to extract URL and elements
  const lines = result.data.split('\n');
  let url = '';
  let title = '';
  const elements: SnapshotElement[] = [];

  for (const line of lines) {
    if (line.startsWith('URL:')) {
      url = line.replace('URL:', '').trim();
    } else if (line.startsWith('Title:')) {
      title = line.replace('Title:', '').trim();
    } else if (line.match(/^@\w+/)) {
      // Parse element lines like "@e1 button 'Sign in'"
      const match = line.match(/^(@\w+)\s+(\w+)\s+(?:'([^']*)'|"([^"]*)")?/);
      if (match) {
        elements.push({
          ref: match[1],
          role: match[2],
          name: match[3] || match[4] || '',
        });
      }
    }
  }

  return {
    success: true,
    data: { url, title, elements, raw: result.data },
  };
}

/**
 * Click an element by ref
 */
export function click(ref: string): Result<string> {
  return runAgentBrowser(['click', ref], 30000);
}

/**
 * Fill an input by ref
 */
export function fill(ref: string, text: string): Result<string> {
  return runAgentBrowser(['fill', ref, text], 30000);
}

/**
 * Press a key
 */
export function pressKey(key: string): Result<string> {
  return runAgentBrowser(['key', key], 15000);
}

/**
 * Take a screenshot
 */
export function screenshot(path?: string): Result<string> {
  const args = ['screenshot'];
  if (path) {
    args.push('-o', path);
  }
  return runAgentBrowser(args, 30000);
}

/**
 * Close the browser
 */
export function closeBrowser(): Result<string> {
  return runAgentBrowser(['close'], 15000);
}

/**
 * Wait for the page to load or for an element
 */
export function wait(msOrSelector?: number | string): Result<string> {
  if (typeof msOrSelector === 'number') {
    // Simple delay
    return new Promise((resolve) => {
      setTimeout(() => resolve({ success: true, data: 'waited' }), msOrSelector);
    }) as unknown as Result<string>;
  }
  // Wait for selector (if supported by agent-browser)
  return runAgentBrowser(['wait', msOrSelector?.toString() || '2000'], 60000);
}

/**
 * Synchronous sleep helper
 */
export function sleep(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Busy wait
  }
}

/**
 * Find an element by partial text match in the snapshot
 */
export function findElementByText(snap: BrowserSnapshot, text: string, role?: string): SnapshotElement | undefined {
  const textLower = text.toLowerCase();
  return snap.elements.find((el) => {
    const nameMatch = el.name.toLowerCase().includes(textLower);
    const roleMatch = !role || el.role === role;
    return nameMatch && roleMatch;
  });
}

/**
 * Find all elements matching criteria
 */
export function findElements(snap: BrowserSnapshot, predicate: (el: SnapshotElement) => boolean): SnapshotElement[] {
  return snap.elements.filter(predicate);
}
