/**
 * Retry policy for SDK dispatch failures.
 *
 * Two error paths into here:
 *   1. Watchdog timeout before the first event arrived — SDK connection may
 *      be stale; drop and re-resume.
 *   2. send() rejected with "Session not found" — SDK lost the session;
 *      drop and re-resume.
 *
 * Both paths take the same recovery action: abort the original generation, drop
 * the stale session, refresh the client, resume, re-subscribe, re-send. Aborting
 * the original first is what prevents the dual-writer contamination of
 * events.jsonl (original + retry both persisting) that doubles a cold session's
 * transcript. Awaiting the new send is
 * acceptable: it produces the same observable behavior as the original
 * fire-and-forget path (events stream from the new subscription either way),
 * and the await catches resume-failure as a thrown error instead of an
 * unhandled rejection.
 */

import type { SessionEvent } from './event-bus.js';

export interface RetryDeps {
  sessionId: string;
  messageOptions: { prompt: string; attachments?: Array<{ type: string; path: string }> };
  handleEvent: (event: SessionEvent) => void;
  // Hooks into the dispatch-state runtime (kept as a struct to avoid pulling
  // in session-manager directly here; tests can pass mocks).
  /** Best-effort abort of the ORIGINAL SDK generation before it is dropped. A cold
   *  session that merely stalled (no first event in 45s) may still be running and
   *  writing to events.jsonl; if we resume+resend without stopping it, both the
   *  original and the retry persist to the same file and every later replay renders
   *  doubled. Returns true when it is safe to resend (original stopped or absent),
   *  false when a live original could not be confirmed stopped — in which case the
   *  retry must NOT resend (leave the single original writer). */
  abortOriginal?: () => Promise<boolean>;
  /** Whether the dispatch has already completed (the original finished on its own
   *  during the abort/resume awaits). When true, the retry bails without resending
   *  — the original already produced and persisted the response. */
  isCompleted?: () => boolean;
  dropStaleSession: (sessionId: string) => void;
  ensureClientHealthy: () => Promise<void>;
  resume: () => Promise<void>;
  getSession: (sessionId: string) => unknown | null;
  beforeSend?: () => Promise<void>;
  // Side effects we don't own but need to trigger.
  resetWatchdog: () => void;
  unsubscribe: () => void;
}

/**
 * Retry the dispatch with a freshly-resumed session. Returns the new
 * unsubscribe handle on success, or null on failure (caller should
 * complete the dispatch with an error).
 */
export async function retryWithFreshClient(deps: RetryDeps): Promise<(() => void) | null> {
  type Subscribable = { on: (cb: (event: SessionEvent) => void) => () => void };
  type Sendable = { send: (opts: Record<string, unknown>) => Promise<unknown> };

  // Stop the original generation before dropping it, so it cannot keep writing a
  // second copy of the response to events.jsonl (the dual-writer contamination
  // behind cold-session doubled transcripts). Only resend if we actually stopped
  // it (or it was absent): a second writer is worse than a failed retry.
  let safeToResend = true;
  if (deps.abortOriginal) {
    try {
      safeToResend = await deps.abortOriginal();
    } catch {
      safeToResend = false;
    }
  }
  // The original may have completed on its own during the abort await; if so, it
  // already persisted its response — do not resend a duplicate background turn.
  if (deps.isCompleted?.()) return null;
  // Could not confirm the original stopped: bail rather than add a second writer.
  if (!safeToResend) return null;

  deps.unsubscribe();
  let newUnsubscribe: (() => void) | null = null;
  try {
    deps.dropStaleSession(deps.sessionId);
    await deps.ensureClientHealthy();
    await deps.resume();
    // A late completion of the original during resume also forecloses the resend.
    if (deps.isCompleted?.()) return null;

    const retrySession = deps.getSession(deps.sessionId);
    if (!retrySession) throw new Error('No session after retry');

    newUnsubscribe = (retrySession as Subscribable).on(deps.handleEvent);
    if (deps.beforeSend) await deps.beforeSend();
    await (retrySession as Sendable).send(deps.messageOptions);
    deps.resetWatchdog();
    return newUnsubscribe;
  } catch {
    // If we subscribed before failing (beforeSend/send threw), tear the
    // listener down — otherwise it leaks and keeps streaming events into an
    // already error-completed dispatch.
    if (newUnsubscribe) newUnsubscribe();
    return null;
  }
}
