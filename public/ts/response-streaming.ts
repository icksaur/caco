/**
 * Response Streaming
 * 
 * Handles receiving streamed responses from the server via WebSocket.
 * Unified message protocol: all messages (history and live) use same handler.
 */

import { escapeHtml, scrollToBottom, isAutoScrollEnabled, enableAutoScroll } from './ui-utils.js';
import { addActivityItem } from './activity.js';
import { setStreaming, isStreaming, getActiveSessionId, setActiveSession, isLoadingHistory, setLoadingHistory } from './app-state.js';
import { getNewChatCwd, showNewChatError } from './model-selector.js';
import { isViewState, setViewState } from './view-controller.js';
import { onMessage, onHistoryComplete, onActivity, isWsConnected, type ChatMessage, type ActivityItem } from './websocket.js';
import { showToast, hideToast } from './toast.js';

// Declare renderMarkdown global
declare global {
  interface Window {
    renderMarkdown?: () => void;
  }
}

/** Timeout for stop button appearance */
let stopButtonTimeout: ReturnType<typeof setTimeout> | null = null;

/** Track if WS handlers are registered */
let wsHandlersRegistered = false;

// ============================================================================
// Bubble Rendering - Unified System
// ============================================================================

/**
 * Message variant determines styling (CSS class suffix)
 * All bubbles use same structure, only class differs
 */
export type MessageVariant = 'user' | 'assistant' | 'applet' | 'agent' | 'error' | 'system';

/**
 * Options for creating a message bubble
 */
interface BubbleOptions {
  id: string;
  role: 'user' | 'assistant';
  variant?: MessageVariant;          // Defaults to role
  content?: string;
  appletSlug?: string;               // For applet variant
  hasImage?: boolean;                // For user variant
  streaming?: boolean;               // For assistant variant
  outputs?: string[];                // For assistant variant
}

/**
 * Get CSS classes for a bubble based on options
 */
function getBubbleClasses(options: BubbleOptions): string {
  const classes = ['message', options.role];
  
  // Add variant class if different from role
  const variant = options.variant ?? options.role;
  if (variant !== options.role) {
    classes.push(variant);
  }
  
  // State classes
  if (options.streaming) {
    classes.push('pending');
  }
  
  return classes.join(' ');
}

/**
 * Create the inner HTML for a user-type bubble
 */
function createUserBubbleInner(content: string, hasImage?: boolean): string {
  const imageIndicator = hasImage ? ' <span class="image-indicator">[img]</span>' : '';
  return `${escapeHtml(content)}${imageIndicator}`;
}

/**
 * Create the inner HTML for an assistant-type bubble
 */
function createAssistantBubbleInner(content: string, streaming?: boolean): string {
  const cursorClass = streaming ? ' streaming-cursor' : '';
  return `
    <div class="activity-wrapper${streaming ? '' : '" style="display: none'}">
      <div class="activity-header" onclick="toggleActivityBox(this)">
        <span class="activity-icon">▶</span>
        <span class="activity-label">Activity</span>
        <span class="activity-count"></span>
      </div>
      <div class="activity-box"></div>
    </div>
    <div class="outputs-container"></div>
    <div class="markdown-content${cursorClass}">${escapeHtml(content)}</div>
  `;
}

/**
 * Unified bubble renderer
 * All message types go through this function
 */
function renderBubble(options: BubbleOptions): HTMLElement {
  const chat = document.getElementById('chat');
  if (!chat) throw new Error('Chat element not found');
  
  const div = document.createElement('div');
  div.className = getBubbleClasses(options);
  div.setAttribute('data-message-id', options.id);
  
  // Role determines structure
  if (options.role === 'user') {
    div.innerHTML = createUserBubbleInner(options.content || '', options.hasImage);
    // Store applet source for CSS styling
    if (options.variant === 'applet' && options.appletSlug) {
      div.dataset.appletSource = options.appletSlug;
    }
  } else {
    div.setAttribute('data-markdown', '');
    div.innerHTML = createAssistantBubbleInner(options.content || '', options.streaming);
    if (options.streaming) {
      div.id = 'pending-response';
    }
    // Store output IDs for later restoration
    if (options.outputs && options.outputs.length > 0) {
      div.setAttribute('data-outputs', options.outputs.join(','));
    }
  }
  
  chat.appendChild(div);
  return div;
}

// ============================================================================
// WebSocket Message Handlers
// ============================================================================

/**
 * Register all WebSocket handlers for messages and activity
 * Called once during app initialization
 */
function registerWsHandlers(): void {
  if (wsHandlersRegistered) return;
  wsHandlersRegistered = true;
  
  // Unified message handler for history and live streaming
  onMessage((msg: ChatMessage) => {
    // Hide any error toast when we get stream messages
    hideToast();
    handleMessage(msg);
  });
  
  // History complete handler
  onHistoryComplete(() => {
    setLoadingHistory(false);
    // Render markdown for all history messages
    if (window.renderMarkdown) window.renderMarkdown();
    // Scroll to bottom after history loads
    scrollToBottom(true);
  });
  
  // Activity handler for tool calls, intents, errors
  onActivity((item: ActivityItem) => {
    addActivityItem(item.type, item.text, item.details);
  });
}

/**
 * Handle a message from WebSocket (unified protocol)
 * - Creates new bubbles
 * - Updates existing bubbles (streaming)
 * - Finalizes bubbles (complete)
 */
function handleMessage(msg: ChatMessage): void {
  // Find existing message element by ID
  const existing = document.querySelector(`[data-message-id="${msg.id}"]`);
  
  if (existing) {
    // Update existing message
    if (msg.deltaContent) {
      appendContent(existing, msg.deltaContent);
    }
    if (msg.status === 'complete') {
      finalizeMessage(existing, msg);
    }
  } else {
    // Create new message
    createMessage(msg);
  }
}

/**
 * Create a new message element using unified renderBubble
 */
function createMessage(msg: ChatMessage): void {
  if (msg.role === 'user') {
    // Determine variant based on source
    let variant: MessageVariant = 'user';
    if (msg.source === 'applet') variant = 'applet';
    else if (msg.source === 'agent') variant = 'agent';
    
    renderBubble({
      id: msg.id,
      role: 'user',
      variant,
      content: msg.content || '',
      hasImage: msg.hasImage,
      appletSlug: msg.appletSlug,
    });
    
    enableAutoScroll();
    scrollToBottom(true);
  } else {
    // Assistant message - could be complete (history) or streaming (live)
    if (msg.status === 'streaming' || !msg.content) {
      // Check if pending response already exists (created by activity)
      const existingPending = document.getElementById('pending-response');
      if (existingPending) {
        // Update the ID to match the server's message ID
        existingPending.setAttribute('data-message-id', msg.id);
        setStreaming(true);
      } else {
        // Start streaming response
        renderBubble({
          id: msg.id,
          role: 'assistant',
          streaming: true,
        });
        setStreaming(true);
      }
    } else {
      // Complete message (history)
      renderBubble({
        id: msg.id,
        role: 'assistant',
        content: msg.content,
        outputs: msg.outputs,
      });
      
      // Only render markdown immediately if not loading history (batched later)
      if (!isLoadingHistory() && window.renderMarkdown) {
        window.renderMarkdown();
      }
    }
  }
}

/**
 * Append delta content to existing streaming message
 */
function appendContent(element: Element, delta: string): void {
  const markdownDiv = element.querySelector('.markdown-content');
  if (markdownDiv) {
    markdownDiv.textContent = (markdownDiv.textContent || '') + delta;
    
    // Collapse activity box after first content
    const wrapper = element.querySelector('.activity-wrapper');
    if (wrapper && !wrapper.classList.contains('collapsed')) {
      wrapper.classList.add('collapsed');
      const icon = wrapper.querySelector('.activity-icon');
      if (icon) icon.textContent = '▶';
    }
    
    scrollToBottom();
  }
}

/**
 * Finalize a streaming message (mark complete)
 */
function finalizeMessage(element: Element, msg: ChatMessage): void {
  element.classList.remove('pending');
  element.removeAttribute('id'); // Remove pending-response id
  
  const markdownDiv = element.querySelector('.markdown-content');
  if (markdownDiv) {
    markdownDiv.classList.remove('streaming-cursor');
    // If final content provided, use it
    if (msg.content) {
      markdownDiv.textContent = msg.content;
    }
  }
  
  setStreaming(false);
  
  // Collapse activity wrapper
  const wrapper = element.querySelector('.activity-wrapper');
  if (wrapper) {
    wrapper.classList.add('collapsed');
    const icon = wrapper.querySelector('.activity-icon');
    if (icon) icon.textContent = '▶';
  }
  
  // Enable form
  setFormEnabled(true);
  
  // Render markdown for the completed message
  (element as HTMLElement).dataset.markdownProcessed = 'false';
  if (window.renderMarkdown) window.renderMarkdown();
  
  scrollToBottom(true);
}

// Re-export setLoadingHistory for external callers (from app-state)
export { setLoadingHistory };

/**
 * Add user message bubble immediately (legacy interface for fallback)
 * Used when WS is not connected. Generates local IDs.
 */
export function addUserBubble(message: string, hasImage: boolean): HTMLElement {
  const userId = `local_user_${Date.now()}`;
  const assistantId = `local_assistant_${Date.now()}`;
  
  // Render user bubble
  renderBubble({
    id: userId,
    role: 'user',
    content: message,
    hasImage,
  });
  
  enableAutoScroll();
  scrollToBottom(true);
  
  // Render pending assistant bubble and return it
  const pending = renderBubble({
    id: assistantId,
    role: 'assistant',
    streaming: true,
  });
  
  scrollToBottom(true);
  return pending;
}

import { getAndClearPendingAppletState, getNavigationContext } from './applet-runtime.js';

/**
 * Stream response using RESTful API:
 * 
 * 1. If newChat: POST /sessions to create session → get sessionId
 * 2. POST /sessions/:id/messages → get streamId
 * 3. GET /stream/:streamId for SSE response
 * 
 * This separates concerns:
 * - Session creation (explicit resource creation)
 * - Message sending (targets specific session)
 * - Response streaming (lightweight SSE connection)
 */
export async function streamResponse(prompt: string, model: string, imageData: string, newChat: boolean, cwd?: string): Promise<void> {
  setStreaming(true);
  
  try {
    // Collect pending applet state (if any) to send with message
    const appletState = getAndClearPendingAppletState();
    // Always collect navigation context for agent queries
    const appletNavigation = getNavigationContext();
    
    let sessionId = getActiveSessionId();
    
    // Step 1: Create new session if this is a new chat
    if (newChat || !sessionId) {
      const sessionRes = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, model })
      });
      
      if (!sessionRes.ok) {
        const error = await sessionRes.json().catch(() => ({ error: 'Session creation failed' }));
        // Handle 409 Conflict (directory locked by another session)
        if (sessionRes.status === 409 && error.code === 'CWD_LOCKED') {
          // Use server's error message which includes cwd path
          throw new Error(error.error || 'Directory is locked by another session');
        }
        throw new Error(error.error || `HTTP ${sessionRes.status}`);
      }
      
      const sessionData = await sessionRes.json();
      sessionId = sessionData.sessionId;
      setActiveSession(sessionId, sessionData.cwd);
      
      // Switch to chatting view now that we have a session
      setViewState('chatting');
      
      // WebSocket is already connected on page load and setActiveSession
      // configures message filtering for the new session
    }
    
    // Step 2: POST message to session, get streamId
    const response = await fetch(`/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        prompt, 
        imageData,
        ...(appletState && { appletState }),  // Only include if has data
        appletNavigation  // Always include navigation context
      })
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    
    // Server returns ok, streaming happens via WebSocket
    await response.json();
    
    // Step 3: Response streaming now happens via WebSocket (see setupWsStreamHandlers)
    // The WS handlers are already registered, nothing more to do here
    
  } catch (error) {
    console.error('Send message error:', error);
    setStreaming(false);
    setFormEnabled(true);  // Re-enable form so user can retry
    
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    // Restore user's message to input so they can retry
    const input = document.querySelector('#chatForm textarea') as HTMLTextAreaElement;
    if (input) {
      input.value = prompt;
      // Trigger input event to resize textarea
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    
    // Show toast (floats above input, doesn't disturb chat)
    showToast(errorMessage);
  }
}

/**
 * Stop streaming response
 */
export function stopStreaming(): void {
  // With WebSocket, we just mark the UI as stopped
  // TODO: Send cancel signal to server if needed
  setStreaming(false);
  
  // Add visual feedback
  addActivityItem('info', 'Stopped by user');
  
  // Mark all response divs as stopped (multi-turn creates multiple)
  const pending = document.getElementById('pending-response');
  if (pending) {
    pending.querySelectorAll('.markdown-content').forEach(div => {
      div.classList.remove('streaming-cursor');
    });
  }
  
  finishPendingResponse();
}

/**
 * Clean up pending response
 */
async function finishPendingResponse(): Promise<void> {
  const pending = document.getElementById('pending-response');
  if (pending) {
    pending.classList.remove('pending');
    pending.removeAttribute('id');
    
    // Remove streaming cursor from ALL content divs (multi-turn creates multiple)
    pending.querySelectorAll('.markdown-content').forEach(content => {
      content.classList.remove('streaming-cursor');
    });
    
    // Collapse activity wrapper when done (user can re-expand)
    const wrapper = pending.querySelector('.activity-wrapper');
    if (wrapper) {
      wrapper.classList.add('collapsed');
      const icon = wrapper.querySelector('.activity-icon');
      if (icon) icon.textContent = '▶';
    }
    
    // Check if auto-scroll is still enabled (user didn't scroll up)
    const shouldScroll = isAutoScrollEnabled();
    
    // Render markdown (may not have been triggered if no assistant.message event)
    pending.dataset.markdownProcessed = 'false';
    if (typeof window.renderMarkdown === 'function') {
      await window.renderMarkdown();
    }
    
    // Scroll after markdown render if auto-scroll still enabled
    if (shouldScroll) {
      requestAnimationFrame(() => {
        scrollToBottom(true);
      });
    }
  }
  
  // Re-enable form
  setFormEnabled(true);
}

/**
 * Enable/disable form during streaming
 */
export function setFormEnabled(enabled: boolean): void {
  const form = document.getElementById('chatForm') as HTMLFormElement;
  const input = form?.querySelector('textarea[name="message"]') as HTMLTextAreaElement;
  const submitBtn = form?.querySelector('button[type="submit"]') as HTMLButtonElement;
  
  if (!form || !input || !submitBtn) return;
  
  // Clear any pending stop button timeout
  if (stopButtonTimeout) {
    clearTimeout(stopButtonTimeout);
    stopButtonTimeout = null;
  }
  
  input.disabled = !enabled;
  
  if (enabled) {
    // Restore to Send button
    submitBtn.disabled = false;
    submitBtn.textContent = 'Send';
    submitBtn.classList.remove('stop-btn');
    submitBtn.onclick = null;
    input.focus();
  } else {
    // Briefly disable to prevent double-tap, then show Stop
    submitBtn.disabled = true;
    submitBtn.textContent = 'Send';
    submitBtn.classList.remove('stop-btn');
    
    stopButtonTimeout = setTimeout(() => {
      // Only show stop if still streaming
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

import { resetTextareaHeight } from './multiline-input.js';

/**
 * Set up form submission handler
 */
export function setupFormHandler(): void {
  // Register WS handlers for messages and activity
  registerWsHandlers();
  
  const form = document.getElementById('chatForm') as HTMLFormElement;
  if (!form) return;
  
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    
    const input = form.querySelector('textarea[name="message"]') as HTMLTextAreaElement;
    const message = input.value.trim();
    const modelInput = document.getElementById('selectedModel') as HTMLInputElement;
    const model = modelInput?.value;
    const imageData = (document.getElementById('imageData') as HTMLInputElement).value;
    
    // Get cwd from new chat form (will be empty if in existing chat)
    const cwd = getNewChatCwd();
    const isNewChat = isViewState('newChat');
    const sessionId = getActiveSessionId();
    
    // DEBUG: Show state when sending
    console.log('[SEND DEBUG]', {
      viewState: isNewChat ? 'newChat' : 'chatting',
      isNewChat,
      sessionId,
      cwd,
      willCreateSession: isNewChat || !sessionId
    });
    
    // If new chat form is visible and cwd is empty, show error
    if (isNewChat && !cwd) {
      showNewChatError('Please enter a working directory');
      return;
    }
    
    // Definitive model logging
    console.log('[MODEL] Client sending request with model:', model || '(undefined)');
    if (isNewChat) console.log('[NEW CHAT] Creating new session with cwd:', cwd);
    
    if (!message) return;
    
    // Disable form during streaming
    setFormEnabled(false);
    
    const hasImage = !!imageData;
    
    // For new chats, don't render locally - WS will connect and server will broadcast
    // For existing sessions with broken WS, render locally as fallback
    // (streamResponse will wait for WS connect on new chats before POSTing)
    
    // Clear input and image, reset textarea height
    input.value = '';
    resetTextareaHeight();
    removeImage();
    
    // HTTP POST is the single path for sending messages to agent
    streamResponse(message, model, imageData, isNewChat, cwd);
  });
}
