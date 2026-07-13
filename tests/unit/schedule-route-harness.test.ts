/**
 * schedule route harness (Mechanism B, docs/spec-backend-coverage-80.md). Mocks
 * schedule-manager (calculateNextRun/triggerSchedule) and points schedule-store
 * at a tmp home via the os.homedir mock, then drives real HTTP so every handler
 * (list/get/put/patch/delete/run + validation) executes against the real store.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

const testState = vi.hoisted(() => ({ homeDir: `/tmp/caco-schedule-harness-${process.pid}` }));

vi.mock('os', async (importOriginal) => {
  const original = await importOriginal<typeof import('os')>();
  return { ...original, homedir: () => testState.homeDir };
});

const calculateNextRun = vi.fn(() => new Date('2030-01-01T00:00:00.000Z'));
const triggerSchedule = vi.fn(async () => ({ success: true }));
vi.mock('../../src/schedule-manager.js', () => ({ calculateNextRun, triggerSchedule }));

let server: Server;
let base: string;

beforeAll(async () => {
  const { router } = await import('../../src/routes/schedule.js');
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
  rmSync(join(testState.homeDir, '.caco'), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

beforeEach(() => {
  rmSync(join(testState.homeDir, '.caco'), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  mkdirSync(join(testState.homeDir, '.caco', 'schedule'), { recursive: true });
  triggerSchedule.mockClear();
});

const put = (slug: string, body: unknown) =>
  fetch(`${base}/schedule/${slug}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const patch = (slug: string, body: unknown) =>
  fetch(`${base}/schedule/${slug}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const validBody = {
  prompt: 'do the thing',
  schedule: { type: 'interval', intervalMinutes: 120 },
};

describe('schedule route harness', () => {
  it('lists an empty schedule set', async () => {
    const r = await fetch(`${base}/schedule`);
    expect(r.status).toBe(200);
    expect((await r.json()).schedules).toEqual([]);
  });

  it('PUT rejects an invalid body then creates on a valid one', async () => {
    expect((await put('s1', { schedule: validBody.schedule })).status).toBe(400);
    expect((await put('s1', { prompt: 'x' })).status).toBe(400);

    const r = await put('s1', validBody);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.created).toBe(true);
    expect(body.slug).toBe('s1');
    expect(calculateNextRun).toHaveBeenCalled();
  });

  it('GET returns a created schedule and 404s an unknown one', async () => {
    await put('s2', validBody);
    const found = await fetch(`${base}/schedule/s2`);
    expect(found.status).toBe(200);
    expect((await found.json()).prompt).toBe('do the thing');

    expect((await fetch(`${base}/schedule/nope`)).status).toBe(404);
  });

  it('PUT on an existing slug updates (created:false)', async () => {
    await put('s3', validBody);
    const r = await put('s3', { ...validBody, prompt: 'updated' });
    expect(r.status).toBe(200);
    expect((await r.json()).created).toBe(false);
  });

  it('PATCH toggles enabled, 404s unknown', async () => {
    await put('s4', validBody);
    const r = await patch('s4', { enabled: false });
    expect(r.status).toBe(200);
    expect((await r.json()).enabled).toBe(false);

    const re = await patch('s4', { enabled: true });
    expect(re.status).toBe(200);
    expect((await re.json()).enabled).toBe(true);

    expect((await patch('nope', { enabled: true })).status).toBe(404);
  });

  it('DELETE removes a schedule; delete of a missing slug is idempotent (200)', async () => {
    await put('s5', validBody);
    const del = await fetch(`${base}/schedule/s5`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect((await del.json()).success).toBe(true);

    // deleteSchedule uses rm({force:true}) → succeeds even when absent.
    const missing = await fetch(`${base}/schedule/nope`, { method: 'DELETE' });
    expect(missing.status).toBe(200);
  });

  it('POST /run triggers an existing schedule and 404s unknown', async () => {
    await put('s6', validBody);
    const r = await fetch(`${base}/schedule/s6/run`, { method: 'POST' });
    expect(r.status).toBe(200);
    expect((await r.json()).status).toBe('executed');
    expect(triggerSchedule).toHaveBeenCalledWith('s6');

    expect((await fetch(`${base}/schedule/nope/run`, { method: 'POST' })).status).toBe(404);
  });

  it('POST /run surfaces a trigger failure as 500', async () => {
    await put('s7', validBody);
    triggerSchedule.mockResolvedValueOnce({ success: false, error: 'boom' } as never);
    const r = await fetch(`${base}/schedule/s7/run`, { method: 'POST' });
    expect(r.status).toBe(500);
  });
});
