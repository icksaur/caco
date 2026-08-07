/**
 * Idle authority (spec-idle-authority).
 *
 * The single seam that classifies a session's `session.idle` and dispatches its
 * effects, so a `caco_enable_tools` reveal-idle (which will auto-continue in a
 * fresh dispatch) is treated as a FALSE idle and never leaks into herd-wake,
 * delegate-completion, or unobserved-marking. All external effects are injected
 * so the classification is unit-testable in isolation.
 */

export interface IdleAuthorityCtx {
  /** Whether this dispatch's idle should mark the session unobserved
   *  (false for agent/system/applet-sourced dispatches). */
  needsObservation: boolean;
}

export interface IdleAuthorityDeps {
  /** The single source of truth: a continuation WILL fire on this idle. */
  hasPendingAutoContinue(sessionId: string): boolean;
  /** Number of tools pending a continuation (drives the cap-message path even
   *  when hasPendingAutoContinue is false at cap). */
  pendingToolCount(sessionId: string): number;
  /** Drive the auto-continue runtime: fires a continuation and resolves `true`
   *  iff a continuation dispatch actually STARTED; `false` at cap / skip / a
   *  failed fire (so the authority runs real-idle effects instead). */
  runAutoContinue(sessionId: string): Promise<boolean>;
  /** Real-idle effect: mark the session unobserved (already gated by caller on
   *  needsObservation being honored here). */
  markIdle(sessionId: string): void;
  /** Real-idle effect: the herd hook (parent wake / own-herd re-eval). Runs for
   *  EVERY real idle, attended or not — which is why it must NOT decide
   *  observation: its `lastIdleAt` stamp is a coldness signal, and the observation
   *  verdict is persisted by `markIdle` above (spec-observation-authority). */
  herdOnSessionIdle(sessionId: string): void;
  /** Real-idle effect: refresh quota. */
  pollQuota(): void;
  /** Real-idle effect: publish the idle to the external idle feed (spec-idle-
   *  notifications). Gated on needsObservation exactly like markIdle, so herd
   *  children / delegates / auto-continuations never reach it. */
  notifyExternalIdle(sessionId: string): void;
  /** Force-emit the dispatch-level idle (dispatchState.signalIdle) when a
   *  continuation was expected — so end() suppressed its idle emit — but failed to
   *  start. Without this the dispatch-emit consumers (waitForActive, waitForIdle,
   *  restart-manager) would never see an idle for this turn
   *  (spec-idle-suppression-central). */
  signalDispatchIdle(sessionId: string): void;
}

/**
 * Classify and handle one `session.idle`. Order:
 *  1. Capture `willFire` BEFORE driving the continuation (the fire path clears
 *     the pending set).
 *  2. If ANY tools are pending, drive the auto-continue runtime — this fires the
 *     continuation, OR at cap emits the terminal cap message. It resolves whether
 *     a continuation dispatch actually STARTED.
 *  3. FALSE idle ONLY when a continuation genuinely started (`willFire` AND
 *     started): return now, suppressing every real-idle effect; the session is
 *     logically still busy until the continuation's own real idle. If a
 *     continuation was expected but did NOT start (cap, pref-off, or a failed
 *     fire that yields no further idle), fall through — otherwise herd-wake /
 *     delegate-completion / unobserved would be dropped forever for this turn.
 *  4. REAL idle: run the real-idle effects — markIdle (if needsObservation),
 *     herd hook, pollQuota.
 */
export async function handleSessionIdle(
  sessionId: string,
  ctx: IdleAuthorityCtx,
  deps: IdleAuthorityDeps,
): Promise<void> {
  const willFire = deps.hasPendingAutoContinue(sessionId);

  let started = false;
  if (deps.pendingToolCount(sessionId) > 0) {
    started = await deps.runAutoContinue(sessionId);
  }

  if (willFire && started) return; // false idle — a continuation is genuinely running

  // Real idle (nothing pending, capped, pref-off, OR a fire that failed to start):
  // propagate to the completion consumers exactly as before.
  // When willFire was true, end() suppressed the dispatch-idle emit expecting a
  // continuation; since it did NOT start, replace that suppressed emit so the
  // dispatch-emit consumers aren't stranded (spec-idle-suppression-central).
  if (willFire && !started) deps.signalDispatchIdle(sessionId);
  if (ctx.needsObservation) {
    deps.markIdle(sessionId);
    deps.notifyExternalIdle(sessionId);
  }
  deps.herdOnSessionIdle(sessionId);
  deps.pollQuota();
}
