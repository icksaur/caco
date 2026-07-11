/**
 * surface route harness (Mechanism B, docs/spec-backend-coverage-80.md). Mounts
 * the real surface router on a bare Express app with sessionManager + websocket
 * mocked and a tmp CACO_HOME backing the real surface-store, then drives real
 * HTTP so the handler bodies (validation, 404/400 branches, mutate/clear/put/
 * patch wiring + broadcast) execute.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

const getSessionCwd = vi.fn((id: string) => (id === 'known' ? '/tmp/x' : null));
const broadcastEvent = vi.fn();

vi.mock('../../src/session-manager.js', () => ({ sessionManager: { getSessionCwd } }));
vi.mock('../../src/routes/websocket.js', () => ({ broadcastEvent }));

let server: Server;
let base: string;
let home: string;
let store: typeof import('../../src/surface-store.js');

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'caco-surface-harness-'));
  process.env.CACO_HOME = home;
  const { router } = await import('../../src/routes/surface.js');
  store = await import('../../src/surface-store.js');
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
  delete process.env.CACO_HOME;
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  broadcastEvent.mockClear();
  store.deleteSurface('known');
});

const S = (p: string) => `${base}/sessions/known/surface${p}`;
const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const put = (url: string, body: unknown) =>
  fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const patch = (url: string, body: unknown) =>
  fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function seedToken(): Promise<string> {
  // getOrInitSurface does NOT persist; an empty mutate materializes the doc on
  // disk (token stays INITIAL since the body is unchanged) so GET can read it.
  const res = store.mutate('known', store.INITIAL_DATA_TOKEN, {});
  return res.ok ? res.dataToken : store.INITIAL_DATA_TOKEN;
}

describe('surface route harness', () => {
  it('404s an unknown session on GET surface', async () => {
    const r = await fetch(`${base}/sessions/nope/surface`);
    expect(r.status).toBe(404);
    expect((await r.json()).error).toMatch(/not found/i);
  });

  it('404s when the session has no surface doc yet', async () => {
    const r = await fetch(S(''));
    expect(r.status).toBe(404);
    expect((await r.json()).error).toMatch(/no surface/i);
  });

  it('returns the seeded doc and its changes', async () => {
    const token = await seedToken();
    const doc = await (await fetch(S(''))).json();
    expect(doc.dataToken).toBe(token);

    const changes = await (await fetch(S('/changes'))).json();
    expect(changes.dataToken).toBe(token);
    expect(typeof changes.changes).toBe('object');
  });

  it('404s changes for an unknown session', async () => {
    const r = await fetch(`${base}/sessions/nope/surface/changes`);
    expect(r.status).toBe(404);
  });

  it('mutate: 400 without a dataToken, ok with a valid one + broadcasts', async () => {
    const token = await seedToken();
    const bad = await post(S('/mutate'), {});
    expect(bad.status).toBe(400);

    const r = await post(S('/mutate'), {
      dataToken: token,
      create: [{ id: 'a', type: 'note', title: 'A' }],
    });
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(broadcastEvent).toHaveBeenCalled();
  });

  it('mutate: stale dataToken fails at the protocol level (HTTP 200, ok:false)', async () => {
    await seedToken();
    const r = await post(S('/mutate'), { dataToken: 'stale-token', create: [] });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBeTruthy();
  });

  it('clear-changes: 400 without a dataToken, ok with a valid one', async () => {
    const token = await seedToken();
    expect((await post(S('/clear-changes'), {})).status).toBe(400);
    const r = await post(S('/clear-changes'), { dataToken: token });
    expect(r.status).toBe(200);
  });

  it('put change: 400 without token, 400 without item, ok when the item exists', async () => {
    const token = await seedToken();
    expect((await put(S('/changes/x'), {})).status).toBe(400);
    expect((await put(S('/changes/x'), { dataToken: token })).status).toBe(400);

    // putChange requires the item to already exist in items; create it first.
    const created = await (await post(S('/mutate'), {
      dataToken: token,
      create: [{ id: 'x', type: 'note', title: 'X' }],
    })).json();
    expect(created.ok).toBe(true);
    broadcastEvent.mockClear();

    const r = await put(S('/changes/x'), {
      dataToken: created.dataToken,
      item: { id: 'x', type: 'note', title: 'X edited' },
    });
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
    expect(broadcastEvent).toHaveBeenCalled();
  });

  it('patch style: 400 without token, ok with a valid one', async () => {
    const token = await seedToken();
    expect((await patch(S('/style'), {})).status).toBe(400);
    const r = await patch(S('/style'), { dataToken: token, style: 'custom', customStyle: 'body{}' });
    expect(r.status).toBe(200);
  });

  it('404s mutate for an unknown session', async () => {
    const r = await post(`${base}/sessions/nope/surface/mutate`, { dataToken: 't' });
    expect(r.status).toBe(404);
  });
});
