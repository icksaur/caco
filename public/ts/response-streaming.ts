/**
 * Response Streaming
 * 
 * Handles receiving streamed responses from the server via WebSocket.
 * Unified message protocol: all messages (history and live) use same handler.
 */

import { escapeHtml, scrollToBottom, isAutoScrollEnabled, enableAutoScroll } from './ui-utils.js';
import { addActivityItem } from './activity.js';
import { setStreaming, getActiveSessionId, setActiveSession } from './state.js';
import { getNewChatCwd, showNewChatError } from './model-selector.js';
import { setViewState, isViewState } from './view-controller.js';
import { onMessage, onHistoryComplete, onActivity, isWsConnected, type ChatMessage, type ActivityItem } from './applet-ws.js';

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

/** Track if currently loading history */
let loadingHistory = false;

/**
 * Register all WebSocket handlers for messages and activity
 * Called once during app initialization
 */
function registerWsHandlers(): void {
  if (wsHandlersRegistered) return;
  wsHandlersRegistered = true;
  
  // Unified message handler for history and live streaming
  onMessage((msg: ChatMessage) => {
    console.log('[WS] Received message:', msg.id, msg.role, msg.status || 'complete', 
      msg.deltaContent ? `delta(${msg.deltaContent.length})` : '',
      loadingHistory ? '(history)' : '(live)');
    handleMessage(msg);
  });
  
  // History complete handler
  onHistoryComplete(() => {
    console.log('[WS] History streaming complete');
    loadingHistory = false;
    // Render markdown for all history messages
    if (window.renderMarkdown) window.renderMarkdown();
    // Scroll to bottom after history loads
    scrollToBottom(true);
  });
  
  // Activity handler for tool calls, intents, errors
  onActivity((item: ActivityItem) => {
    console.log('[WS] Activity:', item.type, item.text);
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
 * Create a new message element
 */
function createMessage(msg: ChatMessage): void {
  if (msg.role === 'user') {
    renderUserBubble(
      msg.content || '', 
      msg.hasImage ?? false, 
      msg.source ?? 'user', 
      msg.appletSlug,
      msg.id
    );
  } else {
    // Assistant message - could be complete (history) or streaming (live)
    if (msg.status === 'streaming' || !msg.content) {
      // Start streaming response
      addPendingResponse(msg.id);
      setStreaming(true);
    } else {
      // Complete message (history)
      renderAssistantBubble(msg.id, msg.content, msg.outputs);
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
  finishPendingResponse();
}

/**
 * Mark that we're loading history (suppress pending response for history messages)
 */
export function setLoadingHistory(loading: boolean): void {
  loadingHistory = loading;
}

/**
 * Render completed assistant message (from history or finalized)
 */
function renderAssistantBubble(id: string, content: string, outputs?: string[]): void {
  const chat = document.getElementById('chat');
  if (!chat) return;
  
  const assistantDiv = document.createElement('div');
  assistantDiv.className = 'message assistant';
  assistantDiv.setAttribute('data-markdown', '');
  assistantDiv.setAttribute('data-message-id', id);
  
  // Create inner structure
  const activityWrapper = document.createElement('div');
  activityWrapper.className = 'activity-wrapper';
  activityWrapper.style.display = 'none';
  activityWrapper.innerHTML = `
    <div class="activity-header" onclick="toggleActivityBox(this)">
      <span class="activity-icon">▶</span>
      <span class="activity-label">Activity</span>
      <span class="activity-count"></span>
    </div>
    <div class="activity-box"></div>
  `;
  
  const outputsContainer = document.createElement('div');
  outputsContainer.className = 'outputs-container';
  
  const markdownContent = document.createElement('div');
  markdownContent.className = 'markdown-content';
  markdownContent.textContent = content; // Raw text for markdown processor
  
  assistantDiv.appendChild(activityWrapper);
  assistantDiv.appendChild(outputsContainer);
  assistantDiv.appendChild(markdownContent);
  chat.appendChild(assistantDiv);
  
  // Store output IDs for later restoration
  if (outputs && outputs.length > 0) {
    assistantDiv.setAttribute('data-outputs', outputs.join(','));
  }
  
  // Only render markdown immediately if not loading history (batched later)
  if (!loadingHistory && window.renderMarkdown) {
    window.renderMarkdown();
  }
}

/**
 * Render user message bubble (unified renderer)
 * Called either directly (fallback) or from WS message handler
 */
function renderUserBubble(
  content: string, 
  hasImage: boolean, 
  source: 'user' | 'applet' = 'user',
  appletSlug?: string,
  messageId?: string
): HTMLElement {
  const chat = document.getElementById('chat');
  if (!chat) throw new Error('Chat element not found');
  
  // Transition from new chat to conversation view
  setViewState('chatting');
  
  // Add user message with applet styling if applicable
  const userDiv = document.createElement('div');
  userDiv.className = `message user${source === 'applet' ? ' applet-invoked' : ''}`;
  if (messageId) {
    userDiv.setAttribute('data-message-id', messageId);
  }
  if (source === 'applet' && appletSlug) {
    userDiv.dataset.appletSource = appletSlug;
  }
  userDiv.innerHTML = `${escapeHtml(content)}${hasImage ? ' <span class="image-indicator">[img]</span>' : ''}`;
  chat.appendChild(userDiv);
  
  // Enable auto-scroll and scroll to bottom when user sends a message
  enableAutoScroll();
  scrollToBottom(true);
  
  return userDiv;
}

/**
 * Add pending assistant response placeholder
 * Called when streaming starts
 */
function addPendingResponse(messageId: string): HTMLElement {
  const chat = document.getElementById('chat');
  if (!chat) throw new Error('Chat element not found');
  
  const assistantDiv = document.createElement('div');
  assistantDiv.className = 'message assistant pending';
  assistantDiv.id = 'pending-response';
  assistantDiv.setAttribute('data-markdown', '');
  assistantDiv.setAttribute('data-message-id', messageId);
  assistantDiv.innerHTML = `
    <div class="activity-wrapper">
      <div class="activity-header" onclick="toggleActivityBox(this)">
        <span class="activity-icon">▶</span>
        <span class="activity-label">Activity</span>
        <span class="activity-count"></span>
      </div>
      <div class="activity-box"></div>
    </div>
    <div class="outputs-container"></div>
    <div class="markdown-content streaming-cursor"></div>
  `;
  chat.appendChild(assistantDiv);
  
  scrollToBottom(true);
  return assistantDiv;
}

/**
 * Add user message bubble immediately (legacy interface for fallback)
 * Used when WS is not connected. Generates local IDs.
 */
export function addUserBubble(message: string, hasImage: boolean): HTMLElement {
  const userId = `local_user_${Date.now()}`;
  const assistantId = `local_assistant_${Date.now()}`;
  renderUserBubble(message, hasImage, 'user', undefined, userId);
  return addPendingResponse(assistantId);
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
        throw new Error(error.error || `HTTP ${sessionRes.status}`);
      }
      
      const sessionData = await sessionRes.json();
      sessionId = sessionData.sessionId;
      setActiveSession(sessionId, sessionData.cwd);
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
    addActivityItem('error', `Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    finishPendingResponse();
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
      if (getActiveEventSource()) {
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
    
    // Unified rendering path:
    // - WS connected: server broadcasts user message, then streams assistant response
    // - WS not connected: fallback direct render (new chat before WS ready)
    if (!isWsConnected()) {
      // Fallback: direct bubble add (WS not ready or new chat)
      // Generate a temporary ID for local rendering
      addUserBubble(message, hasImage);
    }
    // If WS connected, user bubble comes from server broadcast
    // Assistant pending response is created when server sends status:'streaming' message
    
    // Clear input and image, reset textarea height
    input.value = '';
    resetTextareaHeight();
    removeImage();
    
    // HTTP POST is the single path for sending messages to agent
    streamResponse(message, model, imageData, isNewChat, cwd);
  });
}
