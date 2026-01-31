/**
 * Message Streaming
 * 
 * Unified message rendering for chat, activity, and special message types.
 * Uses MessageInserter class to manage nested div structure:
 * 
 * #chat (parent)
 *   └─ message div (outer: user/assistant/activity/agent)
 *       └─ content div (inner: markdown-content, activity-item, etc.)
 * 
 * Pattern:
 * 1. ensureOuter(type) - get/create outer message div
 * 2. ensureInner(type) - get/create inner content div (for types that need it)
 * 3. Insert content into inner div
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

/** Get outer class for event type, or undefined if not mapped */
export function getOuterClass(eventType: string): string | undefined {
  return EVENT_TO_OUTER[eventType];
}

/** Legacy outer types for backward compatibility during migration */
type OuterType = 'user' | 'assistant' | 'activity' | 'agent';

/** Legacy outer div configurations (will be removed in Phase 2) */
const OUTER_CONFIG: Record<OuterType, { cssClass: string; template?: string }> = {
  user: {
    cssClass: 'message user'
  },
  assistant: {
    cssClass: 'chat-content',
    template: '<div class="outputs-container"></div><div class="markdown-content"></div>'
  },
  activity: {
    cssClass: 'message activity',
    template: `
      <div class="activity-header" onclick="window.toggleActivityBox?.(this)">
        <span class="activity-icon">▼</span>
        <span class="activity-label">Activity</span>
        <span class="activity-count"></span>
      </div>
      <div class="activity-box"></div>
    `
  },
  agent: {
    cssClass: 'message user agent'  // Agent messages look like user but styled differently
  }
};

/**
 * MessageInserter - manages nested message structure in #chat
 */
export class MessageInserter {
  private chat: HTMLElement;
  
  constructor() {
    this.chat = document.getElementById('chat')!;
  }
  
  // ==========================================================================
  // Phase 1: New event-type-based API
  // ==========================================================================
  
  /**
   * Get or create outer div for given event type.
   * Uses EVENT_TO_OUTER map to determine CSS class.
   * 
   * Reuse rules:
   * - user-message, agent-message, applet-message: always create new
   * - assistant-message, assistant-activity: reuse if last div matches
   */
  ensureOuterByEventType(eventType: string, forceNew: boolean = false): HTMLElement | null {
    const cssClass = EVENT_TO_OUTER[eventType];
    if (!cssClass) return null;
    
    const lastDiv = this.chat.lastElementChild as HTMLElement | null;
    
    // These types always create new div
    const alwaysNew = ['user-message', 'agent-message', 'applet-message'];
    if (forceNew || alwaysNew.includes(cssClass)) {
      return this.createOuterByClass(cssClass);
    }
    
    // For assistant-message and assistant-activity, reuse if matches
    if (lastDiv?.classList.contains(cssClass)) {
      return lastDiv;
    }
    
    return this.createOuterByClass(cssClass);
  }
  
  /**
   * Create new outer div with given CSS class
   */
  private createOuterByClass(cssClass: string): HTMLElement {
    const div = document.createElement('div');
    div.className = cssClass;
    this.chat.appendChild(div);
    scrollToBottom();
    return div;
  }
  
  /**
   * Append content to outer div (Phase 1: just append, will be messy with deltas)
   */
  appendContent(outer: HTMLElement, content: string): void {
    // For now, just append raw content
    // Phase 2 will add inner divs with replace logic
    outer.textContent = (outer.textContent || '') + content;
    scrollToBottom();
  }
  
  // ==========================================================================
  // Legacy API (will be removed in Phase 2)
  // ==========================================================================
  
  /**
   * Ensure outer message div exists for given type.
   * - user/agent: always create new
   * - assistant/activity: reuse if last div matches, else create new
   */
  ensureOuter(type: OuterType, forceNew: boolean = false): HTMLElement {
    const config = OUTER_CONFIG[type];
    const lastDiv = this.chat.lastElementChild as HTMLElement | null;
    
    // User and agent always create new div
    if (type === 'user' || type === 'agent' || forceNew) {
      return this.createOuter(type);
    }
    
    // For assistant/activity, check if we can reuse
    const mainClass = config.cssClass.split(' ')[0];
    if (lastDiv?.classList.contains(mainClass)) {
      return lastDiv;
    }
    
    return this.createOuter(type);
  }
  
  /**
   * Create new outer div
   */
  private createOuter(type: OuterType): HTMLElement {
    const config = OUTER_CONFIG[type];
    const div = document.createElement('div');
    div.className = config.cssClass;
    
    if (config.template) {
      div.innerHTML = config.template;
    }
    
    if (type === 'assistant') {
      div.setAttribute('data-markdown', '');
    }
    
    this.chat.appendChild(div);
    scrollToBottom();
    return div;
  }
  
  /**
   * Ensure inner content element exists within outer div.
   * Returns the element where content should be inserted.
   */
  ensureInner(outer: HTMLElement, type: OuterType): HTMLElement {
    switch (type) {
      case 'assistant':
        return outer.querySelector('.markdown-content') || outer;
      case 'activity':
        return outer.querySelector('.activity-box') || outer;
      default:
        return outer;
    }
  }
  
  /**
   * Insert user message
   */
  insertUser(content: string, hasImage: boolean = false, source?: 'user' | 'applet' | 'agent', appletSlug?: string): HTMLElement {
    const type: OuterType = source === 'agent' ? 'agent' : 'user';
    const outer = this.ensureOuter(type);
    
    const imageIndicator = hasImage ? ' <span class="image-indicator">[img]</span>' : '';
    outer.innerHTML = escapeHtml(content) + imageIndicator;
    
    if (source === 'applet') {
      outer.classList.add('applet');
      if (appletSlug) outer.dataset.appletSource = appletSlug;
    }
    
    scrollToBottom();
    return outer;
  }
  
  /**
   * Insert assistant content
   */
  insertAssistant(content: string, append: boolean = true): HTMLElement {
    const outer = this.ensureOuter('assistant');
    const inner = this.ensureInner(outer, 'assistant');
    
    if (append) {
      const existing = inner.textContent || '';
      if (existing) {
        inner.textContent = existing + '\n\n' + content;
      } else {
        inner.textContent = content;
      }
    } else {
      inner.textContent = content;
    }
    
    scrollToBottom();
    return outer;
  }
  
  /**
   * Insert activity item
   */
  insertActivity(itemType: string, text: string, details?: string): HTMLElement {
    const outer = this.ensureOuter('activity');
    const activityBox = this.ensureInner(outer, 'activity');
    
    // Create activity item element
    const itemDiv = document.createElement('div');
    itemDiv.className = `activity-item ${itemType}`;
    
    if (details) {
      const summary = document.createElement('div');
      summary.className = 'activity-summary';
      summary.textContent = text;
      summary.onclick = () => itemDiv.classList.toggle('expanded');
      itemDiv.appendChild(summary);
      
      const detailsDiv = document.createElement('div');
      detailsDiv.className = 'activity-details';
      detailsDiv.textContent = details;
      itemDiv.appendChild(detailsDiv);
    } else {
      itemDiv.textContent = text;
    }
    
    activityBox.appendChild(itemDiv);
    
    // Update count
    const count = activityBox.querySelectorAll('.activity-item').length;
    const countSpan = outer.querySelector('.activity-count');
    if (countSpan) countSpan.textContent = `(${count})`;
    
    // Scroll
    (activityBox as HTMLElement).scrollTop = activityBox.scrollHeight;
    scrollToBottom();
    
    return itemDiv;
  }
  
  /**
   * Get outputs container for current assistant message
   */
  getOutputsContainer(): HTMLElement | null {
    const chatDivs = this.chat.querySelectorAll('.chat-content');
    const lastChatDiv = chatDivs[chatDivs.length - 1];
    return lastChatDiv?.querySelector('.outputs-container') || null;
  }
  
  /**
   * Store output IDs on current assistant message
   */
  storeOutputIds(outer: HTMLElement, outputs: string[]): void {
    if (outputs.length > 0) {
      const existing = outer.getAttribute('data-outputs') || '';
      const combined = existing ? existing + ',' + outputs.join(',') : outputs.join(',');
      outer.setAttribute('data-outputs', combined);
    }
  }
}

// Singleton inserter
let inserter: MessageInserter | null = null;

function getInserter(): MessageInserter {
  if (!inserter) {
    inserter = new MessageInserter();
  }
  return inserter;
}

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
 * Phase 1: Uses new outer div classes via event type mapping
 */
function handleMessage(msg: ChatMessage): void {
  hideToast();
  const ins = getInserter();
  const eventType = messageToEventType(msg);
  
  // Try new Phase 1 rendering
  const outer = ins.ensureOuterByEventType(eventType);
  
  if (outer) {
    // New Phase 1 path
    const content = msg.content || msg.deltaContent || '';
    
    if (msg.role === 'user') {
      // User messages: escape HTML, show image indicator
      const imageIndicator = msg.hasImage ? ' [img]' : '';
      outer.innerHTML = escapeHtml(content) + imageIndicator;
      outer.setAttribute('data-message-id', msg.id);
    } else {
      // Assistant: append content (Phase 1 = messy deltas, Phase 2 = replace with inner)
      if (msg.deltaContent) {
        // Append delta
        outer.textContent = (outer.textContent || '') + msg.deltaContent;
      } else if (msg.content) {
        // Full content - for now just set it (overwrites deltas if any came first)
        outer.textContent = msg.content;
        outer.setAttribute('data-markdown', '');
        
        if (msg.outputs) {
          ins.storeOutputIds(outer, msg.outputs);
        }
      }
      
      // Render markdown when complete
      if (msg.status === 'complete' && window.renderMarkdownElement) {
        window.renderMarkdownElement(outer);
      }
    }
    
    if (msg.status === 'complete') {
      setStreaming(false);
      setFormEnabled(true);
    }
    
    scrollToBottom();
    return;
  }
  
  // Fallback to legacy path (should not happen with complete map)
  if (msg.role === 'user') {
    const div = ins.insertUser(
      msg.content || '',
      msg.hasImage,
      msg.source,
      msg.appletSlug
    );
    div.setAttribute('data-message-id', msg.id);
    
  } else {
    // Assistant message
    
    // Skip deltas - we only render complete content (for now)
    if (msg.deltaContent) {
      if (msg.status === 'complete') {
        setStreaming(false);
        setFormEnabled(true);
      }
      return;
    }
    
    // Complete content
    if (msg.content) {
      const outer = ins.insertAssistant(msg.content);
      
      if (msg.outputs) {
        ins.storeOutputIds(outer, msg.outputs);
      }
      
      // Render markdown unless loading history
      if (!isLoadingHistory() && window.renderMarkdown) {
        window.renderMarkdown();
      }
    }
    
    if (msg.status === 'complete') {
      setStreaming(false);
      setFormEnabled(true);
    }
  }
  
  scrollToBottom();
}

/**
 * Map ActivityItem type to SDK event type for Phase 1 rendering
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
 * Phase 1: Uses new assistant-activity class
 */
function handleActivity(item: ActivityItem): void {
  // Handle reload signal
  if (item.type === 'info' && item.text === 'Reload triggered') {
    window.location.reload();
    return;
  }
  
  const ins = getInserter();
  const eventType = activityToEventType(item);
  
  // Try new Phase 1 rendering
  const outer = ins.ensureOuterByEventType(eventType);
  
  if (outer) {
    // Phase 1: just append activity text
    const line = document.createElement('div');
    line.className = 'activity-line';
    line.textContent = item.text;
    if (item.details) {
      line.title = item.details;  // Show details on hover
    }
    outer.appendChild(line);
    scrollToBottom();
    return;
  }
  
  // Fallback to legacy
  ins.insertActivity(item.type, item.text, item.details);
}

/**
 * Handle output
 */
function handleOutput(outputId: string): void {
  const container = getInserter().getOutputsContainer();
  if (container) {
    renderOutputById(outputId, container).catch(err => 
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
