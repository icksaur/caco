/**
 * Event Inserter
 * 
 * Given a DOM element and SDK event data, make the DOM right.
 * Handles content extraction, data storage, and element manipulation.
 * 
 * @remarks Unit test all changes - see tests/unit/event-inserter.test.ts
 */

/**
 * Element interface for DOM manipulation
 * Subset of HTMLElement to allow testing without real DOM
 */
export interface InserterElement {
  textContent: string | null;
  dataset: Record<string, string | undefined>;
}

/**
 * Event inserter function signature
 * Directly mutates the element - sets textContent, stores dataset values
 * @param element - Element to manipulate
 * @param data - Event data object
 */
type EventInserterFn = (element: InserterElement, data: Record<string, unknown>) => void;

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
 * Create a simple path-based inserter (replace mode)
 */
function setPath(p: string): EventInserterFn {
  return (element, data) => {
    const value = getByPath(data, p);
    element.textContent = typeof value === 'string' ? value : '';
  };
}

/**
 * Create an append-mode inserter for delta events
 */
function appendPath(p: string): EventInserterFn {
  return (element, data) => {
    const existing = element.textContent || '';
    const value = getByPath(data, p);
    element.textContent = existing + (typeof value === 'string' ? value : '');
  };
}

/**
 * Event type → inserter function mapping
 * 
 * Simple events use setPath() for direct property access.
 * Delta events use appendPath() to accumulate content.
 * Complex events use custom functions for formatting and data storage.
 */
const EVENT_INSERTERS: Record<string, EventInserterFn> = {
  // User/assistant messages
  'user.message': setPath('content'),
  'assistant.message': setPath('content'),
  'assistant.message_delta': appendPath('deltaContent'),
  
  // Reasoning
  'assistant.reasoning': setPath('content'),
  'assistant.reasoning_delta': appendPath('deltaContent'),
  
  // Intent
  'assistant.intent': (element, data) => {
    element.textContent = `💡 ${data.intent || ''}`;
  },
  
  // Tool events - richer format with data storage
  'tool.execution_start': (element, data) => {
    const name = (data.toolName || 'tool') as string;
    const args = data.arguments as Record<string, unknown> | undefined;
    const input = (args?.command || args?.description || '') as string;
    
    // Store for later use by tool.execution_complete
    element.dataset.toolName = name;
    if (input) element.dataset.toolInput = input;
    
    // Set content
    element.textContent = input ? `🔧 **${name}**\n\`${input}\`` : `🔧 **${name}**`;
  },
  
  'tool.execution_complete': (element, data) => {
    // Read stored values
    const name = element.dataset.toolName || 'tool';
    const input = element.dataset.toolInput || '';
    const success = data.success as boolean;
    const result = getByPath(data, 'result.content') as string | undefined;
    const icon = success ? '✓' : '✗';
    
    // Build: icon name + input + output
    let content = `${icon} **${name}**`;
    if (input) content += `\n\`${input}\``;
    if (success && result) {
      content += `\n${result}`;
    } else if (!success) {
      const error = data.error as string | undefined;
      if (error) content += `\n${error}`;
    }
    element.textContent = content;
  },
  
  'tool.execution_progress': (element, data) => {
    const existing = element.textContent || '';
    const msg = data.progressMessage as string | undefined;
    if (msg) element.textContent = `${existing}\n${msg}`;
  },
  
  'tool.execution_partial_result': (element, data) => {
    const existing = element.textContent || '';
    const output = data.partialOutput as string | undefined;
    if (output) element.textContent = existing + output;
  },
  
  // Session events
  'session.compaction_start': (element) => {
    element.textContent = '📦 Compacting conversation...';
  },
  'session.compaction_complete': (element) => {
    element.textContent = '📦 Conversation compacted';
  },
  
  // Caco synthetic types
  'caco.agent': setPath('content'),
  'caco.applet': setPath('content'),
};

/**
 * SDK event structure
 */
export interface SessionEvent {
  type: string;
  data?: Record<string, unknown>;
}

/**
 * Insert event content into element
 * Directly manipulates the element - sets textContent, stores data attributes
 * 
 * @param event - SDK event with type and data
 * @param element - Element to manipulate
 * @returns true if event was handled, false if no inserter exists
 */
export function insertEvent(
  event: SessionEvent,
  element: InserterElement
): boolean {
  const inserter = EVENT_INSERTERS[event.type];
  if (!inserter) return false;
  inserter(element, event.data || {});
  return true;
}

/**
 * Check if an event type has an inserter
 */
export function hasInserter(eventType: string): boolean {
  return eventType in EVENT_INSERTERS;
}
