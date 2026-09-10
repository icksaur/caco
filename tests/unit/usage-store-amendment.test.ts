/**
 * Oracles for the amendment's aggregation fields (spec-usage-metrics row 11).
 *
 * Records written before the amendment carry none of these fields, so every one
 * must be absent-not-zero when nothing contributes it — a 0 would claim a
 * measurement that was never taken.
 *
 * CACO_HOME is set and removed per test (the store resolves it at import time):
 * leaking it at module scope redirects every other suite's ~/.caco reads into a
 * temp dir, which fails eight unrelated session-manager files.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { TurnUsage, PricedModel, UsageRecord } from '../../src/usage-metrics.js';

let tmp: string;

beforeEach(() => {
  vi.resetModules();
  tmp = mkdtempSync(join(tmpdir(), 'caco-usage-agg-'));
  process.env.CACO_HOME = tmp;
});

afterEach(() => {
  delete process.env.CACO_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

const MODELS: PricedModel[] = [
  { id: 'opus', inputPerMtok: 15, outputPerMtok: 75, cachePerMtok: 1.5 },
  { id: 'mini', inputPerMtok: 1, outputPerMtok: 4, cachePerMtok: 0.1 },
];

const HOUR = '2026-09-09T10:00:00.000Z';
const FROM = '2026-09-09T10:00:00.000Z';
const TO = '2026-09-09T10:59:59.000Z';

function turn(over: Partial<TurnUsage> = {}): TurnUsage {
  return { model: 'opus', freshInputTokens: 0, cachedTokens: 0, outputTokens: 0, initiator: 'root', ...over };
}

async function store() {
  return import('../../src/usage-store.js');
}

async function record(perTurn: TurnUsage[], ts = HOUR): Promise<UsageRecord> {
  const { buildUsageRecord } = await import('../../src/usage-metrics.js');
  return buildUsageRecord({
    sessionId: 's', model: 'auto', tokens: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, turns: 0 },
    rates: null, contextWindow: null, ts, perTurn, models: MODELS,
  });
}

describe('aggregateHourly amendment fields', () => {
  it('sums credits per model across records in the bucket', async () => {
    const s = await store();
    s.appendUsageRecord(await record([turn({ model: 'opus', freshInputTokens: 1_000_000 })]));
    s.appendUsageRecord(await record([turn({ model: 'mini', freshInputTokens: 2_000_000 })]));
    s.appendUsageRecord(await record([turn({ model: 'opus', freshInputTokens: 1_000_000 })]));

    const [bucket] = s.aggregateHourly(FROM, TO);

    expect(bucket.perModelCredits?.opus).toBeCloseTo(30, 9);
    expect(bucket.perModelCredits?.mini).toBeCloseTo(2, 9);
  });

  it('nulls only the model key that had an unpriced contribution', async () => {
    const s = await store();
    s.appendUsageRecord(await record([turn({ model: 'opus', freshInputTokens: 1_000_000 })]));
    s.appendUsageRecord(await record([turn({ model: 'ghost', freshInputTokens: 500 })]));

    const [bucket] = s.aggregateHourly(FROM, TO);

    expect(bucket.perModelCredits?.opus).toBeCloseTo(15, 9);
    expect(bucket.perModelCredits?.ghost).toBeNull();
  });

  it('sums nano-AIU when reported', async () => {
    const s = await store();
    s.appendUsageRecord(await record([turn({ nanoAiu: 100 })]));
    s.appendUsageRecord(await record([turn({ nanoAiu: 25 })]));

    expect(s.aggregateHourly(FROM, TO)[0].sdkNanoAiu).toBe(125);
  });

  it('omits nano-AIU entirely when no record reported it', async () => {
    const s = await store();
    s.appendUsageRecord(await record([turn()]));

    // Absent, not 0 — 0 would claim the SDK priced these calls at nothing.
    expect(s.aggregateHourly(FROM, TO)[0].sdkNanoAiu).toBeUndefined();
  });

  it('counts sub-agent turns separately without excluding them from credits', async () => {
    const s = await store();
    s.appendUsageRecord(await record([
      turn({ initiator: 'root', freshInputTokens: 1_000_000 }),
      turn({ initiator: 'sub-agent', freshInputTokens: 1_000_000 }),
      turn({ initiator: 'sub-agent', freshInputTokens: 1_000_000 }),
    ]));

    const [bucket] = s.aggregateHourly(FROM, TO);

    expect(bucket.subAgentTurns).toBe(2);
    // All three turns' spend is in the bucket credits.
    expect(bucket.credits).toBeCloseTo(45, 9);
  });

  it('counts requests that priced only some of their turns', async () => {
    const s = await store();
    s.appendUsageRecord(await record([turn({ freshInputTokens: 1_000_000 }), turn({ model: 'ghost' })]));
    s.appendUsageRecord(await record([turn({ freshInputTokens: 1_000_000 })]));

    expect(s.aggregateHourly(FROM, TO)[0].partialRequests).toBe(1);
  });

  it('leaves every amendment field absent for pre-amendment records', async () => {
    const s = await store();
    const { buildUsageRecord } = await import('../../src/usage-metrics.js');
    // A record with no perTurn — exactly what the shipped path wrote.
    s.appendUsageRecord(buildUsageRecord({
      sessionId: 's', model: 'opus',
      tokens: { inputTokens: 1_000_000, cachedTokens: 0, outputTokens: 0, turns: 1 },
      rates: { input: 15, cache: 1.5, output: 75 }, contextWindow: null, ts: HOUR,
    }));

    const [bucket] = s.aggregateHourly(FROM, TO);

    expect(bucket.credits).toBeCloseTo(15, 9);
    expect(bucket.perModelCredits).toBeUndefined();
    expect(bucket.sdkNanoAiu).toBeUndefined();
    expect(bucket.subAgentTurns).toBeUndefined();
    expect(bucket.partialRequests).toBeUndefined();
  });

  it('keeps priced and unpriced request counts mutually exclusive', async () => {
    const s = await store();
    s.appendUsageRecord(await record([turn({ freshInputTokens: 1_000_000 })]));
    s.appendUsageRecord(await record([turn({ model: 'ghost' })]));

    const [bucket] = s.aggregateHourly(FROM, TO);

    expect(bucket.pricedRequests).toBe(1);
    expect(bucket.unpricedRequests).toBe(1);
  });

  it('echoes the amendment fields through the HTTP payload', async () => {
    const s = await store();
    const { getHourlyPayload } = await import('../../src/routes/usage.js');
    s.appendUsageRecord(await record([
      turn({ freshInputTokens: 1_000_000, nanoAiu: 7 }),
      turn({ initiator: 'sub-agent', model: 'mini', freshInputTokens: 1_000_000 }),
    ], new Date().toISOString()));

    const payload = getHourlyPayload({ days: '1' });
    const bucket = payload.buckets.find(b => (b.sdkNanoAiu ?? 0) > 0);

    // The route must not field-pick the bucket: these reach the applet or nothing does.
    expect(bucket?.sdkNanoAiu).toBe(7);
    expect(bucket?.perModelCredits).toBeDefined();
    expect(bucket?.subAgentTurns).toBe(1);
  });
});
