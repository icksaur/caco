/**
 * Response Streaming
 * 
 * Handles receiving streamed responses from the server via SSE.
 * Separated from message sending (which happens via POST or WebSocket).
 */

import type { ToolEventData, MessageEventData } from './types.js';
import { escapeHtml, scrollToBottom, isAutoScrollEnabled, enableAutoScroll } from './ui-utils.js';
import { addActivityItem, formatToolArgs, formatToolResult, toggleActivityBox } from './activity.js';
import { renderDisplayOutput } from './display-output.js';
import { removeImage } from './image-paste.js';
import { setStreaming, getActiveEventSource, getActiveSessionId, setActiveSession } from './state.js';
import { getNewChatCwd, showNewChatError } from './model-selector.js';
import { setViewState, isViewState } from './view-controller.js';
import { onUserMessage, isWsConnected, wsSendMessage, type UserMessage } from './applet-ws.js';

// Declare renderMarkdown global
declare global {
  interface Window {
    renderMarkdown?: () => void;
  }
}

/** Timeout for stop button appearance */
let stopButtonTimeout: ReturnType<typeof setTimeout> | null = null;

/** Track if WS message handler is registered */
let wsHandlerRegistered = false;

/**
 * Register WebSocket message handler for unified rendering
 * Called once during app initialization
 */
function registerWsMessageHandler(): void {
  if (wsHandlerRegistered) return;
  wsHandlerRegistered = true;
  
  onUserMessage((msg: UserMessage) => {
    console.log('[WS] Received userMessage:', msg.id, msg.source);
    renderUserBubble(msg.content, msg.hasImage, msg.source, msg.appletSlug);
  });
}

/**
 * Render user message bubble (unified renderer)
 * Called either directly (fallback) or from WS message handler
 */
function renderUserBubble(
  content: string, 
  hasImage: boolean, 
  source: 'user' | 'applet' = 'user',
  appletSlug?: string
): HTMLElement {
  const chat = document.getElementById('chat');
  if (!chat) throw new Error('Chat element not found');
  
  // Transition from new chat to conversation view
  setViewState('chatting');
  
  // Add user message with applet styling if applicable
  const userDiv = document.createElement('div');
  userDiv.className = `message user${source === 'applet' ? ' applet-invoked' : ''}`;
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
 * Called after user bubble is rendered
 */
function addPendingResponse(): HTMLElement {
  const chat = document.getElementById('chat');
  if (!chat) throw new Error('Chat element not found');
  
  const assistantDiv = document.createElement('div');
  assistantDiv.className = 'message assistant pending';
  assistantDiv.id = 'pending-response';
  assistantDiv.setAttribute('data-markdown', '');
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
 * Add user message bubble immediately (legacy interface)
 * Now wraps renderUserBubble + addPendingResponse
 */
export function addUserBubble(message: string, hasImage: boolean): HTMLElement {
  renderUserBubble(message, hasImage, 'user');
  return addPendingResponse();
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
  setStreaming(true, null);
  
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
    
    const { streamId } = await response.json();
    
    // Step 3: Connect to SSE for response streaming
    const eventSource = new EventSource(`/api/stream/${streamId}`);
    setStreaming(true, eventSource);
    setupEventSourceHandlers(eventSource);
    
  } catch (error) {
    console.error('Send message error:', error);
    setStreaming(false, null);
    addActivityItem('error', `Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    finishPendingResponse();
  }
}

interface StreamState {
  getContent: () => string;
  setContent: (c: string) => void;
  getFirstDelta: () => boolean;
  setFirstDelta: (v: boolean) => void;
  getResponseDiv: () => Element | null;
  setResponseDiv: (div: Element | null) => void;
}

/**
 * Finalize current turn content and create a new content div for next turn
 */
function startNewTurn(state: StreamState): void {
  const pending = document.getElementById('pending-response');
  if (!pending) return;
  
  const currentDiv = state.getResponseDiv();
  
  // Always remove cursor from current div
  if (currentDiv) {
    currentDiv.classList.remove('streaming-cursor');
  }
  
  // Render markdown for current div if it has content
  if (currentDiv && state.getContent().trim()) {
    pending.dataset.markdownProcessed = 'false';
    if (typeof window.renderMarkdown === 'function') window.renderMarkdown();
  }
  
  // Create new content div for next turn - append at end to maintain order
  const newDiv = document.createElement('div');
  newDiv.className = 'markdown-content streaming-cursor';
  pending.appendChild(newDiv);
  
  // Reset state for new turn
  state.setResponseDiv(newDiv);
  state.setContent('');
  
  // Re-expand activity box for new turn
  const wrapper = pending.querySelector('.activity-wrapper');
  if (wrapper) {
    wrapper.classList.remove('collapsed');
    const icon = wrapper.querySelector('.activity-icon');
    if (icon) icon.textContent = '▼';
  }
  state.setFirstDelta(false);
}

/**
 * Handle a single SSE event
 */
function handleSSEEvent(eventType: string, dataStr: string, state: StreamState): void {
  try {
    const data = dataStr ? JSON.parse(dataStr) : {};
    const responseDiv = state.getResponseDiv();
    
    switch (eventType) {
      case 'assistant.message_delta':
        if (data.deltaContent) {
          state.setContent(state.getContent() + data.deltaContent);
          if (responseDiv) responseDiv.textContent = state.getContent();
          
          if (!state.getFirstDelta()) {
            const wrapper = document.querySelector('#pending-response .activity-wrapper');
            if (wrapper) {
              wrapper.classList.add('collapsed');
              const icon = wrapper.querySelector('.activity-icon');
              if (icon) icon.textContent = '▶';
            }
            state.setFirstDelta(true);
          }
          scrollToBottom();
        }
        break;
        
      case 'assistant.message':
        if (data.content && responseDiv) {
          responseDiv.textContent = data.content;
          responseDiv.classList.remove('streaming-cursor');
          const pending = document.getElementById('pending-response');
          if (pending) pending.dataset.markdownProcessed = 'false';
          if (typeof window.renderMarkdown === 'function') window.renderMarkdown();
        }
        break;
        
      case 'assistant.turn_start': {
        const turnNum = parseInt(data.turnId || 0) + 1;
        addActivityItem('turn', `Turn ${turnNum}...`);
        // Only start new content div if this isn't the first turn
        if (turnNum > 1) {
          startNewTurn(state);
        }
        break;
      }
        
      case 'assistant.intent':
        if (data.intent) addActivityItem('intent', `Intent: ${data.intent}`);
        break;
        
      case 'tool.execution_start': {
        const toolName = data.toolName || data.name || 'tool';
        const args = formatToolArgs(data.arguments);
        addActivityItem('tool', `▶ ${toolName}`, args ? `Arguments: ${args}` : null);
        break;
      }
        
      case 'tool.execution_complete': {
        const toolName = data.toolName || data.name || 'tool';
        const status = data.success ? '✓' : '✗';
        addActivityItem('tool-result', `${status} ${toolName}`, data.result ? formatToolResult(data.result) : null);
        if (data._output) renderDisplayOutput(data._output);
        if (data._reload) {
          console.log('[RELOAD] Received reload signal, refreshing page...');
          setTimeout(() => location.reload(), 500);
        }
        break;
      }
        
      case 'session.error':
        addActivityItem('error', `Error: ${data.message || 'Unknown error'}`);
        break;
        
      case 'error':
        addActivityItem('error', `Error: ${data.message || 'Connection error'}`);
        break;
    }
  } catch (_e) {
    // Ignore parse errors
  }
}

/**
 * Setup event handlers for EventSource (GET streaming)
 */
function setupEventSourceHandlers(eventSource: EventSource): void {
  let responseDiv: Element | null = document.querySelector('#pending-response .markdown-content');
  let responseContent = '';
  let firstDeltaReceived = false;
  
  const state: StreamState = {
    getContent: () => responseContent,
    setContent: (c: string) => { responseContent = c; },
    getFirstDelta: () => firstDeltaReceived,
    setFirstDelta: (v: boolean) => { firstDeltaReceived = v; },
    getResponseDiv: () => responseDiv,
    setResponseDiv: (div: Element | null) => { responseDiv = div; }
  };

  // Handle response text deltas
  eventSource.addEventListener('assistant.message_delta', (e: MessageEvent) => {
    handleSSEEvent('assistant.message_delta', e.data, state);
  });
  
  // Handle final message
  eventSource.addEventListener('assistant.message', (e: MessageEvent) => {
    handleSSEEvent('assistant.message', e.data, state);
  });
  
  // Handle turn start
  eventSource.addEventListener('assistant.turn_start', (e: MessageEvent) => {
    handleSSEEvent('assistant.turn_start', e.data, state);
  });
  
  // Handle intent
  eventSource.addEventListener('assistant.intent', (e: MessageEvent) => {
    handleSSEEvent('assistant.intent', e.data, state);
  });
  
  // Handle tool execution
  eventSource.addEventListener('tool.execution_start', (e: MessageEvent) => {
    handleSSEEvent('tool.execution_start', e.data, state);
  });
  
  eventSource.addEventListener('tool.execution_complete', (e: MessageEvent) => {
    handleSSEEvent('tool.execution_complete', e.data, state);
  });
  
  // Handle errors
  eventSource.addEventListener('session.error', (e: MessageEvent) => {
    handleSSEEvent('session.error', e.data, state);
  });
  
  eventSource.addEventListener('error', (e: MessageEvent) => {
    handleSSEEvent('error', e.data || '{}', state);
  });
  
  // Handle completion
  eventSource.addEventListener('done', () => {
    eventSource.close();
    setStreaming(false, null);
    finishPendingResponse();
  });
  
  eventSource.addEventListener('session.idle', () => {
    // Will also receive 'done', but handle just in case
  });
  
  // Handle connection errors
  eventSource.onerror = (err) => {
    console.error('EventSource error:', err);
    eventSource.close();
    setStreaming(false, null);
    
    if (!responseContent && !firstDeltaReceived) {
      addActivityItem('error', 'Connection lost');
    }
    
    finishPendingResponse();
  };
}

/**
 * Stop streaming response
 */
export function stopStreaming(): void {
  const activeEventSource = getActiveEventSource();
  if (activeEventSource) {
    activeEventSource.close();
    setStreaming(false, null);
    
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
  // Register WS message handler for unified rendering
  registerWsMessageHandler();
  
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
    
    // For existing sessions with WS connected, send via WS for unified rendering
    // The WS handler will render the bubble when the echo comes back
    // For new chats or when WS not connected, use legacy direct rendering
    if (!isNewChat && isWsConnected()) {
      console.log('[WS] Sending message via WebSocket');
      wsSendMessage(message, imageData || undefined, 'user');
      // Add pending response immediately (bubble comes from WS echo)
      addPendingResponse();
    } else {
      // Legacy path: direct bubble add (WS not ready or new chat)
      addUserBubble(message, hasImage);
    }
    
    // Clear input and image, reset textarea height
    input.value = '';
    resetTextareaHeight();
    removeImage();
    
    // Start streaming - explicitly pass whether this is a new chat
    streamResponse(message, model, imageData, isNewChat, cwd);
  });
}
