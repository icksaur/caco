/**
 * Per-session token-usage cache from the SDK's `session.usage_info` events.
 * Kept in its own leaf module so the session runtime can clear it on session
 * exit without importing the websocket route.
 *
 * Beyond tokenLimit/currentTokens, retains the context-window BREAKDOWN
 * (toolDefinitionsTokens / systemTokens / conversationTokens) — `toolDefinitionsTokens`
 * EXCLUDES deferred tools, so it is the live proof that deferral shrinks the tool
 * block (spec-tool-reveal B0). These were previously arriving on the event and being
 * dropped.
 */

export interface SessionUsage {
  tokenLimit: number;
  currentTokens: number;
  /** Tool-definition tokens sent to the model this turn (EXCLUDES deferred tools). */
  toolDefinitionsTokens?: number;
  systemTokens?: number;
  conversationTokens?: number;
}

const usageBySession = new Map<string, SessionUsage>();

/** Pure: build a SessionUsage from a `session.usage_info` event's data, or null if
 *  the required tokenLimit/currentTokens are absent. Retains the optional breakdown
 *  fields only when present (never fabricates a zero). The single capture point, so
 *  the websocket route stays a thin caller. */
export function extractSessionUsage(data: unknown): SessionUsage | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as {
    tokenLimit?: number; currentTokens?: number;
    toolDefinitionsTokens?: number; systemTokens?: number; conversationTokens?: number;
  };
  if (!d.tokenLimit || !d.currentTokens) return null;
  const usage: SessionUsage = { tokenLimit: d.tokenLimit, currentTokens: d.currentTokens };
  if (typeof d.toolDefinitionsTokens === 'number') usage.toolDefinitionsTokens = d.toolDefinitionsTokens;
  if (typeof d.systemTokens === 'number') usage.systemTokens = d.systemTokens;
  if (typeof d.conversationTokens === 'number') usage.conversationTokens = d.conversationTokens;
  return usage;
}

export function setSessionUsage(sessionId: string, usage: SessionUsage): void {
  usageBySession.set(sessionId, usage);
}

export function getSessionUsage(sessionId: string): SessionUsage | undefined {
  return usageBySession.get(sessionId);
}

export function clearSessionUsage(sessionId: string): void {
  usageBySession.delete(sessionId);
}
