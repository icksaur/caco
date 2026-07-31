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
import { WORKFLOW_KILL_GRACE_MS, WORKFLOW_LOG_CAP_BYTES, WORKFLOW_TIMEOUT_MIN_MS } from '../../src/config.js';
import { STORAGE_ROOT } from '../../src/storage-paths.js';
import { mkdir, utimes } from 'fs/promises';
import { existsSync } from 'fs';

const execFileAsync = promisify(execFile);

// The reap test must let the child boot, spawn its shell and reach `touch`
// BEFORE the deadline fires, or its start-witness fails: child startup measures
// ~190ms alone and ~390ms under full-suite contention, so this keeps a ~4x
// margin. The infinite-loop test needs no such slack and runs at the floor.
const REAP_TEST_TIMEOUT_MS = WORKFLOW_TIMEOUT_MIN_MS + 500;

/** A `ps` snapshot, or undefined if `ps` could not be run. */
async function psSnapshot(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('ps', ['-eo', 'args'], { windowsHide: true });
    return stdout;
  } catch {
    return undefined;
  }
}

/**
 * Whether `ps` can enumerate processes here. Probed once up front so a
 * transient failure mid-poll is retried rather than mistaken for "this platform
 * has no ps" — which would silently void the test instead of failing it.
 */
async function canInspectProcesses(): Promise<boolean> {
  return (await psSnapshot()) !== undefined;
}

/**
 * The `ps` snapshot taken once `marker` is gone, or the last successful one if
 * `timeoutMs` elapses first — so a failing assertion names the survivor. Polls
 * rather than sleeping a fixed grace: reaping is near-instant, so a constant
 * wait both pads the suite and flakes the day a reap runs long.
 */
async function waitForReap(marker: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last: string | undefined;
  for (;;) {
    const snapshot = await psSnapshot();
    if (snapshot !== undefined) {
      last = snapshot;
      if (!snapshot.includes(marker)) return snapshot;
    }
    if (Date.now() >= deadline) {
      // Never assert against an absent snapshot: "" contains no marker and
      // would pass vacuously.
      if (last === undefined) throw new Error('ps returned no snapshot before the deadline');
      return last;
    }
    await new Promise((res) => setTimeout(res, 25));
  }
}

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
    // A busy loop never yields, so no in-child timer can fire: only a
    // parent-side signal ends this run.
    const r = await runWorkflow(base, { code: 'while (true) {}', timeoutMs: WORKFLOW_TIMEOUT_MIN_MS });
    expect(r.timedOut).toBe(true);
    expect(r.outcome).toBe('error');
    expect(Date.now() - start).toBeLessThan(10000);
  }, 15000);

  it('reaps child processes spawned via sh() on timeout', async () => {
    if (!(await canInspectProcesses())) return; // no `ps`; reaping is unverifiable here

    const nonce = `${process.pid}${Date.now() % 1000}`;
    const marker = `sleep 9.${nonce}`;
    const started = join(base, `sh-started-${nonce}`);
    const r = await runWorkflow(base, {
      code: `await caco.sh(${JSON.stringify(`touch '${started}'; ${marker}`)});`,
      timeoutMs: REAP_TEST_TIMEOUT_MS,
    });
    expect(r.timedOut).toBe(true);

    const survivors = await waitForReap(marker, WORKFLOW_KILL_GRACE_MS + 3000);
    // Proves the grandchild existed before asserting it is gone: one that never
    // spawned is equally absent from `ps`, so without this the test would pass
    // vacuously whenever the deadline beat child startup.
    expect(existsSync(started)).toBe(true);
    expect(survivors).not.toContain(marker);
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

