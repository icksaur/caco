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

describe('runWorkflow envelope', () => {
  it('runner is available (tsx resolvable)', async () => {
    expect(await isWorkflowRunnerAvailable()).toBe(true);
  });

  it('emits a JSON value computed from the facade', async () => {
    const r = await runWorkflow(base, { code: `
      const hits = await caco.grep('NEEDLE');
      emit({ count: hits.length, first: (await caco.read('data.txt', [1, 1])).text });
    ` });
    expect(r.outcome).toBe('emitted');
    expect(r.value).toEqual({ count: 2, first: 'one NEEDLE' });
    expect(r.timedOut).toBe(false);
  });

  it('accumulates observedBytes from facade read payloads', async () => {
    const withReads = await runWorkflow(base, {
      code: `
        await caco.grep('NEEDLE');
        const r = await caco.read('data.txt', [1, 1]);
        emit({ n: r.text.length });
      `,
    });
    expect(withReads.outcome).toBe('emitted');
    expect(withReads.observedBytes).toBeGreaterThan(0);

    const noReads = await runWorkflow(base, { code: 'emit({ a: 1 });' });
    expect(noReads.observedBytes).toBe(0);
  });

  it('counts facade calls as commandCount (virtual tool calls)', async () => {
    const r = await runWorkflow(base, {
      code: `
        await caco.grep('NEEDLE');
        await caco.read('data.txt', [1, 1]);
        await caco.glob('*.txt');
        emit({ done: true });
      `,
    });
    expect(r.outcome).toBe('emitted');
    expect(r.commandCount).toBe(3);

    const none = await runWorkflow(base, { code: 'emit({ a: 1 });' });
    expect(none.commandCount).toBe(0);
  });

  it('keeps the first emit when emit() is called twice', async () => {
    const r = await runWorkflow(base, { code: 'emit({ a: 1 }); emit({ a: 2 });' });
    expect(r.outcome).toBe('emitted');
    expect(r.value).toEqual({ a: 1 });
  });

  it('reports a clear error for a non-JSON-serializable value', async () => {
    const r = await runWorkflow(base, { code: 'emit({ big: 1n });' });
    expect(r.outcome).toBe('error');
    expect(r.error).toMatch(/not JSON-serializable/i);
  });

  it('reports no-emit when the script never calls emit()', async () => {
    const r = await runWorkflow(base, { code: 'const x = 1 + 1;' });
    expect(r.outcome).toBe('no-emit');
  });

  it('captures an uncaught throw as an error with stack', async () => {
    const r = await runWorkflow(base, { code: 'throw new Error(\'boom\');' });
    expect(r.outcome).toBe('error');
    expect(r.error).toMatch(/boom/);
  });

  it('rejects facade path escapes inside the workflow', async () => {
    const r = await runWorkflow(base, { code: `
      try { await caco.read('../../etc/passwd'); emit({ escaped: true }); }
      catch { emit({ escaped: false }); }
    ` });
    expect(r.value).toEqual({ escaped: false });
  });
});

describe('runWorkflow bounds', () => {
  it('caps captured logs at the byte ceiling and flags truncation', async () => {
    const r = await runWorkflow(base, {
      code: 'for (let i = 0; i < 60000; i++) console.log(\'x\'.repeat(100));',
      timeoutMs: 20000,
    });
    expect(r.logsTruncated).toBe(true);
    expect(Buffer.byteLength(r.logs, 'utf8')).toBeLessThanOrEqual(WORKFLOW_LOG_CAP_BYTES);
  }, 30000);

  it('rejects an oversized emit value instead of loading it all into memory', async () => {
    const r = await runWorkflow(base, { code: 'emit({ blob: \'q\'.repeat(3 * 1024 * 1024) });', timeoutMs: 20000 });
    expect(r.outcome).toBe('error');
    expect(r.error).toMatch(/too large/i);
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
      const { stdout } = await execFileAsync('ps', ['-eo', 'args']);
      survivors = stdout;
    } catch { /* ps unavailable; skip */ }
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
