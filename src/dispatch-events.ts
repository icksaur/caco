/**
 * Server-side side-effects fired by SDK events during dispatch.
 *
 * Pure-effects layer: intent capture, auto-context, usage tracking,
 * reload signal consumption. Separated from the watchdog and event-routing
 * concerns in dispatchMessage() so each can be reasoned about alone.
 */

import { setSessionIntent } from './session-meta-store.js';
import { updateUsage } from './usage-state.js';
import { shouldEmitReload } from './sdk-event-parser.js';
import { consumeReloadSignal } from './applet-state.js';
import type { SessionEvent } from './routes/websocket.js';

interface QuotaSnapshot {
  isUnlimitedEntitlement: boolean;
  entitlementRequests: number;
  usedRequests: number;
  remainingPercentage: number;
  resetDate?: string;
}

export interface DispatchEventDeps {
  /** Caller-provided file tracker. Updates the session-context list when
   *  the agent edits or creates a file. */
  autoAddFileContext: (sessionId: string, path: string) => void;
  /** Forward a synthetic event back to the client (used for caco.reload). */
  onEvent: (event: SessionEvent) => void;
}

/**
 * Apply server-side side-effects for one SDK event.
 * Returns nothing; effects are written to storage and applet state.
 */
export function applyDispatchEventEffects(
  sessionId: string,
  event: SessionEvent,
  deps: DispatchEventDeps
): void {
  const eventData = event.data || {};

  // Capture intent for session state display.
  if (event.type === 'assistant.intent' && eventData.intent) {
    setSessionIntent(sessionId, String(eventData.intent));
  }

  // Also capture intent from the report_intent tool call.
  if (event.type === 'tool.execution_start') {
    const toolName = (eventData.toolName || eventData.name) as string | undefined;
    const args = eventData.arguments as Record<string, unknown> | undefined;
    if (toolName === 'report_intent' && typeof args?.intent === 'string') {
      setSessionIntent(sessionId, args.intent);
    }
    // Auto-populate session context from file-modifying tools only.
    if (typeof args?.path === 'string' && (toolName === 'create' || toolName === 'edit')) {
      deps.autoAddFileContext(sessionId, args.path);
    }
  }

  if (event.type === 'assistant.usage') {
    const quotaSnapshots = eventData.quotaSnapshots as Record<string, QuotaSnapshot> | undefined;
    updateUsage(quotaSnapshots);
  }

  // Reload requires consuming an external state flag.
  if (shouldEmitReload(event) && consumeReloadSignal(sessionId)) {
    deps.onEvent({ type: 'caco.reload', data: {} });
  }
}
