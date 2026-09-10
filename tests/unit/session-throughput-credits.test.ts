/**
 * Oracles for the session-lifetime credit accumulator (spec-usage-metrics
 * amendment, row 10).
 *
 * The footer prices `totalIn/totalCache/totalOut` at ONE active model's rates,
 * which is wrong the moment a session runs more than one model — and under Auto
 * there is no rate to price with at all, so the credit headline hides. These pin
 * the server-side accumulator that makes spend authoritative instead: each turn
 * contributes at the rates of the model that actually ran it.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordUsage,
  snapshot,
  clearSession,
  resetRequest,
} from '../../src/session-throughput.js';

const SID = 'credit-accum';
const OPUS = { input: 15, cache: 1.5, output: 75 };
const MINI = { input: 1, cache: 0.1, output: 4 };

beforeEach(() => clearSession(SID));

describe('session-lifetime priced credits', () => {
  it('starts at zero with nothing unpriced', () => {
    const s = snapshot(SID);
    expect(s.totalCreditsPriced).toBe(0);
    expect(s.totalTurnsUnpriced).toBe(0);
  });

  it('prices a turn at the rates supplied for that turn', () => {
    recordUsage(SID, { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 }, OPUS);

    expect(snapshot(SID).totalCreditsPriced).toBeCloseTo(15, 9);
  });

  it('accumulates across turns at DIFFERENT models — the whole point', () => {
    recordUsage(SID, { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 }, OPUS);
    recordUsage(SID, { inputTokens: 2_000_000, cacheReadTokens: 0, outputTokens: 0 }, MINI);

    // 15 + 2 — a single-model footer estimate could not produce this.
    expect(snapshot(SID).totalCreditsPriced).toBeCloseTo(17, 9);
    expect(snapshot(SID).totalTurnsUnpriced).toBe(0);
  });

  it('prices the fresh/cached split the same way the token columns do', () => {
    recordUsage(SID, { inputTokens: 1_000_000, cacheReadTokens: 400_000, outputTokens: 100_000 }, OPUS);

    // fresh 600k @15 + cached 400k @1.5 + out 100k @75
    const expected = (600_000 * 15 + 400_000 * 1.5 + 100_000 * 75) / 1_000_000;
    expect(snapshot(SID).totalCreditsPriced).toBeCloseTo(expected, 9);
  });

  it('counts an unpriced turn instead of silently pricing it as free', () => {
    recordUsage(SID, { inputTokens: 1_000_000, outputTokens: 0 }, OPUS);
    recordUsage(SID, { inputTokens: 5_000_000, outputTokens: 0 }, null);

    expect(snapshot(SID).totalCreditsPriced).toBeCloseTo(15, 9);
    expect(snapshot(SID).totalTurnsUnpriced).toBe(1);
  });

  it('treats an omitted rate argument as unpriced', () => {
    recordUsage(SID, { inputTokens: 1_000, outputTokens: 1 });

    expect(snapshot(SID).totalCreditsPriced).toBe(0);
    expect(snapshot(SID).totalTurnsUnpriced).toBe(1);
  });

  it('survives a new request — these are session-lifetime, like the token totals', () => {
    recordUsage(SID, { inputTokens: 1_000_000, outputTokens: 0 }, OPUS);
    resetRequest(SID);

    expect(snapshot(SID).totalCreditsPriced).toBeCloseTo(15, 9);
  });

  it('resets with the session', () => {
    recordUsage(SID, { inputTokens: 1_000_000, outputTokens: 0 }, OPUS);
    clearSession(SID);

    expect(snapshot(SID).totalCreditsPriced).toBe(0);
  });
});
