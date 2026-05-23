/**
 * Browser Connection
 *
 * Singleton CDP connection to operator-launched Edge. Wraps puppeteer-core's
 * `connect()` with:
 *   - lazy init / single reconnect-on-drop
 *   - explicit mutex (puppeteer-core does NOT serialize concurrent operations)
 *   - dialog auto-dismiss handler
 *   - auth_required flag on frameNavigated to allowlisted origins
 *   - helper-script spawn (detached) for caco_browser_ensure_running
 *   - in-flight launch dedup so concurrent ensure_running calls share one helper
 */

import { spawn } from 'child_process';
import { existsSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { loadBrowserConfig, saveBrowserConfig, type BrowserConfig } from './browser-config.js';

export type EnsureMode = 'visible' | 'hidden' | 'headless';

interface ConnectionState {
  browser: Browser;
  page: Page;
  config: BrowserConfig;
  authRedirectTo: string | null;
  dialogOpen: boolean;
}

let current: ConnectionState | null = null;
let inFlightLaunch: Promise<void> | null = null;
let mutexQueue: Promise<unknown> = Promise.resolve();

export async function withMutex<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  const prior = mutexQueue;
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  mutexQueue = next;

  const waitTimeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new BrowserBusyError()), timeoutMs);
  });

  try {
    await Promise.race([prior, waitTimeout]);
  } catch (err) {
    release();
    throw err;
  }

  try {
    return await fn();
  } finally {
    release();
  }
}

export class BrowserBusyError extends Error {
  constructor() {
    super('Browser is busy with another operation');
    this.name = 'BrowserBusyError';
  }
}

export class NotConnectedError extends Error {
  constructor(message = 'Browser not connected. Call caco_browser_ensure_running first.') {
    super(message);
    this.name = 'NotConnectedError';
  }
}

export class LaunchFailedError extends Error {
  readonly diagnostics: string;
  constructor(message: string, diagnostics = '') {
    super(message);
    this.name = 'LaunchFailedError';
    this.diagnostics = diagnostics;
  }
}

export async function getConnection(): Promise<ConnectionState> {
  if (current) {
    if (current.browser.connected) return current;
    current = null;
  }
  const config = loadBrowserConfig();
  try {
    const browser = await puppeteer.connect({
      browserURL: config.cdpUrl,
      defaultViewport: null,
    });
    const pages = await browser.pages();
    const page = pages[0] ?? await browser.newPage();
    const state: ConnectionState = {
      browser,
      page,
      config,
      authRedirectTo: null,
      dialogOpen: false,
    };
    installHandlers(state);
    current = state;
    return state;
  } catch (err) {
    throw new NotConnectedError(
      `Could not connect to Edge at ${config.cdpUrl}: ${(err as Error).message}. ` +
      'Call caco_browser_ensure_running to start it.',
    );
  }
}

export function invalidateConnection(): void {
  if (current) {
    try { void current.browser.disconnect(); } catch { /* ignore */ }
    current = null;
  }
}

function installHandlers(state: ConnectionState): void {
  state.page.on('dialog', (dialog) => {
    state.dialogOpen = true;
    void dialog.dismiss().finally(() => { state.dialogOpen = false; });
  });

  state.page.on('framenavigated', (frame) => {
    if (frame !== state.page.mainFrame()) return;
    try {
      const url = new URL(frame.url());
      const allowlist = state.config.authOriginAllowlist;
      if (allowlist.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) {
        state.authRedirectTo = frame.url();
      } else {
        state.authRedirectTo = null;
      }
    } catch {
      state.authRedirectTo = null;
    }
  });

  state.browser.on('disconnected', () => {
    if (current?.browser === state.browser) current = null;
  });
}

/**
 * Spawn the helper script detached, capturing stderr/stdout for diagnostics.
 * Returns the captured output (empty string if helper exited cleanly with no output).
 */
export async function spawnHelper(mode: EnsureMode): Promise<string> {
  const isWindows = process.platform === 'win32';
  const scriptDir = resolveHelperDir();
  const script = isWindows
    ? join(scriptDir, 'start-browser.ps1')
    : join(scriptDir, 'start-browser.sh');

  if (!existsSync(script)) {
    throw new LaunchFailedError(
      `Helper script not found: ${script}`,
      `Looked in ${scriptDir}. Set CACO_BROWSER_HELPER_DIR to override.`
    );
  }

  const logFile = join(mkdtempSync(join(tmpdir(), 'caco-browser-')), 'helper.log');
  const cmd = isWindows ? 'powershell.exe' : 'bash';
  const args = isWindows
    ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Mode', mode, '-LogFile', logFile]
    : [script, '--mode', mode, '--log-file', logFile];

  return new Promise<string>((resolve, reject) => {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', (err) => {
      reject(new LaunchFailedError(`Failed to spawn helper: ${err.message}`, ''));
    });
    child.on('exit', (code) => {
      let diagnostics = '';
      try {
        if (existsSync(logFile)) diagnostics = readFileSync(logFile, 'utf-8').slice(0, 2000);
      } catch { /* ignore */ }
      if (code === 0) resolve(diagnostics);
      else reject(new LaunchFailedError(`Helper exited with code ${code}`, diagnostics));
    });
    child.unref();
  });
}

function resolveHelperDir(): string {
  if (process.env.CACO_BROWSER_HELPER_DIR) return process.env.CACO_BROWSER_HELPER_DIR;
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'scripts');
}

/**
 * Idempotent: if Edge is already CDP-reachable, returns existing connection
 * info without spawning. Otherwise spawns helper and waits for CDP up to
 * config.launchTimeoutMs. Concurrent callers share one in-flight launch.
 */
export async function ensureRunning(mode: EnsureMode = 'visible'): Promise<{ cdpUrl: string; started: boolean; actualMode: string; diagnostics: string }> {
  const config = loadBrowserConfig();

  if (await isReachable(config.cdpUrl)) {
    return {
      cdpUrl: config.cdpUrl,
      started: false,
      actualMode: config.lastLaunchedMode ?? 'unknown',
      diagnostics: '',
    };
  }

  if (inFlightLaunch) {
    await inFlightLaunch;
    const after = loadBrowserConfig();
    return {
      cdpUrl: after.cdpUrl,
      started: false,
      actualMode: after.lastLaunchedMode ?? 'unknown',
      diagnostics: '(joined in-flight launch)',
    };
  }

  let diagnostics = '';
  inFlightLaunch = (async () => {
    diagnostics = await spawnHelper(mode);
    await waitForCdp(config.cdpUrl, config.launchTimeoutMs);
  })();

  try {
    await inFlightLaunch;
  } finally {
    inFlightLaunch = null;
  }

  saveBrowserConfig({ lastLaunchedMode: mode });
  return { cdpUrl: config.cdpUrl, started: true, actualMode: mode, diagnostics };
}

async function isReachable(cdpUrl: string): Promise<boolean> {
  try {
    const versionUrl = cdpUrl.replace(/\/$/, '') + '/json/version';
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1000);
    const response = await fetch(versionUrl, { signal: ctrl.signal });
    clearTimeout(t);
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForCdp(cdpUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isReachable(cdpUrl)) return;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new LaunchFailedError(
    `Timed out after ${timeoutMs}ms waiting for CDP at ${cdpUrl}`,
    ''
  );
}

export { saveBrowserConfig };
