/**
 * Retry policy for SDK dispatch failures.
 *
 * Two error paths into here:
 *   1. Watchdog timeout before the first event arrived — SDK connection may
 *      be stale; drop and re-resume.
 *   2. send() rejected with "Session not found" — SDK lost the session;
 *      drop and re-resume.
 *
 * Both paths take the same recovery action: drop the stale session, refresh
 * the client, resume, re-subscribe, re-send. Awaiting the new send is
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
  dropStaleSession: (sessionId: string) => void;
  ensureClientHealthy: () => Promise<void>;
  resume: () => Promise<void>;
  getSession: (sessionId: string) => unknown | null;
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

  deps.unsubscribe();
  try {
    deps.dropStaleSession(deps.sessionId);
    await deps.ensureClientHealthy();
    await deps.resume();

    const retrySession = deps.getSession(deps.sessionId);
    if (!retrySession) throw new Error('No session after retry');

    const newUnsubscribe = (retrySession as Subscribable).on(deps.handleEvent);
    await (retrySession as Sendable).send(deps.messageOptions);
    deps.resetWatchdog();
    return newUnsubscribe;
  } catch {
    return null;
  }
}
