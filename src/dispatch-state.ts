/**
 * DispatchState - Tracks active dispatches and their context
 * 
 * Consolidates busy tracking and correlation context into one source of truth.
 * A session is "dispatching" when actively processing a message from the SDK.
 * 
 * Extends EventEmitter: emits 'idle' when a dispatch ends, enabling
 * event-driven completion detection in swarm/delegate tools.
 */

import { EventEmitter } from 'events';
import { createWatchdog } from './dispatch-watchdog.js';

export interface ActiveDispatch {
  correlationId: string;
  startedAt: number;
}

/** Options for an activity-aware wait. */
export interface WaitForActiveOptions {
  /** Resolve 'timeout' after this long with no activity from the session (resets on each event). */
  idleTimeoutMs: number;
  /** Resolve 'timeout' after this long total regardless of activity — caller-side backstop. */
  maxTotalMs: number;
  /** Optional liveness probe; when it returns true the wait resolves 'gone'. */
  isGone?: () => boolean;
  /** How often to poll isGone (default 10s). */
  gonePollMs?: number;
  /**
   * Optional idle-suppression predicate (spec-idle-authority): while it returns
   * true, an idle is NOT a real idle (the session is about to auto-continue), so
   * NONE of the idle-resolution paths resolve. Gates the entry fast-path, the
   * post-arm re-check, AND the `idle` listener, so a reveal-dispatch that ends
   * before/after the listener attaches cannot resolve the wait early. Resolves
   * only once the session reaches a real idle (predicate false).
   */
  suppressIdle?: () => boolean;
}

export class DispatchState extends EventEmitter {
  private dispatches = new Map<string, ActiveDispatch>();

  constructor() {
    super();
    // Each waitForActive adds an 'activity' + 'idle' listener; many concurrent
    // delegate waits would trip the default 10-listener warning. Unbounded is
    // safe here — listeners are always removed on resolution.
    this.setMaxListeners(0);
  }

  start(sessionId: string, correlationId: string): void {
    if (this.dispatches.has(sessionId)) {
      throw new Error(`Session ${sessionId} is already dispatching`);
    }
    this.dispatches.set(sessionId, {
      correlationId,
      startedAt: Date.now()
    });
  }

  end(sessionId: string): void {
    this.dispatches.delete(sessionId);
    this.emit('idle', sessionId);
  }

  /** Signal that a session emitted an SDK event — resets activity-aware waits. */
  notifyActivity(sessionId: string, eventType: string): void {
    this.emit('activity', { sessionId, eventType });
  }

  isBusy(sessionId: string): boolean {
    return this.dispatches.has(sessionId);
  }

  getActiveCount(): number {
    return this.dispatches.size;
  }

  getCorrelationId(sessionId: string): string | undefined {
    return this.dispatches.get(sessionId)?.correlationId;
  }

  getDispatch(sessionId: string): ActiveDispatch | undefined {
    return this.dispatches.get(sessionId);
  }

  getAllActive(): Map<string, ActiveDispatch> {
    return new Map(this.dispatches);
  }

  waitForIdle(sessionId: string, timeoutMs: number): Promise<'idle' | 'timeout'> {
    return new Promise((resolve) => {
      if (!this.isBusy(sessionId)) { resolve('idle'); return; }

      let resolved = false;
      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        this.removeListener('idle', onIdle);
      };

      const timer = setTimeout(() => { cleanup(); resolve('timeout'); }, timeoutMs);

      const onIdle = (id: string) => {
        if (id !== sessionId) return;
        cleanup();
        resolve('idle');
      };

      this.on('idle', onIdle);
      if (!this.isBusy(sessionId)) { cleanup(); resolve('idle'); }
    });
  }

  /**
   * Wait for a session's dispatch to finish, bounded by an *inactivity* gap
   * (reset by each `notifyActivity` for the session) rather than a flat deadline,
   * plus a non-resetting absolute cap as a caller-side backstop. The idle gap
   * reuses createWatchdog, so a long-running tool pauses it exactly as an
   * interactive dispatch does — a delegate that is genuinely working never
   * false-times-out. Resolves 'idle' when the dispatch ends, 'gone' when isGone
   * trips, or 'timeout' on either the idle gap or the absolute cap.
   */
  waitForActive(sessionId: string, opts: WaitForActiveOptions): Promise<'idle' | 'timeout' | 'gone'> {
    return new Promise((resolve) => {
      if (opts.isGone?.()) { resolve('gone'); return; }
      // Entry fast-path: only treat a not-busy session as idle if a continuation
      // is NOT pending (spec-idle-authority — else keep waiting for the real idle).
      if (!this.isBusy(sessionId) && !opts.suppressIdle?.()) { resolve('idle'); return; }

      let settled = false;
      const finish = (outcome: 'idle' | 'timeout' | 'gone') => {
        if (settled) return;
        settled = true;
        watchdog.cancel();
        clearTimeout(absoluteTimer);
        if (goneTimer) clearInterval(goneTimer);
        this.removeListener('activity', onActivity);
        this.removeListener('idle', onIdle);
        resolve(outcome);
      };

      const watchdog = createWatchdog({
        initialTimeoutMs: opts.idleTimeoutMs,
        betweenEventTimeoutMs: opts.idleTimeoutMs,
        longRunningTimeoutMs: opts.idleTimeoutMs,
        onTimeout: () => finish('timeout'),
      });

      const absoluteTimer = setTimeout(() => finish('timeout'), opts.maxTotalMs);

      const goneTimer = opts.isGone
        ? setInterval(() => { if (opts.isGone!()) finish('gone'); }, opts.gonePollMs ?? 10_000)
        : undefined;

      const onActivity = (e: { sessionId: string; eventType: string }) => {
        if (e.sessionId === sessionId) watchdog.notifyEvent(e.eventType);
      };
      // Listener: a suppressed idle (pending continuation) is ignored — stay armed
      // until the continuation reaches a real idle and emits again.
      const onIdle = (id: string) => { if (id === sessionId && !opts.suppressIdle?.()) finish('idle'); };

      this.on('activity', onActivity);
      this.on('idle', onIdle);
      // Post-arm re-check: same suppression gate as the entry fast-path.
      if (!this.isBusy(sessionId) && !opts.suppressIdle?.()) finish('idle');
    });
  }
}

export const dispatchState = new DispatchState();
