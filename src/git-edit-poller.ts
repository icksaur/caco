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
import { readFile, stat } from 'fs/promises';
import { join } from 'path';
import { broadcastEvent } from './event-bus.js';
import type { SessionEvent } from './types.js';

export type FileStatus = 'modified' | 'untracked' | 'deleted' | 'renamed';

export interface DiffHunk {
  /** 1-indexed HEAD line where removed region starts. */
  headStart: number;
  /** Number of removed (HEAD-side) lines. */
  headLen: number;
  /** 1-indexed working-tree line where added region starts. */
  workStart: number;
  /** Number of added (working-tree) lines. */
  workLen: number;
}

export interface FullFile {
  /** HEAD blob lines. Null when there is no HEAD blob (untracked). */
  headLines: string[] | null;
  /** Working-tree file lines. Empty array when working tree absent (deleted). */
  workLines: string[];
  /** Parsed unified diff hunks. */
  hunks: DiffHunk[];
}

export interface EditEntry {
  path: string;            // absolute
  relativePath: string;
  diff: string;
  status: FileStatus;
  renamedFrom?: string;
  isBinary?: boolean;
  timestamp: string;
  truncated?: { hiddenLines: number };
  /** V2: full-file diff payload. Absent when fallback to hunk view is required
   *  (binary, deleted, files exceeding FULLFILE_LINE_CAP). */
  fullFile?: FullFile;
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
/** V2: each buildEntry now spawns two git subprocesses (git diff +
 *  git show HEAD:path for the V2 fullFile payload). Halved from V1's
 *  8 so the in-flight subprocess count remains bounded at 8. */
const DIFF_CONCURRENCY = 4;
/** V2: per-file line cap above which fullFile is omitted (card falls back
 *  to v1 hunk view). Bounds payload + render cost. */
const FULLFILE_LINE_CAP = 5000;

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

/**
 * Parse unified-diff hunk headers from a `git diff` string. Returns the list
 * of {headStart, headLen, workStart, workLen} entries.
 *
 * Header format: `@@ -h,hlen +w,wlen @@` (lengths default to 1 when omitted).
 * Examples this parser handles:
 *   `@@ -1,3 +5,2 @@`           → {1, 3, 5, 2}
 *   `@@ -10 +12 @@`             → {10, 1, 12, 1}  (length omitted = 1)
 *   `@@ -0,0 +1,5 @@`           → {0, 0, 1, 5}    (pure addition at file start)
 *   `@@ -1,5 +0,0 @@`           → {1, 5, 0, 0}    (pure deletion of file start)
 *
 * Empty diff strings (no hunks) yield [].
 */
function parseHunks(diff: string): DiffHunk[] {
  const out: DiffHunk[] = [];
  if (!diff) return out;
  const re = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(diff)) !== null) {
    out.push({
      headStart: parseInt(m[1], 10),
      headLen: m[2] !== undefined ? parseInt(m[2], 10) : 1,
      workStart: parseInt(m[3], 10),
      workLen: m[4] !== undefined ? parseInt(m[4], 10) : 1,
    });
  }
  return out;
}

/**
 * Split a buffer/string into lines, preserving exactly the line content
 * (no trailing newline character on each entry). Mirrors how git treats
 * the final newline: a file with N newline-terminated lines produces N
 * entries; a file ending without a newline still produces N entries
 * (the last entry has its content).
 */
function toLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  // Drop a single trailing empty entry produced by a final '\n'.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Best-effort read of the HEAD blob for `relPath` as text. Returns null if
 * the file isn't in HEAD (untracked / newly-added in working tree) or if
 * the read errors. Binary detection is left to the caller (we still return
 * the bytes for V2's purposes).
 */
async function readHeadBlob(repoRoot: string, relPath: string): Promise<string | null> {
  const result = await runGit(['show', `HEAD:${relPath}`], repoRoot, DIFF_TIMEOUT_MS);
  if (result.code !== 0) return null;
  return result.stdout.toString('utf-8');
}

/**
 * Build the V2 fullFile payload for a single path. Returns null for cases the
 * client must fall back to v1 hunk view: binary, deleted (working tree
 * absent), or files exceeding FULLFILE_LINE_CAP on either side.
 *
 * `originalRelPath` is the HEAD-side path (renamedFrom for renames; same as
 * relPath otherwise) so the HEAD blob comes from the correct entry.
 */
async function computeFullFile(
  repoRoot: string,
  relPath: string,
  originalRelPath: string,
  status: FileStatus,
  isBinary: boolean,
  diffText: string,
): Promise<FullFile | undefined> {
  if (isBinary) return undefined;
  if (status === 'deleted') return undefined;

  let headText: string | null = null;
  if (status !== 'untracked') {
    headText = await readHeadBlob(repoRoot, originalRelPath);
  }

  let workText = '';
  try {
    const absPath = join(repoRoot, relPath);
    const st = await stat(absPath);
    if (!st.isFile()) return undefined;
    workText = await readFile(absPath, 'utf-8');
  } catch {
    // Working tree file absent or unreadable — treat as fallback case.
    return undefined;
  }

  const headLines = headText === null ? null : toLines(headText);
  const workLines = toLines(workText);

  if ((headLines?.length ?? 0) > FULLFILE_LINE_CAP) return undefined;
  if (workLines.length > FULLFILE_LINE_CAP) return undefined;

  const hunks = parseHunks(diffText);
  return { headLines, workLines, hunks };
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

  /** Build one EditEntry for a single path. Shared between pollSession and snapshot. */
  async function buildEntry(repoRoot: string, path: string, info: { status: FileStatus; renamedFrom?: string }): Promise<EditEntry> {
    const { diff, isBinary, truncated } = await fetchDiff(repoRoot, path, info.status);
    const originalRelPath = info.renamedFrom ?? path;
    const fullFile = await computeFullFile(repoRoot, path, originalRelPath, info.status, isBinary, diff);
    const entry: EditEntry = {
      path: join(repoRoot, path),
      relativePath: path,
      diff,
      status: info.status,
      timestamp: new Date().toISOString(),
    };
    if (info.renamedFrom) entry.renamedFrom = info.renamedFrom;
    if (isBinary) entry.isBinary = true;
    if (truncated) entry.truncated = truncated;
    if (fullFile) entry.fullFile = fullFile;
    return entry;
  }

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
        return buildEntry(state.repoRoot, path, info);
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
        return buildEntry(state.repoRoot, path, info);
      });
      return edits;
    },
  };
}

// Exports for unit tests
export const _internal = { parsePorcelain, truncateDiff, parseHunks, toLines };
