import type { SessionIdRef } from './types.js';

/**
 * Placeholder id a freshly-created `SessionIdRef` carries between tool
 * construction and the SDK assigning the real `session.sessionId`. Tools and
 * hooks only read the ref at execution time, by which point it holds the real
 * id — so storing under this sentinel is always a bug.
 */
export const PENDING_SESSION_ID = 'PENDING';

/**
 * Resolve a `SessionIdRef` to a usable session id, or throw. Every consumer that
 * routes runtime state (tool output, embed queue) by session identity must go
 * through this so a premature store fails loudly instead of misrouting.
 */
export function requireSessionId(ref: SessionIdRef): string {
  const id = ref.id;
  if (!id || id === PENDING_SESSION_ID) {
    throw new Error('requireSessionId: session ref has no assigned id yet');
  }
  return id;
}
