import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadBrowserConfig, saveBrowserConfig } from '../../src/browser-config.js';

let tmp: string;
let origHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'caco-bcfg-'));
  origHome = process.env.CACO_HOME;
  process.env.CACO_HOME = tmp;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.CACO_HOME;
  else process.env.CACO_HOME = origHome;
  rmSync(tmp, { recursive: true, force: true });
});

describe('browser-config', () => {
  it('returns defaults when no file present', () => {
    const cfg = loadBrowserConfig();
    expect(cfg.cdpUrl).toBe('http://127.0.0.1:9222');
    expect(cfg.defaultTimeoutMs).toBe(10000);
    expect(cfg.launchTimeoutMs).toBe(30000);
    expect(cfg.evalEnabled).toBe(false);
    expect(cfg.profileDir).toContain(tmp);
  });

  it('merges file values over defaults', () => {
    writeFileSync(join(tmp, 'browser-config.json'), JSON.stringify({
      cdpUrl: 'http://127.0.0.1:9333',
      evalEnabled: true,
    }));
    const cfg = loadBrowserConfig();
    expect(cfg.cdpUrl).toBe('http://127.0.0.1:9333');
    expect(cfg.evalEnabled).toBe(true);
    expect(cfg.launchTimeoutMs).toBe(30000);
  });

  it('rejects non-loopback cdpUrl', () => {
    writeFileSync(join(tmp, 'browser-config.json'), JSON.stringify({
      cdpUrl: 'http://10.0.0.1:9222',
    }));
    expect(() => loadBrowserConfig()).toThrow(/127\.0\.0\.1 or localhost/);
  });

  it('saveBrowserConfig persists partial updates', () => {
    saveBrowserConfig({ lastLaunchedMode: 'headless' });
    const cfg = loadBrowserConfig();
    expect(cfg.lastLaunchedMode).toBe('headless');
    expect(cfg.cdpUrl).toBe('http://127.0.0.1:9222');
  });
});
