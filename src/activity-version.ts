/**
 * Activity version + long-poll parking (spec-pager).
 *
 * A process-global monotonic counter bumped on any transition that can change the
 * pager board, plus a bounded wait so a client can hang until something moves.
 *
 * Deliberately NOT an event feed like `idle-feed.ts`. That carries cursors, ring
 * eviction and a `reset` flag because its consumers must not miss an individual
 * idle. The pager only ever needs the CURRENT board, so a version + full snapshot
 * is enough — and is self-healing: a missed bump costs latency, never
 * correctness, because the next response carries whole truth.
 */

/** Hard cap on one hold. Also bounds how long a parked request can delay a
 *  graceful restart, and is the backstop that makes a missed bump self-correct. */
export const PAGER_WAIT_CAP_MS = 10_000;
/** Max concurrently parked waiters; past the cap `read` answers immediately. */
export const PAGER_WAITER_CAP = 256;
/**
 * Bumps inside this window settle parked readers once. The counter is global, so
 * without this every dispatch start/end in any session wakes every poller and
 * rebuilds a snapshot — worst exactly when a swarm is running, which is the case
 * the pager exists to watch. Bounds wake frequency; the wait cap bounds staleness.
 */
export const PAGER_COALESCE_MS = 250;

export interface ActivityReadOptions {
  /** Park while `since === version`. Absent ⇒ answer immediately. */
  since?: number;
  /** Hold in ms (0 ⇒ immediate). Clamped to PAGER_WAIT_CAP_MS. */
  wait?: number;
  /** Abort the hold early (client disconnect). */
  signal?: AbortSignal;
}

export interface ActivityReadResult {
  version: number;
}

interface Waiter {
  resolve: (r: ActivityReadResult) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class ActivityVersion {
  private current = 0;
  private waiters = new Set<Waiter>();
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;

  get version(): number {
    return this.current;
  }

  /** Test seam: parked waiters. */
  get waiterCount(): number {
    return this.waiters.size;
  }

  /** Test seam: timers still outstanding (waiters + a pending coalesced wake). */
  get pendingTimerCount(): number {
    return this.waiters.size + (this.coalesceTimer ? 1 : 0);
  }

  /** Clamp a requested hold. Exported as a method so the contract is testable
   *  without waiting out the cap. */
  clampWait(wait: number | undefined): number {
    if (!Number.isFinite(wait) || wait === undefined || wait <= 0) return 0;
    return Math.min(Math.floor(wait), PAGER_WAIT_CAP_MS);
  }

  /**
   * Record a board-changing transition. The counter ALWAYS advances; only the
   * wake is coalesced — dropping versions could hand a reader a version it had
   * already seen, which would park it against a change it never observed.
   */
  bump(): void {
    this.current++;
    if (this.coalesceTimer || this.waiters.size === 0) return;
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null;
      for (const w of [...this.waiters]) this.settle(w);
    }, PAGER_COALESCE_MS);
    // Never hold the process open for a wake-up.
    this.coalesceTimer.unref?.();
  }

  /** Read the current version, optionally parking until it moves. */
  read(opts: ActivityReadOptions): Promise<ActivityReadResult> {
    const wait = this.clampWait(opts.wait);

    // Answer immediately when the caller is behind, has no cursor, is ahead (the
    // counter reset on restart — never hang on a version that will not return),
    // does not want to wait, is already gone, or the parking budget is spent.
    const caughtUp = opts.since !== undefined && opts.since === this.current;
    if (!caughtUp || wait <= 0 || opts.signal?.aborted || this.waiters.size >= PAGER_WAITER_CAP) {
      return Promise.resolve({ version: this.current });
    }

    return new Promise<ActivityReadResult>((resolve) => {
      // Registered synchronously with the check above — no await between them, so
      // no transition can land in a gap and be lost.
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => this.settle(waiter), wait),
        signal: opts.signal,
      };
      waiter.timer.unref?.();
      if (opts.signal) {
        waiter.onAbort = () => this.settle(waiter);
        opts.signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }

  /** Resolve a parked waiter with the version as of now (a bump, timeout, or abort). */
  private settle(waiter: Waiter): void {
    if (!this.waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
    waiter.resolve({ version: this.current });
  }

  /** Test seam: clear all state. */
  _resetForTest(): void {
    for (const w of this.waiters) clearTimeout(w.timer);
    this.waiters.clear();
    if (this.coalesceTimer) clearTimeout(this.coalesceTimer);
    this.coalesceTimer = null;
    this.current = 0;
  }
}

export const activityVersion = new ActivityVersion();
