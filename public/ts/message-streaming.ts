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

import { escapeHtml, scrollToBottom } from './ui-utils.js';
import { setStreaming, isStreaming, getActiveSessionId, setActiveSession, isLoadingHistory, setLoadingHistory } from './app-state.js';
import { getNewChatCwd, showNewChatError } from './model-selector.js';
import { isViewState, setViewState } from './view-controller.js';
import { onMessage, onHistoryComplete, onActivity, onOutput, type ChatMessage, type ActivityItem } from './websocket.js';
import { showToast, hideToast } from './toast.js';
import { renderOutputById, restoreOutputsFromHistory } from './display-output.js';
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
// Formatting Utilities
// ============================================================================

interface ToolResult {
  content?: string | unknown;
  [key: string]: unknown;
}

/**
 * Format tool arguments for display
 */
export function formatToolArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return '';
  
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string') {
      const display = value.length > 80 ? value.substring(0, 80) + '...' : value;
      parts.push(`${key}: ${display}`);
    } else if (typeof value === 'object') {
      parts.push(`${key}: ${JSON.stringify(value).substring(0, 60)}...`);
    } else {
      parts.push(`${key}: ${value}`);
    }
  }
  return parts.join(', ');
}

/**
 * Format tool result for display
 */
export function formatToolResult(result: ToolResult | undefined): string {
  if (!result) return '';
  
  if (result.content) {
    const content = typeof result.content === 'string' 
      ? result.content 
      : JSON.stringify(result.content);
    return content.length > 500 ? content.substring(0, 500) + '...' : content;
  }
  
  return JSON.stringify(result).substring(0, 200);
}

// ============================================================================
// MessageInserter - Core DOM manipulation
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
  'assistant.turn_start': 'assistant-activity',
  'assistant.turn_end': 'assistant-activity',
  'assistant.intent': 'assistant-activity',
  'assistant.reasoning': 'assistant-activity',
  'assistant.reasoning_delta': 'assistant-activity',
  'tool.execution_start': 'assistant-activity',
  'tool.execution_progress': 'assistant-activity',
  'tool.execution_partial_result': 'assistant-activity',
  'tool.execution_complete': 'assistant-activity',
  'session.start': 'assistant-activity',
  'session.idle': 'assistant-activity',
  'session.error': 'assistant-activity',
  'session.truncation': 'assistant-activity',
  'session.compaction_start': 'assistant-activity',
  'session.compaction_complete': 'assistant-activity',
  'session.usage_info': 'assistant-activity',
  'assistant.usage': 'assistant-activity',
  
  // Caco synthetic types
  'caco.agent': 'agent-message',
  'caco.applet': 'applet-message',
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
  'assistant.turn_start': null,  // omit
  'assistant.turn_end': null,    // omit
  'assistant.intent': 'intent-text',
  'assistant.reasoning': 'reasoning-text',
  'assistant.reasoning_delta': 'reasoning-text',
  'tool.execution_start': 'tool-text',
  'tool.execution_progress': 'tool-text',
  'tool.execution_partial_result': 'tool-text',
  'tool.execution_complete': 'tool-text',
  'session.start': null,         // omit
  'session.idle': null,          // omit
  'session.error': null,         // omit
  'session.truncation': null,    // omit
  'session.compaction_start': 'compact-text',
  'session.compaction_complete': 'compact-text',
  'session.usage_info': null,    // omit
  'assistant.usage': null,       // omit
  
  // Caco synthetic types
  'caco.agent': 'agent-text',
  'caco.applet': 'applet-text',
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
  
  constructor(map: Record<string, string | null>) {
    this.map = map;
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
      return last;
    }
    
    // Create new
    const div = document.createElement('div');
    div.className = cssClass;
    parent.appendChild(div);
    return div;
  }
}

// Two inserters with their respective maps
const outerInserter = new ElementInserter(EVENT_TO_OUTER as Record<string, string | null>);
const innerInserter = new ElementInserter(EVENT_TO_INNER);

// ============================================================================
// Message Handlers
// ============================================================================

/**
 * Map ChatMessage to SDK event type for new Phase 1 rendering
 */
function messageToEventType(msg: ChatMessage): string {
  if (msg.role === 'user') {
    if (msg.source === 'agent') return 'caco.agent';
    if (msg.source === 'applet') return 'caco.applet';
    return 'user.message';
  }
  // Assistant
  if (msg.deltaContent) return 'assistant.message_delta';
  return 'assistant.message';
}

/**
 * Handle incoming chat message (history or live)
 * Phase 2: Uses outer + inner inserters with REPLACE semantics
 */
function handleMessage(msg: ChatMessage): void {
  hideToast();
  const chat = document.getElementById('chat')!;
  const eventType = messageToEventType(msg);
  
  // Get outer div
  const outer = outerInserter.getElement(eventType, chat);
  if (!outer) return;
  
  // Get inner div (null = omit this event type)
  const inner = innerInserter.getElement(eventType, outer);
  if (!inner) return;
  
  const content = msg.content || msg.deltaContent || '';
  
  if (msg.role === 'user') {
    // User messages: escape HTML, show image indicator
    const imageIndicator = msg.hasImage ? ' [img]' : '';
    inner.innerHTML = escapeHtml(content) + imageIndicator;
    outer.setAttribute('data-message-id', msg.id);
  } else {
    // Assistant: REPLACE content in inner div (deltas accumulate naturally)
    if (msg.deltaContent) {
      inner.textContent = (inner.textContent || '') + msg.deltaContent;
    } else if (msg.content) {
      inner.textContent = msg.content;
      outer.setAttribute('data-markdown', '');
      
      if (msg.outputs) {
        const existing = outer.getAttribute('data-outputs') || '';
        const combined = existing ? existing + ',' + msg.outputs.join(',') : msg.outputs.join(',');
        outer.setAttribute('data-outputs', combined);
      }
    }
    
    // Render markdown when complete
    if (msg.status === 'complete' && window.renderMarkdownElement) {
      window.renderMarkdownElement(inner);
    }
  }
  
  if (msg.status === 'complete') {
    setStreaming(false);
    setFormEnabled(true);
  }
  
  scrollToBottom();
}

/**
 * Map ActivityItem type to SDK event type
 */
function activityToEventType(item: ActivityItem): string {
  switch (item.type) {
    case 'intent': return 'assistant.intent';
    case 'tool': return 'tool.execution_start';
    case 'tool-result': return 'tool.execution_complete';
    case 'error': return 'session.error';
    case 'turn': return 'assistant.turn_start';
    default: return 'assistant.intent';  // fallback for info, etc.
  }
}

/**
 * Handle activity item
 * Phase 2: Uses outer + inner inserters
 */
function handleActivity(item: ActivityItem): void {
  // Handle reload signal
  if (item.type === 'info' && item.text === 'Reload triggered') {
    window.location.reload();
    return;
  }
  
  const chat = document.getElementById('chat')!;
  const eventType = activityToEventType(item);
  
  // Get outer div
  const outer = outerInserter.getElement(eventType, chat);
  if (!outer) return;
  
  // Get inner div (null = omit this event type)
  const inner = innerInserter.getElement(eventType, outer);
  if (!inner) return;
  
  // REPLACE content in inner div
  inner.textContent = item.text;
  if (item.details) {
    inner.title = item.details;
  }
  
  scrollToBottom();
}

/**
 * Handle output
 * TODO: Phase 5 - outputs need proper container
 */
function handleOutput(outputId: string): void {
  // Find last assistant-message as container for now
  const chat = document.getElementById('chat');
  const lastAssistant = chat?.querySelector('.assistant-message:last-of-type');
  if (lastAssistant) {
    renderOutputById(outputId, lastAssistant as HTMLElement).catch(err => 
      console.error('Failed to render output:', err)
    );
  }
}

/**
 * Handle history complete
 */
function handleHistoryComplete(): void {
  setLoadingHistory(false);
  
  if (window.renderMarkdown) window.renderMarkdown();
  
  restoreOutputsFromHistory().catch(err => 
    console.error('Failed to restore outputs:', err)
  );
  
  scrollToBottom(true);
}

// ============================================================================
// WebSocket Registration
// ============================================================================

let wsHandlersRegistered = false;

function registerWsHandlers(): void {
  if (wsHandlersRegistered) return;
  wsHandlersRegistered = true;
  
  onMessage(handleMessage);
  onHistoryComplete(handleHistoryComplete);
  onActivity(handleActivity);
  onOutput(handleOutput);
}

// ============================================================================
// Form Handling
// ============================================================================

let stopButtonTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Enable/disable form during streaming
 */
export function setFormEnabled(enabled: boolean): void {
  const form = document.getElementById('chatForm') as HTMLFormElement;
  const input = form?.querySelector('textarea[name="message"]') as HTMLTextAreaElement;
  const submitBtn = form?.querySelector('button[type="submit"]') as HTMLButtonElement;
  
  if (!form || !input || !submitBtn) return;
  
  if (stopButtonTimeout) {
    clearTimeout(stopButtonTimeout);
    stopButtonTimeout = null;
  }
  
  input.disabled = !enabled;
  
  if (enabled) {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Send';
    submitBtn.classList.remove('stop-btn');
    submitBtn.onclick = null;
    input.focus();
  } else {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Send';
    submitBtn.classList.remove('stop-btn');
    
    stopButtonTimeout = setTimeout(() => {
      if (isStreaming()) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Stop';
        submitBtn.classList.add('stop-btn');
        submitBtn.onclick = (e) => {
          e.preventDefault();
          stopStreaming();
        };
      }
    }, 400);
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
  
  setStreaming(false);
  setFormEnabled(true);
}

/**
 * Stream response via REST API + WebSocket
 */
export async function streamResponse(prompt: string, model: string, imageData: string, newChat: boolean, cwd?: string): Promise<void> {
  setStreaming(true);
  
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
    setStreaming(false);
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
