/**
 * Transient turn retry (spec-transient-retry).
 *
 * After sleep or power-on the network is often not up yet, and the SDK fails the
 * turn before the model runs ("Unable to discover model capabilities ... network
 * ... timed out"). The user's message is already in the transcript, so a retry
 * does not resend it: it sends a short system continuation, with progressive
 * backoff and jitter, and only while nothing else has happened in the session.
 */

export const TRANSIENT_RETRY_MAX = 6;
export const TRANSIENT_RETRY_BASE_MS = 15_000;
export const TRANSIENT_RETRY_IDENTIFIER = 'retry';
export const TRANSIENT_RETRY_PROMPT =
  'The previous turn failed before you responded because the network was not ready. Continue with the previous request.';

/**
 * Whether an error message describes a connectivity failure worth retrying.
 * Matches on the text only to classify it; callers must not log the message.
 */
export function isTransientTurnError(message: unknown): boolean {
  if (typeof message !== 'string') return false;
  return /\b(network|timed? ?out|timeout|connectivity|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|fetch failed|getaddrinfo|502|503|504)\b/i.test(message);
}

/** Whether an error says the SDK client has no usable credentials. Only a
 *  fresh client re-reads them, so these trigger a client restart. */
export function isClientAuthError(message: unknown): boolean {
  if (typeof message !== 'string') return false;
  return /No GitHub OAuth token|Copilot HMAC key|\b401\b|Unauthorized|not authenticated/i.test(message);
}

/** Delay before retry `attempt` (1-based): base * 2^(attempt-1), +/-20% jitter.
 *  15s, 30s, 60s, 2m, 4m, 8m: about 16 minutes in all. */
export function transientRetryDelayMs(attempt: number, random: () => number = Math.random): number {
  const raw = TRANSIENT_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1);
  return Math.round(raw * (0.8 + 0.4 * random()));
}

/** Event types that mean the model actually produced something this turn; after
 *  one of these a failure is not retried (the work may be half done). */
export function isModelOutputEvent(type: string): boolean {
  if (type.startsWith('tool.')) return true;
  if (!type.startsWith('assistant.')) return false;
  return type !== 'assistant.turn_start' && type !== 'assistant.turn_end' && type !== 'assistant.usage';
}

type Timer = ReturnType<typeof setTimeout>;
const pending = new Map<string, Timer>();
/** The attempt number of each pending retry (read by the session overview). */
const pendingAttempt = new Map<string, number>();

/** Schedule one retry for a session, replacing any already pending. */
export function scheduleTransientRetry(sessionId: string, delayMs: number, run: () => void, attempt?: number): void {
  cancelTransientRetry(sessionId);
  const t = setTimeout(() => { pending.delete(sessionId); pendingAttempt.delete(sessionId); run(); }, delayMs);
  t.unref?.();
  pending.set(sessionId, t);
  if (attempt !== undefined) pendingAttempt.set(sessionId, attempt);
}

/** Drop a pending retry. True if one was pending. */
export function cancelTransientRetry(sessionId: string): boolean {
  const t = pending.get(sessionId);
  if (!t) return false;
  clearTimeout(t);
  pending.delete(sessionId);
  pendingAttempt.delete(sessionId);
  return true;
}

export function hasPendingTransientRetry(sessionId: string): boolean {
  return pending.has(sessionId);
}

/** The attempt number of a pending retry, or undefined when none is pending
 *  (0 when one is pending but was scheduled without an attempt number). */
export function pendingTransientRetryAttempt(sessionId: string): number | undefined {
  return pending.has(sessionId) ? (pendingAttempt.get(sessionId) ?? 0) : undefined;
}
