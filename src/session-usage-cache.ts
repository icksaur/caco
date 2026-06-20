/**
 * Per-session token-usage cache (tokenLimit / currentTokens from the SDK's
 * `session.usage_info` events). Kept in its own leaf module so the session
 * runtime can clear it on session exit without importing the websocket route.
 */

export interface SessionUsage {
  tokenLimit: number;
  currentTokens: number;
}

const usageBySession = new Map<string, SessionUsage>();

export function setSessionUsage(sessionId: string, usage: SessionUsage): void {
  usageBySession.set(sessionId, usage);
}

export function getSessionUsage(sessionId: string): SessionUsage | undefined {
  return usageBySession.get(sessionId);
}

export function clearSessionUsage(sessionId: string): void {
  usageBySession.delete(sessionId);
}
