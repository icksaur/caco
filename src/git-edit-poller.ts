/**
 * Git Edit Poller
 *
 * Polls `git status --porcelain` per session and broadcasts the diff
 * between consecutive snapshots as `caco.edit` events. See docs/file-edits.md.
 *
 * Triggered from three places:
 *   - internal timer (1.5s active / 5s idle)
 *   - dispatch-events on tool.execution_complete for write tools
 *   - manual refresh via the /file-edits/snapshot endpoint
 *
 * All triggers funnel into triggerPoll(), which debounces 50ms.
 *
 * One subprocess per poll for status; one per changed-file path for diff.
 * No pre-image cache: git is the source of truth.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { broadcastEvent } from './event-bus.js';
import type { SessionEvent } from './types.js';

export type FileStatus = 'modified' | 'untracked' | 'deleted' | 'renamed';

export interface EditEntry {
  path: string;            // absolute
  relativePath: string;
  diff: string;
  status: FileStatus;
  renamedFrom?: string;
  isBinary?: boolean;
  timestamp: string;
  truncated?: { hiddenLines: number };
}

interface SessionPollerState {
  cwd: string;
  repoRoot: string;
  /** Map<relativePath, { status, renamedFrom? }> last known dirty set. */
  lastDirty: Map<string, { status: FileStatus; renamedFrom?: string }>;
  timer: NodeJS.Timeout | null;
  debounceTimer: NodeJS.Timeout | null;
  lastActivityMs: number;
  /** When true, we're in the middle of a poll; new triggers are no-ops. */
  polling: boolean;
}

const ACTIVE_CADENCE_MS = 1500;
const IDLE_CADENCE_MS = 5000;
const ACTIVITY_WINDOW_MS = 10_000;
const DEBOUNCE_MS = 50;
const DIFF_TIMEOUT_MS = 2000;
const DIFF_LINE_CAP = 1000;
const STATUS_TIMEOUT_MS = 5000;
const DIFF_CONCURRENCY = 8;

/**
 * Run an array of async jobs with at most `limit` in flight at any time.
 * Preserves output order. Used to bound `git diff` subprocess fan-out
 * on bursty events (branch checkout, stash pop, large formatter passes).
 */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  const n = Math.min(limit, items.length);
  const workers: Promise<void>[] = [];
  for (let k = 0; k < n; k++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/**
 * Run a git subprocess with a timeout. Returns stdout (binary buffer) and exit code.
 * Rejects only on spawn failure; non-zero exit returns the captured output.
 */
function runGit(args: string[], cwd: string, timeoutMs: number): Promise<{ stdout: Buffer; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve({ stdout: Buffer.concat(chunks), stderr: stderr + '\n(timed out)', code: 124 });
    }, timeoutMs);
    child.stdout.on('data', (b: Buffer) => chunks.push(b));
    child.stderr.on('data', (b: Buffer) => { stderr += b.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ stdout: Buffer.concat(chunks), stderr, code: code ?? -1 }); });
  });
}

/**
 * Find the git repo root containing `cwd`. Returns null if not in a git repo.
 */
async function findRepoRoot(cwd: string): Promise<string | null> {
  if (!existsSync(cwd)) return null;
  try {
    const result = await runGit(['rev-parse', '--show-toplevel'], cwd, 2000);
    if (result.code !== 0) return null;
    return result.stdout.toString('utf-8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Parse `git status --porcelain=v1 -z` output (NUL-delimited).
 * Returns a map of relative-path -> { status, renamedFrom? }.
 *
 * Porcelain v1 format per entry: `XY <path>\0`, except renames which use
 * `XY <new>\0<old>\0` (the rename source follows on the next null-separated field).
 */
function parsePorcelain(stdout: Buffer): Map<string, { status: FileStatus; renamedFrom?: string }> {
  const out = new Map<string, { status: FileStatus; renamedFrom?: string }>();
  const text = stdout.toString('utf-8');
  if (!text) return out;
  // Split on NUL but keep order; renames consume an extra field.
  const parts = text.split('\0');
  // Last element is empty (trailing \0). Iterate, peeking ahead for renames.
  let i = 0;
  while (i < parts.length) {
    const entry = parts[i];
    if (!entry) { i++; continue; }
    if (entry.length < 3) { i++; continue; }
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    let status: FileStatus = 'modified';
    let renamedFrom: string | undefined;
    if (xy === '??') {
      status = 'untracked';
    } else if (xy[0] === 'D' || xy[1] === 'D') {
      status = 'deleted';
    } else if (xy[0] === 'R' || xy[1] === 'R' || xy[0] === 'C' || xy[1] === 'C') {
      // Rename and copy share the same encoding: 'X  new\0old\0'. We bucket
      // copies under 'renamed' for v1; the source path is preserved in
      // renamedFrom either way.
      status = 'renamed';
      renamedFrom = parts[i + 1];
      i++;
    } else {
      status = 'modified';
    }
    out.set(path, { status, renamedFrom });
    i++;
  }
  return out;
}

/**
 * Fetch the unified diff for one path. For untracked files, synthesize a
 * "+all" diff. For deletions and binaries, return appropriate placeholders.
 */
async function fetchDiff(
  repoRoot: string,
  path: string,
  status: FileStatus,
): Promise<{ diff: string; isBinary: boolean; truncated?: { hiddenLines: number } }> {
  if (status === 'untracked') {
    const absPath = join(repoRoot, path);
    try {
      const result = await runGit(['diff', '--no-color', '--no-index', '/dev/null', absPath], repoRoot, DIFF_TIMEOUT_MS);
      // git diff --no-index returns exit 1 on differences (which is always the case here).
      const text = result.stdout.toString('utf-8');
      const isBinary = /^Binary files /m.test(text);
      const { diff, truncated } = truncateDiff(text);
      return { diff, isBinary, truncated };
    } catch {
      return { diff: '(untracked file — failed to read)', isBinary: false };
    }
  }
  // tracked path: modified, deleted, or renamed
  const result = await runGit(['diff', '--no-color', 'HEAD', '--', path], repoRoot, DIFF_TIMEOUT_MS);
  if (result.code === 124) return { diff: '(diff timed out)', isBinary: false };
  const text = result.stdout.toString('utf-8');
  const isBinary = /^Binary files /m.test(text);
  const { diff, truncated } = truncateDiff(text);
  return { diff, isBinary, truncated };
}

function truncateDiff(diff: string): { diff: string; truncated?: { hiddenLines: number } } {
  const lines = diff.split('\n');
  if (lines.length <= DIFF_LINE_CAP) return { diff };
  const kept = lines.slice(0, DIFF_LINE_CAP);
  const hiddenLines = lines.length - DIFF_LINE_CAP;
  return {
    diff: kept.join('\n') + `\n... (truncated — ${hiddenLines} lines hidden)`,
    truncated: { hiddenLines },
  };
}

export interface GitEditPoller {
  /** Attach explicitly; safe to call multiple times. */
  attachToSession(sessionId: string, cwd: string): Promise<void>;
  detachFromSession(sessionId: string): void;
  triggerPoll(sessionId: string, source: 'event' | 'manual-refresh'): void;
  /** Return the current dirty set as edits (used by snapshot endpoint).
   *  Lazy-attaches if the session isn't tracked yet. */
  snapshot(sessionId: string, cwd?: string): Promise<EditEntry[]>;
}

export function createGitEditPoller(): GitEditPoller {
  const sessions = new Map<string, SessionPollerState>();

  async function pollSession(sessionId: string, source: 'timer' | 'event' | 'manual-refresh'): Promise<void> {
    const state = sessions.get(sessionId);
    if (!state || state.polling) return;
    state.polling = true;
    try {
      const result = await runGit(['status', '--porcelain=v1', '-z', '-u'], state.repoRoot, STATUS_TIMEOUT_MS);
      if (result.code !== 0 && result.code !== 124) {
        console.warn(`[FILE-EDITS] git status failed in ${state.repoRoot}: ${result.stderr.slice(0, 200)}`);
        return;
      }
      const current = parsePorcelain(result.stdout);
      const newOrChanged: string[] = Array.from(current.keys());
      const cleared: string[] = [];
      for (const path of state.lastDirty.keys()) {
        if (!current.has(path)) cleared.push(path);
      }

      if (newOrChanged.length === 0 && cleared.length === 0) {
        return; // No-op; don't broadcast empty.
      }

      // Fetch diffs with bounded concurrency to avoid fork-bomb on
      // large dirty sets (branch checkout, stash pop, formatter runs).
      const edits: EditEntry[] = [];
      const diffs = await mapWithConcurrency(newOrChanged, DIFF_CONCURRENCY, async (path) => {
        const info = current.get(path);
        if (!info) return null;
        const { diff, isBinary, truncated } = await fetchDiff(state.repoRoot, path, info.status);
        const entry: EditEntry = {
          path: join(state.repoRoot, path),
          relativePath: path,
          diff,
          status: info.status,
          timestamp: new Date().toISOString(),
        };
        if (info.renamedFrom) entry.renamedFrom = info.renamedFrom;
        if (isBinary) entry.isBinary = true;
        if (truncated) entry.truncated = truncated;
        return entry;
      });
      for (const e of diffs) { if (e) edits.push(e); }

      state.lastDirty = current;

      broadcastEvent(sessionId, {
        type: 'caco.edit',
        data: { edits, cleared, pollSource: source },
      } as SessionEvent);
    } catch (err) {
      console.warn(`[FILE-EDITS] poll error for ${sessionId.slice(0, 8)}:`, (err as Error).message);
    } finally {
      state.polling = false;
    }
  }

  function scheduleTimer(sessionId: string): void {
    const state = sessions.get(sessionId);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    const idle = (Date.now() - state.lastActivityMs) > ACTIVITY_WINDOW_MS;
    const cadence = idle ? IDLE_CADENCE_MS : ACTIVE_CADENCE_MS;
    state.timer = setTimeout(() => {
      void pollSession(sessionId, 'timer').then(() => scheduleTimer(sessionId));
    }, cadence);
  }

  return {
    async attachToSession(sessionId: string, cwd: string): Promise<void> {
      if (sessions.has(sessionId)) return;
      const repoRoot = await findRepoRoot(cwd);
      if (!repoRoot) {
        console.log(`[FILE-EDITS] ${sessionId.slice(0, 8)} cwd=${cwd} is not a git repo; poller not attached`);
        return;
      }
      sessions.set(sessionId, {
        cwd,
        repoRoot,
        lastDirty: new Map(),
        timer: null,
        debounceTimer: null,
        lastActivityMs: 0,
        polling: false,
      });
      console.log(`[FILE-EDITS] attached to session ${sessionId.slice(0, 8)} (repo: ${repoRoot})`);
      // Initial poll to populate state without broadcasting (snapshot endpoint
      // will return the current dirty set on applet open).
      const state = sessions.get(sessionId)!;
      try {
        const result = await runGit(['status', '--porcelain=v1', '-z', '-u'], state.repoRoot, STATUS_TIMEOUT_MS);
        if (result.code === 0) state.lastDirty = parsePorcelain(result.stdout);
      } catch { /* poller still scheduled */ }
      scheduleTimer(sessionId);
    },

    detachFromSession(sessionId: string): void {
      const state = sessions.get(sessionId);
      if (!state) return;
      if (state.timer) clearTimeout(state.timer);
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      sessions.delete(sessionId);
      console.log(`[FILE-EDITS] detached from session ${sessionId.slice(0, 8)}`);
    },

    triggerPoll(sessionId: string, source: 'event' | 'manual-refresh'): void {
      const state = sessions.get(sessionId);
      if (!state) return;
      state.lastActivityMs = Date.now();
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      state.debounceTimer = setTimeout(() => {
        state.debounceTimer = null;
        void pollSession(sessionId, source).then(() => scheduleTimer(sessionId));
      }, DEBOUNCE_MS);
    },

    async snapshot(sessionId: string, cwd?: string): Promise<EditEntry[]> {
      let state = sessions.get(sessionId);
      if (!state && cwd) {
        await this.attachToSession(sessionId, cwd);
        state = sessions.get(sessionId);
      }
      if (!state) return [];
      const result = await runGit(['status', '--porcelain=v1', '-z', '-u'], state.repoRoot, STATUS_TIMEOUT_MS);
      if (result.code !== 0) return [];
      const current = parsePorcelain(result.stdout);
      const entries = Array.from(current.entries());
      const edits = await mapWithConcurrency(entries, DIFF_CONCURRENCY, async ([path, info]) => {
        const { diff, isBinary, truncated } = await fetchDiff(state.repoRoot, path, info.status);
        const entry: EditEntry = {
          path: join(state.repoRoot, path),
          relativePath: path,
          diff,
          status: info.status,
          timestamp: new Date().toISOString(),
        };
        if (info.renamedFrom) entry.renamedFrom = info.renamedFrom;
        if (isBinary) entry.isBinary = true;
        if (truncated) entry.truncated = truncated;
        return entry;
      });
      return edits;
    },
  };
}

// Exports for unit tests
export const _internal = { parsePorcelain, truncateDiff };
