/**
 * Idle event feed (spec-idle-notifications).
 *
 * One global, append-only, monotonic-seq ring of "a session reached a real idle"
 * events, exposed to out-of-process automation via a long-poll HTTP read. It is
 * the machine-observable analog of the UI's unobserved dot: the idle authority
 * appends here on exactly the real idles it marks unobserved (needsObservation),
 * so herd children, delegates, and tool-enable auto-continuations never appear.
 *
 * The cursor is the point of the design: a reader passes back the `cursor` it last
 * saw, so an idle that lands between two reads is returned IMMEDIATELY on the next
 * read (scan seq > after) rather than hung on. The bounded ring can evict an
 * unseen event; that is surfaced as `reset` (never a silent gap), and a
 * per-session `lastSeq` keeps a session-filtered reader from a spurious reset when
 * a noisy neighbor evicts the window but the reader is caught up on its own
 * session.
 */

/** Max events retained in the ring (older are evicted → `reset` for stale readers). */
export const IDLE_RING_CAP = 1000;
/** Hard cap on a single long-poll hold, so a socket never hangs unbounded. */
export const IDLE_WAIT_CAP_MS = 30_000;
/** Max concurrently parked waiters; over the cap `read` returns immediately. */
export const IDLE_WAITER_CAP = 256;
/** Max stored response length in UTF-16 code units (≈ chars; multibyte chars are
 *  a few bytes each). Longer is truncated with `truncated:true`. Bounds per-event
 *  memory; total feed memory is this × IDLE_RING_CAP. */
export const IDLE_RESPONSE_CAP = 64 * 1024;

export interface IdleEvent {
  seq: number;
  sessionId: string;
  idleAt: string;
  response: string;
  truncated: boolean;
  kind: string;
  correlationId?: string;
}

export interface IdleReadResult {
  cursor: number;
  events: IdleEvent[];
  reset: boolean;
}

export interface IdleReadOptions {
  /** Return events with seq > after. Absent ⇒ start at head (future only). */
  after?: number;
  /** Filter to one session (events AND waiter wake). */
  session?: string;
  /** Long-poll hold in ms (0 ⇒ immediate). Capped at IDLE_WAIT_CAP_MS. */
  wait?: number;
  /** Abort the long-poll early (client disconnect) — resolves with the current scan. */
  signal?: AbortSignal;
}

interface Waiter {
  after: number;
  session?: string;
  resolve: (r: IdleReadResult) => void;
  timer: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
  signal?: AbortSignal;
}

export class IdleFeed {
  private ring: IdleEvent[] = [];
  private head = 0;
  private lastSeq = new Map<string, number>();
  private waiters = new Set<Waiter>();

  /** Append one idle event; assigns the next global seq and wakes matching waiters. */
  append(sessionId: string, response: string, kind: string, correlationId?: string): IdleEvent {
    const seq = ++this.head;
    this.lastSeq.set(sessionId, seq);
    const truncated = response.length > IDLE_RESPONSE_CAP;
    const event: IdleEvent = {
      seq,
      sessionId,
      idleAt: new Date().toISOString(),
      response: truncated ? response.slice(0, IDLE_RESPONSE_CAP) : response,
      truncated,
      kind,
      ...(correlationId ? { correlationId } : {}),
    };
    this.ring.push(event);
    if (this.ring.length > IDLE_RING_CAP) this.ring.shift();

    for (const w of [...this.waiters]) {
      if (!w.session || w.session === sessionId) this.settle(w);
    }
    return event;
  }

  /** Read events since `after`, optionally long-polling. */
  read(opts: IdleReadOptions): Promise<IdleReadResult> {
    const after = opts.after ?? this.head;
    const session = opts.session;
    const immediate = this.scan(after, session);
    const wait = Math.min(opts.wait ?? 0, IDLE_WAIT_CAP_MS);

    if (immediate.events.length > 0 || immediate.reset || wait <= 0 || this.waiters.size >= IDLE_WAITER_CAP) {
      return Promise.resolve(immediate);
    }

    return new Promise<IdleReadResult>((resolve) => {
      const waiter: Waiter = {
        after,
        session,
        resolve,
        timer: setTimeout(() => this.settle(waiter), wait),
        signal: opts.signal,
      };
      if (opts.signal) {
        waiter.onAbort = () => this.settle(waiter);
        opts.signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.add(waiter);
      // Non-miss re-check: an append that landed between the scan above and this
      // insertion is caught here, so the boundary event can't be lost.
      const recheck = this.scan(after, session);
      if (recheck.events.length > 0 || recheck.reset) this.settle(waiter);
    });
  }

  /** Resolve a parked waiter with a fresh scan (from an append match, timeout, or abort). */
  private settle(waiter: Waiter): void {
    if (!this.waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
    waiter.resolve(this.scan(waiter.after, waiter.session));
  }

  /** Compute the events since `after` (+ filter) and the reset flag. */
  private scan(after: number, session?: string): IdleReadResult {
    const events = this.ring.filter(
      (e) => e.seq > after && (session === undefined || e.sessionId === session),
    );
    const oldestRetained = this.ring.length > 0 ? this.ring[0].seq : this.head + 1;
    const stale = after > this.head;
    const evictedGap = after + 1 < oldestRetained;
    const reset = session === undefined
      ? stale || evictedGap
      // Filtered: only a gap the reader could have missed for ITS session counts.
      : stale || (evictedGap && (this.lastSeq.get(session) ?? 0) > after);
    return { cursor: this.head, events, reset };
  }

  /** Drop a deleted session's `lastSeq` bookkeeping (wired to session delete), so
   *  the map stays bounded by live sessions rather than lifetime session count —
   *  which matters on a persistent host churning ephemeral sessions (Ralph loops).
   *  Retained ring events for the session age out naturally. */
  remove(sessionId: string): void {
    this.lastSeq.delete(sessionId);
  }

  /** Test seam: clear all state. */
  _resetForTest(): void {
    for (const w of this.waiters) clearTimeout(w.timer);
    this.waiters.clear();
    this.ring = [];
    this.head = 0;
    this.lastSeq.clear();
  }
}

export const idleFeed = new IdleFeed();
