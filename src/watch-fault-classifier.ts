/**
 * Watch-fault classifier (spec-server-resilience).
 *
 * A long-lived Caco server hosts many sessions in one process. A single
 * unhandled `fs.watch` error — e.g. a spurious Windows `EPERM` when OneDrive
 * syncs/dehydrates files under a watched tree, or `ENOSPC` exhausting inotify —
 * otherwise reaches the process-level `uncaughtException` handler and kills the
 * whole server, taking every session down with it.
 *
 * Such a fault is benign and self-contained: the watcher is simply gone; no
 * application state is mid-mutation (the throw originates inside Node's watcher
 * onchange callback). The process can and should continue. This module is the
 * pure, unit-testable predicate the process handler branches on. It lives apart
 * from `server.ts` because that module boots the server on import.
 */

/** Watcher error codes we treat as benign and survivable (with syscall==='watch'). */
const WATCH_FAULT_CODES = new Set(['EPERM', 'EACCES', 'ENOENT', 'EBADF', 'ENOSPC', 'EMFILE']);

/**
 * True when `err` is a transient filesystem-watch fault safe to survive.
 * Gated on `syscall === 'watch'` plus a narrow code allowlist, so real fatal
 * errors (a failed open/write, a genuine logic bug) still exit as before.
 * `UNKNOWN` is accepted only on win32, where OneDrive occasionally reports it.
 */
export function isBenignWatcherFault(
  err: unknown,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const e = err as NodeJS.ErrnoException | undefined;
  if (!e || e.syscall !== 'watch' || !e.code) return false;
  if (WATCH_FAULT_CODES.has(e.code)) return true;
  return platform === 'win32' && e.code === 'UNKNOWN';
}
