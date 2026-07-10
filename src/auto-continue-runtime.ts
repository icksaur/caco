/**
 * Auto-continuation runtime (spec-enable-tools-autocontinue).
 *
 * Impure glue between the `session.idle` seam and a fresh continuation dispatch.
 * When a dispatch revealed tools via `caco_enable_tools`, the SDK's frozen
 * per-dispatch tool array means those tools are only usable in the NEXT dispatch.
 * On idle we therefore (idempotently) re-assert the reveal and auto-send ONE
 * `[system:autocontinue]` follow-up so the agent continues its task with the
 * tools present.
 *
 * All external effects are injected (`AutoContinueDeps`) so the decision +
 * fire/reset/cap flow is unit-testable without the SDK, and a per-session
 * trailing-edge chain coalesces multiple idle evaluations into one.
 */

import { decideAutoContinue, AUTO_CONTINUE_CAP } from './auto-continue.js';

/** Identifier used on the continuation's `[system:<id>]` prefix — drives the
 *  purple rendering, distinct from generic `[system:herd]`. */
export const AUTOCONTINUE_IDENTIFIER = 'autocontinue';

export interface AutoContinueDeps {
  /** Tools awaiting a continuation for this session (empty ⇒ nothing pending). */
  getPendingTools(sessionId: string): string[];
  /** Consecutive auto-continuations already fired. */
  getAttempts(sessionId: string): number;
  /** Whether the session is currently processing another dispatch. */
  isBusy(sessionId: string): boolean;
  /** Idempotently re-apply the reveal so the tools are live for the continuation
   *  dispatch even if a resume reseeded excludedTools in between. */
  reassert(sessionId: string, tools: string[]): Promise<void>;
  /** Clear the pending-continuation tool set (counter is untouched). */
  clearPendingTools(sessionId: string): void;
  /** Mark a continuation as being SET UP (spec-idle-suppression-central): held from
   *  before clearPendingTools until the continuation dispatch has registered (or the
   *  fire failed), so the restart gate keeps deferring across the sub-window where
   *  the pending set is already cleared but startDispatch has not yet run. */
  markContinuing(sessionId: string): void;
  /** Release the set-up marker (paired with markContinuing, in a finally). */
  clearContinuing(sessionId: string): void;
  /** Increment the consecutive-continuation counter. */
  bumpAttempts(sessionId: string): void;
  /** Start a fresh continuation dispatch carrying the given (already-prefixed)
   *  system prompt. */
  dispatch(sessionId: string, prompt: string): Promise<void>;
  /** Emit a one-off system message (used for the terminal cap-reached notice). */
  emitSystem(sessionId: string, text: string): void;
  /** Whether auto-continuation is enabled (operator preference). */
  enabled(): boolean;
  /** Cap on consecutive auto-continuations. */
  cap: number;
}

/** The continuation prompt the agent receives — names the now-available tools. */
export function buildContinuationPrompt(tools: string[]): string {
  const list = tools.join(', ');
  return `Enabled tools are now available for this request: ${list}. Continue the task you were working on using them.`;
}

const CAP_MESSAGE =
  'Auto-continue limit reached. Enable the remaining tools and send a message to continue.';

// Per-session trailing-edge chain: many idle evaluations coalesce into one, and
// an idle arriving mid-evaluation re-evaluates once at the tail.
const chains = new Map<string, Promise<unknown>>();

/** Evaluate and, if warranted, fire exactly one auto-continuation for the
 *  session. Serialized per session via the trailing-edge chain. Resolves `true`
 *  iff a continuation dispatch actually STARTED (so a caller — the idle authority
 *  — can fall through to real-idle effects when it did NOT: cap, skip, or a failed
 *  fire that will produce no further idle). */
export function maybeAutoContinue(sessionId: string, deps: AutoContinueDeps): Promise<boolean> {
  const prior = chains.get(sessionId) ?? Promise.resolve();
  // `evaluate` swallows operational errors internally, but guard the chain too so a
  // never-expected throw can't surface as an unhandled rejection on either the
  // stored chain, the cleanup, or the returned promise.
  const run = prior.catch(() => {}).then(() => evaluate(sessionId, deps)).catch(() => false);
  chains.set(sessionId, run);
  void run.finally(() => { if (chains.get(sessionId) === run) chains.delete(sessionId); });
  return run;
}

async function evaluate(sessionId: string, deps: AutoContinueDeps): Promise<boolean> {
  if (!deps.enabled()) return false;
  const decision = decideAutoContinue({
    hasPending: deps.getPendingTools(sessionId).length > 0,
    busy: deps.isBusy(sessionId),
    attempts: deps.getAttempts(sessionId),
    cap: deps.cap,
  });
  if (decision === 'skip') return false;
  if (decision === 'cap-reached') {
    deps.emitSystem(sessionId, CAP_MESSAGE);
    return false;
  }
  // fire: re-assert the reveal, consume the pending set, count the attempt, then
  // start a fresh dispatch where the tools are present. The re-assert and dispatch
  // can reject — most notably a 409 SESSION_BUSY if a concurrent human/agent
  // dispatch lands during the `reassert` await (a benign TOCTOU: that dispatch
  // already reset our budget), or a send failure if the session was evicted. Such
  // failures must NEVER escape as an unhandled rejection (there is no global
  // handler; it could crash the server), so we swallow them here — the operator can
  // always re-prompt, and a concurrent dispatch supersedes us anyway. On failure we
  // return `false` so the idle authority runs the real-idle effects (herd wake /
  // delegate completion / unobserved) that would otherwise never fire, since no
  // continuation dispatch means no further session.idle for this turn.
  const tools = deps.getPendingTools(sessionId);
  // Mark BEFORE clearing pending (both synchronous, no await between): from here the
  // restart gate sees an in-flight continuation, closing the window between the
  // pending set being cleared and startDispatch registering the new dispatch — where
  // active count is 0 AND nothing is pending, so an immediate checkAndRestart would
  // otherwise slip through and kill the not-yet-started continuation
  // (spec-idle-suppression-central).
  deps.markContinuing(sessionId);
  deps.clearPendingTools(sessionId);
  deps.bumpAttempts(sessionId);
  try {
    await deps.reassert(sessionId, tools);
    await deps.dispatch(sessionId, buildContinuationPrompt(tools));
    return true;
  } catch (e) {
    console.warn(`[AUTOCONTINUE] continuation for ${sessionId.slice(0, 8)} did not start: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  } finally {
    // By now startDispatch has run (active>0 covers the running continuation) or the
    // fire failed — either way the set-up marker is no longer needed.
    deps.clearContinuing(sessionId);
  }
}

/** Test seam: reset the per-session chains. */
export function _resetAutoContinueChains(): void {
  chains.clear();
}

export { AUTO_CONTINUE_CAP, CAP_MESSAGE };
