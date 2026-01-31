/**
 * Event Filter
 * 
 * Filters SDK events before broadcasting to clients.
 * Uses a whitelist approach - events are allowed if ANY listed property is present and non-empty.
 * See doc/chatview-design.md for the property whitelist table.
 */

export interface FilterableEvent {
  type: string;
  data?: Record<string, unknown>;
}

/**
 * Whitelist of properties that indicate an event has displayable content.
 * If ANY of these properties are present and non-empty, the event is allowed through.
 */
const CONTENT_PROPERTIES = [
  'content',         // user.message, assistant.message, assistant.reasoning, system.message
  'deltaContent',    // assistant.message_delta, assistant.reasoning_delta
  'intent',          // assistant.intent
  'toolName',        // tool.execution_start, tool.user_requested
  'toolCallId',      // tool.execution_complete, tool.execution_progress, tool.execution_partial_result
  'message',         // session.error, session.info
  'progressMessage', // tool.execution_progress
  'partialOutput',   // tool.execution_partial_result
  'agentName',       // subagent.started, subagent.completed, subagent.failed, subagent.selected
];

/**
 * Check if a value is non-empty (string with length > 0, or truthy non-string)
 */
function isNonEmpty(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.length > 0;
  }
  return Boolean(value);
}

/**
 * Determine if an event should be filtered (not broadcast)
 * 
 * Returns true (filter out) if NONE of the whitelisted properties are present and non-empty.
 * Returns false (keep) if ANY whitelisted property is present and non-empty.
 */
export function shouldFilter(event: FilterableEvent): boolean {
  const data = event.data;
  if (!data) return true;
  
  // Allow through if any whitelisted property is non-empty
  for (const prop of CONTENT_PROPERTIES) {
    if (isNonEmpty(data[prop])) {
      return false; // Don't filter - has content
    }
  }
  
  return true; // Filter out - no displayable content
}
