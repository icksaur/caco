import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

/**
 * The three operator routes added by spec-enable-tools-config-freshness.
 *
 * Their manager methods are covered by mcp-freshness / session-manager tests;
 * what is untested is the HTTP boundary itself — status codes, the input
 * validation that stands between an operator and a destructive purge, and the
 * error translation. Each of these routes either recreates warm sessions
 * (busting their prompt cache) or deletes learned keys, so a wrapper that
 * silently accepts the wrong shape is the expensive kind of bug.
 */
const manager = vi.hoisted(() => ({
  reloadMcpConfig: vi.fn(async () => ({ ok: true, recreated: [] as string[], skipped: [] as string[], failed: [] as string[] })),
  listKnownRegistryServers: vi.fn(() => [] as string[]),
  forgetUnknownTools: vi.fn(async (_servers: string[]) => ({ removed: 0, persisted: true })),
}));

vi.mock('../../src/session-manager.js', () => ({ sessionManager: manager }));
vi.mock('../../src/storage.js', () => ({
  getMcpAuth: vi.fn(() => ({ servers: {} })),
  setMcpAuth: vi.fn(),
  getMcpServerAuth: vi.fn(),
  updateMcpServerAuth: vi.fn(),
}));
vi.mock('../../src/cli-oauth.js', () => ({ listCliOAuthConfigs: vi.fn(() => []) }));
vi.mock('../../src/mcp-discovery.js', () => ({ discoverOAuthMetadata: vi.fn(), serverIdFromUrl: vi.fn((u: string) => u) }));
vi.mock('../../src/mcp-auth-service.js', () => ({ refreshAccessToken: vi.fn() }));

let server: Server;
let base: string;

const post = (path: string, body?: unknown) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? '{}' : JSON.stringify(body),
  });

beforeAll(async () => {
  const { router } = await import('../../src/routes/mcp-auth.js');
  const app = express();
  app.use(express.json());
  app.use('/api/mcp/auth', router);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp/auth`;
});

afterAll(() => { server?.close(); });

beforeEach(() => {
  vi.clearAllMocks();
  manager.reloadMcpConfig.mockResolvedValue({ ok: true, recreated: [], skipped: [], failed: [] });
  manager.listKnownRegistryServers.mockReturnValue([]);
  manager.forgetUnknownTools.mockResolvedValue({ removed: 0, persisted: true });
});

describe('POST /reload', () => {
  it('returns the reload report on success', async () => {
    manager.reloadMcpConfig.mockResolvedValue({ ok: true, recreated: ['s-1'], skipped: ['s-2'], failed: [] });
    const res = await post('/reload');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, recreated: ['s-1'], skipped: ['s-2'] });
  });

  it('reports a malformed config as a client error, not a server fault', async () => {
    // The reload is transactional: a bad config leaves every session's prior
    // config intact, so this is a refusal rather than a failure.
    manager.reloadMcpConfig.mockResolvedValue({ ok: false, error: 'bad json at line 3', recreated: [], skipped: [], failed: [] } as never);
    const res = await post('/reload');
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'bad json at line 3' });
  });

  it('supplies an error string when the manager reports failure without one', async () => {
    manager.reloadMcpConfig.mockResolvedValue({ ok: false, recreated: [], skipped: [], failed: [] } as never);
    const res = await post('/reload');
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'reload failed' });
  });

  it('turns a thrown error into a 500 rather than an unhandled rejection', async () => {
    manager.reloadMcpConfig.mockRejectedValue(new Error('disk gone'));
    const res = await post('/reload');
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ error: 'disk gone' });
  });
});

describe('GET /registry-servers', () => {
  it('lists the candidate stale server names', async () => {
    manager.listKnownRegistryServers.mockReturnValue(['ADO', 'github-mcp-server']);
    const res = await fetch(base + '/registry-servers');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ servers: ['ADO', 'github-mcp-server'] });
  });

  it('is read-only: listing does not purge anything', async () => {
    await fetch(base + '/registry-servers');
    expect(manager.forgetUnknownTools).not.toHaveBeenCalled();
  });
});

describe('POST /forget-unknown', () => {
  it('purges the named servers and reports what went', async () => {
    manager.forgetUnknownTools.mockResolvedValue({ removed: 7, persisted: true });
    const res = await post('/forget-unknown', { servers: ['ADO'] });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ removed: 7, persisted: true });
    expect(manager.forgetUnknownTools).toHaveBeenCalledWith(['ADO']);
  });

  it('refuses an empty list, because the purge must be an explicit choice', async () => {
    // An empty list is the shape an accidental "purge everything" would take;
    // there is deliberately no automatic sweep.
    const res = await post('/forget-unknown', { servers: [] });
    expect(res.status).toBe(400);
    expect(manager.forgetUnknownTools).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing field', {}],
    ['a bare string', { servers: 'ADO' }],
    ['a non-string member', { servers: ['ADO', 7] }],
    ['null', { servers: null }],
  ])('refuses %s without touching the registry', async (_label, body) => {
    const res = await post('/forget-unknown', body);
    expect(res.status).toBe(400);
    expect(manager.forgetUnknownTools).not.toHaveBeenCalled();
  });
});
