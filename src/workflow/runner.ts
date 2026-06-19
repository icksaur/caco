import { spawn } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import { mkdtemp, writeFile, rm, readFile, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { STORAGE_ROOT, ensureDir } from '../storage-paths.js';
import {
  WORKFLOW_TIMEOUT_DEFAULT_MS,
  WORKFLOW_TIMEOUT_CAP_MS,
  WORKFLOW_KILL_GRACE_MS,
  WORKFLOW_LOG_CAP_BYTES,
  WORKFLOW_RESULT_MAX_BYTES,
} from '../config.js';

export type WorkflowOutcome = 'emitted' | 'error' | 'no-emit';

export interface WorkflowRunResult {
  outcome: WorkflowOutcome;
  /** Present when outcome === 'emitted'. The JSON value the workflow emitted. */
  value?: unknown;
  /** Present when outcome === 'error'. The captured error/stack. */
  error?: string;
  /**
   * Total bytes the facade returned to the script (read payloads) — what would
   * have entered the model context as individual tool calls. Used to estimate
   * token savings. 0 when the envelope predates this field or was unreadable.
   */
  observedBytes: number;
  /** Combined stdout+stderr, capped at WORKFLOW_LOG_CAP_BYTES. */
  logs: string;
  logsTruncated: boolean;
  timedOut: boolean;
  exitCode: number | null;
  durationMs: number;
}

interface TsxRunner {
  /** Absolute node executable. */
  node: string;
  /** Absolute path to the tsx CLI entry. */
  cli: string;
}

/** Resolve the tsx CLI to an absolute path without relying on PATH. */
function locateTsx(): TsxRunner | null {
  try {
    const require = createRequire(import.meta.url);
    const pkgJson = require.resolve('tsx/package.json');
    const cli = join(dirname(pkgJson), 'dist/cli.mjs');
    if (!existsSync(cli)) return null;
    return { node: process.execPath, cli };
  } catch {
    return null;
  }
}

let runnerProbe: Promise<TsxRunner | null> | undefined;

/**
 * Resolve tsx and smoke-test that it can transform+run a TS module. Cached for
 * the process lifetime so the cost is paid once at startup.
 */
export function resolveTsxRunner(): Promise<TsxRunner | null> {
  if (runnerProbe) return runnerProbe;
  runnerProbe = (async () => {
    const runner = locateTsx();
    if (!runner) return null;
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(tmpdir(), 'caco-tsx-probe-'));
      const probe = join(dir, 'probe.mts');
      await writeFile(probe, 'const x: number = 41; process.stdout.write(String(x + 1));');
      const out = await new Promise<string>((resolveOut, rejectOut) => {
        const child = spawn(runner.node, [runner.cli, probe], { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, NODE_NO_WARNINGS: '1' } });
        let buf = '';
        child.stdout.on('data', (d) => { buf += d.toString(); });
        child.on('error', rejectOut);
        child.on('close', (code) => (code === 0 ? resolveOut(buf) : rejectOut(new Error(`probe exit ${code}`))));
      });
      return out.trim() === '42' ? runner : null;
    } catch {
      return null;
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  })();
  return runnerProbe;
}

export async function isWorkflowRunnerAvailable(): Promise<boolean> {
  return (await resolveTsxRunner()) !== null;
}

const SCRATCH_TTL_MS = 60 * 60 * 1000;

/**
 * Remove crash-leftover per-run scratch dirs (a run normally cleans up its own
 * in `finally`; a hard kill can skip that). Best-effort, runs once at startup.
 */
export async function sweepWorkflowScratch(): Promise<void> {
  const root = join(STORAGE_ROOT, 'workflows');
  if (!existsSync(root)) return;
  const now = Date.now();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  await Promise.all(entries.map(async (name) => {
    if (!name.startsWith('run-')) return;
    const dir = join(root, name);
    try {
      const info = await stat(dir);
      if (now - info.mtimeMs > SCRATCH_TTL_MS) await rm(dir, { recursive: true, force: true });
    } catch { /* racing another sweep/cleanup */ }
  }));
}

function facadeModuleUrl(): string {
  const facadeJs = fileURLToPath(new URL('./facade.js', import.meta.url));
  const facadeTs = facadeJs.replace(/\.js$/, '.ts');
  return pathToFileURL(existsSync(facadeTs) ? facadeTs : facadeJs).href;
}

/**
 * The script the child runs. User `code` is the body of an async IIFE with
 * `caco` (the facade) and `emit` in scope. `emit` writes the result envelope
 * via temp+rename so a partial file is never observed; a second `emit` throws.
 */
function buildHarness(userCode: string, sessionCwd: string, resultPath: string): string {
  return `import { createFacade } from ${JSON.stringify(facadeModuleUrl())};
import { writeFileSync, renameSync } from 'node:fs';

const __resultPath = ${JSON.stringify(resultPath)};
let __observedBytes = 0;
const __rawFacade = createFacade(${JSON.stringify(sessionCwd)});
const __account = (v: unknown): unknown => {
  try {
    __observedBytes += Buffer.byteLength(typeof v === 'string' ? v : (JSON.stringify(v) ?? ''), 'utf8');
  } catch { /* unserializable payloads are not counted */ }
  return v;
};
// Counting proxy: every read-oriented facade call adds the bytes it returned to
// __observedBytes — the data that would otherwise have entered the model context.
const caco = new Proxy(__rawFacade as Record<string, unknown>, {
  get(target, prop) {
    const orig = (target as Record<string, unknown>)[prop as string];
    if (typeof orig !== 'function') return orig;
    return async (...args: unknown[]) => __account(await (orig as (...a: unknown[]) => unknown).apply(target, args));
  },
});

let __written = false;

function __write(ok: boolean, body: Record<string, unknown>): void {
  const envelope = JSON.stringify({ ok, observedBytes: __observedBytes, ...body });
  const tmp = __resultPath + '.tmp';
  writeFileSync(tmp, envelope);
  renameSync(tmp, __resultPath);
  __written = true;
}

function emit(value: unknown): void {
  if (__written) throw new Error('emit() called more than once');
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (e) {
    __write(false, { error: 'emit(): value is not JSON-serializable: ' + (e instanceof Error ? e.message : String(e)) });
    throw new Error('emit(): value is not JSON-serializable');
  }
  if (json === undefined) {
    __write(false, { error: 'emit(): value is undefined or not JSON-serializable' });
    throw new Error('emit(): value is undefined or not JSON-serializable');
  }
  __write(true, { value });
}

void (async () => {
  try {
    await (async () => {
${userCode}
    })();
  } catch (e) {
    if (!__written) {
      __write(false, { error: e instanceof Error ? (e.stack || e.message) : String(e) });
    }
  }
})();
`;
}

function clampTimeout(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return WORKFLOW_TIMEOUT_DEFAULT_MS;
  return Math.max(1000, Math.min(WORKFLOW_TIMEOUT_CAP_MS, Math.floor(requested)));
}

export interface RunWorkflowOptions {
  code: string;
  timeoutMs?: number;
}

/**
 * Run one workflow script in a detached tsx subprocess scoped to `sessionCwd`.
 * Enforces a wall-clock timeout (process-group kill so children die too) and a
 * hard log byte ceiling, then reads the emit() result envelope.
 */
export async function runWorkflow(sessionCwd: string, options: RunWorkflowOptions): Promise<WorkflowRunResult> {
  const runner = await resolveTsxRunner();
  if (!runner) throw new Error('workflow runner unavailable (tsx not resolvable)');

  const timeoutMs = clampTimeout(options.timeoutMs);
  const root = join(STORAGE_ROOT, 'workflows');
  ensureDir(root);
  const scratch = await mkdtemp(join(root, 'run-'));
  const entry = join(scratch, 'entry.mts');
  const resultPath = join(scratch, 'result.json');

  const started = Date.now();
  try {
    await writeFile(entry, buildHarness(options.code, sessionCwd, resultPath));

    let logBytes = 0;
    let logsTruncated = false;
    const chunks: Buffer[] = [];
    const capture = (d: Buffer): void => {
      if (logsTruncated) return;
      const remaining = WORKFLOW_LOG_CAP_BYTES - logBytes;
      if (d.length <= remaining) {
        chunks.push(d);
        logBytes += d.length;
      } else {
        if (remaining > 0) chunks.push(d.subarray(0, remaining));
        logBytes = WORKFLOW_LOG_CAP_BYTES;
        logsTruncated = true;
      }
    };

    const child = spawn(runner.node, [runner.cli, entry], {
      cwd: sessionCwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try { child.kill(signal); } catch { /* already gone */ }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), WORKFLOW_KILL_GRACE_MS);
      killTimer.unref();
    }, timeoutMs);
    timer.unref();

    const exitCode = await new Promise<number | null>((resolveExit) => {
      child.on('error', () => resolveExit(null));
      child.on('close', (code) => resolveExit(code));
    });
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);

    const logs = Buffer.concat(chunks).toString('utf8');
    const durationMs = Date.now() - started;

    let envelope: { ok: boolean; value?: unknown; error?: string; observedBytes?: number } | null = null;
    if (existsSync(resultPath)) {
      const size = (await stat(resultPath)).size;
      if (size > WORKFLOW_RESULT_MAX_BYTES) {
        envelope = { ok: false, error: `emitted value too large (${size} bytes, cap ${WORKFLOW_RESULT_MAX_BYTES}); emit a compact summary instead` };
      } else {
        try {
          envelope = JSON.parse(await readFile(resultPath, 'utf8'));
        } catch {
          envelope = { ok: false, error: 'result envelope was not valid JSON' };
        }
      }
    }

    const observedBytes = typeof envelope?.observedBytes === 'number' ? envelope.observedBytes : 0;

    if (envelope && envelope.ok) {
      return { outcome: 'emitted', value: envelope.value, observedBytes, logs, logsTruncated, timedOut, exitCode, durationMs };
    }
    if (envelope && !envelope.ok) {
      return { outcome: 'error', error: envelope.error ?? 'unknown error', observedBytes, logs, logsTruncated, timedOut, exitCode, durationMs };
    }
    if (timedOut) {
      return { outcome: 'error', error: `workflow timed out after ${timeoutMs} ms`, observedBytes, logs, logsTruncated, timedOut, exitCode, durationMs };
    }
    if (exitCode !== 0 && exitCode !== null) {
      return { outcome: 'error', error: `workflow process exited with code ${exitCode} without calling emit()`, observedBytes, logs, logsTruncated, timedOut, exitCode, durationMs };
    }
    return { outcome: 'no-emit', observedBytes, logs, logsTruncated, timedOut, exitCode, durationMs };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
