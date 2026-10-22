import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { MCPAuthState } from '../../src/mcp-auth-store.js';

/**
 * Oracles for spec-mcp-auth-keepalive: proactively refreshing Caco-managed MCP
 * OAuth tokens before they expire mid-session, closing the gap that made
 * icm-mcp (and any other OAuth-protected remote MCP server) silently stop
 * working inside a long-warm session with no path back except a full Caco
 * restart. See mcp-auth-service.ts for the "why" in depth.
 *
 * `serversNeedingProactiveRefresh` is pure selection logic (one getMcpAuth()
 * read, no fetch) — tested directly against a real temp store, same pattern
 * as mcp-auth-store-atomic.test.ts. `refreshNearExpiryTokens` additionally
 * drives the real refresh HTTP call via a mocked fetch, proving the two
 * compose correctly end to end.
 */

let tempHome: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'caco-mcp-auth-keepalive-'));
  process.env.CACO_HOME = tempHome;
  vi.resetModules();
  vi.unstubAllGlobals();
});

afterEach(() => {
  delete process.env.CACO_HOME;
  rmSync(tempHome, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

async function freshModules() {
  // Re-import with the temp CACO_HOME active (STORAGE_ROOT is read at
  // import). vi.resetModules() in beforeEach forces re-evaluation.
  const store = await import('../../src/mcp-auth-store.js');
  const service = await import('../../src/mcp-auth-service.js');
  return { ...store, ...service };
}

const NOW = 1_700_000_000_000;

function serverState(overrides: Partial<MCPAuthState> = {}): MCPAuthState {
  return {
    url: 'https://icm-mcp-prod.azure-api.net/v1/',
    authorizationEndpoint: 'https://login.microsoftonline.com/authorize',
    tokenEndpoint: 'https://login.microsoftonline.com/token',
    clientId: 'client-123',
    token: 'live-access-token',
    refreshToken: 'live-refresh-token',
    needsAuth: false,
    needsClientId: false,
    ...overrides,
  };
}

describe('serversNeedingProactiveRefresh — the selection oracle', () => {
  it('selects a server whose token is already past expiry', async () => {
    const { setMcpServerAuth, serversNeedingProactiveRefresh } = await freshModules();
    setMcpServerAuth('icm-mcp-prod-azure-api-net', serverState({ expiresAt: NOW - 1000 }));
    expect(serversNeedingProactiveRefresh(NOW)).toEqual(['icm-mcp-prod-azure-api-net']);
  });

  it('selects a server whose token expires within the proactive window', async () => {
    const { setMcpServerAuth, serversNeedingProactiveRefresh, PROACTIVE_REFRESH_WINDOW_MS } = await freshModules();
    setMcpServerAuth('srv', serverState({ expiresAt: NOW + PROACTIVE_REFRESH_WINDOW_MS - 1000 }));
    expect(serversNeedingProactiveRefresh(NOW)).toEqual(['srv']);
  });

  it('excludes a server whose token is comfortably outside the window', async () => {
    const { setMcpServerAuth, serversNeedingProactiveRefresh, PROACTIVE_REFRESH_WINDOW_MS } = await freshModules();
    setMcpServerAuth('srv', serverState({ expiresAt: NOW + PROACTIVE_REFRESH_WINDOW_MS + 60_000 }));
    expect(serversNeedingProactiveRefresh(NOW)).toEqual([]);
  });

  it('excludes a server with no refreshToken (nothing to refresh toward)', async () => {
    const { setMcpServerAuth, serversNeedingProactiveRefresh } = await freshModules();
    setMcpServerAuth('srv', serverState({ expiresAt: NOW - 1000, refreshToken: undefined }));
    expect(serversNeedingProactiveRefresh(NOW)).toEqual([]);
  });

  it('excludes a server with no expiresAt (never actually authenticated)', async () => {
    const { setMcpServerAuth, serversNeedingProactiveRefresh } = await freshModules();
    setMcpServerAuth('srv', serverState({ expiresAt: undefined }));
    expect(serversNeedingProactiveRefresh(NOW)).toEqual([]);
  });

  it('excludes a server already flagged needsAuth (prior refresh failed outright; retrying would just repeat the failure)', async () => {
    const { setMcpServerAuth, serversNeedingProactiveRefresh } = await freshModules();
    setMcpServerAuth('srv', serverState({ expiresAt: NOW - 1000, needsAuth: true }));
    expect(serversNeedingProactiveRefresh(NOW)).toEqual([]);
  });

  it('selects multiple independently-eligible servers', async () => {
    const { setMcpServerAuth, serversNeedingProactiveRefresh } = await freshModules();
    setMcpServerAuth('a', serverState({ expiresAt: NOW - 1000 }));
    setMcpServerAuth('b', serverState({ expiresAt: NOW + 999_999_999 })); // far future, excluded
    setMcpServerAuth('c', serverState({ expiresAt: NOW - 1 }));
    expect(serversNeedingProactiveRefresh(NOW).sort()).toEqual(['a', 'c']);
  });
});

describe('refreshNearExpiryTokens — end-to-end composition', () => {
  it('refreshes every eligible server independently and returns the refreshed ids', async () => {
    const { setMcpServerAuth, getMcpServerAuth, refreshNearExpiryTokens } = await freshModules();
    setMcpServerAuth('good', serverState({ expiresAt: NOW - 1000 }));
    setMcpServerAuth('also-good', serverState({ expiresAt: NOW - 1000 }));
    setMcpServerAuth('not-due', serverState({ expiresAt: NOW + 999_999_999 }));

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: 'fresh-token', refresh_token: 'fresh-refresh', expires_in: 3600 }),
    })));

    const refreshed = (await refreshNearExpiryTokens(NOW)).sort();
    expect(refreshed).toEqual(['also-good', 'good']);
    expect(getMcpServerAuth('good')?.token).toBe('fresh-token');
    expect(getMcpServerAuth('also-good')?.token).toBe('fresh-token');
    // The not-due server was never touched — fetch was called exactly twice.
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it('one failing server does not block the others from refreshing', async () => {
    const { setMcpServerAuth, getMcpServerAuth, refreshNearExpiryTokens } = await freshModules();
    setMcpServerAuth('fails', serverState({ expiresAt: NOW - 1000 }));
    setMcpServerAuth('succeeds', serverState({ expiresAt: NOW - 1000 }));

    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      call++;
      if (call === 1) return { ok: false, status: 401, json: async () => ({ error_description: 'invalid_grant' }) };
      return { ok: true, json: async () => ({ access_token: 'fresh-token', expires_in: 3600 }) };
    }));

    const refreshed = await refreshNearExpiryTokens(NOW);
    expect(refreshed).toHaveLength(1);
    // Whichever server's fetch call landed second got refreshed; the other
    // is flagged needsAuth by refreshAccessToken's own failure handling.
    const states = { fails: getMcpServerAuth('fails'), succeeds: getMcpServerAuth('succeeds') };
    const refreshedState = Object.values(states).find(s => s?.token === 'fresh-token');
    const failedState = Object.values(states).find(s => s?.needsAuth === true);
    expect(refreshedState).toBeTruthy();
    expect(failedState).toBeTruthy();
  });

  it('returns an empty array with zero fetch calls when nothing is near expiry', async () => {
    const { setMcpServerAuth, refreshNearExpiryTokens } = await freshModules();
    setMcpServerAuth('srv', serverState({ expiresAt: NOW + 999_999_999 }));
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(await refreshNearExpiryTokens(NOW)).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
