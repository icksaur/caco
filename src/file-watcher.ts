/**
 * File Watcher (V3.3)
 *
 * Per-session chokidar watcher rooted at the git repo root. Drives the
 * `triggerPoll('fs-event')` path in git-edit-poller so external edits
 * (user saves in VSCode, shell tools) surface in the applet within
 * ~300ms instead of waiting for the next polling tick.
 *
 * See docs/spec-files-applet-edits.md.
 *
 * Failure mode: any chokidar `error` (ENOSPC, permission, etc.) detaches
 * the watcher for that session; the poller falls back to timer-only mode
 * at the 5s cadence. The `attach` return value tells the caller whether
 * to expect events.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import chokidar, { type FSWatcher } from 'chokidar';
import ignore, { type Ignore } from 'ignore';

/** Directories that are NEVER worth watching for diffs, even if they
 *  aren't in .gitignore. Same list the file-picker uses for parity. */
const EXCLUDED_DIRS = new Set([
  'node_modules', 'dist', 'build', 'coverage', '.git', '.next',
  'target', 'vendor', 'bin', 'obj', 'out', 'tmp',
]);

export interface FileWatcher {
  /** Attach a chokidar watcher to `repoRoot`. Idempotent per session.
   *  Returns true if attached, false if chokidar errored at construction
   *  and the caller should stay in timer-only mode. */
  attach(sessionId: string, repoRoot: string, onChange: () => void): Promise<boolean>;
  detach(sessionId: string): void;
  /** Diagnostic: are we currently watching this session? */
  isWatching(sessionId: string): boolean;
}

interface SessionWatcher {
  watcher: FSWatcher;
  repoRoot: string;
}

/** Build a chokidar `ignored` predicate from the repo's .gitignore plus
 *  the hardcoded EXCLUDED_DIRS list. Used at watcher construction; not
 *  reloaded mid-run (see docs/spec-files-applet-edits.md). */
async function buildIgnoredPredicate(repoRoot: string): Promise<(p: string) => boolean> {
  let ig: Ignore | null = null;
  try {
    const gitignoreContent = await readFile(join(repoRoot, '.gitignore'), 'utf-8');
    ig = ignore().add(gitignoreContent);
  } catch { /* no .gitignore */ }

  return (absPath: string): boolean => {
    // Compute path relative to repoRoot.
    if (!absPath.startsWith(repoRoot)) return false;
    let rel = absPath.slice(repoRoot.length);
    if (rel.startsWith('/') || rel.startsWith('\\')) rel = rel.slice(1);
    if (rel === '') return false;

    // ANY segment in EXCLUDED_DIRS → ignore. The first-segment-only
    // check would miss nested cases like 'packages/foo/node_modules'
    // common in monorepos.
    const segs = rel.split(/[/\\]/);
    for (let i = 0; i < segs.length; i++) {
      if (EXCLUDED_DIRS.has(segs[i])) return true;
    }

    // .gitignore match.
    if (ig && ig.ignores(rel)) return true;
    return false;
  };
}

export function createFileWatcher(): FileWatcher {
  const watchers = new Map<string, SessionWatcher>();

  return {
    async attach(sessionId: string, repoRoot: string, onChange: () => void): Promise<boolean> {
      if (watchers.has(sessionId)) return true;

      let ignored: (p: string) => boolean;
      try {
        ignored = await buildIgnoredPredicate(repoRoot);
      } catch (err) {
        console.warn(`[FILE-EDITS] file-watcher: ignore-predicate build failed for ${sessionId.slice(0, 8)}: ${(err as Error).message}`);
        return false;
      }

      let watcher: FSWatcher;
      try {
        watcher = chokidar.watch(repoRoot, {
          persistent: false,
          ignoreInitial: true,
          awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
          atomic: true,
          followSymlinks: false, // overrides chokidar default of true
          ignored,
        });
      } catch (err) {
        console.warn(`[FILE-EDITS] file-watcher: chokidar construct failed for ${sessionId.slice(0, 8)}: ${(err as Error).message}`);
        return false;
      }

      watcher.on('all', () => {
        onChange();
      });
      watcher.on('error', (err) => {
        console.warn(`[FILE-EDITS] file-watcher: error for ${sessionId.slice(0, 8)}: ${(err as Error).message}`);
        this.detach(sessionId);
      });

      watchers.set(sessionId, { watcher, repoRoot });
      console.log(`[FILE-EDITS] file-watcher: attached to session ${sessionId.slice(0, 8)} (repo: ${repoRoot})`);
      return true;
    },

    detach(sessionId: string): void {
      const sw = watchers.get(sessionId);
      if (!sw) return;
      try {
        void sw.watcher.close();
      } catch { /* best effort */ }
      watchers.delete(sessionId);
      console.log(`[FILE-EDITS] file-watcher: detached from session ${sessionId.slice(0, 8)}`);
    },

    isWatching(sessionId: string): boolean {
      return watchers.has(sessionId);
    },
  };
}
