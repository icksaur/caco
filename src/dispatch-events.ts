/**
 * Server-side side-effects fired by SDK events during dispatch.
 *
 * Pure-effects layer: intent capture, auto-context, usage tracking,
 * reload signal consumption. Separated from the watchdog and event-routing
 * concerns in dispatchMessage() so each can be reasoned about alone.
 */

import { setSessionIntent } from './session-meta-store.js';
import { updateUsage, getUsage, type QuotaSnapshot } from './usage-state.js';
import { shouldEmitReload } from './sdk-event-parser.js';
import { consumeReloadSignal } from './applet-state.js';
import { broadcastGlobalEvent } from './event-bus.js';
import type { SessionEvent } from './event-bus.js';
import type { GitEditPoller } from './git-edit-poller.js';
import { extractProperty } from './sdk-normalizer.js';
import { recordUsage, recordRateLimit, recordToolCall, snapshot } from './session-throughput.js';
import { extractActionOptions } from './offer-action-parse.js';
import { updateSessionMeta } from './storage.js';

// Set by server.ts after the poller is constructed. Optional — if absent
// (e.g. unit tests), the file-edits triggers become no-ops.
let gitEditPoller: GitEditPoller | null = null;
export function setGitEditPoller(p: GitEditPoller | null): void {
  gitEditPoller = p;
}

/** Tools that mutate files. Triggers a file-edits poll on success. */
const WRITE_TOOLS = new Set(['edit', 'create', 'write', 'apply_patch']);

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
    const { changed } = updateUsage(quotaSnapshots);
    if (changed) {
      const usage = getUsage();
      if (usage) {
        broadcastGlobalEvent({ type: 'caco.usage', data: { ...usage } } as SessionEvent);
      }
    }
    const inputTokens = extractProperty(event, 'inputTokens');
    const outputTokens = extractProperty(event, 'outputTokens');
    const cacheReadTokens = extractProperty(event, 'cacheReadTokens');
    const reasoningTokens = extractProperty(event, 'reasoningTokens');
    recordUsage(sessionId, { inputTokens, outputTokens, cacheReadTokens, reasoningTokens });
    deps.onEvent({ type: 'caco.throughput', data: snapshot(sessionId) as unknown as Record<string, unknown> });
  }

  if (event.type === 'model.call_failure') {
    const statusCode = extractProperty<number>(event, 'statusCode');
    if (statusCode === 429) {
      recordRateLimit(sessionId);
      deps.onEvent({ type: 'caco.throughput', data: snapshot(sessionId) as unknown as Record<string, unknown> });
    }
  }

  // Count completed tool calls (and failures) for round-trip metrics. Use
  // extractProperty: live events carry `success` at the root, history events
  // under `data` — reading eventData.success alone miscounts every live
  // success as a failure.
  if (event.type === 'tool.execution_complete') {
    recordToolCall(sessionId, extractProperty<boolean>(event, 'success') !== true);
  }

  // Response actions: a final ```caco-actions fenced block in the assistant
  // message is parsed into meta.responseOptions, which the client renders as
  // pinned next-step buttons. No block → no change. The block is hidden in the
  // transcript by the markdown code() renderer + the streaming strip guard.
  if (event.type === 'assistant.message') {
    const content = extractProperty<string>(event, 'content');
    if (typeof content === 'string') {
      const options = extractActionOptions(content);
      if (options.length > 0) {
        updateSessionMeta(sessionId, meta => { meta.responseOptions = options; });
      }
    }
  }

  // Trigger an immediate file-edits poll when a write tool finishes
  // successfully. The poller debounces, so multiple completions in flight
  // collapse into one poll.
  if (event.type === 'tool.execution_complete' && gitEditPoller) {
    const toolName = (eventData.toolName || eventData.name) as string | undefined;
    if (toolName && WRITE_TOOLS.has(toolName) && eventData.success === true) {
      gitEditPoller.triggerPoll(sessionId, 'event');
    }
  }

  // Reload requires consuming an external state flag.
  if (shouldEmitReload(event) && consumeReloadSignal(sessionId)) {
    deps.onEvent({ type: 'caco.reload', data: {} });
  }
}
