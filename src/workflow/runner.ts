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
  WORKFLOW_TIMEOUT_MIN_MS,
  WORKFLOW_KILL_GRACE_MS,
  WORKFLOW_LOG_CAP_BYTES,
  WORKFLOW_RESULT_MAX_BYTES,
} from '../config.js';

const isWindows = process.platform === 'win32';

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
  /**
   * Number of facade calls the workflow made (virtual tool calls). One workflow
   * round trip stands in for this many individual tool calls. 0 when the
   * envelope predates this field or was unreadable.
   */
  commandCount: number;
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
        const child = spawn(runner.node, [runner.cli, probe], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
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

function moduleUrl(relJs: string): string {
  const js = fileURLToPath(new URL(relJs, import.meta.url));
  const ts = js.replace(/\.js$/, '.ts');
  return pathToFileURL(existsSync(ts) ? ts : js).href;
}

/**
 * The script the child runs. User `code` is the body of an async IIFE with
 * `caco` (the facade) and `emit` in scope. The emit/accounting/serialization
 * logic lives in `harness-runtime.ts` (imported by URL, unit-tested in-process);
 * only the subprocess fs write and the live byte/command counters stay inline.
 */
function buildHarness(userCode: string, sessionCwd: string, resultPath: string): string {
  return `import { createFacade, wrapFacadeForAccounting } from ${JSON.stringify(moduleUrl('./facade.js'))};
import { accountBytes, createEmitController } from ${JSON.stringify(moduleUrl('./harness-runtime.js'))};
import { writeFileSync, renameSync } from 'node:fs';

const __resultPath = ${JSON.stringify(resultPath)};
let __observedBytes = 0;
let __commandCount = 0;
const __rawFacade = createFacade(${JSON.stringify(sessionCwd)});
// Counting hook: every read-oriented facade call adds the bytes it returned to
// __observedBytes (data that would otherwise have entered the model context) and
// increments __commandCount (one virtual tool call).
const __account = (v) => { __commandCount += 1; __observedBytes += accountBytes(v); };
const caco = wrapFacadeForAccounting(__rawFacade, __account);

// Atomic envelope write (temp+rename) reading the live counters at write time.
function __write(ok, body) {
  const envelope = JSON.stringify({ ok, observedBytes: __observedBytes, commandCount: __commandCount, ...body });
  const tmp = __resultPath + '.tmp';
  writeFileSync(tmp, envelope);
  renameSync(tmp, __resultPath);
}

const __ctl = createEmitController(__write);
const emit = __ctl.emit;

void (async () => {
  try {
    await (async () => {
${userCode}
    })();
  } catch (e) {
    __ctl.finalizeError(e);
  }
})();
`;
}

function clampTimeout(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return WORKFLOW_TIMEOUT_DEFAULT_MS;
  return Math.max(WORKFLOW_TIMEOUT_MIN_MS, Math.min(WORKFLOW_TIMEOUT_CAP_MS, Math.floor(requested)));
}

/** Shape of the JSON envelope the child harness writes to result.json. */
export interface ParsedEnvelope {
  ok: boolean;
  value?: unknown;
  error?: string;
  observedBytes?: number;
  commandCount?: number;
}

/**
 * Outcome of reading the result file, preserving size-guard-BEFORE-parse: an
 * oversized file is never parsed/loaded (`oversized`), a present-but-corrupt file
 * is `invalid`, a missing file is `absent`. Keeps these distinct so the classifier
 * can synthesize the right error and so `absent` (no-emit) ≠ `invalid` (error).
 */
export type EnvelopeFileResult =
  | { kind: 'absent' }
  | { kind: 'oversized'; size: number }
  | { kind: 'invalid' }
  | { kind: 'ok'; envelope: ParsedEnvelope };

export async function readEnvelopeFile(resultPath: string, maxBytes: number): Promise<EnvelopeFileResult> {
  if (!existsSync(resultPath)) return { kind: 'absent' };
  const size = (await stat(resultPath)).size;
  if (size > maxBytes) return { kind: 'oversized', size };
  try {
    return { kind: 'ok', envelope: JSON.parse(await readFile(resultPath, 'utf8')) as ParsedEnvelope };
  } catch {
    return { kind: 'invalid' };
  }
}

export interface ClassifyInput {
  file: EnvelopeFileResult;
  timedOut: boolean;
  exitCode: number | null;
  timeoutMs: number;
  maxBytes: number;
  logs: string;
  logsTruncated: boolean;
  durationMs: number;
}

/**
 * Pure classification of a finished run into a WorkflowRunResult. Branch
 * precedence is load-bearing and matches the original inline logic exactly:
 * a written envelope (ok, or a !ok error incl. synthesized oversized/invalid)
 * beats timeout, which beats a nonzero exit, which beats no-emit.
 */
export function classifyEnvelope(input: ClassifyInput): WorkflowRunResult {
  const { file, timedOut, exitCode, timeoutMs, maxBytes, logs, logsTruncated, durationMs } = input;

  let envelope: ParsedEnvelope | null;
  switch (file.kind) {
    case 'absent': envelope = null; break;
    case 'oversized': envelope = { ok: false, error: `emitted value too large (${file.size} bytes, cap ${maxBytes}); emit a compact summary instead` }; break;
    case 'invalid': envelope = { ok: false, error: 'result envelope was not valid JSON' }; break;
    case 'ok': envelope = file.envelope; break;
  }

  const observedBytes = typeof envelope?.observedBytes === 'number' ? envelope.observedBytes : 0;
  const commandCount = typeof envelope?.commandCount === 'number' ? envelope.commandCount : 0;
  const common = { observedBytes, commandCount, logs, logsTruncated, timedOut, exitCode, durationMs };

  if (envelope && envelope.ok) {
    return { outcome: 'emitted', value: envelope.value, ...common };
  }
  if (envelope && !envelope.ok) {
    return { outcome: 'error', error: envelope.error ?? 'unknown error', ...common };
  }
  if (timedOut) {
    return { outcome: 'error', error: `workflow timed out after ${timeoutMs} ms`, ...common };
  }
  if (exitCode !== 0 && exitCode !== null) {
    return { outcome: 'error', error: `workflow process exited with code ${exitCode} without calling emit()`, ...common };
  }
  return { outcome: 'no-emit', ...common };
}

export interface RunWorkflowOptions {
  code: string;
  timeoutMs?: number;
}

/**
 * Run one workflow script in a tsx subprocess scoped to `sessionCwd` (detached
 * on Unix for process-group kill; non-detached on Windows so console grandchildren
 * stay hidden). Enforces a wall-clock timeout (tree kill so children die too) and
 * a hard log byte ceiling, then reads the emit() result envelope.
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

    // On Windows we do NOT detach: a DETACHED_PROCESS parent has no console, so
    // any console grandchild it spawns (PowerShell via caco.sh, rg via caco.rg)
    // escapes into a fresh VISIBLE window despite windowsHide. Keeping the
    // workflow node non-detached makes its child spawns occur in the same
    // proven-quiet context as routes/shell.ts (which spawns PowerShell hidden
    // from the main server process and never flashes). Unix keeps detached so
    // the timeout path can group-kill via process.kill(-pid). Tree reaping on
    // Windows is handled by taskkill /T in killGroup (Windows has no process
    // groups, so child.kill() would orphan the grandchildren).
    const child = spawn(runner.node, [runner.cli, entry], {
      cwd: sessionCwd,
      detached: !isWindows,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      if (isWindows) {
        // No process groups on Windows; taskkill /T walks and kills the whole
        // tree (node + its PowerShell/rg children). /F (force) on the SIGKILL
        // phase; the SIGTERM phase attempts a non-forced kill first. taskkill
        // itself is spawned hidden so the reap doesn't flash a window.
        const args = signal === 'SIGKILL'
          ? ['/pid', String(child.pid), '/T', '/F']
          : ['/pid', String(child.pid), '/T'];
        try {
          spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
        } catch {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }
        return;
      }
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

    const file = await readEnvelopeFile(resultPath, WORKFLOW_RESULT_MAX_BYTES);
    return classifyEnvelope({
      file, timedOut, exitCode, timeoutMs,
      maxBytes: WORKFLOW_RESULT_MAX_BYTES, logs, logsTruncated, durationMs,
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
