/**
 * Response Streaming
 * 
 * Handles receiving streamed responses from the server via SSE.
 * Separated from message sending (which happens via POST).
 */

import type { ToolEventData, MessageEventData } from './types.js';
import { escapeHtml, scrollToBottom } from './ui-utils.js';
import { addActivityItem, formatToolArgs, formatToolResult, toggleActivityBox } from './activity.js';
import { renderDisplayOutput } from './display-output.js';
import { executeApplet, type AppletContent } from './applet-runtime.js';
import { removeImage } from './image-paste.js';
import { setStreaming, getActiveEventSource } from './state.js';
import { getNewChatCwd, showNewChatError } from './model-selector.js';
import { setViewState, isViewState } from './view-controller.js';

// Declare renderMarkdown global
declare global {
  interface Window {
    renderMarkdown?: () => void;
  }
}

/** Timeout for stop button appearance */
let stopButtonTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Add user message bubble immediately
 */
export function addUserBubble(message: string, hasImage: boolean): HTMLElement {
  const chat = document.getElementById('chat');
  if (!chat) throw new Error('Chat element not found');
  
  // Transition from new chat to conversation view
  setViewState('chatting');
  
  // Add user message
  const userDiv = document.createElement('div');
  userDiv.className = 'message user';
  userDiv.innerHTML = `${escapeHtml(message)}${hasImage ? ' <span class="image-indicator">[img]</span>' : ''}`;
  chat.appendChild(userDiv);
  
  // Add pending response with activity box
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
  
  // Scroll to bottom
  scrollToBottom();
  
  return assistantDiv;
}

import { getAndClearPendingAppletState } from './applet-runtime.js';

/**
 * Stream response: POST message first, then connect to SSE for response
 * 
 * This separates concerns:
 * - Sending (POST with large body for images)
 * - Receiving (GET SSE with just streamId)
 */
export async function streamResponse(prompt: string, model: string, imageData: string, newChat: boolean, cwd?: string): Promise<void> {
  setStreaming(true, null);
  
  try {
    // Collect pending applet state (if any) to send with message
    const appletState = getAndClearPendingAppletState();
    
    // Step 1: POST message to get streamId
    const response = await fetch('/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        prompt, 
        model, 
        imageData, 
        newChat, 
        cwd,
        ...(appletState && { appletState })  // Only include if has data
      })
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    
    const { streamId } = await response.json();
    
    // Step 2: Connect to SSE for response streaming
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
}

/**
 * Handle a single SSE event
 */
function handleSSEEvent(eventType: string, dataStr: string, responseDiv: Element | null, state: StreamState): void {
  try {
    const data = dataStr ? JSON.parse(dataStr) : {};
    
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
        
      case 'assistant.turn_start':
        addActivityItem('turn', `Turn ${parseInt(data.turnId || 0) + 1}...`);
        break;
        
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
        if (data._applet) executeApplet(data._applet as AppletContent);
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
  const responseDiv = document.querySelector('#pending-response .markdown-content');
  let responseContent = '';
  let firstDeltaReceived = false;
  
  const state: StreamState = {
    getContent: () => responseContent,
    setContent: (c: string) => { responseContent = c; },
    getFirstDelta: () => firstDeltaReceived,
    setFirstDelta: (v: boolean) => { firstDeltaReceived = v; }
  };

  // Handle response text deltas
  eventSource.addEventListener('assistant.message_delta', (e: MessageEvent) => {
    handleSSEEvent('assistant.message_delta', e.data, responseDiv, state);
  });
  
  // Handle final message
  eventSource.addEventListener('assistant.message', (e: MessageEvent) => {
    handleSSEEvent('assistant.message', e.data, responseDiv, state);
  });
  
  // Handle turn start
  eventSource.addEventListener('assistant.turn_start', (e: MessageEvent) => {
    handleSSEEvent('assistant.turn_start', e.data, responseDiv, state);
  });
  
  // Handle intent
  eventSource.addEventListener('assistant.intent', (e: MessageEvent) => {
    handleSSEEvent('assistant.intent', e.data, responseDiv, state);
  });
  
  // Handle tool execution
  eventSource.addEventListener('tool.execution_start', (e: MessageEvent) => {
    handleSSEEvent('tool.execution_start', e.data, responseDiv, state);
  });
  
  eventSource.addEventListener('tool.execution_complete', (e: MessageEvent) => {
    handleSSEEvent('tool.execution_complete', e.data, responseDiv, state);
  });
  
  // Handle errors
  eventSource.addEventListener('session.error', (e: MessageEvent) => {
    handleSSEEvent('session.error', e.data, responseDiv, state);
  });
  
  eventSource.addEventListener('error', (e: MessageEvent) => {
    handleSSEEvent('error', e.data || '{}', responseDiv, state);
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
    
    // Mark response as stopped
    const responseDiv = document.querySelector('#pending-response .markdown-content');
    if (responseDiv) {
      responseDiv.classList.remove('streaming-cursor');
    }
    
    finishPendingResponse();
  }
}

/**
 * Clean up pending response
 */
function finishPendingResponse(): void {
  const pending = document.getElementById('pending-response');
  if (pending) {
    pending.classList.remove('pending');
    pending.removeAttribute('id');
    
    // Remove streaming cursor
    const content = pending.querySelector('.markdown-content');
    if (content) {
      content.classList.remove('streaming-cursor');
    }
    
    // Collapse activity wrapper when done (user can re-expand)
    const wrapper = pending.querySelector('.activity-wrapper');
    if (wrapper) {
      wrapper.classList.add('collapsed');
      const icon = wrapper.querySelector('.activity-icon');
      if (icon) icon.textContent = '▶';
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
  const input = form?.querySelector('input[name="message"]') as HTMLInputElement;
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

/**
 * Set up form submission handler
 */
export function setupFormHandler(): void {
  const form = document.getElementById('chatForm') as HTMLFormElement;
  if (!form) return;
  
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    
    const input = form.querySelector('input[name="message"]') as HTMLInputElement;
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
    
    // Add user bubble immediately
    const hasImage = !!imageData;
    addUserBubble(message, hasImage);
    
    // Clear input and image
    input.value = '';
    removeImage();
    
    // Start streaming - explicitly pass whether this is a new chat
    streamResponse(message, model, imageData, isNewChat, cwd);
  });
}
