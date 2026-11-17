/**
 * GET /api/overview (spec-session-overview, O4 and route rules). Uses the real
 * collector, meta store, dispatch state, activity version and unobserved
 * tracker against a temp CACO_HOME, and proves a call performs no writes.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { mkdirSync, writeFileSync, readdirSync, readFileSync, statSync, rmSync } from 'fs';
import { createServer } from 'http';
import { join } from 'path';

const env = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: j } = await import('node:path');
  const home = mkdtempSync(j(tmpdir(), 'caco-overview-'));
  process.env.CACO_HOME = home;
  return { home, ids: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'] };
});

const dispatchMessage = vi.hoisted(() => vi.fn());

vi.mock('../../src/session-manager.js', () => ({
  sessionManager: {
    listForPager: () => env.ids.map(sessionId => ({ sessionId, cwd: 'C:/work' })),
    isBusy: () => false,
    getPendingTools: () => [],
  },
}));
vi.mock('../../src/schedule-store.js', () => ({
  listSchedules: async () => [],
  loadDefinition: async () => null,
  loadLastRun: async () => null,
}));
vi.mock('../../src/routes/session-messages.js', () => ({ dispatchMessage }));

let server: Server;
let base: string;
let activityVersion: typeof import('../../src/activity-version.js').activityVersion;
let unobservedTracker: typeof import('../../src/unobserved-tracker.js').unobservedTracker;
let dispatchState: typeof import('../../src/dispatch-state.js').dispatchState;

function writeMeta(id: string, meta: Record<string, unknown>): void {
  const dir = join(env.home, 'sessions', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
}

function snapshotFiles(): Record<string, { text: string; mtimeMs: number }> {
  const out: Record<string, { text: string; mtimeMs: number }> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name);
      if (name.isDirectory()) walk(p);
      else out[p] = { text: readFileSync(p, 'utf8'), mtimeMs: statSync(p).mtimeMs };
    }
  };
  walk(env.home);
  return out;
}

beforeAll(async () => {
  const now = Date.now();
  writeMeta(env.ids[0], { name: 'offer', responseOptions: ['Go'], responseOptionsAt: new Date(now - 60_000).toISOString(), lastUsedAt: new Date(now - 3_600_000).toISOString(), unobserved: true });
  writeMeta(env.ids[1], {
    name: 'wake', lastUsedAt: new Date(now - 3_600_000).toISOString(),
    wake: { everyMinutes: 60, registeredAt: new Date(now - 86_400_000).toISOString(), nextWakeAt: new Date(now + 600_000).toISOString(), consecutiveFailures: 0 },
  });
  writeMeta(env.ids[2], { name: 'archived', folder: 'auto-archive' });
  // Create the instance file before the snapshot (boot does this in production).
  const { getInstanceIdentity } = await import('../../src/instance-identity.js');
  getInstanceIdentity();
  ({ activityVersion } = await import('../../src/activity-version.js'));
  ({ unobservedTracker } = await import('../../src/unobserved-tracker.js'));
  ({ dispatchState } = await import('../../src/dispatch-state.js'));
  unobservedTracker.hydrate(env.ids);
  const { router } = await import('../../src/routes/overview.js');
  const app = express();
  app.use('/api', router);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(() => {
  server?.close();
  rmSync(env.home, { recursive: true, force: true });
});

describe('GET /api/overview', () => {
  it('scope=local performs no writes (O4)', async () => {
    const before = {
      files: snapshotFiles(),
      version: activityVersion.version,
      unobserved: unobservedTracker.getUnobservedIds().sort(),
      dispatches: [...dispatchState.getAllActive().keys()],
    };
    for (const context of ['brief', 'full', 'none']) {
      const res = await fetch(`${base}/overview?scope=local&context=${context}`);
      expect(res.status).toBe(200);
    }
    expect(snapshotFiles()).toEqual(before.files);
    expect(activityVersion.version).toBe(before.version);
    expect(unobservedTracker.getUnobservedIds().sort()).toEqual(before.unobserved);
    expect([...dispatchState.getAllActive().keys()]).toEqual(before.dispatches);
    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it('returns the instance, schemaVersion, no-store, and excludes archived sessions', async () => {
    const res = await fetch(`${base}/overview`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body).toMatchObject({ schemaVersion: 1, scope: 'local', coverage: 'complete', show: 'all' });
    expect(body.instance.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.counts).toMatchObject({ total: 2, archivedExcluded: 1 });
    const offer = body.entries.find((e: { sessionId: string }) => e.sessionId === env.ids[0]);
    expect(offer).toMatchObject({ key: `${body.instance.id}:${env.ids[0]}`, tier: 'full', waits: [{ kind: 'user-offer' }], cwd: 'C:/work' });
    const wake = body.entries.find((e: { sessionId: string }) => e.sessionId === env.ids[1]);
    expect(wake.waits[0].kind).toBe('wake');
  });

  it('context=brief drops error and event type; none reads no context', async () => {
    const brief = await (await fetch(`${base}/overview?context=brief`)).json();
    for (const e of brief.entries) {
      expect(e.context.lastError).toBeUndefined();
      expect(e.context.lastEventType).toBeUndefined();
    }
    const none = await (await fetch(`${base}/overview?context=none`)).json();
    expect(none.entries.every((e: { context: { status: string } }) => e.context.status === 'not-read')).toBe(true);
  });

  it('scope=all with the hop header is 400; without it is local data marked partial', async () => {
    expect((await fetch(`${base}/overview?scope=all`, { headers: { 'X-Caco-Overview-Hop': '1' } })).status).toBe(400);
    expect((await fetch(`${base}/overview?scope=local`, { headers: { 'X-Caco-Overview-Hop': '1' } })).status).toBe(200);
    const all = await (await fetch(`${base}/overview?scope=all`)).json();
    expect(all).toMatchObject({ scope: 'all', coverage: 'partial' });
    expect(all.note).toBeTruthy();
  });

  it('scope=all merges a peer, flags a duplicated session on both copies, and records the peer id (O5)', async () => {
    const peerId = 'bbbbbbbb-0000-4000-8000-0000000000bb';
    const { buildSessionOverview } = await import('../../src/session-overview.js');
    const peerOverview = buildSessionOverview({
      instance: { id: peerId, name: 'devbox' },
      sessions: [
        { sessionId: env.ids[0], cwd: null, meta: { name: 'copy' }, tail: { context: { status: 'ok' }, ask: { matched: null } } },
        { sessionId: 'peer-only', cwd: null, meta: { name: 'p' }, tail: { context: { status: 'ok' }, ask: { matched: null } } },
      ],
      archiveFolder: 'auto-archive', wakeLoopEnabled: true, contextRead: true,
    }, Date.now());
    const hits: Array<{ url: string; hop: unknown }> = [];
    const peer = createServer((req, res) => {
      hits.push({ url: req.url ?? '', hop: req.headers['x-caco-overview-hop'] });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(peerOverview));
    });
    await new Promise<void>(r => peer.listen(0, '127.0.0.1', () => r()));
    const origin = `http://127.0.0.1:${(peer.address() as AddressInfo).port}`;
    const peersFile = join(env.home, 'peers.json');
    writeFileSync(peersFile, JSON.stringify([{ url: origin, hostname: 'devbox' }, { url: 'http://10.9.9.9:53000', hostname: 'remote' }]));
    try {
      const body = await (await fetch(`${base}/overview?scope=all`)).json();
      expect(body.scope).toBe('all');
      expect(body.coverage).toBe('partial'); // the non-loopback peer is skipped
      expect(body.instances.map((i: { status: string }) => i.status)).toEqual(['ok', 'ok', 'skipped']);
      expect(body.instances[1]).toMatchObject({ instance: { id: peerId, name: 'devbox' } });
      const dup = body.entries.filter((e: { sessionId: string }) => e.sessionId === env.ids[0]);
      expect(dup).toHaveLength(2);
      for (const e of dup) expect(e.flags.map((f: { code: string }) => f.code)).toContain('duplicate-session');
      expect(body.entries.some((e: { key: string }) => e.key === `${peerId}:peer-only`)).toBe(true);
      expect(body.counts.total).toBe(4);
      expect(hits).toEqual([{ url: '/api/overview?scope=local&show=all&context=brief', hop: '1' }]);
      expect(JSON.parse(readFileSync(peersFile, 'utf8'))[0].id).toBe(peerId);
      // Only the skipped peer keeps coverage partial.
      writeFileSync(peersFile, JSON.stringify([{ url: origin, hostname: 'devbox' }]));
      const complete = await (await fetch(`${base}/overview?scope=all&show=attention`)).json();
      expect(complete.coverage).toBe('complete');
      expect(complete.entries.every((e: { tier: string }) => e.tier === 'full')).toBe(true);
    } finally {
      rmSync(peersFile, { force: true });
      peer.closeAllConnections?.();
      await new Promise(r => peer.close(() => r(undefined)));
    }
  });

  it('rejects bad parameters and filters by show and keys', async () => {
    expect((await fetch(`${base}/overview?scope=peers`)).status).toBe(400);
    expect((await fetch(`${base}/overview?show=everything`)).status).toBe(400);
    expect((await fetch(`${base}/overview?context=lots`)).status).toBe(400);
    const att = await (await fetch(`${base}/overview?show=attention`)).json();
    expect(att.counts.omitted).toBeGreaterThanOrEqual(0);
    expect(att.entries.every((e: { tier: string }) => e.tier === 'full')).toBe(true);
    const keyed = await (await fetch(`${base}/overview?keys=${env.ids[1]}`)).json();
    expect(keyed.entries.map((e: { sessionId: string }) => e.sessionId)).toEqual([env.ids[1]]);
  });
});
