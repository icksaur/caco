/**
 * Message Streaming
 * 
 * Unified message rendering for chat, activity, and special message types.
 * Uses ElementInserter class with two maps:
 * 
 * 1. EVENT_TO_OUTER - Maps event type → outer div class (5 types)
 * 2. EVENT_TO_INNER - Maps event type → inner div class (content target)
 * 
 * Pattern:
 *   outer = outerInserter.getElement(eventType, chat)
 *   inner = innerInserter.getElement(eventType, outer)
 *   inner.textContent = content  // REPLACE
 */

import { scrollToBottom } from './ui-utils.js';
import { getActiveSessionId, setActiveSession, setLoadingHistory } from './app-state.js';
import { getNewChatCwd, showNewChatError } from './model-selector.js';
import { isViewState, setViewState } from './view-controller.js';
import { onEvent, type SessionEvent } from './websocket.js';
import { showToast, hideToast } from './toast.js';
import { getAndClearPendingAppletState, getNavigationContext } from './applet-runtime.js';
import { resetTextareaHeight } from './multiline-input.js';
import { isTerminalEvent } from './terminal-events.js';
import { insertEvent } from './event-inserter.js';

// Declare renderMarkdown global
declare global {
  interface Window {
    renderMarkdown?: () => void;
    renderMarkdownElement?: (element: Element) => void;
    toggleActivityBox?: (el: HTMLElement) => void;
  }
}

// Re-export for external callers
export { setLoadingHistory };

// ============================================================================
// ElementInserter - Core DOM manipulation
// ============================================================================

/** 
 * Phase 1: Event Type → Outer Div Class Mapping
 * Maps SDK event.type strings to the 5 chat div classes
 */
const EVENT_TO_OUTER: Record<string, string> = {
  // User message
  'user.message': 'user-message',
  
  // Assistant messages
  'assistant.message': 'assistant-message',
  'assistant.message_delta': 'assistant-message',
  
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
  'caco.info': 'assistant-activity',
};

/**
 * Phase 2: Event Type → Inner Div Class Mapping
 * Maps SDK event.type strings to inner content div classes
 * 'omit' means don't render this event type
 */
const EVENT_TO_INNER: Record<string, string | null> = {
  // User/assistant content
  'user.message': 'user-text',
  'assistant.message': 'assistant-text',
  'assistant.message_delta': 'assistant-text',
  
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
  'caco.info': null,  // omit - internal signal
};

/**
 * Keyed events - events that use data-key for find-and-replace
 * Maps event type → property name to extract key value from event.data
 */
const EVENT_KEY_PROPERTY: Record<string, string> = {
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
};

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
 * 
 * @remarks Unit test all changes - see tests/unit/element-inserter.test.ts
 */
export class ElementInserter {
  private map: Record<string, string | null>;
  private name: string;
  private debug: (msg: string) => void;
  private keyProperty: Record<string, string>;
  
  constructor(
    map: Record<string, string | null>, 
    name: string, 
    debug?: (msg: string) => void,
    keyProperty?: Record<string, string>
  ) {
    this.map = map;
    this.name = name;
    this.debug = debug || (() => {});
    this.keyProperty = keyProperty || {};
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
    
    // Auto-collapse previous activity boxes when creating any new outer div
    parent.querySelectorAll('.assistant-activity:not(.collapsed)').forEach(el => {
      el.classList.add('collapsed');
    });
    
    // Create new
    const div = document.createElement('div');
    div.className = cssClass;
    parent.appendChild(div);
    this.debug(`[INSERTER] "${this.name}" create new div for type "${eventType}"`);
    return div;
  }
  
  /**
   * Get or create element by data-key attribute
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
    div.className = cssClass;
    div.dataset.key = keyValue;
    parent.appendChild(div);
    this.debug(`[INSERTER] "${this.name}" create keyed div for "${eventType}" key="${keyValue}"`);
    return div;
  }
}

// Debug logger - set to console.log to enable
const inserterDebug: (msg: string) => void = console.log;

// Two inserters with their respective maps
const outerInserter = new ElementInserter(EVENT_TO_OUTER as Record<string, string | null>, 'outer');//inserterDebug);
const innerInserter = new ElementInserter(EVENT_TO_INNER, 'inner', undefined, EVENT_KEY_PROPERTY);

// ============================================================================
// Event Handlers
// ============================================================================

/**
 * Handle incoming SDK event (history or live)
 * Uses outer + inner inserters with event.type for routing
 */
function handleEvent(event: SessionEvent): void {
  console.log('[handleEvent]', event.type, event.data);
  hideToast();
  const chat = document.getElementById('chat')!;
  const eventType = event.type;
  const data = event.data || {};
  
  // Get outer div
  const outer = outerInserter.getElement(eventType, chat);
  if (!outer) return;
  
  // Get inner div (null = omit this event type)
  // Pass data for keyed lookup (tool calls, reasoning, messages)
  const inner = innerInserter.getElement(eventType, outer, data);
  if (!inner) return;
  
  // Insert event content into element (handles data storage and markdown rendering)
  insertEvent(event, inner);
  
  // Re-enable form on terminal events (streaming complete)
  if (isTerminalEvent(eventType)) {
    setFormEnabled(true);
  }
  
  scrollToBottom();
}

// ============================================================================
// WebSocket Registration
// ============================================================================

function registerWsHandlers(): void {
  onEvent(handleEvent);
}

// ============================================================================
// Form Handling
// ============================================================================

/**
 * Enable/disable form during streaming
 * Just toggles a class - CSS handles visual state
 */
export function setFormEnabled(enabled: boolean): void {
  const form = document.getElementById('chatForm');
  const cursor = document.getElementById('workingCursor');
  if (!form) return;
  
  if (enabled) {
    form.classList.remove('streaming');
    cursor?.classList.add('hidden');
    const input = form.querySelector('textarea') as HTMLTextAreaElement;
    input?.focus();
  } else {
    form.classList.add('streaming');
    cursor?.classList.remove('hidden');
  }
}

/**
 * Stop streaming
 */
export function stopStreaming(): void {
  const sessionId = getActiveSessionId();
  if (sessionId) {
    fetch(`/api/sessions/${sessionId}/cancel`, { method: 'POST' })
      .catch(err => console.error('Failed to cancel:', err));
  }
  
  setFormEnabled(true);
}

/**
 * Stream response via REST API + WebSocket
 */
export async function streamResponse(prompt: string, model: string, imageData: string, newChat: boolean, cwd?: string): Promise<void> {
  setFormEnabled(false);
  
  try {
    const appletState = getAndClearPendingAppletState();
    const appletNavigation = getNavigationContext();
    
    let sessionId = getActiveSessionId();
    
    if (newChat || !sessionId) {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, model })
      });
      
      if (!res.ok) {
        const error = await res.json().catch(() => ({ error: 'Session creation failed' }));
        if (res.status === 409 && error.code === 'CWD_LOCKED') {
          throw new Error(error.error || 'Directory is locked by another session');
        }
        throw new Error(error.error || `HTTP ${res.status}`);
      }
      
      const data = await res.json();
      sessionId = data.sessionId;
      setActiveSession(sessionId, data.cwd);
      setViewState('chatting');
    }
    
    const res = await fetch(`/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        prompt, 
        imageData,
        ...(appletState && { appletState }),
        appletNavigation
      })
    });
    
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(error.error || `HTTP ${res.status}`);
    }
    
  } catch (error) {
    console.error('Send message error:', error);
    setFormEnabled(true);
    
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    const input = document.querySelector('#chatForm textarea') as HTMLTextAreaElement;
    if (input) {
      input.value = prompt;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    
    showToast(errorMessage);
  }
}

// ============================================================================
// Setup
// ============================================================================

function removeImage(): void {
  const imageData = document.getElementById('imageData') as HTMLInputElement;
  const imagePreview = document.getElementById('imagePreview');
  if (imageData) imageData.value = '';
  if (imagePreview) imagePreview.classList.add('hidden');
}

/**
 * Set up form submission handler
 */
export function setupFormHandler(): void {
  registerWsHandlers();
  
  // Toggle collapsed activity boxes - only first child (header) is clickable
  const chatDiv = document.getElementById('chat');
  if (chatDiv) {
    chatDiv.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const activity = target.closest('.assistant-activity');
      if (!activity) return;
      
      // Only toggle if clicking the first child (header)
      const firstChild = activity.firstElementChild;
      if (firstChild && (target === firstChild || firstChild.contains(target))) {
        activity.classList.toggle('collapsed');
      }
    });
  }
  
  // Expose toggleActivityBox globally
  window.toggleActivityBox = (header: HTMLElement) => {
    const wrapper = header.closest('.message.activity');
    if (!wrapper) return;
    const box = wrapper.querySelector('.activity-box') as HTMLElement;
    const icon = header.querySelector('.activity-icon');
    if (box) {
      const isHidden = box.style.display === 'none';
      box.style.display = isHidden ? '' : 'none';
      if (icon) icon.textContent = isHidden ? '▼' : '▶';
    }
  };
  
  const form = document.getElementById('chatForm') as HTMLFormElement;
  if (!form) return;
  
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    
    const input = form.querySelector('textarea[name="message"]') as HTMLTextAreaElement;
    const message = input.value.trim();
    const modelInput = document.getElementById('selectedModel') as HTMLInputElement;
    const model = modelInput?.value;
    const imageData = (document.getElementById('imageData') as HTMLInputElement).value;
    
    const cwd = getNewChatCwd();
    const isNewChat = isViewState('newChat');
    
    if (isNewChat && !cwd) {
      showNewChatError('Please enter a working directory');
      return;
    }
    
    if (!message) return;
    
    setFormEnabled(false);
    
    input.value = '';
    resetTextareaHeight();
    removeImage();
    
    streamResponse(message, model, imageData, isNewChat, cwd);
  });
}
