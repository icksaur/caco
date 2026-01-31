/**
 * Content Extractor
 * 
 * Extracts display content from SDK event data.
 * Handles both simple property paths and complex formatting.
 * 
 * @remarks Unit test all changes - see tests/unit/content-extractor.test.ts
 */

/**
 * Content extractor function signature
 * @param data - Event data object
 * @param existing - Existing content in the element (for append mode)
 * @returns New content string to set in the element
 */
type ContentExtractor = (data: Record<string, unknown>, existing: string) => string;

/**
 * Get nested property by dot path (e.g., 'result.content')
 */
function getByPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce(
    (o, k) => (o as Record<string, unknown>)?.[k], 
    obj
  );
}

/**
 * Create a simple path-based extractor (replace mode)
 */
function path(p: string): ContentExtractor {
  return (data) => {
    const value = getByPath(data, p);
    return typeof value === 'string' ? value : '';
  };
}

/**
 * Create an append-mode extractor for delta events
 */
function appendPath(p: string): ContentExtractor {
  return (data, existing) => {
    const value = getByPath(data, p);
    return existing + (typeof value === 'string' ? value : '');
  };
}

/**
 * Event type → content extractor mapping
 * 
 * Simple events use path() for direct property access.
 * Delta events use appendPath() to accumulate content.
 * Complex events use custom functions for formatting.
 */
const CONTENT_EXTRACTORS: Record<string, ContentExtractor> = {
  // User/assistant messages
  'user.message': path('content'),
  'assistant.message': path('content'),
  'assistant.message_delta': appendPath('deltaContent'),
  
  // Reasoning
  'assistant.reasoning': path('content'),
  'assistant.reasoning_delta': appendPath('deltaContent'),
  
  // Intent
  'assistant.intent': (data) => `💡 ${data.intent || ''}`,
  
  // Tool events - formatted display
  'tool.execution_start': (data) => `🔧 ${data.toolName || 'tool'}`,
  'tool.execution_complete': (data) => {
    const name = data.toolName || 'tool';
    const success = data.success as boolean;
    const result = getByPath(data, 'result.content') as string | undefined;
    if (success) {
      return result ? `✓ ${name}: ${result}` : `✓ ${name}`;
    }
    const error = data.error as string | undefined;
    return error ? `✗ ${name}: ${error}` : `✗ ${name}`;
  },
  'tool.execution_progress': (data, existing) => {
    const msg = data.progressMessage as string | undefined;
    return msg ? `${existing}\n${msg}` : existing;
  },
  'tool.execution_partial_result': (data, existing) => {
    const output = data.partialOutput as string | undefined;
    return output ? existing + output : existing;
  },
  
  // Session events
  'session.compaction_start': () => '📦 Compacting conversation...',
  'session.compaction_complete': () => '📦 Conversation compacted',
  
  // Caco synthetic types
  'caco.agent': path('content'),
  'caco.applet': path('content'),
};

/**
 * Extract content for display from event data
 * 
 * @param eventType - SDK event type string
 * @param data - Event data object
 * @param existing - Existing content in the target element
 * @returns Content string to set in the element, or null if no extractor
 */
export function extractContent(
  eventType: string, 
  data: Record<string, unknown>, 
  existing: string
): string | null {
  const extractor = CONTENT_EXTRACTORS[eventType];
  if (!extractor) return null;
  return extractor(data, existing);
}

/**
 * Check if an event type has a content extractor
 */
export function hasExtractor(eventType: string): boolean {
  return eventType in CONTENT_EXTRACTORS;
}
