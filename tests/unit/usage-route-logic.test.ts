import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let tmp: string;
const NOW = '2026-07-07T18:30:00.000Z';

beforeEach(() => {
  vi.resetModules();
  tmp = mkdtempSync(join(tmpdir(), 'caco-usage-route-'));
  process.env.CACO_HOME = tmp;
});

afterEach(() => {
  delete process.env.CACO_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

describe('parseHourlyQuery', () => {
  it('defaults to a 7-day window ending now', async () => {
    const { parseHourlyQuery } = await import('../../src/routes/usage.js');
    const r = parseHourlyQuery({}, new Date(NOW).getTime());
    expect(r.days).toBe(7);
    expect(r.to).toBe(NOW);
    expect(r.from).toBe('2026-06-30T18:30:00.000Z');
  });

  it('clamps days to [1, 90]', async () => {
    const { parseHourlyQuery } = await import('../../src/routes/usage.js');
    expect(parseHourlyQuery({ days: '0' }, Date.now()).days).toBe(1);
    expect(parseHourlyQuery({ days: '500' }, Date.now()).days).toBe(90);
    expect(parseHourlyQuery({ days: 'notanumber' }, Date.now()).days).toBe(7);
    expect(parseHourlyQuery({ days: '14' }, Date.now()).days).toBe(14);
  });
});

describe('parseRecordsQuery', () => {
  it('defaults to a 7-day window + default limit', async () => {
    const { parseRecordsQuery } = await import('../../src/routes/usage.js');
    const r = parseRecordsQuery({}, new Date(NOW).getTime());
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.to).toBe(NOW);
    expect(r.from).toBe('2026-06-30T18:30:00.000Z');
    expect(r.limit).toBe(500);
  });

  it('rejects a malformed from/to with a 400 message', async () => {
    const { parseRecordsQuery } = await import('../../src/routes/usage.js');
    expect(parseRecordsQuery({ from: 'garbage' }, Date.now())).toEqual({ error: 'from must be an ISO timestamp' });
    expect(parseRecordsQuery({ to: 'nope' }, Date.now())).toEqual({ error: 'to must be an ISO timestamp' });
  });

  it('rejects an inverted window', async () => {
    const { parseRecordsQuery } = await import('../../src/routes/usage.js');
    const r = parseRecordsQuery({ from: '2026-07-07T00:00:00.000Z', to: '2026-07-06T00:00:00.000Z' }, Date.now());
    expect(r).toEqual({ error: 'to must be >= from' });
  });

  it('clamps limit to [1, 5000]', async () => {
    const { parseRecordsQuery } = await import('../../src/routes/usage.js');
    const a = parseRecordsQuery({ limit: '0' }, Date.now());
    const b = parseRecordsQuery({ limit: '999999' }, Date.now());
    if ('error' in a || 'error' in b) throw new Error('unexpected error');
    expect(a.limit).toBe(1);
    expect(b.limit).toBe(5000);
  });

  it('clamps an over-wide window width to <= 90 days (keeping the recent end)', async () => {
    const { parseRecordsQuery } = await import('../../src/routes/usage.js');
    const r = parseRecordsQuery({ from: '1970-01-01T00:00:00.000Z', to: NOW }, new Date(NOW).getTime());
    if ('error' in r) throw new Error(r.error);
    expect(r.to).toBe(NOW);
    const widthDays = (new Date(r.to).getTime() - new Date(r.from).getTime()) / (24 * 60 * 60 * 1000);
    expect(widthDays).toBeCloseTo(90, 6);
  });
});

describe('getHourlyPayload', () => {
  it('returns the window + dense hourly buckets with priced/unpriced counts', async () => {
    const store = await import('../../src/usage-store.js');
    const usage = await import('../../src/routes/usage.js');
    const base = {
      sessionId: 's', model: 'claude-opus-4.6', contextWindow: 200_000,
      inputTokens: 10, cachedTokens: 5, outputTokens: 2,
      inputTokenCost: 1, cachedTokenCost: 0.1, outputTokenCost: 0.5, requestCredits: 1.6, turns: 1,
    };
    store.appendUsageRecord({ ...base, ts: '2026-07-07T18:05:00.000Z' });
    store.appendUsageRecord({ ...base, ts: '2026-07-07T18:15:00.000Z', requestCredits: null, inputTokenCost: null, cachedTokenCost: null, outputTokenCost: null, model: null });

    const payload = usage.getHourlyPayload({ days: '1' }, new Date(NOW).getTime());
    expect(payload.to).toBe(NOW);
    const hour = payload.buckets.find(b => b.hour === '2026-07-07T18:00:00.000Z');
    expect(hour).toBeDefined();
    expect(hour!.pricedRequests).toBe(1);
    expect(hour!.unpricedRequests).toBe(1);
    expect(hour!.credits).toBeCloseTo(1.6, 9);
    expect(hour!.inputTokens).toBe(20);
  });
});

describe('getRecordsPayload', () => {
  it('returns the most recent records first and flags truncation', async () => {
    const store = await import('../../src/usage-store.js');
    const usage = await import('../../src/routes/usage.js');
    const base = {
      sessionId: 's', model: 'm', contextWindow: null,
      inputTokens: 1, cachedTokens: 0, outputTokens: 0,
      inputTokenCost: null, cachedTokenCost: null, outputTokenCost: null, requestCredits: null, turns: 1,
    };
    store.appendUsageRecord({ ...base, ts: '2026-07-07T10:00:00.000Z', sessionId: 'a' });
    store.appendUsageRecord({ ...base, ts: '2026-07-07T11:00:00.000Z', sessionId: 'b' });
    store.appendUsageRecord({ ...base, ts: '2026-07-07T12:00:00.000Z', sessionId: 'c' });
    // limit 2 → newest two, newest first
    const res = usage.getRecordsPayload({ limit: '2' }, new Date(NOW).getTime());
    if ('error' in res) throw new Error(res.error);
    expect(res.records.map(r => r.sessionId)).toEqual(['c', 'b']);
    expect(res.truncated).toBe(true);
  });

  it('does not flag truncation when all records fit', async () => {
    const store = await import('../../src/usage-store.js');
    const usage = await import('../../src/routes/usage.js');
    const base = {
      sessionId: 's', model: 'm', contextWindow: null,
      inputTokens: 1, cachedTokens: 0, outputTokens: 0,
      inputTokenCost: null, cachedTokenCost: null, outputTokenCost: null, requestCredits: null, turns: 1,
    };
    store.appendUsageRecord({ ...base, ts: '2026-07-07T10:00:00.000Z', sessionId: 'a' });
    store.appendUsageRecord({ ...base, ts: '2026-07-07T11:00:00.000Z', sessionId: 'b' });
    const res = usage.getRecordsPayload({ limit: '10' }, new Date(NOW).getTime());
    if ('error' in res) throw new Error(res.error);
    expect(res.records.map(r => r.sessionId)).toEqual(['b', 'a']);
    expect(res.truncated).toBe(false);
  });

  it('surfaces a parse error as { status: 400 }', async () => {
    const usage = await import('../../src/routes/usage.js');
    const res = usage.getRecordsPayload({ from: 'bad' }, Date.now());
    expect(res).toMatchObject({ error: 'from must be an ISO timestamp' });
  });
});
