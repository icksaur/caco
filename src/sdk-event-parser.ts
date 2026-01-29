/**
 * SDK Event Parser
 * 
 * Utilities for parsing SDK event data, particularly extracting
 * toolTelemetry from the SDK's nested JSON serialization format.
 */

export interface ToolTelemetry {
  outputId?: string;
  reloadTriggered?: boolean;
  [key: string]: unknown;
}

export interface ToolExecutionCompleteEvent {
  toolCallId?: string;
  toolName?: string;
  name?: string;
  success?: boolean;
  result?: {
    content?: string;
    detailedContent?: string;
  };
  toolTelemetry?: Record<string, unknown>;
}

/**
 * Extract toolTelemetry from a tool.execution_complete event.
 * 
 * The SDK serializes our handler return value into result.content as a JSON string.
 * The actual toolTelemetry is nested inside that JSON, not at the top level.
 * 
 * Example SDK event:
 * {
 *   "success": true,
 *   "result": {
 *     "content": "{\"textResultForLlm\":\"...\",\"toolTelemetry\":{\"outputId\":\"out_xxx\"}}"
 *   },
 *   "toolTelemetry": {}  // Empty at top level!
 * }
 * 
 * This function extracts the toolTelemetry from result.content.
 */
export function extractToolTelemetry(eventData: ToolExecutionCompleteEvent): ToolTelemetry | undefined {
  // First, try to extract from nested JSON in result.content
  if (eventData.result?.content) {
    try {
      const parsed = JSON.parse(eventData.result.content);
      if (parsed.toolTelemetry && typeof parsed.toolTelemetry === 'object') {
        return parsed.toolTelemetry as ToolTelemetry;
      }
    } catch {
      // Not JSON, that's fine - some tools return plain text
    }
  }
  
  // Fallback: check top-level toolTelemetry (in case SDK behavior changes)
  if (eventData.toolTelemetry) {
    const topLevel = eventData.toolTelemetry as ToolTelemetry;
    // Only return if it has actual data (not empty object)
    if (topLevel.outputId || topLevel.reloadTriggered) {
      return topLevel;
    }
  }
  
  return undefined;
}

/**
 * Extract the tool name from event data (handles SDK field name variations)
 */
export function extractToolName(eventData: ToolExecutionCompleteEvent): string {
  return (eventData.toolName || eventData.name || 'tool') as string;
}
