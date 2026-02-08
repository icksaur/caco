/**
 * Element Inserter
 * 
 * DOM element creation and reuse for chat message rendering.
 * Manages the outer (message type) and inner (content) div structure.
 * 
 * This is different from event-inserter.ts which handles content insertion.
 * This module handles element creation/lookup.
 * 
 * @remarks Unit test all changes - see tests/unit/element-inserter.test.ts
 */

/** 
 * Event Type → Outer Div Class Mapping
 * Maps SDK event.type strings to the 5 chat div classes
 */
export const EVENT_TO_OUTER: Record<string, string> = {
  // User message
  'user.message': 'user-message',
  
  // Assistant messages
  'assistant.message': 'assistant-message',
  'assistant.message_delta': 'assistant-message',
  
  // Thinking indicator (removed on first content)
  'assistant.turn_start': 'assistant-activity',
  
  // Activity (all activity goes in same box)
  'assistant.intent': 'assistant-activity',
  'assistant.reasoning': 'assistant-activity',
  'assistant.reasoning_delta': 'assistant-activity',
  'tool.execution_start': 'assistant-activity',
  'tool.execution_progress': 'assistant-activity',
  'tool.execution_partial_result': 'assistant-activity',
  'tool.execution_complete': 'assistant-activity',
  'session.error': 'assistant-activity',
  'session.compaction_start': 'assistant-activity',
  'session.compaction_complete': 'assistant-activity',
  
  // Caco synthetic types
  'caco.agent': 'agent-message',
  'caco.applet': 'applet-message',
  'caco.scheduler': 'scheduler-message',
  'caco.embed': 'embed-message',
  'caco.info': 'assistant-activity',
};

/**
 * Event Type → Inner Div Class Mapping
 * Maps SDK event.type strings to inner content div classes
 * null means don't render this event type
 */
export const EVENT_TO_INNER: Record<string, string | null> = {
  // User/assistant content
  'user.message': 'user-text',
  'assistant.message': 'assistant-text',
  'assistant.message_delta': 'assistant-text',
  
  // Thinking indicator (ephemeral - removed on content)
  'assistant.turn_start': 'thinking-text',
  
  // Activity inner types
  'assistant.intent': 'intent-text',
  'assistant.reasoning': 'reasoning-text',
  'assistant.reasoning_delta': 'reasoning-text',
  'tool.execution_start': 'tool-text',
  'tool.execution_progress': 'tool-text',
  'tool.execution_partial_result': 'tool-text',
  'tool.execution_complete': 'tool-text',
  'session.error': null,         // omit
  'session.compaction_start': 'compact-text',
  'session.compaction_complete': 'compact-text',
  
  // Caco synthetic types
  'caco.agent': 'agent-text',
  'caco.applet': 'applet-text',
  'caco.scheduler': 'scheduler-text',
  'caco.embed': 'embed-content',
  'caco.info': null,  // omit - internal signal
};

/**
 * Keyed events - events that use data-key for find-and-replace
 * Maps event type → property name to extract key value from event.data
 */
export const EVENT_KEY_PROPERTY: Record<string, string> = {
  // Thinking indicator uses turnId
  'assistant.turn_start': 'turnId',
  // Tool events use toolCallId
  'tool.execution_start': 'toolCallId',
  'tool.execution_progress': 'toolCallId',
  'tool.execution_partial_result': 'toolCallId',
  'tool.execution_complete': 'toolCallId',
  // Reasoning events use reasoningId
  'assistant.reasoning': 'reasoningId',
  'assistant.reasoning_delta': 'reasoningId',
  // Message deltas use messageId
  'assistant.message': 'messageId',
  'assistant.message_delta': 'messageId',
  // Embed events use outputId (each embed gets own element)
  'caco.embed': 'outputId',
};

/**
 * Events that should create pre-collapsed inner children
 * Tool calls start collapsed; reasoning streams visibly then collapses on completion
 */
export const PRE_COLLAPSED_EVENTS = new Set([
  'tool.execution_start',
]);

/** Get outer class for event type, or undefined if not mapped */
export function getOuterClass(eventType: string): string | undefined {
  return EVENT_TO_OUTER[eventType];
}

/** Get inner class for event type, or null if omitted, undefined if not mapped */
export function getInnerClass(eventType: string): string | null | undefined {
  return EVENT_TO_INNER[eventType];
}

/**
 * Generic element inserter - works with any map and parent
 * Reuses last child if it matches, otherwise creates new.
 * 
 * With keyProperty map: uses data-key attribute for find-and-replace
 * (e.g., multiple tool calls within same activity box)
 */
export class ElementInserter {
  private map: Record<string, string | null>;
  private name: string;
  private debug: (msg: string) => void;
  private keyProperty: Record<string, string>;
  private preCollapsed: Set<string>;
  
  constructor(
    map: Record<string, string | null>, 
    name: string, 
    debug?: (msg: string) => void,
    keyProperty?: Record<string, string>,
    preCollapsed?: Set<string>
  ) {
    this.map = map;
    this.name = name;
    this.debug = debug || (() => {});
    this.keyProperty = keyProperty || {};
    this.preCollapsed = preCollapsed || new Set();
  }
  
  /**
   * Get or create element for event type within parent.
   * Returns null if event type maps to null (omit) or undefined (not in map).
   * 
   * If event type has a keyProperty, uses data-key attribute for lookup:
   * - Finds existing child with matching data-key, OR
   * - Creates new child with data-key set
   * 
   * Otherwise uses simple last-child matching.
   */
  getElement(eventType: string, parent: HTMLElement, data?: Record<string, unknown>): HTMLElement | null {
    const cssClass = this.map[eventType];
    if (cssClass === null || cssClass === undefined) return null;
    
    // Check if this event type uses keyed lookup
    const keyProp = this.keyProperty[eventType];
    if (keyProp && data) {
      const keyValue = data[keyProp];
      if (typeof keyValue === 'string' && keyValue) {
        return this.getOrCreateKeyed(cssClass, parent, keyValue, eventType);
      }
    }
    
    // Default: reuse last child if it matches
    const last = parent.lastElementChild as HTMLElement | null;
    if (last?.classList.contains(cssClass)) {
      this.debug(`[INSERTER] "${this.name}" reuse existing div for type "${eventType}"`);
      return last;
    }
    
    // Create new
    const div = document.createElement('div');
    div.className = cssClass;
    parent.appendChild(div);
    this.debug(`[INSERTER] "${this.name}" create new div for type "${eventType}"`);
    return div;
  }
  
  /**
   * Get or create element by data-key attribute
   * Tool calls start collapsed; other keyed elements do not
   */
  private getOrCreateKeyed(cssClass: string, parent: HTMLElement, keyValue: string, eventType: string): HTMLElement {
    // Search for existing child with matching data-key
    const existing = parent.querySelector(`[data-key="${keyValue}"]`) as HTMLElement | null;
    if (existing) {
      this.debug(`[INSERTER] "${this.name}" found keyed div for "${eventType}" key="${keyValue}"`);
      return existing;
    }
    
    // Create new with data-key
    const div = document.createElement('div');
    // Only pre-collapse certain event types (tool calls)
    const shouldCollapse = this.preCollapsed.has(eventType);
    div.className = shouldCollapse ? cssClass + ' collapsed' : cssClass;
    div.dataset.key = keyValue;
    parent.appendChild(div);
    this.debug(`[INSERTER] "${this.name}" create keyed div for "${eventType}" key="${keyValue}" collapsed=${shouldCollapse}`);
    return div;
  }
}

/**
 * Create pre-configured inserters for outer and inner elements
 */
export function createInserters(): { outerInserter: ElementInserter; innerInserter: ElementInserter } {
  const outerInserter = new ElementInserter(EVENT_TO_OUTER as Record<string, string | null>, 'outer');
  const innerInserter = new ElementInserter(EVENT_TO_INNER, 'inner', undefined, EVENT_KEY_PROPERTY, PRE_COLLAPSED_EVENTS);
  return { outerInserter, innerInserter };
}
