import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { UsageRecord } from '../../src/usage-metrics.js';

let tmp: string;

beforeEach(() => {
  vi.resetModules();
  tmp = mkdtempSync(join(tmpdir(), 'caco-usage-store-'));
  process.env.CACO_HOME = tmp;
});

afterEach(() => {
  delete process.env.CACO_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

function rec(over: Partial<UsageRecord> & { ts: string }): UsageRecord {
  return {
    sessionId: 'sess',
    model: 'claude-opus-4.6',
    contextWindow: 200_000,
    inputTokens: 100,
    cachedTokens: 200,
    outputTokens: 50,
    inputTokenCost: 1,
    cachedTokenCost: 0.2,
    outputTokenCost: 1.5,
    requestCredits: 2.7,
    turns: 3,
    ...over,
  };
}

const USAGE_DIR = () => join(tmp, 'metrics', 'usage');

describe('usage-store', () => {
  it('appends a record to its UTC-day partition file', async () => {
    const store = await import('../../src/usage-store.js');
    store.appendUsageRecord(rec({ ts: '2026-07-07T12:00:00.000Z' }));
    expect(existsSync(join(USAGE_DIR(), '2026-07-07.jsonl'))).toBe(true);
  });

  it('partitions across UTC days and reads back only the in-window rows ascending', async () => {
    const store = await import('../../src/usage-store.js');
    store.appendUsageRecord(rec({ ts: '2026-07-06T23:30:00.000Z', sessionId: 'a' }));
    store.appendUsageRecord(rec({ ts: '2026-07-07T00:30:00.000Z', sessionId: 'b' }));
    store.appendUsageRecord(rec({ ts: '2026-07-08T05:00:00.000Z', sessionId: 'c' }));

    // two distinct day-files
    expect(readdirSync(USAGE_DIR()).sort()).toEqual(['2026-07-06.jsonl', '2026-07-07.jsonl', '2026-07-08.jsonl']);

    const rows = store.readUsageRecords('2026-07-07T00:00:00.000Z', '2026-07-07T23:59:59.999Z');
    expect(rows.map(r => r.sessionId)).toEqual(['b']);
  });

  it('reads across a multi-day window in ascending ts order', async () => {
    const store = await import('../../src/usage-store.js');
    store.appendUsageRecord(rec({ ts: '2026-07-08T05:00:00.000Z', sessionId: 'c' }));
    store.appendUsageRecord(rec({ ts: '2026-07-06T23:30:00.000Z', sessionId: 'a' }));
    store.appendUsageRecord(rec({ ts: '2026-07-07T00:30:00.000Z', sessionId: 'b' }));
    const rows = store.readUsageRecords('2026-07-06T00:00:00.000Z', '2026-07-08T23:59:59.999Z');
    expect(rows.map(r => r.sessionId)).toEqual(['a', 'b', 'c']);
  });

  it('tolerates a corrupt/partial line without throwing', async () => {
    const store = await import('../../src/usage-store.js');
    store.appendUsageRecord(rec({ ts: '2026-07-07T01:00:00.000Z', sessionId: 'ok1' }));
    appendFileSync(join(USAGE_DIR(), '2026-07-07.jsonl'), 'not-json{\n');
    store.appendUsageRecord(rec({ ts: '2026-07-07T02:00:00.000Z', sessionId: 'ok2' }));
    const rows = store.readUsageRecords('2026-07-07T00:00:00.000Z', '2026-07-07T23:59:59.999Z');
    expect(rows.map(r => r.sessionId)).toEqual(['ok1', 'ok2']);
  });

  it('returns [] when no usage dir exists', async () => {
    const store = await import('../../src/usage-store.js');
    expect(store.readUsageRecords('2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z')).toEqual([]);
  });

  it('does not read day-files outside the window', async () => {
    const store = await import('../../src/usage-store.js');
    store.appendUsageRecord(rec({ ts: '2026-01-01T00:00:00.000Z', sessionId: 'old' }));
    store.appendUsageRecord(rec({ ts: '2026-07-07T00:00:00.000Z', sessionId: 'new' }));
    const files = store.dayFilesInWindow('2026-07-07T00:00:00.000Z', '2026-07-07T23:59:59.999Z');
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/2026-07-07\.jsonl$/);
  });
});

describe('aggregateHourly', () => {
  it('buckets credits + tokens into dense UTC-hour buckets', async () => {
    const store = await import('../../src/usage-store.js');
    // two records in the 12:00 UTC hour, one in 14:00
    store.appendUsageRecord(rec({ ts: '2026-07-07T12:10:00.000Z', requestCredits: 1, inputTokens: 10, cachedTokens: 5, outputTokens: 2 }));
    store.appendUsageRecord(rec({ ts: '2026-07-07T12:50:00.000Z', requestCredits: 2, inputTokens: 20, cachedTokens: 5, outputTokens: 3 }));
    store.appendUsageRecord(rec({ ts: '2026-07-07T14:00:00.000Z', requestCredits: 4, inputTokens: 1, cachedTokens: 1, outputTokens: 1 }));

    const buckets = store.aggregateHourly('2026-07-07T12:00:00.000Z', '2026-07-07T14:59:59.999Z');
    // dense: hours 12,13,14 present
    expect(buckets.map(b => b.hour)).toEqual([
      '2026-07-07T12:00:00.000Z',
      '2026-07-07T13:00:00.000Z',
      '2026-07-07T14:00:00.000Z',
    ]);
    expect(buckets[0]).toMatchObject({ credits: 3, inputTokens: 30, cachedTokens: 10, outputTokens: 5, pricedRequests: 2, unpricedRequests: 0 });
    expect(buckets[1]).toMatchObject({ credits: 0, inputTokens: 0, pricedRequests: 0, unpricedRequests: 0 });
    expect(buckets[2]).toMatchObject({ credits: 4, pricedRequests: 1 });
  });

  it('marks an all-unpriced hour with credits=null but keeps token totals', async () => {
    const store = await import('../../src/usage-store.js');
    store.appendUsageRecord(rec({ ts: '2026-07-07T09:00:00.000Z', requestCredits: null, inputTokenCost: null, cachedTokenCost: null, outputTokenCost: null, inputTokens: 40, cachedTokens: 0, outputTokens: 10, model: null }));
    const buckets = store.aggregateHourly('2026-07-07T09:00:00.000Z', '2026-07-07T09:59:59.999Z');
    expect(buckets).toHaveLength(1);
    expect(buckets[0].credits).toBeNull();
    expect(buckets[0].unpricedRequests).toBe(1);
    expect(buckets[0].pricedRequests).toBe(0);
    expect(buckets[0].inputTokens).toBe(40);
  });

  it('sums priced credits and still flags unpriced requests in a mixed hour', async () => {
    const store = await import('../../src/usage-store.js');
    store.appendUsageRecord(rec({ ts: '2026-07-07T09:10:00.000Z', requestCredits: 5, inputTokens: 10, cachedTokens: 0, outputTokens: 0 }));
    store.appendUsageRecord(rec({ ts: '2026-07-07T09:20:00.000Z', requestCredits: null, inputTokens: 7, cachedTokens: 0, outputTokens: 0, model: null }));
    const [b] = store.aggregateHourly('2026-07-07T09:00:00.000Z', '2026-07-07T09:59:59.999Z');
    expect(b.credits).toBe(5);
    expect(b.pricedRequests).toBe(1);
    expect(b.unpricedRequests).toBe(1);
    expect(b.inputTokens).toBe(17);
  });
});
