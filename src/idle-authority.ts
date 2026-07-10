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
  /** Drive the auto-continue runtime: fires a continuation, or (at cap) emits the
   *  terminal cap message, or no-ops. */
  runAutoContinue(sessionId: string): Promise<void>;
  /** Real-idle effect: mark the session unobserved (already gated by caller on
   *  needsObservation being honored here). */
  markIdle(sessionId: string): void;
  /** Real-idle effect: the herd hook (parent wake / own-herd re-eval). */
  herdOnSessionIdle(sessionId: string): void;
  /** Real-idle effect: refresh quota. */
  pollQuota(): void;
}

/**
 * Classify and handle one `session.idle`. Order:
 *  1. Capture `willFire` BEFORE driving the continuation (the fire path clears
 *     the pending set).
 *  2. If ANY tools are pending, drive the auto-continue runtime — this fires the
 *     continuation, OR at cap emits the terminal cap message. Driving it whenever
 *     pending>0 is what guarantees the cap message never drops silently.
 *  3. If `willFire` ⇒ FALSE idle: return now. Suppress every real-idle effect;
 *     the session is logically still busy until the continuation reaches a real
 *     idle with nothing pending.
 *  4. Otherwise ⇒ REAL idle (nothing pending, capped, or pref-off): run the
 *     real-idle effects — markIdle (if needsObservation), herd hook, pollQuota.
 */
export async function handleSessionIdle(
  sessionId: string,
  ctx: IdleAuthorityCtx,
  deps: IdleAuthorityDeps,
): Promise<void> {
  const willFire = deps.hasPendingAutoContinue(sessionId);

  if (deps.pendingToolCount(sessionId) > 0) {
    await deps.runAutoContinue(sessionId);
  }

  if (willFire) return; // false idle — inert to completion signals

  // Real idle: propagate to the completion consumers exactly as before.
  if (ctx.needsObservation) deps.markIdle(sessionId);
  deps.herdOnSessionIdle(sessionId);
  deps.pollQuota();
}
