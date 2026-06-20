/**
 * P7 slice 1 follow-up: register_mcp_server must not clobber a concurrent
 * registration/auth that lands during its awaited OAuth discovery. The tool
 * only registers when the server is still absent at write time, so a fresh
 * `prev` established during the gap wins through the atomic boundary.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const discovery = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('../../src/mcp-discovery.js', () => ({ discoverOAuthMetadata: discovery.fn }));
vi.mock('../../src/cli-oauth.js', () => ({ getCliOAuthConfig: () => null }));

let tempHome: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'caco-mcp-tool-'));
  process.env.CACO_HOME = tempHome;
  vi.resetModules();
  discovery.fn.mockReset();
});

afterEach(() => {
  delete process.env.CACO_HOME;
  rmSync(tempHome, { recursive: true, force: true });
});

interface ToolWithHandler {
  handler: (args: { serverUrl: string; serverId: string; clientId?: string }) => Promise<unknown>;
}

describe('register_mcp_server concurrent-write safety', () => {
  it('preserves a concurrent auth that lands during discovery', async () => {
    const storage = await import('../../src/storage.js');
    const { createMcpAuthTools } = await import('../../src/mcp-auth-tools.js');
    const [tool] = createMcpAuthTools() as unknown as ToolWithHandler[];

    let resolveDiscovery!: (m: unknown) => void;
    discovery.fn.mockReturnValue(new Promise((r) => { resolveDiscovery = r; }));

    // Registration begins and suspends on discovery (server absent at start).
    const pending = tool.handler({ serverUrl: 'https://api.example.com', serverId: 'srv' });
    await Promise.resolve();

    // A concurrent flow registers AND authenticates srv during the gap.
    storage.updateMcpServerAuth('srv', () => ({
      url: 'https://api.example.com',
      authorizationEndpoint: 'https://auth.example.com/authorize',
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'cid',
      token: 'live-token',
      needsAuth: false,
      needsClientId: false,
    }));

    // Discovery completes; the tool writes through the boundary.
    resolveDiscovery({
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
      scopes_supported: ['read'],
    });
    await pending;

    const final = storage.getMcpServerAuth('srv');
    // The concurrent auth survives — the tool did NOT overwrite it.
    expect(final?.token).toBe('live-token');
    expect(final?.needsAuth).toBe(false);
  });

  it('still registers normally when no concurrent write occurs', async () => {
    const storage = await import('../../src/storage.js');
    const { createMcpAuthTools } = await import('../../src/mcp-auth-tools.js');
    const [tool] = createMcpAuthTools() as unknown as ToolWithHandler[];

    discovery.fn.mockResolvedValue({
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
      scopes_supported: ['read'],
    });

    await tool.handler({ serverUrl: 'https://api.example.com', serverId: 'srv', clientId: 'cid' });

    const final = storage.getMcpServerAuth('srv');
    expect(final?.authorizationEndpoint).toBe('https://auth.example.com/authorize');
    expect(final?.clientId).toBe('cid');
    expect(final?.needsAuth).toBe(true);
  });
});
