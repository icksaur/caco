/**
 * watch route harness. Mounts the real watch router on a bare Express app with
 * singleton deps (sessionManager/sessionState/websocket) mocked, and drives real
 * HTTP requests so the handler bodies execute. This is the reference pattern for
 * the route-coverage push (docs/spec-backend-coverage-80.md, Mechanism B).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

const getSessionCwd = vi.fn((id: string) => (id === 'known' ? '/tmp/x' : null));
const onSessionEnd = vi.fn();
const broadcastEvent = vi.fn();

vi.mock('../../src/session-manager.js', () => ({ sessionManager: { getSessionCwd } }));
vi.mock('../../src/session-state.js', () => ({ sessionState: { onSessionEnd } }));
vi.mock('../../src/routes/websocket.js', () => ({ broadcastEvent }));

let server: Server;
let base: string;
let tmp: string;
let watchedFile: string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'caco-watch-harness-'));
  watchedFile = join(tmp, 'foo.ts');
  writeFileSync(watchedFile, 'x');
  const { router } = await import('../../src/routes/watch.js');
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
  rmSync(tmp, { recursive: true, force: true });
});

describe('watch route harness (prototype)', () => {
  it('404s an unknown session', async () => {
    const r = await fetch(`${base}/sessions/nope/watch`, { method: 'GET' });
    expect(r.status).toBe(404);
    expect((await r.json()).error).toMatch(/not found/i);
  });

  it('400s a missing path on acquire', async () => {
    const r = await fetch(`${base}/sessions/known/watch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
  });

  it('acquires, lists, renews, and releases a lease', async () => {
    const acq = await fetch(`${base}/sessions/known/watch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: watchedFile, scope: 'file' }),
    });
    expect(acq.status).toBe(200);
    const { leaseId } = await acq.json();
    expect(leaseId).toBeTruthy();

    const list = await (await fetch(`${base}/sessions/known/watch`)).json();
    expect(list.leases.some((l: { leaseId: string }) => l.leaseId === leaseId)).toBe(true);

    const renew = await fetch(`${base}/sessions/known/watch/${leaseId}/renew`, { method: 'POST' });
    expect(renew.status).toBe(200);

    const del = await fetch(`${base}/sessions/known/watch/${leaseId}`, { method: 'DELETE' });
    expect((await del.json()).ok).toBe(true);
  });
});
