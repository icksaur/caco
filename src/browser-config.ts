/**
 * Browser Automation Config
 *
 * Loaded from <STORAGE_ROOT>/browser-config.json. Defaults applied for missing
 * fields so a fresh install has a working config without manual editing.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { ensureDir } from './storage-paths.js';

function storageRoot(): string {
  return process.env.CACO_HOME || join(homedir(), '.caco');
}

export interface BrowserConfig {
  cdpUrl: string;
  defaultTimeoutMs: number;
  launchTimeoutMs: number;
  evalEnabled: boolean;
  evalOriginAllowlist: string[];
  authOriginAllowlist: string[];
  profileDir: string;
  screenshotDir: string;
  lastLaunchedMode?: 'visible' | 'hidden' | 'headless';
}

function defaults(): BrowserConfig {
  const root = storageRoot();
  return {
    cdpUrl: 'http://127.0.0.1:9222',
    defaultTimeoutMs: 10000,
    launchTimeoutMs: 30000,
    evalEnabled: false,
    evalOriginAllowlist: [],
    authOriginAllowlist: ['login.microsoftonline.com', 'login.live.com', 'accounts.google.com'],
    profileDir: join(root, 'browser-profile'),
    screenshotDir: join(root, 'browser-screenshots'),
  };
}

export function getBrowserConfigPath(): string {
  return join(storageRoot(), 'browser-config.json');
}

export function loadBrowserConfig(): BrowserConfig {
  const path = getBrowserConfigPath();
  const d = defaults();
  if (!existsSync(path)) return d;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<BrowserConfig>;
    const merged = { ...d, ...raw };
    if (!isLoopbackUrl(merged.cdpUrl)) {
      throw new Error(`browser-config.json: cdpUrl must point to 127.0.0.1 or localhost, got ${merged.cdpUrl}`);
    }
    return merged;
  } catch (err) {
    throw new Error(`Failed to load ${path}: ${(err as Error).message}`);
  }
}

export function saveBrowserConfig(partial: Partial<BrowserConfig>): void {
  ensureDir(storageRoot());
  const current = existsSync(getBrowserConfigPath()) ? loadBrowserConfig() : defaults();
  const next = { ...current, ...partial };
  writeFileSync(getBrowserConfigPath(), JSON.stringify(next, null, 2));
}

function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1';
  } catch {
    return false;
  }
}
