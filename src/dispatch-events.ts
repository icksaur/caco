/**
 * Server-side side-effects fired by SDK events during dispatch.
 *
 * Pure-effects layer: intent capture, auto-context, usage tracking,
 * reload signal consumption. Separated from the watchdog and event-routing
 * concerns in dispatchMessage() so each can be reasoned about alone.
 */

import { setSessionIntent } from './session-meta-store.js';
import { updateUsage, getUsage, type QuotaSnapshot } from './usage-state.js';
import { broadcastGlobalEvent } from './event-bus.js';
import type { SessionEvent } from './event-bus.js';
import type { GitEditPoller } from './git-edit-poller.js';
import { extractProperty } from './sdk-normalizer.js';
import { recordUsage, recordRateLimit, recordToolCall, recordToolUse, recordCompaction, snapshot } from './session-throughput.js';
import { toolKeyFromEvent } from './tool-key.js';
import { learnMcpKey } from './tool-key-registry.js';
import { stampToolUsage } from './tool-usage-store.js';
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
  /** Forward a synthetic event back to the client (e.g. caco.throughput). */
  onEvent: (event: SessionEvent) => void;
  /** Registered Caco tool names, for disambiguating a bare toolName (caco vs
   *  builtin) when stamping tool usage. REQUIRED — the type system enforces that
   *  every caller wires the usage meter, so it can't silently fail closed (a
   *  "measurement with no error path"). Tests with no interest in stamping pass
   *  `() => new Set()`. */
  cacoToolNames: () => ReadonlySet<string>;
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
    // Stamp tool usage under the canonical ToolKey (the SAME key excludedTools
    // uses), so the reveal C-phase never mis-keys a used tool. Only tool.execution_start
    // carries the tool identity (mcpServerName/mcpToolName/toolName); complete does not.
    // A resolution failure must not crash dispatch — log loudly (a measurement WITH an
    // error path) rather than fabricate or swallow silently.
    try {
      const mcpServerName = eventData.mcpServerName as string | undefined;
      const mcpToolName = eventData.mcpToolName as string | undefined;
      // Learn this MCP tool's model-facing key (toolName IS the model-facing name) so
      // the catalog/defer paths can resolve its exclusion key even after it's deferred.
      if (mcpServerName && mcpToolName && toolName) learnMcpKey(mcpServerName, mcpToolName, toolName);
      const key = toolKeyFromEvent({ toolName, mcpServerName, mcpToolName }, deps.cacoToolNames());
      recordToolUse(sessionId, key);
      stampToolUsage(key);
    } catch (e) {
      console.error(`[TOOLS] could not resolve tool key for usage stamp (tool=${String(toolName)}):`, e instanceof Error ? e.message : e);
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
    const cacheWriteTokens = extractProperty(event, 'cacheWriteTokens');
    const reasoningTokens = extractProperty(event, 'reasoningTokens');
    recordUsage(sessionId, { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens });
    deps.onEvent({ type: 'caco.throughput', data: snapshot(sessionId) as unknown as Record<string, unknown> });
  }

  if (event.type === 'model.call_failure') {
    const statusCode = extractProperty<number>(event, 'statusCode');
    if (statusCode === 429) {
      recordRateLimit(sessionId);
      deps.onEvent({ type: 'caco.throughput', data: snapshot(sessionId) as unknown as Record<string, unknown> });
    }
  }

  // A context compaction ends the "avoided context is still in the window" premise the
  // workflow "lean" compound term relies on, so reset its forward base (spec-workflow-
  // savings-model item 4). Automatic seam — this fires on the LIVE, single-delivery
  // dispatch event stream (background/threshold compaction mid-dispatch); the manual
  // /compact RPC resets separately in compactSession, disjoint from this path.
  if (event.type === 'session.compaction_complete') {
    recordCompaction(sessionId);
    deps.onEvent({ type: 'caco.throughput', data: snapshot(sessionId) as unknown as Record<string, unknown> });
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
}
