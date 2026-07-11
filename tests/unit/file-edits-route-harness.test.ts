/**
 * file-edits route harness (Mechanism B, docs/spec-backend-coverage-80.md).
 * Mocks sessionManager, injects a fake GitEditPoller via initFileEditsRoutes,
 * and uses the real file-edits-store under a tmp CACO_HOME; drives real HTTP so
 * the handler validation/branches execute.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

let cwdDir: string;
const getSessionCwd = vi.fn((id: string) => (id === 'known' ? cwdDir : null));

vi.mock('../../src/session-manager.js', () => ({ sessionManager: { getSessionCwd } }));

const poller = {
  snapshot: vi.fn(async () => [{ relativePath: 'a.ts', status: 'modified' }]),
  isAttached: vi.fn(() => true),
  openFile: vi.fn(async (_s: string, rel: string) => (rel === 'missing.ts' ? null : { relativePath: rel })),
};

let server: Server;
let base: string;
let home: string;
let flushCards: (sessionId: string) => void;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'caco-fe-home-'));
  process.env.CACO_HOME = home;
  cwdDir = mkdtempSync(join(tmpdir(), 'caco-fe-cwd-'));
  writeFileSync(join(cwdDir, 'real.ts'), 'x');
  const mod = await import('../../src/routes/file-edits.js');
  mod.initFileEditsRoutes(poller as never);
  flushCards = mod.flushFileEditsCardList;
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(() => {
  server?.close();
  delete process.env.CACO_HOME;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwdDir, { recursive: true, force: true });
});

beforeEach(() => {
  poller.snapshot.mockClear();
  poller.openFile.mockClear();
});

const F = (p: string) => `${base}/sessions/known/file-edits${p}`;
const jpost = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const jput = (url: string, body: unknown) =>
  fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('file-edits route harness', () => {
  it('404s an unknown session on snapshot', async () => {
    const r = await fetch(`${base}/sessions/nope/file-edits/snapshot`);
    expect(r.status).toBe(404);
  });

  it('returns the poller snapshot + isGit', async () => {
    const r = await fetch(F('/snapshot'));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body.edits)).toBe(true);
    expect(body.isGit).toBe(true);
    expect(poller.snapshot).toHaveBeenCalled();
  });

  it('open: rejects invalid relativePath variants', async () => {
    expect((await jpost(F('/open'), {})).status).toBe(400);
    expect((await jpost(F('/open'), { relativePath: '' })).status).toBe(400);
    expect((await jpost(F('/open'), { relativePath: '/etc/passwd' })).status).toBe(400);
    expect((await jpost(F('/open'), { relativePath: 'a/../../b' })).status).toBe(400);
    expect((await jpost(F('/open'), { relativePath: 'a.ts', diffMode: 'bogus' })).status).toBe(400);
  });

  it('open: materializes an edit for a valid repo path', async () => {
    const r = await jpost(F('/open'), { relativePath: 'real.ts', diffMode: 'staged' });
    expect(r.status).toBe(200);
    expect((await r.json()).edit.relativePath).toBe('real.ts');
    expect(poller.openFile).toHaveBeenCalled();
  });

  it('open: 404 when the poller cannot find the path', async () => {
    const r = await jpost(F('/open'), { relativePath: 'missing.ts' });
    expect(r.status).toBe(404);
  });

  it('cards: GET returns a list, PUT validates then persists', async () => {
    const got = await (await fetch(F('/cards'))).json();
    expect(Array.isArray(got.cards)).toBe(true);

    expect((await jput(F('/cards'), 'nope')).status).toBe(400);
    expect((await jput(F('/cards'), { schemaVersion: 9, cards: [], dismissed: [] })).status).toBe(400);
    expect((await jput(F('/cards'), { schemaVersion: 2, cards: [{ bad: 1 }], dismissed: [] })).status).toBe(400);
    expect((await jput(F('/cards'), { schemaVersion: 2, cards: [], dismissed: [5] })).status).toBe(400);

    const ok = await jput(F('/cards'), {
      schemaVersion: 2,
      cards: [{ relativePath: 'a.ts', collapsed: true }],
      dismissed: ['old.ts'],
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).ok).toBe(true);

    // Writes are debounced 500ms; flush so the read-back sees them synchronously.
    flushCards('known');
    const after = await (await fetch(F('/cards'))).json();
    expect(after.cards.some((c: { relativePath: string }) => c.relativePath === 'a.ts')).toBe(true);
  });

  it('cards: POST alias also persists (sendBeacon path)', async () => {
    const r = await jpost(F('/cards'), { schemaVersion: 1, cards: [], dismissed: [] });
    expect(r.status).toBe(200);
  });
});
