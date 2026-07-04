import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ToolKey } from '../../src/tool-key.js';

const fsMock = vi.hoisted(() => ({
  readFileSync: vi.fn((): string => { throw new Error('no file'); }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));
vi.mock('fs', () => fsMock);

import {
  stampToolUsage, getNowActiveSeconds, getLastUsedActiveSeconds,
  MAX_ACTIVE_GAP_SECONDS, DEFER_STALE_THRESHOLD_ACTIVE_SECONDS,
  _resetUsageStoreForTest, _setClockForTest,
} from '../../src/tool-usage-store.js';

let nowMs = 0;

beforeEach(() => {
  vi.clearAllMocks();
  fsMock.readFileSync.mockImplementation(() => { throw new Error('no file'); });
  nowMs = 1_000_000;
  _setClockForTest(() => nowMs);
  _resetUsageStoreForTest();
  _setClockForTest(() => nowMs);
});

const KEY = 'github-list_issues' as ToolKey;

describe('tool-usage-store — active clock + per-tool stamps', () => {
  it('starts at zero active-seconds with no stamps', () => {
    expect(getNowActiveSeconds()).toBe(0);
    expect(getLastUsedActiveSeconds().size).toBe(0);
  });

  it('advances the active clock by real elapsed time between interactions', () => {
    getNowActiveSeconds();          // anchor tick at t=0
    nowMs += 30_000;                // 30s later
    expect(getNowActiveSeconds()).toBe(30);
    nowMs += 90_000;                // +90s
    expect(getNowActiveSeconds()).toBe(120);
  });

  it('caps a single idle gap at MAX_ACTIVE_GAP_SECONDS (idle does not age tools)', () => {
    getNowActiveSeconds();
    nowMs += 6 * 60 * 60 * 1000;    // 6 hours idle
    expect(getNowActiveSeconds()).toBe(MAX_ACTIVE_GAP_SECONDS);
  });

  it('stamps a tool at the current active-clock value', () => {
    getNowActiveSeconds();
    nowMs += 10_000;
    stampToolUsage(KEY);
    expect(getLastUsedActiveSeconds().get(KEY)).toBe(10);
  });

  it('age = now − stamp; a tool crosses the stale threshold after 2 active-hours', () => {
    stampToolUsage(KEY);            // stamped at t≈0
    const stamp = getLastUsedActiveSeconds().get(KEY) as number;
    // Advance in <=cap steps, ticking each step so the active clock accumulates real
    // elapsed time (25 * 5min = ~2.08h of active time).
    for (let i = 0; i < 25; i++) { nowMs += MAX_ACTIVE_GAP_SECONDS * 1000; getNowActiveSeconds(); }
    const age = getNowActiveSeconds() - stamp;
    expect(age).toBeGreaterThan(DEFER_STALE_THRESHOLD_ACTIVE_SECONDS);
  });

  it('persists the clock + stamps on each stamp', () => {
    stampToolUsage(KEY);
    expect(fsMock.writeFileSync).toHaveBeenCalled();
    const written = JSON.parse((fsMock.writeFileSync.mock.calls.at(-1) as unknown[])[1] as string);
    expect(written.lastUsed[KEY]).toBeTypeOf('number');
    expect(written.activeSeconds).toBeTypeOf('number');
  });

  it('reloads persisted state and does NOT count process-down time', () => {
    // Simulate a prior process that stamped at active-second 500 with clock at 800.
    fsMock.readFileSync.mockReturnValue(JSON.stringify({ activeSeconds: 800, lastUsed: { [KEY]: 500 } }));
    _resetUsageStoreForTest();
    _setClockForTest(() => nowMs);
    nowMs += 10 * 60 * 60 * 1000;  // 10h of process-down before first access
    // First access anchors the tick to NOW, so downtime is not counted: clock stays 800.
    expect(getNowActiveSeconds()).toBe(800);
    expect(getLastUsedActiveSeconds().get(KEY)).toBe(500);
  });

  it('does not throw when persistence fails (heuristic, hot path)', () => {
    fsMock.writeFileSync.mockImplementation(() => { throw new Error('disk full'); });
    expect(() => stampToolUsage(KEY)).not.toThrow();
    expect(getLastUsedActiveSeconds().get(KEY)).toBeTypeOf('number'); // still stamped in memory
  });
});
