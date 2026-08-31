import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const testState = vi.hoisted(() => ({
  homeDir: `${process.env.TEMP || process.env.TMPDIR || '/tmp'}/caco-mcp-config-loader-${process.pid}`,
  cacoAuth: { servers: {} as Record<string, { token?: string; refreshToken?: string; expiresAt?: number }> },
  cliTokens: new Map<string, { accessToken: string; expiresAt?: number }>(),
  refreshResult: false,
  refreshedToken: '',
}));

vi.mock('os', async (importOriginal) => {
  const original = await importOriginal<typeof import('os')>();
  return { ...original, homedir: () => testState.homeDir };
});

vi.mock('../../src/storage.js', () => ({
  getMcpAuth: vi.fn(() => testState.cacoAuth),
}));

vi.mock('../../src/cli-oauth.js', () => ({
  getCliOAuthTokens: vi.fn((url: string) => testState.cliTokens.get(url) ?? null),
}));

vi.mock('../../src/mcp-auth-service.js', () => ({
  refreshAccessToken: vi.fn(async (serverId: string) => {
    if (testState.refreshResult) {
      testState.cacoAuth = {
        servers: {
          ...testState.cacoAuth.servers,
          [serverId]: { token: testState.refreshedToken, expiresAt: Date.now() + 60_000 },
        },
      };
    }
    return testState.refreshResult;
  }),
}));

vi.mock('../../src/mcp-discovery.js', () => ({
  serverIdFromUrl: vi.fn((url: string) => new URL(url).hostname.replace(/\./g, '-')),
}));

import { getCliOAuthTokens } from '../../src/cli-oauth.js';
import { refreshAccessToken } from '../../src/mcp-auth-service.js';
import { loadMcpServers, loadMcpServersStrict } from '../../src/mcp-config-loader.js';

const configDir = join(testState.homeDir, '.copilot');
const configPath = join(configDir, 'mcp-config.json');

function writeConfig(config: unknown): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config), 'utf-8');
}

describe('loadMcpServers', () => {
  beforeEach(() => {
    rmSync(testState.homeDir, { recursive: true, force: true });
    testState.cacoAuth = { servers: {} };
    testState.cliTokens.clear();
    testState.refreshResult = false;
    testState.refreshedToken = '';
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.mocked(console.log).mockRestore();
    vi.mocked(console.error).mockRestore();
    rmSync(testState.homeDir, { recursive: true, force: true });
  });

  it('returns undefined when mcp-config.json does not exist', async () => {
    await expect(loadMcpServers()).resolves.toBeUndefined();
  });

  it('returns undefined when the config contains no servers', async () => {
    writeConfig({ mcpServers: {} });

    await expect(loadMcpServers()).resolves.toBeUndefined();
  });

  it('returns undefined for malformed JSON config', async () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, '{ not json', 'utf-8');

    await expect(loadMcpServers()).resolves.toBeUndefined();
  });

  it('returns a local command server without injecting authorization headers', async () => {
    writeConfig({
      mcpServers: {
        local: { command: 'node', args: ['server.js'], env: { NODE_ENV: 'test' } },
      },
    });

    const servers = await loadMcpServers();

    expect(servers).toEqual({
      local: { command: 'node', args: ['server.js'], env: { NODE_ENV: 'test' } },
    });
    expect(getCliOAuthTokens).not.toHaveBeenCalled();
  });

  it('injects a non-expired Caco auth token for a remote server', async () => {
    const url = 'https://api.example.com/mcp';
    testState.cacoAuth = {
      servers: {
        'api-example-com': { token: 'caco-token', expiresAt: Date.now() + 60_000 },
      },
    };
    writeConfig({
      mcpServers: {
        remote: { url, headers: { 'X-Trace': 'keep' } },
      },
    });

    const servers = await loadMcpServers();

    expect(servers).toEqual({
      remote: {
        url,
        headers: { 'X-Trace': 'keep', Authorization: 'Bearer caco-token' },
      },
    });
    expect(getCliOAuthTokens).not.toHaveBeenCalled();
  });

  it('falls back to a valid CLI OAuth token when Caco auth has no token', async () => {
    const url = 'https://fallback.example.com/mcp';
    testState.cliTokens.set(url, { accessToken: 'cli-token', expiresAt: Math.floor(Date.now() / 1000) + 60 });
    writeConfig({
      mcpServers: {
        remote: { url },
      },
    });

    const servers = await loadMcpServers();

    expect(servers).toEqual({
      remote: {
        url,
        headers: { Authorization: 'Bearer cli-token' },
      },
    });
  });

  it('skips an expired CLI OAuth fallback token', async () => {
    const url = 'https://expired-cli.example.com/mcp';
    testState.cliTokens.set(url, { accessToken: 'old-cli-token', expiresAt: Math.floor(Date.now() / 1000) - 60 });
    writeConfig({
      mcpServers: {
        remote: { url },
      },
    });

    const servers = await loadMcpServers();

    expect(servers).toEqual({
      remote: { url },
    });
  });

  it('refreshes an expired Caco token and injects the refreshed token', async () => {
    const url = 'https://refresh.example.com/mcp';
    testState.cacoAuth = {
      servers: {
        'refresh-example-com': {
          token: 'expired-token',
          refreshToken: 'refresh-token',
          expiresAt: Date.now() - 1_000,
        },
      },
    };
    testState.refreshResult = true;
    testState.refreshedToken = 'fresh-token';
    writeConfig({
      mcpServers: {
        remote: { url },
      },
    });

    const servers = await loadMcpServers();

    expect(refreshAccessToken).toHaveBeenCalledWith('refresh-example-com');
    expect(servers).toEqual({
      remote: {
        url,
        headers: { Authorization: 'Bearer fresh-token' },
      },
    });
  });
});

describe('loadMcpServersStrict — transactional reload gate', () => {
  beforeEach(() => {
    rmSync(testState.homeDir, { recursive: true, force: true });
    testState.cacoAuth = { servers: {} };
    testState.cliTokens.clear();
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.mocked(console.log).mockRestore();
    vi.mocked(console.error).mockRestore();
    rmSync(testState.homeDir, { recursive: true, force: true });
  });

  it('no file causes ok true with undefined servers', async () => {
    await expect(loadMcpServersStrict()).resolves.toEqual({ ok: true, servers: undefined });
  });

  it('empty mcpServers causes ok true with undefined servers', async () => {
    writeConfig({ mcpServers: {} });
    await expect(loadMcpServersStrict()).resolves.toEqual({ ok: true, servers: undefined });
  });

  it('malformed JSON causes ok false (the transactional gate)', async () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, '{ not json', 'utf-8');
    const r = await loadMcpServersStrict();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/malformed/i);
  });

  it('valid servers cause ok true with the injected server map', async () => {
    writeConfig({ mcpServers: { local: { command: 'node', args: ['s.js'] } } });
    const r = await loadMcpServersStrict();
    expect(r).toEqual({ ok: true, servers: { local: { command: 'node', args: ['s.js'] } } });
  });

  it('valid JSON that is not an object (null) causes ok true with no servers (no throw)', async () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, 'null', 'utf-8');
    await expect(loadMcpServersStrict()).resolves.toEqual({ ok: true, servers: undefined });
  });

  it('a malformed remote server URL is isolated — it never throws and other servers still load', async () => {
    writeConfig({
      mcpServers: {
        broken: { url: 'not a valid url' }, // serverIdFromUrl(new URL(...)) throws for this
        good: { command: 'node', args: ['s.js'] },
      },
    });
    const r = await loadMcpServersStrict();
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Both entries survive; the broken one just has no injected Authorization header.
      expect(r.servers).toEqual({
        broken: { url: 'not a valid url' },
        good: { command: 'node', args: ['s.js'] },
      });
    }
  });
});
