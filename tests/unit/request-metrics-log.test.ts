import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let tmp: string;

beforeEach(() => {
  vi.resetModules();
  tmp = mkdtempSync(join(tmpdir(), 'caco-metrics-test-'));
  process.env.CACO_HOME = tmp;
});

afterEach(() => {
  delete process.env.CACO_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

const ROW = {
  requestIn: 100,
  requestCache: 50,
  requestOut: 20,
  requestTurns: 3,
  requestReasoning: 1500,
  requestToolCalls: 5,
  requestToolFailures: 1,
  requestWorkflowCodeBytes: 800,
  requestWallMs: 4200,
  rateLimitCount: 0,
};

describe('request-metrics-log', () => {
  it('appends a row and reads it back with sessionId and ts', async () => {
    const mod = await import('../../src/request-metrics-log.js');
    mod.appendRequestMetrics('sess-1', ROW);
    const rows = mod.readRequestMetrics();
    expect(rows.length).toBe(1);
    expect(rows[0].sessionId).toBe('sess-1');
    expect(rows[0].requestTurns).toBe(3);
    expect(rows[0].requestReasoning).toBe(1500);
    expect(typeof rows[0].ts).toBe('string');
  });

  it('accumulates multiple rows as JSONL', async () => {
    const mod = await import('../../src/request-metrics-log.js');
    mod.appendRequestMetrics('sess-1', ROW);
    mod.appendRequestMetrics('sess-2', { ...ROW, requestTurns: 7 });
    const rows = mod.readRequestMetrics();
    expect(rows.length).toBe(2);
    expect(rows.map(r => r.requestTurns).sort()).toEqual([3, 7]);
  });

  it('returns an empty array when no log exists', async () => {
    const mod = await import('../../src/request-metrics-log.js');
    expect(mod.readRequestMetrics()).toEqual([]);
  });

  it('tolerates a corrupt line without throwing', async () => {
    const mod = await import('../../src/request-metrics-log.js');
    mod.appendRequestMetrics('sess-1', ROW);
    const { appendFileSync } = await import('fs');
    appendFileSync(join(tmp, 'metrics', 'requests.jsonl'), 'not json\n');
    mod.appendRequestMetrics('sess-2', ROW);
    const rows = mod.readRequestMetrics();
    expect(rows.length).toBe(2);
    expect(existsSync(join(tmp, 'metrics', 'requests.jsonl'))).toBe(true);
  });
});
