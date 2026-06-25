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
