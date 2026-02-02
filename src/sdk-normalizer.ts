/**
 * SDK Event Normalizer
 * 
 * Normalizes Copilot SDK events into consistent shapes.
 * 
 * The SDK has inconsistent event structures:
 * - Live events: properties at root { type, toolCallId, result }
 * - History events: properties wrapped { type, data: { toolCallId, result } }
 * 
 * This module provides ONE place to handle this inconsistency.
 * All code should use these extractors instead of accessing SDK properties directly.
 * 
 * @remarks Unit test all changes - see tests/unit/sdk-normalizer.test.ts
 */

/**
 * Raw SDK event - we don't know if properties are at root or in data
 */
export interface RawSDKEvent {
  type: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Normalized tool execution complete event
 */
export interface NormalizedToolComplete {
  toolCallId: string;
  toolName?: string;
  success: boolean;
  resultContent?: string;
}

/**
 * Extract a property from SDK event, handling both wrapped and unwrapped formats.
 * 
 * SDK events may have properties at:
 * - Root level: { type, toolCallId, result }
 * - In data wrapper: { type, data: { toolCallId, result } }
 * 
 * This function checks both locations.
 */
export function extractProperty<T>(event: RawSDKEvent, property: string): T | undefined {
  // Check data wrapper first (history format)
  if (event.data && property in event.data) {
    return event.data[property] as T;
  }
  // Check root level (live format)
  if (property in event) {
    return event[property] as T;
  }
  return undefined;
}

/**
 * Normalize a tool.execution_complete event into consistent shape.
 * Returns null if event is not tool.execution_complete.
 */
export function normalizeToolComplete(event: RawSDKEvent): NormalizedToolComplete | null {
  if (event.type !== 'tool.execution_complete') {
    return null;
  }
  
  const toolCallId = extractProperty<string>(event, 'toolCallId');
  const toolName = extractProperty<string>(event, 'toolName');
  const success = extractProperty<boolean>(event, 'success') ?? false;
  const result = extractProperty<{ content?: string }>(event, 'result');
  
  if (!toolCallId) {
    return null;
  }
  
  return {
    toolCallId,
    toolName,
    success,
    resultContent: result?.content
  };
}

/**
 * Extract text content from tool result.
 * Handles JSON-wrapped content (e.g., from display tools).
 * 
 * Tool results may be:
 * - Plain text: "Hello world"
 * - JSON with textResultForLlm: '{"textResultForLlm":"[output:xxx]..."}'
 */
export function extractToolResultText(resultContent: string | undefined): string | undefined {
  if (!resultContent) {
    return undefined;
  }
  
  // Try to parse as JSON and extract textResultForLlm
  try {
    const parsed = JSON.parse(resultContent);
    if (typeof parsed.textResultForLlm === 'string') {
      return parsed.textResultForLlm;
    }
  } catch {
    // Not JSON, use as-is
  }
  
  return resultContent;
}
