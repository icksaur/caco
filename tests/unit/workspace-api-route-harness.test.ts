/**
 * workspace-api route harness (Mechanism B, docs/spec-backend-coverage-80.md).
 * The file routes use the real fs + real path-utils against /tmp (an allowed
 * base); the /servers + /defer routes have their tool/session singletons mocked
 * to empties so the handler bodies run without the SDK.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

const sessionManager = {
  isClientRunning: vi.fn(() => true),
  isActive: vi.fn(() => false),
  mostRecentActiveSessionId: vi.fn(() => null),
  listMcpServers: vi.fn(async () => []),
  listMcpTools: vi.fn(async () => []),
  listBuiltinTools: vi.fn(async () => []),
  getCurrentToolMetadata: vi.fn(async () => []),
  getContextInfo: vi.fn(async () => ({ sessionId: null, contextInfo: null })),
  getCacoToolCatalog: vi.fn(() => []),
  getExcludedToolKeys: vi.fn(() => []),
  setServerDeferred: vi.fn(async () => ({ sessionsChanged: 0 })),
};

vi.mock('../../src/session-manager.js', () => ({ sessionManager }));
vi.mock('../../src/tool-registry.js', () => ({ excludedBuiltinNames: () => [], isDeferEligibleCacoTool: () => false, isPseudoServer: (n: string) => n === 'Caco' || n === 'Built-in' }));
vi.mock('../../src/tool-key-registry.js', () => ({ lookupMcpKey: () => null, learnFromMetadata: vi.fn() }));
vi.mock('../../src/tool-catalog.js', () => ({ buildToolCatalog: () => [] }));
vi.mock('../../src/session-tool-state.js', () => ({ classifyTool: () => 'enabled' }));
vi.mock('../../src/manual-defer-store.js', () => ({ getDeferredServers: () => new Set() }));
vi.mock('../../src/auto-defer-store.js', () => ({ getAutoDeferred: () => new Set() }));
vi.mock('../../src/tool-usage-store.js', () => ({
  getNowActiveSeconds: () => 0,
  getLastUsedActiveSeconds: () => ({}),
  DEFER_STALE_THRESHOLD_ACTIVE_SECONDS: 1000,
}));
vi.mock('../../src/tool-size.js', () => ({ estimateToolTokens: () => 0 }));
vi.mock('../../src/tool-size-store.js', () => ({ getToolSize: () => null, recordObservedSizes: vi.fn() }));
vi.mock('../../src/session-throughput.js', () => ({ snapshot: () => null }));
vi.mock('../../src/session-usage-cache.js', () => ({ getSessionUsage: () => undefined }));

let server: Server;
let base: string;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'caco-ws-'));
  writeFileSync(join(dir, 'r.txt'), 'hello');
  const { router } = await import('../../src/routes/workspace-api.js');
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('workspace-api route harness', () => {
  it('read_file: 400 no path, 403 disallowed base, 200 real /tmp file', async () => {
    expect((await post('/read_file', {})).status).toBe(400);
    expect((await post('/read_file', { path: '/etc/passwd' })).status).toBe(403);
    const ok = await post('/read_file', { path: join(dir, 'r.txt') });
    expect(ok.status).toBe(200);
    expect((await ok.json()).content).toBe('hello');
  });

  it('read_file: 400 when the allowed path does not exist', async () => {
    const r = await post('/read_file', { path: join(dir, 'nope.txt') });
    expect(r.status).toBe(400);
  });

  it('write_file: 400 missing fields, 200 round-trips to /tmp', async () => {
    expect((await post('/write_file', { path: join(dir, 'w.txt') })).status).toBe(400);
    const ok = await post('/write_file', { path: join(dir, 'w.txt'), content: 'data' });
    expect(ok.status).toBe(200);
    const back = await post('/read_file', { path: join(dir, 'w.txt') });
    expect((await back.json()).content).toBe('data');
  });

  it('list_directory: 400 no path, 200 lists the temp dir', async () => {
    expect((await post('/list_directory', {})).status).toBe(400);
    const ok = await post('/list_directory', { path: dir });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.ok).toBe(true);
    expect(body.files.some((f: { name: string }) => f.name === 'r.txt')).toBe(true);
  });

  it('GET /tools returns the static tool descriptors', async () => {
    const r = await fetch(`${base}/tools`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.tools.map((t: { name: string }) => t.name)).toContain('read_file');
    expect(Array.isArray(body.allowedDirectories)).toBe(true);
  });

  it('GET /servers returns clientRunning:false when the SDK is down', async () => {
    sessionManager.isClientRunning.mockReturnValueOnce(false);
    const r = await fetch(`${base}/servers`);
    expect(r.status).toBe(200);
    expect((await r.json()).clientRunning).toBe(false);
  });

  it('GET /servers assembles an (empty) server list when running', async () => {
    const r = await fetch(`${base}/servers`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.clientRunning).toBe(true);
    expect(Array.isArray(body.servers)).toBe(true);
  });

  it('POST /servers/:server/defer: 400 non-boolean, 200 happy', async () => {
    expect((await post('/servers/ctx7/defer', {})).status).toBe(400);
    const ok = await post('/servers/ctx7/defer', { deferred: true });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.ok).toBe(true);
    expect(sessionManager.setServerDeferred).toHaveBeenCalledWith('ctx7', true);
  });
});
