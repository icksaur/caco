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
 * Reuses last child if it matches, otherwise creates new
 */
export class ElementInserter {
  private map: Record<string, string | null>;
  private name: string;
  private debug: (msg: string) => void;
  
  constructor(map: Record<string, string | null>, name: string, debug?: (msg: string) => void) {
    this.map = map;
    this.name = name;
    this.debug = debug || (() => {});
  }
  
  /**
   * Get or create element for event type within parent.
   * Returns null if event type maps to null (omit) or undefined (not in map).
   * Reuses last child if it has the same class, otherwise creates new.
   */
  getElement(eventType: string, parent: HTMLElement): HTMLElement | null {
    const cssClass = this.map[eventType];
    if (cssClass === null || cssClass === undefined) return null;
    
    // Reuse last child if it matches
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
}

// Debug logger - set to console.log to enable
const inserterDebug: (msg: string) => void = console.log;

// Two inserters with their respective maps
const outerInserter = new ElementInserter(EVENT_TO_OUTER as Record<string, string | null>, 'outer', inserterDebug);
const innerInserter = new ElementInserter(EVENT_TO_INNER, 'inner', inserterDebug);

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
  const inner = innerInserter.getElement(eventType, outer);
  if (!inner) return;
  
  // Extract content from event.data
  const content = data.content as string | undefined;
  const deltaContent = data.deltaContent as string | undefined;
  
  // Set content based on what's present
  if (deltaContent) {
    // Streaming: append delta
    inner.textContent = (inner.textContent || '') + deltaContent;
  } else if (content) {
    // Complete message: replace
    inner.textContent = content;
  }
  
  // Render markdown on assistant.message (complete)
  if (eventType === 'assistant.message') {
    if (window.renderMarkdownElement) {
      window.renderMarkdownElement(inner);
    }
  }
  
  // Re-enable form on session.idle
  if (eventType === 'session.idle') {
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
  if (!form) return;
  
  if (enabled) {
    form.classList.remove('streaming');
    const input = form.querySelector('textarea') as HTMLTextAreaElement;
    input?.focus();
  } else {
    form.classList.add('streaming');
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
