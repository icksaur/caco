/**
 * Shared session-history read helpers.
 *
 * `getLastAssistantMessage` was private to delegate-tool.ts; it is lifted here so
 * both caco_session_delegate and the herd tools (caco_herd_state) return a
 * session's last response through ONE implementation (spec-session-orchestration
 * §Design, Plan A2). The history provider is injected (defaulting to
 * sessionManager.getHistory) so the scan is unit-testable without a live session.
 */

import { sessionManager } from './session-manager.js';
import type { SessionEvent } from './types.js';

export type HistoryProvider = (sessionId: string) => Promise<SessionEvent[]>;

/** The content of a session's most recent `assistant.message`, or a sentinel
 *  string when there is none / history is unreadable. Never throws — a failing
 *  provider yields an error sentinel, so a caller collecting many sessions'
 *  results is never derailed by one bad read. */
export async function getLastAssistantMessage(
  sessionId: string,
  getHistory: HistoryProvider = (id) => sessionManager.getHistory(id),
): Promise<string> {
  try {
    const events = await getHistory(sessionId);
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'assistant.message') {
        const content = events[i].data?.content;
        if (typeof content === 'string') return content;
      }
    }
    return '(no assistant response found)';
  } catch (e) {
    return `(error reading history: ${e instanceof Error ? e.message : e})`;
  }
}
