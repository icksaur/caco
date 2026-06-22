/**
 * INTEGRATION smokes for the workflow runner. Each test here spawns a REAL tsx
 * subprocess (slow: node start + esbuild transform), so this file is deliberately
 * small — only behaviors that genuinely need a child process live here. The pure
 * emit/accounting and envelope-classification logic is unit-tested in-process in
 * workflow-harness-runtime.test.ts and workflow-classify-envelope.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { join } from 'path';
import { runWorkflow, isWorkflowRunnerAvailable, sweepWorkflowScratch } from '../../src/workflow/runner.js';
import { WORKFLOW_LOG_CAP_BYTES } from '../../src/config.js';
import { STORAGE_ROOT } from '../../src/storage-paths.js';
import { mkdir, utimes } from 'fs/promises';
import { existsSync } from 'fs';

const execFileAsync = promisify(execFile);

let base: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'wf-runner-'));
  await writeFile(join(base, 'data.txt'), 'one NEEDLE\ntwo\nNEEDLE three\n');
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('runWorkflow (integration smokes)', () => {
  it('runner is available (tsx resolvable)', async () => {
    expect(await isWorkflowRunnerAvailable()).toBe(true);
  });

  it('spawns a child, runs the facade, and emits a JSON value (happy path)', async () => {
    const r = await runWorkflow(base, { code: `
      const hits = await caco.grep('NEEDLE');
      emit({ count: hits.length, first: (await caco.read('data.txt', [1, 1])).text });
    ` });
    expect(r.outcome).toBe('emitted');
    expect(r.value).toEqual({ count: 2, first: 'one NEEDLE' });
    expect(r.timedOut).toBe(false);
    // accounting is wired end-to-end (logic itself is unit-tested separately)
    expect(r.observedBytes).toBeGreaterThan(0);
    expect(r.commandCount).toBe(2);
  }, 15000);

  it('captures a non-serializable emit as a clean error (harness wiring)', async () => {
    const r = await runWorkflow(base, { code: 'emit({ big: 1n });' });
    expect(r.outcome).toBe('error');
    expect(r.error).toMatch(/not JSON-serializable/i);
  }, 15000);

  it('caps captured logs at the byte ceiling and flags truncation', async () => {
    const r = await runWorkflow(base, {
      code: 'for (let i = 0; i < 60000; i++) console.log(\'x\'.repeat(100));',
      timeoutMs: 20000,
    });
    expect(r.logsTruncated).toBe(true);
    expect(Buffer.byteLength(r.logs, 'utf8')).toBeLessThanOrEqual(WORKFLOW_LOG_CAP_BYTES);
  }, 30000);

  it('times out an infinite loop within the deadline', async () => {
    const start = Date.now();
    const r = await runWorkflow(base, { code: 'while (true) {}', timeoutMs: 1500 });
    expect(r.timedOut).toBe(true);
    expect(r.outcome).toBe('error');
    expect(Date.now() - start).toBeLessThan(10000);
  }, 15000);

  it('reaps child processes spawned via sh() on timeout', async () => {
    const marker = `sleep 9.${Date.now() % 100000}`;
    const r = await runWorkflow(base, { code: `await caco.sh(${JSON.stringify(marker)});`, timeoutMs: 1500 });
    expect(r.timedOut).toBe(true);
    await new Promise((res) => setTimeout(res, 1500));
    let survivors = '';
    try {
      const { stdout } = await execFileAsync('ps', ['-eo', 'args'], { windowsHide: true });
      survivors = stdout;
    } catch { /* ps unavailable (e.g. Windows); skip */ }
    if (survivors) expect(survivors).not.toContain(marker);
  }, 15000);
});

describe('sweepWorkflowScratch', () => {
  it('removes stale run dirs and keeps fresh ones', async () => {
    const root = join(STORAGE_ROOT, 'workflows');
    await mkdir(root, { recursive: true });
    const stale = join(root, `run-stale-${process.pid}-${Date.now()}`);
    const fresh = join(root, `run-fresh-${process.pid}-${Date.now()}`);
    await mkdir(stale, { recursive: true });
    await mkdir(fresh, { recursive: true });
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(stale, old, old);

    await sweepWorkflowScratch();

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    await rm(fresh, { recursive: true, force: true });
  });
});

