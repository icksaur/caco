/**
 * DispatchState - Tracks active dispatches and their context
 * 
 * Consolidates busy tracking and correlation context into one source of truth.
 * A session is "dispatching" when actively processing a message from the SDK.
 * 
 * Extends EventEmitter: emits 'idle' when a dispatch ends, enabling
 * event-driven completion detection in the delegate tool.
 */

import { EventEmitter } from 'events';
import { createWatchdog } from './dispatch-watchdog.js';
import { activityVersion } from './activity-version.js';

export interface ActiveDispatch extends DispatchLineage {
  correlationId: string;
  startedAt: number;
}

/**
 * What a dispatch carries forward to a continuation of the same turn (auto-continue,
 * transient retry) and, for depth and peerOrigin, to the agent calls it makes.
 * Carried as one record so no carrier can copy one field without the others.
 *  - depth: server-derived hop count (spec-herd-depth-breadth). A root entry is 1,
 *    an agent call is the caller's depth + 1.
 *  - peerOrigin: the turn's root came from another Caco instance; such a turn may
 *    not reach other instances (spec-peer-session-tools).
 *  - turnId: the root's correlation id, kept across continuations, so a peer
 *    delegate can tell when the turn it started has finished.
 */
export interface DispatchLineage {
  depth: number;
  peerOrigin: boolean;
  turnId: string;
}

export interface TurnState {
  active: string | null;
  lastCompleted: string | null;
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
}

export class DispatchState extends EventEmitter {
  private dispatches = new Map<string, ActiveDispatch>();
  /** turnId of the last dispatch that ended in a real idle, per session. */
  private lastCompleted = new Map<string, string>();
  /** turnId of a dispatch whose idle was suppressed for an imminent continuation;
   *  promoted to lastCompleted if the continuation never starts (signalIdle). */
  private suppressedTurn = new Map<string, string>();

  // Injected idle suppressor (spec-idle-suppression-central): returns true when a
  // session is about to auto-continue (a caco_enable_tools reveal-idle), so this
  // idle must NOT be signalled to dispatch-emit consumers (waitForActive,
  // waitForIdle, restart-manager). Injected — dispatch-state imports no
  // SessionManager (layering). The single dispatch-emit-side consumption of the
  // reveal-continuation predicate.
  private idleSuppressor: ((sessionId: string) => boolean) | null = null;

  constructor() {
    super();
    // Each waitForActive adds an 'activity' + 'idle' listener; many concurrent
    // delegate waits would trip the default 10-listener warning. Unbounded is
    // safe here — listeners are always removed on resolution.
    this.setMaxListeners(0);
  }

  /** Wire the idle-suppression predicate (once, at startup). */
  setIdleSuppressor(fn: (sessionId: string) => boolean): void {
    this.idleSuppressor = fn;
  }

  /** True when the session is truly idle for completion purposes: no active
   *  dispatch AND not about to auto-continue. The single internal definition every
   *  wait path resolves on. */
  private isEffectivelyIdle(sessionId: string): boolean {
    return !this.isBusy(sessionId) && !this.idleSuppressor?.(sessionId);
  }

  start(sessionId: string, correlationId: string, lineage: Partial<DispatchLineage> = {}): void {
    if (this.dispatches.has(sessionId)) {
      throw new Error(`Session ${sessionId} is already dispatching`);
    }
    this.suppressedTurn.delete(sessionId);
    this.dispatches.set(sessionId, {
      correlationId,
      startedAt: Date.now(),
      depth: lineage.depth ?? 1,
      peerOrigin: lineage.peerOrigin ?? false,
      turnId: lineage.turnId ?? correlationId,
    });
    // Busy/idle transitions change the pager board. Bumped directly rather than
    // via a new event, which would be inert until someone wired a listener
    // (spec-pager). Unconditional: unlike the 'idle' emit below this is a level
    // signal, so suppressing it would hide a real busy change.
    activityVersion.bump();
  }

  end(sessionId: string, opts: { completed?: boolean } = {}): void {
    const ended = this.dispatches.get(sessionId);
    const wasDispatching = this.dispatches.delete(sessionId);
    if (wasDispatching) activityVersion.bump();
    // Only a turn that reached a real session.idle is finished for peers; an
    // error, timeout, cancel or a turn waiting for a network retry is not.
    const finished = opts.completed === true ? ended?.turnId : undefined;
    // Suppress the idle signal when a continuation is imminent: the edge-triggered
    // consumers (waitForActive.onIdle, restart-manager) must not see this idle. A
    // real idle arrives later — from the continuation's own end(), or from
    // signalIdle() if the continuation fails to start (spec-idle-suppression-central).
    if (this.idleSuppressor?.(sessionId)) {
      if (finished) this.suppressedTurn.set(sessionId, finished);
      return;
    }
    if (finished) this.lastCompleted.set(sessionId, finished);
    this.emit('idle', sessionId);
  }

  /** Force-emit a real idle for a session (spec-idle-suppression-central): the
   *  replacement emit when a continuation was expected (end() suppressed) but
   *  failed to start, so no continuation end() will ever fire. Only the idle
   *  authority calls this, on the willFire-but-not-started fallthrough. */
  signalIdle(sessionId: string): void {
    const turn = this.suppressedTurn.get(sessionId);
    if (turn !== undefined) {
      this.suppressedTurn.delete(sessionId);
      this.lastCompleted.set(sessionId, turn);
    }
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

  /** The hop-count depth of the session's active dispatch, or undefined if none.
   *  A caller must be busy (mid-tool-call) for this to be defined — which is what
   *  the route relies on to derive an agent call's depth (spec-herd-depth-breadth). */
  getDepth(sessionId: string): number | undefined {
    return this.dispatches.get(sessionId)?.depth;
  }

  /** The active dispatch's lineage, or undefined when idle. */
  getLineage(sessionId: string): DispatchLineage | undefined {
    const d = this.dispatches.get(sessionId);
    return d ? { depth: d.depth, peerOrigin: d.peerOrigin, turnId: d.turnId } : undefined;
  }

  /** The running turn and the last finished turn (in memory only). */
  getTurn(sessionId: string): TurnState {
    return {
      active: this.dispatches.get(sessionId)?.turnId ?? null,
      lastCompleted: this.lastCompleted.get(sessionId) ?? null,
    };
  }

  getDispatch(sessionId: string): ActiveDispatch | undefined {
    return this.dispatches.get(sessionId);
  }

  getAllActive(): Map<string, ActiveDispatch> {
    return new Map(this.dispatches);
  }

  waitForIdle(sessionId: string, timeoutMs: number): Promise<'idle' | 'timeout'> {
    return new Promise((resolve) => {
      // Effectively-idle gate (spec-idle-suppression-central): a reveal-idle
      // (pending continuation) is not a real idle — keep waiting.
      if (this.isEffectivelyIdle(sessionId)) { resolve('idle'); return; }

      let resolved = false;
      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        this.removeListener('idle', onIdle);
      };

      const timer = setTimeout(() => { cleanup(); resolve('timeout'); }, timeoutMs);

      const onIdle = (id: string) => {
        if (id !== sessionId || !this.isEffectivelyIdle(sessionId)) return;
        cleanup();
        resolve('idle');
      };

      this.on('idle', onIdle);
      if (this.isEffectivelyIdle(sessionId)) { cleanup(); resolve('idle'); }
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
      // Entry fast-path: resolve only when effectively idle — not busy AND no
      // pending continuation (spec-idle-suppression-central).
      if (this.isEffectivelyIdle(sessionId)) { resolve('idle'); return; }

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
      // Listener: an idle for this session resolves only when effectively idle;
      // a suppressed reveal-idle keeps the wait armed until the real idle.
      const onIdle = (id: string) => { if (id === sessionId && this.isEffectivelyIdle(sessionId)) finish('idle'); };

      this.on('activity', onActivity);
      this.on('idle', onIdle);
      // Post-arm re-check: same effectively-idle gate as the entry fast-path.
      if (this.isEffectivelyIdle(sessionId)) finish('idle');
    });
  }
}

export const dispatchState = new DispatchState();
