/**
 * Git Edit Poller
 *
 * Polls `git status --porcelain` per session and broadcasts the diff
 * between consecutive snapshots as `caco.edit` events. See docs/file-edits.md.
 *
 * Triggered from two places:
 *   - internal timer (1.5s active / 5s idle)
 *   - dispatch-events on tool.execution_complete for write tools
 *
 * Both triggers funnel into triggerPoll(), which debounces 50ms.
 *
 * One subprocess per poll for status; one per changed-file path for diff.
 * No pre-image cache: git is the source of truth.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { readFile, stat } from 'fs/promises';
import { join } from 'path';
import { broadcastEvent } from './event-bus.js';
import { createFileWatcher } from './file-watcher.js';
import type { SessionEvent } from './types.js';

/** V3.3: env toggle for the chokidar filesystem watcher. Set to 'off'
 *  (case-insensitive; '0', 'false', 'no' also accepted) to force
 *  timer-only mode (use case: NFS / network mounts where chokidar
 *  attaches without error but silently misses events). Read once at
 *  module load. */
const WATCH_ENABLED = !(/^(off|0|false|no)$/i.test(String(process.env.CACO_FILE_EDITS_WATCH ?? '')));

export type FileStatus = 'modified' | 'untracked' | 'deleted' | 'renamed' | 'clean';

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
  /** Unified-diff text. Optional: clean entries (status='clean') omit it. */
  diff?: string;
  status: FileStatus;
  renamedFrom?: string;
  isBinary?: boolean;
  timestamp: string;
  /** V3.1: working-tree file mtime in ms (Date.now() epoch). Drives
   *  client-side "most recent edit" picks for the Follow-edits jump
   *  target. Absent for clean entries with no on-disk file (deleted),
   *  binary fallback paths that couldn't stat, etc. */
  mtimeMs?: number;
  truncated?: { hiddenLines: number };
  /** V2: full-file diff payload. Absent when fallback to hunk view is required
   *  (binary, deleted, files exceeding FULLFILE_LINE_CAP). For clean entries
   *  (V2.1), present with hunks=[] and workLines=headLines. */
  fullFile?: FullFile;
}

interface SessionPollerState {
  cwd: string;
  repoRoot: string;
  /** Map<relativePath, { status, renamedFrom? }> last known dirty set. */
  lastDirty: Map<string, { status: FileStatus; renamedFrom?: string }>;
  timer: NodeJS.Timeout | null;
  debounceTimer: NodeJS.Timeout | null;
  /** When true, we're in the middle of a poll; new triggers are no-ops. */
  polling: boolean;
}

const IDLE_CADENCE_MS = 5000;
/** V3.3: backstop cadence when chokidar is attached. The fs watcher
 *  drives polling on every real edit; this tick exists only to catch
 *  the rare case where chokidar misses (NFS, etc.). */
const WATCHED_BACKSTOP_MS = 30_000;
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
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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
  /** True when the session is attached (its cwd resolved to a git repo).
   *  Used by the snapshot endpoint to tell the client whether the diff
   *  path is usable; a non-git cwd has no repo root and can't diff. */
  isAttached(sessionId: string): boolean;
  triggerPoll(sessionId: string, source: 'event' | 'fs-event'): void;
  /** Return the current dirty set as edits (used by snapshot endpoint).
   *  Lazy-attaches if the session isn't tracked yet.
   *  V2.1: optional persistedCleanPaths — paths from the persisted card
   *  list. Any persisted path NOT currently dirty gets a clean EditEntry
   *  built from `git show HEAD:<path>` so the client renders its body. */
  snapshot(sessionId: string, cwd?: string, persistedCleanPaths?: string[]): Promise<EditEntry[]>;
  /** V3.1: materialize an EditEntry for an arbitrary path picked by the
   *  user. Returns null if the session is unknown, the path is missing
   *  from both HEAD and the working tree, or git fails. The caller is
   *  responsible for input validation (no `..`, no NUL, etc.).
   *
   *  V6: opts.diffMode optionally selects an alternate diff source:
   *    - 'unstaged' (default): existing working-tree behavior.
   *    - 'staged': `git diff --cached -- <relPath>`.
   *  For staged, the returned EditEntry carries the diff text only;
   *  FileStatus is 'modified' regardless (the mode is carried by the
   *  client-side container, not the entry).
   *
   *  V6.1: removed 'range' mode (no natural entry point survived V6
   *  scope; the URL-typing use case wasn't worth the complexity). */
  openFile(
    sessionId: string,
    relPath: string,
    opts?: { diffMode?: 'unstaged' | 'staged' },
  ): Promise<EditEntry | null>;
}

export function createGitEditPoller(): GitEditPoller {
  const sessions = new Map<string, SessionPollerState>();
  // V3.3: per-session chokidar watcher. attach/detach mirror the
  // poller's per-session lifecycle. The watcher is a no-op when
  // WATCH_ENABLED is false (CACO_FILE_EDITS_WATCH=off).
  const fileWatcher = createFileWatcher();

  /** Best-effort file mtime. Returns undefined on stat failure (deleted,
   *  unreadable). Used to populate EditEntry.mtimeMs so the client can
   *  pick the freshest edit for the Follow-edits jump target. */
  async function readMtimeMs(absPath: string): Promise<number | undefined> {
    try {
      const st = await stat(absPath);
      return st.mtimeMs;
    } catch {
      return undefined;
    }
  }

  /** Build one EditEntry for a single path. Shared between pollSession and snapshot. */
  async function buildEntry(repoRoot: string, path: string, info: { status: FileStatus; renamedFrom?: string }): Promise<EditEntry> {
    const { diff, isBinary, truncated } = await fetchDiff(repoRoot, path, info.status);
    const originalRelPath = info.renamedFrom ?? path;
    const absPath = join(repoRoot, path);
    const fullFile = await computeFullFile(repoRoot, path, originalRelPath, info.status, isBinary, diff);
    const mtimeMs = await readMtimeMs(absPath);
    const entry: EditEntry = {
      path: absPath,
      relativePath: path,
      diff,
      status: info.status,
      timestamp: new Date().toISOString(),
    };
    if (info.renamedFrom) entry.renamedFrom = info.renamedFrom;
    if (isBinary) entry.isBinary = true;
    if (truncated) entry.truncated = truncated;
    if (fullFile) entry.fullFile = fullFile;
    if (mtimeMs !== undefined) entry.mtimeMs = mtimeMs;
    return entry;
  }

  /** V2.1: Build a clean EditEntry for a path that exists in HEAD but is
   *  clean in the working tree. Synthesizes fullFile with workLines=headLines
   *  and hunks=[] so the client renders the full file as all-context rows.
   *  Returns null if the HEAD blob cannot be read (path missing from HEAD,
   *  e.g. user committed a deletion). */
  async function buildCleanEntry(repoRoot: string, relPath: string): Promise<EditEntry | null> {
    const headText = await readHeadBlob(repoRoot, relPath);
    if (headText === null) return null;
    const absPath = join(repoRoot, relPath);
    const lines = toLines(headText);
    const mtimeMs = await readMtimeMs(absPath);
    const base: EditEntry = {
      path: absPath,
      relativePath: relPath,
      status: 'clean',
      timestamp: new Date().toISOString(),
    };
    if (mtimeMs !== undefined) base.mtimeMs = mtimeMs;
    if (lines.length > FULLFILE_LINE_CAP) {
      return base;
    }
    base.fullFile = { headLines: lines, workLines: lines, hunks: [] };
    return base;
  }

  /** V3.1: Build an EditEntry for an untracked path picked by the user.
   *  Reads the working-tree file and synthesizes a single "+all" hunk
   *  so the client's buildRows produces all-add rows (matching what
   *  computeFullFile does for status='untracked' via git diff --no-index). */
  async function buildUntrackedEntry(repoRoot: string, relPath: string): Promise<EditEntry | null> {
    const absPath = join(repoRoot, relPath);
    let workText: string;
    try {
      workText = await readFile(absPath, 'utf-8');
    } catch {
      return null;
    }
    const workLines = toLines(workText);
    const mtimeMs = await readMtimeMs(absPath);
    const base: EditEntry = {
      path: absPath,
      relativePath: relPath,
      status: 'untracked',
      timestamp: new Date().toISOString(),
    };
    if (mtimeMs !== undefined) base.mtimeMs = mtimeMs;
    if (workLines.length > FULLFILE_LINE_CAP) return base;
    base.fullFile = {
      headLines: null,
      workLines,
      hunks: [{ headStart: 0, headLen: 0, workStart: 1, workLen: workLines.length }],
    };
    return base;
  }

  async function pollSession(sessionId: string, source: 'timer' | 'event' | 'fs-event'): Promise<void> {
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

      // V2.1: build clean entries for paths transitioning dirty→clean
      // so the client can render the full HEAD content immediately.
      const cleanedEdits: EditEntry[] = [];
      if (cleared.length > 0) {
        const cleans = await mapWithConcurrency(cleared, DIFF_CONCURRENCY, async (path) => {
          return buildCleanEntry(state.repoRoot, path);
        });
        for (const c of cleans) { if (c) cleanedEdits.push(c); }
      }

      state.lastDirty = current;

      broadcastEvent(sessionId, {
        type: 'caco.edit',
        data: { edits, cleared, cleanedEdits, pollSource: source },
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
    // V3.3 cadence: 30s when chokidar is attached (backstop only);
    // 5s when not (the 1.5s active heuristic from V3.2 is dropped).
    const cadence = fileWatcher.isWatching(sessionId) ? WATCHED_BACKSTOP_MS : IDLE_CADENCE_MS;
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
        polling: false,
      });
      console.log(`[FILE-EDITS] attached to session ${sessionId.slice(0, 8)} (repo: ${repoRoot})`);
      // Initial poll to populate state without broadcasting (snapshot endpoint
      // will return the current dirty set on applet open).
      const state = sessions.get(sessionId)!;
      let initialPollOk = false;
      try {
        const result = await runGit(['status', '--porcelain=v1', '-z', '-u'], state.repoRoot, STATUS_TIMEOUT_MS);
        if (result.code === 0) {
          state.lastDirty = parsePorcelain(result.stdout);
          initialPollOk = true;
        }
      } catch { /* poller still scheduled */ }
      // V3.3: attach the chokidar watcher AFTER the initial poll so
      // lastDirty is populated. Otherwise a watcher event firing during
      // the await above would race the inline poll and broadcast every
      // dirty file as "new."
      // If the initial poll FAILED, lastDirty is still empty — attaching
      // chokidar now would re-create the spurious-broadcast race the
      // ordering was supposed to eliminate. Skip the attach; the next
      // timer tick (5s, unwatched cadence) will retry status, and a
      // future attach attempt could be wired by the operator. For now,
      // a single failed initial poll degrades us to timer-only mode for
      // the session's lifetime — rare, acceptable.
      if (WATCH_ENABLED && initialPollOk) {
        const onChange = (): void => this.triggerPoll(sessionId, 'fs-event');
        const attached = await fileWatcher.attach(sessionId, repoRoot, onChange);
        if (!attached) {
          console.log(`[FILE-EDITS] ${sessionId.slice(0, 8)} chokidar attach failed; using timer-only mode`);
        }
      } else if (WATCH_ENABLED && !initialPollOk) {
        console.warn(`[FILE-EDITS] ${sessionId.slice(0, 8)} initial poll failed; skipping chokidar attach (timer-only mode)`);
      }
      scheduleTimer(sessionId);
    },

    detachFromSession(sessionId: string): void {
      const state = sessions.get(sessionId);
      if (!state) return;
      if (state.timer) clearTimeout(state.timer);
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      fileWatcher.detach(sessionId);
      sessions.delete(sessionId);
      console.log(`[FILE-EDITS] detached from session ${sessionId.slice(0, 8)}`);
    },

    isAttached(sessionId: string): boolean {
      return sessions.has(sessionId);
    },

    triggerPoll(sessionId: string, source: 'event' | 'fs-event'): void {
      const state = sessions.get(sessionId);
      if (!state) return;
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      state.debounceTimer = setTimeout(() => {
        state.debounceTimer = null;
        void pollSession(sessionId, source).then(() => scheduleTimer(sessionId));
      }, DEBOUNCE_MS);
    },

    async snapshot(sessionId: string, cwd?: string, persistedCleanPaths?: string[]): Promise<EditEntry[]> {
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
      // V2.1: also build clean entries for persisted paths that aren't
      // currently dirty. Bounded by 50-card cap minus dirty count so the
      // total snapshot size stays under the client's visible cap.
      if (persistedCleanPaths && persistedCleanPaths.length > 0) {
        const slots = Math.max(0, 50 - edits.length);
        const cleanCandidates = persistedCleanPaths
          .filter((p) => !current.has(p))
          .slice(-slots); // tail = most-recently-touched per spec
        if (cleanCandidates.length > 0) {
          const cleans = await mapWithConcurrency(cleanCandidates, DIFF_CONCURRENCY, async (path) => {
            return buildCleanEntry(state.repoRoot, path);
          });
          for (const c of cleans) { if (c) edits.push(c); }
        }
      }
      return edits;
    },

    async openFile(
      sessionId: string,
      relPath: string,
      opts?: { diffMode?: 'unstaged' | 'staged' },
    ): Promise<EditEntry | null> {
      const state = sessions.get(sessionId);
      if (!state) return null;
      const diffMode = opts?.diffMode || 'unstaged';

      if (diffMode === 'staged') {
        // V6: snapshot diff against the staging area. The poller
        // does not track staged tabs (no watcher, no follow-up
        // poll); the entry is a point-in-time read. Reopen the
        // tab (e.g. by re-clicking in git-status) to refresh.
        const args = ['diff', '--no-color', '--cached', '--', relPath];
        const result = await runGit(args, state.repoRoot, DIFF_TIMEOUT_MS);
        if (result.code === 124) return null;
        if (result.code !== 0 && result.code !== 1) {
          // git diff returns 1 when there are differences; non-0/non-1 = failure.
          return null;
        }
        const text = result.stdout.toString('utf-8');
        const isBinary = /^Binary files /m.test(text);
        const { diff, truncated } = truncateDiff(text);
        const absPath = join(state.repoRoot, relPath);
        const mtimeMs = await readMtimeMs(absPath);
        const entry: EditEntry = {
          path: absPath,
          relativePath: relPath,
          diff,
          status: 'modified',
          timestamp: new Date().toISOString(),
        };
        if (isBinary) entry.isBinary = true;
        if (truncated) entry.truncated = truncated;
        if (mtimeMs !== undefined) entry.mtimeMs = mtimeMs;
        return entry;
      }

      // diffMode === 'unstaged' (default): existing working-tree path.
      // Per-path git status: returns at most one or two entries.
      // No --no-renames so an R/C entry's source-path NUL field is
      // present for buildEntry to consume.
      const result = await runGit(
        ['status', '--porcelain=v1', '-z', '-u', '--', relPath],
        state.repoRoot,
        STATUS_TIMEOUT_MS,
      );
      if (result.code !== 0) return null;
      const current = parsePorcelain(result.stdout);
      const info = current.get(relPath);
      if (info) {
        if (info.status === 'untracked') {
          return buildUntrackedEntry(state.repoRoot, relPath);
        }
        return buildEntry(state.repoRoot, relPath, info);
      }
      // Path is clean. Verify it exists in HEAD, then build clean entry.
      return buildCleanEntry(state.repoRoot, relPath);
    },
  };
}

// Exports for unit tests
export const _internal = { parsePorcelain, truncateDiff, parseHunks, toLines };
