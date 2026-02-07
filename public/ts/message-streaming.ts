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
import { onEvent, subscribeToSession, type SessionEvent } from './websocket.js';
import { showToast, hideToast } from './toast.js';
import { getAndClearPendingAppletState, getNavigationContext } from './applet-runtime.js';
import { resetTextareaHeight } from './multiline-input.js';
import { isTerminalEvent } from './terminal-events.js';
import { insertEvent } from './event-inserter.js';
import { removeImage } from './image-paste.js';
import { markSessionObserved } from './session-observed.js';
import { 
  ElementInserter,
  EVENT_TO_OUTER,
  EVENT_TO_INNER,
  EVENT_KEY_PROPERTY,
  PRE_COLLAPSED_EVENTS,
  getOuterClass,
  getInnerClass
} from './element-inserter.js';

// Re-export for external callers
export { setLoadingHistory };
// Re-export element-inserter functions for external callers
export { getOuterClass, getInnerClass };

const outerInserter = new ElementInserter(EVENT_TO_OUTER as Record<string, string | null>, 'outer');
const innerInserter = new ElementInserter(EVENT_TO_INNER, 'inner', undefined, EVENT_KEY_PROPERTY, PRE_COLLAPSED_EVENTS);

/**
 * Handle incoming SDK event (history or live)
 * Uses outer + inner inserters with event.type for routing
 */
function handleEvent(event: SessionEvent): void {
  hideToast();
  const chat = document.getElementById('chat')!;
  let eventType = event.type;
  const data = event.data || {};
  
  // Transform user.message with non-user source to synthetic type
  // This allows applet/agent/scheduler messages to have distinct styling
  if (eventType === 'user.message' && data.source && data.source !== 'user') {
    eventType = `caco.${data.source}`;
  }
  
  // DEBUG: Log all event types received
  console.log(`[EVENT] ${eventType}`, data);
  
  // Re-enable form on terminal events (streaming complete)
  // Check BEFORE outer/inner logic since terminal events may not have display elements
  if (isTerminalEvent(eventType)) {
    setFormEnabled(true);
    
    // Mark session as observed - user has seen the completed response
    if (eventType === 'session.idle') {
      const sessionId = getActiveSessionId();
      if (sessionId) {
        markSessionObserved(sessionId);
      }
    }
  }
  
  // Special case: assistant.reasoning arrives after deltas, may be in a different outer div
  // Search entire chat for existing reasoning element by reasoningId
  if (eventType === 'assistant.reasoning' && data.reasoningId) {
    const existing = chat.querySelector(`[data-key="${data.reasoningId}"]`) as HTMLElement | null;
    if (existing) {
      // Found the delta-streamed element - update and collapse it
      insertEvent(event, existing);
      // Add header AFTER insertEvent (which replaces content via renderMarkdown)
      const header = document.createElement('p');
      header.className = 'reasoning-header';
      header.textContent = 'reasoning';
      existing.insertBefore(header, existing.firstChild);
      existing.classList.add('collapsed');
      scrollToBottom();
      return;
    }
    // Not found (no deltas were streamed) - fall through to normal flow
  }
  
  // Get outer div
  const outer = outerInserter.getElement(eventType, chat);
  if (!outer) return;
  
  // Get inner div (null = omit this event type)
  // Pass data for keyed lookup (tool calls, reasoning, messages)
  const inner = innerInserter.getElement(eventType, outer, data);
  if (!inner) return;
  
  // Insert event content into element (handles data storage and markdown rendering)
  insertEvent(event, inner);
  
  // Post-collapse: reasoning collapses after streaming is complete
  if (eventType === 'assistant.reasoning') {
    inner.classList.add('collapsed');
  }
  
  scrollToBottom();
}

function registerWsHandlers(): void {
  onEvent(handleEvent);
}

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
      // Clear chat history for new session
      const chat = document.getElementById('chat');
      if (chat) chat.innerHTML = '';
      
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, model })
      });
      
      if (!res.ok) {
        const error = await res.json().catch(() => ({ error: 'Session creation failed' }));
        throw new Error(error.error || `HTTP ${res.status}`);
      }
      
      const data = await res.json();
      sessionId = data.sessionId;
      setActiveSession(sessionId, data.cwd);
      subscribeToSession(sessionId);
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

// Setup

/**
 * Set up form submission handler
 */
export function setupFormHandler(): void {
  registerWsHandlers();
  
  // Toggle collapsed inner items within activity boxes
  // Each tool-text, reasoning-text etc. is individually collapsible
  const chatDiv = document.getElementById('chat');
  if (chatDiv) {
    chatDiv.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const activity = target.closest('.assistant-activity');
      if (!activity) return;
      
      // Find the direct child of activity that was clicked
      // This is the inner item (tool-text, reasoning-text, etc.)
      let innerItem = target;
      while (innerItem.parentElement && innerItem.parentElement !== activity) {
        innerItem = innerItem.parentElement;
      }
      
      // Toggle collapse on the inner item
      if (innerItem && innerItem.parentElement === activity) {
        innerItem.classList.toggle('collapsed');
      }
    });
  }
  
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
