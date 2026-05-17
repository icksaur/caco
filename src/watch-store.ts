/**
 * File-watch lease store.
 *
 * See docs/file-watch-leases.md. Manages opaque time-bounded leases backed by
 * Node's fs.watch. Refcounts by canonical path so multiple leases on the same
 * file share one underlying watcher.
 *
 * No path whitelisting — Caco runs as the user and inherits their file
 * permissions. EACCES on watch() open is the only access boundary.
 */

import { watch, statSync, realpathSync, existsSync, type FSWatcher } from 'fs';
import { randomUUID } from 'crypto';

export type WatchScope = 'file' | 'dir';
export type FsEventType = 'change' | 'rename';

export interface Lease {
  leaseId: string;
  sessionId: string;
  realPath: string;       // canonical, post-realpath
  requestPath: string;    // as the caller asked (for responses)
  scope: WatchScope;
  expiresAt: number;
}

export interface AcquireOk {
  ok: true;
  leaseId: string;
  ttlMs: number;
  path: string;
  scope: WatchScope;
}

export interface AcquireFail {
  ok: false;
  reason: 'path-not-found' | 'lease-cap' | 'watch-failed';
  error?: string;
}

export type AcquireResult = AcquireOk | AcquireFail;

export interface RenewOk {
  ok: true;
  ttlMs: number;
  expiresAt: string;
}

export interface RenewFail {
  ok: false;
  reason: 'unknown-lease';
}

export type RenewResult = RenewOk | RenewFail;

export interface LeaseSummary {
  leaseId: string;
  path: string;
  scope: WatchScope;
  expiresAt: string;
}

interface PathEntry {
  realPath: string;
  watcher: FSWatcher;
  scope: WatchScope;
  leases: Set<string>;
  coalesceTimer: NodeJS.Timeout | null;
  pendingEvent: { eventType: FsEventType; filename?: string } | null;
}

export interface ChangeEvent {
  leaseId: string;
  sessionId: string;
  path: string;
  eventType: FsEventType;
  filename?: string;
}

export type ChangeBroadcaster = (event: ChangeEvent) => void;

const DEFAULT_TTL_MS = 5 * 60_000;
const COALESCE_MS = 150;
const REATTACH_DELAY_MS = 50;
const PROCESS_LEASE_CAP = 16;
const EXPIRY_SCAN_INTERVAL_MS = 30_000;

/**
 * Construct a watch store. Tests can pass a fake broadcaster and a `now`
 * override; production passes the real WS broadcast and Date.now.
 */
export function createWatchStore(deps: {
  broadcast: ChangeBroadcaster;
  now?: () => number;
  ttlMs?: number;
  coalesceMs?: number;
  reattachDelayMs?: number;
  expiryScanIntervalMs?: number;
  leaseCap?: number;
}) {
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const coalesceMs = deps.coalesceMs ?? COALESCE_MS;
  const reattachDelayMs = deps.reattachDelayMs ?? REATTACH_DELAY_MS;
  const leaseCap = deps.leaseCap ?? PROCESS_LEASE_CAP;
  const expiryInterval = deps.expiryScanIntervalMs ?? EXPIRY_SCAN_INTERVAL_MS;

  const leases = new Map<string, Lease>();
  const paths = new Map<string, PathEntry>();

  function emitCoalesced(entry: PathEntry): void {
    const pending = entry.pendingEvent;
    entry.pendingEvent = null;
    entry.coalesceTimer = null;
    if (!pending) return;
    for (const leaseId of entry.leases) {
      const lease = leases.get(leaseId);
      if (!lease) continue;
      deps.broadcast({
        leaseId,
        sessionId: lease.sessionId,
        path: lease.requestPath,
        eventType: pending.eventType,
        filename: pending.filename,
      });
    }
  }

  function scheduleEmit(entry: PathEntry, eventType: FsEventType, filename: string | undefined): void {
    // Merge with any pending event: a 'change' overrides a queued 'rename'
    // when both fire in the window (content matters more than the structural
    // event). 'rename' wins if it arrives last.
    if (entry.pendingEvent && entry.pendingEvent.eventType === 'change' && eventType === 'rename') {
      // Keep the change as-is unless rename signals a structural event we
      // should report. For file scope rename means rename-over (re-attach
      // logic below handles it); for dir scope rename = child add/remove,
      // overwrite.
      entry.pendingEvent = { eventType, filename };
    } else {
      entry.pendingEvent = { eventType, filename };
    }
    if (entry.coalesceTimer) return;
    entry.coalesceTimer = setTimeout(() => emitCoalesced(entry), coalesceMs);
  }

  function attachWatcher(realPath: string, _scope: WatchScope): FSWatcher {
    // Recursive is deliberately false; spec is non-recursive only.
    return watch(realPath, { persistent: false, recursive: false }, (eventType, filename) => {
      const entry = paths.get(realPath);
      if (!entry) return;

      const ev: FsEventType = eventType === 'rename' ? 'rename' : 'change';
      const name = filename ?? undefined;

      // Save-and-replace re-attach: file scope, rename event. The original
      // inode is detached from the path; reopen on the path after a short delay
      // so the editor finishes its rename-write cycle. Emit a 'change' to the
      // consumer (semantically: contents changed).
      if (entry.scope === 'file' && ev === 'rename') {
        // Tear down the dead watcher immediately.
        try { entry.watcher.close(); } catch { /* ignore */ }
        // Hold open a slot in the map so newly-arriving acquires share the
        // re-attached watcher.
        setTimeout(() => {
          // Bail if the path entry was released or replaced during the wait.
          const stillEntry = paths.get(realPath);
          if (stillEntry !== entry) return;

          if (!existsSync(realPath)) {
            // Genuine deletion / move-away. Emit the rename so the consumer
            // can react. Lease stays active in case the file reappears later.
            scheduleEmit(entry, 'rename', name);
            return;
          }

          try {
            entry.watcher = attachWatcher(realPath, entry.scope);
          } catch (err) {
            // Re-attach failed (rare; e.g. EACCES after permission change).
            // Tell the consumer something happened so they can re-fetch and
            // discover the broken state on their own terms.
            console.warn(`[WATCH] Re-attach failed for ${realPath}:`, err);
            scheduleEmit(entry, 'rename', name);
            return;
          }
          scheduleEmit(entry, 'change', name);
        }, reattachDelayMs);
        return;
      }

      scheduleEmit(entry, ev, name);
    });
  }

  /** Acquire a new lease. Returns AcquireResult; never throws on protocol-level failures. */
  function acquireLease(sessionId: string, path: string, scope?: WatchScope): AcquireResult {
    if (leases.size >= leaseCap) {
      return { ok: false, reason: 'lease-cap' };
    }

    let realPath: string;
    try {
      realPath = realpathSync.native(path);
    } catch {
      return { ok: false, reason: 'path-not-found' };
    }

    let resolvedScope: WatchScope;
    if (scope) {
      resolvedScope = scope;
    } else {
      try {
        const st = statSync(realPath);
        resolvedScope = st.isDirectory() ? 'dir' : 'file';
      } catch {
        return { ok: false, reason: 'path-not-found' };
      }
    }

    let entry = paths.get(realPath);
    if (!entry) {
      let watcher: FSWatcher;
      try {
        watcher = attachWatcher(realPath, resolvedScope);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: 'watch-failed', error: msg };
      }
      entry = {
        realPath,
        watcher,
        scope: resolvedScope,
        leases: new Set(),
        coalesceTimer: null,
        pendingEvent: null,
      };
      paths.set(realPath, entry);
    }

    const leaseId = `lease-${randomUUID()}`;
    const lease: Lease = {
      leaseId,
      sessionId,
      realPath,
      requestPath: path,
      scope: resolvedScope,
      expiresAt: now() + ttlMs,
    };
    leases.set(leaseId, lease);
    entry.leases.add(leaseId);

    return { ok: true, leaseId, ttlMs, path, scope: resolvedScope };
  }

  function renewLease(leaseId: string): RenewResult {
    const lease = leases.get(leaseId);
    if (!lease) return { ok: false, reason: 'unknown-lease' };
    lease.expiresAt = now() + ttlMs;
    return { ok: true, ttlMs, expiresAt: new Date(lease.expiresAt).toISOString() };
  }

  function releaseLease(leaseId: string): void {
    const lease = leases.get(leaseId);
    if (!lease) return;
    leases.delete(leaseId);
    const entry = paths.get(lease.realPath);
    if (!entry) return;
    entry.leases.delete(leaseId);
    if (entry.leases.size === 0) {
      try { entry.watcher.close(); } catch { /* ignore */ }
      if (entry.coalesceTimer) {
        clearTimeout(entry.coalesceTimer);
        entry.coalesceTimer = null;
      }
      paths.delete(lease.realPath);
    }
  }

  function releaseSession(sessionId: string): void {
    for (const lease of Array.from(leases.values())) {
      if (lease.sessionId === sessionId) releaseLease(lease.leaseId);
    }
  }

  function listLeases(sessionId: string): LeaseSummary[] {
    const out: LeaseSummary[] = [];
    for (const lease of leases.values()) {
      if (lease.sessionId === sessionId) {
        out.push({
          leaseId: lease.leaseId,
          path: lease.requestPath,
          scope: lease.scope,
          expiresAt: new Date(lease.expiresAt).toISOString(),
        });
      }
    }
    return out;
  }

  /** Scan for expired leases. Called periodically by the interval timer; also
   *  exposed for tests so they can drive time manually. */
  function expireDue(): number {
    const cutoff = now();
    let n = 0;
    for (const lease of Array.from(leases.values())) {
      if (lease.expiresAt <= cutoff) {
        releaseLease(lease.leaseId);
        n++;
      }
    }
    return n;
  }

  const expiryHandle: NodeJS.Timeout | null = expiryInterval > 0
    ? setInterval(expireDue, expiryInterval)
    : null;

  if (expiryHandle && typeof expiryHandle.unref === 'function') {
    expiryHandle.unref();
  }

  function shutdown(): void {
    if (expiryHandle) clearInterval(expiryHandle);
    for (const entry of paths.values()) {
      try { entry.watcher.close(); } catch { /* ignore */ }
      if (entry.coalesceTimer) clearTimeout(entry.coalesceTimer);
    }
    paths.clear();
    leases.clear();
  }

  return {
    acquireLease,
    renewLease,
    releaseLease,
    releaseSession,
    listLeases,
    expireDue,
    shutdown,
    // Inspectable internals for tests / debug.
    _state: { leases, paths },
  };
}

export type WatchStore = ReturnType<typeof createWatchStore>;
