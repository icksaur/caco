/**
 * SSE Streaming implementation
 */

import type { ToolEventData, MessageEventData } from './types.js';
import { escapeHtml, scrollToBottom } from './ui-utils.js';
import { addActivityItem, formatToolArgs, formatToolResult, toggleActivityBox } from './activity.js';
import { renderDisplayOutput } from './display-output.js';
import { removeImage } from './image-paste.js';
import { setStreaming, getActiveEventSource } from './state.js';
import { hideNewChat, getNewChatCwd, showNewChatError } from './model-selector.js';

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
  
  // Hide new chat form, show chat (transition from new chat to conversation)
  hideNewChat();
  
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

/**
 * Stream response via EventSource
 */
export function streamResponse(prompt: string, model: string, imageData: string, cwd?: string): void {
  // Build URL with parameters
  const params = new URLSearchParams({ prompt, model });
  if (imageData) {
    params.set('imageData', imageData);
  }
  if (cwd) {
    params.set('cwd', cwd);
  }
  
  const eventSource = new EventSource(`/api/stream?${params.toString()}`);
  setStreaming(true, eventSource);
  
  const responseDiv = document.querySelector('#pending-response .markdown-content');
  let responseContent = '';
  let firstDeltaReceived = false;
  
  // Handle response text deltas
  eventSource.addEventListener('assistant.message_delta', (e: MessageEvent) => {
    const data: MessageEventData = JSON.parse(e.data);
    if (data.deltaContent) {
      responseContent += data.deltaContent;
      if (responseDiv) responseDiv.textContent = responseContent;
      
      // Collapse activity wrapper on first delta
      if (!firstDeltaReceived) {
        const wrapper = document.querySelector('#pending-response .activity-wrapper');
        if (wrapper) {
          wrapper.classList.add('collapsed');
          const icon = wrapper.querySelector('.activity-icon');
          if (icon) icon.textContent = '▶';
        }
        firstDeltaReceived = true;
      }
      
      scrollToBottom();
    }
  });
  
  // Handle final message
  eventSource.addEventListener('assistant.message', (e: MessageEvent) => {
    const data: MessageEventData = JSON.parse(e.data);
    if (data.content && responseDiv) {
      // Set final content as text (renderMarkdown will parse it)
      responseDiv.textContent = data.content;
      responseDiv.classList.remove('streaming-cursor');
      
      // Mark as not processed so renderMarkdown will handle it
      const pending = document.getElementById('pending-response');
      if (pending) {
        pending.dataset.markdownProcessed = 'false';
      }
      
      // Render markdown (with DOMPurify sanitization)
      if (typeof window.renderMarkdown === 'function') {
        window.renderMarkdown();
      }
    }
  });
  
  // Handle turn start
  eventSource.addEventListener('assistant.turn_start', (e: MessageEvent) => {
    const data = JSON.parse(e.data);
    addActivityItem('turn', `Turn ${parseInt(data.turnId || 0) + 1}...`);
  });
  
  // Handle intent
  eventSource.addEventListener('assistant.intent', (e: MessageEvent) => {
    const data = JSON.parse(e.data);
    if (data.intent) {
      addActivityItem('intent', `Intent: ${data.intent}`);
    }
  });
  
  // Handle tool execution
  eventSource.addEventListener('tool.execution_start', (e: MessageEvent) => {
    const data: ToolEventData = JSON.parse(e.data);
    const toolName = data.toolName || data.name || 'tool';
    const args = formatToolArgs(data.arguments);
    const summary = `▶ ${toolName}`;
    const details = args ? `Arguments: ${args}` : null;
    addActivityItem('tool', summary, details);
  });
  
  eventSource.addEventListener('tool.execution_complete', (e: MessageEvent) => {
    const data: ToolEventData = JSON.parse(e.data);
    const toolName = data.toolName || data.name || 'tool';
    const status = data.success ? '✓' : '✗';
    const summary = `${status} ${toolName}`;
    const details = data.result ? formatToolResult(data.result) : null;
    addActivityItem('tool-result', summary, details);
    
    // Display output if present (from display-only tools)
    if (data._output) {
      renderDisplayOutput(data._output);
    }
  });
  
  // Handle errors
  eventSource.addEventListener('session.error', (e: MessageEvent) => {
    const data = JSON.parse(e.data);
    addActivityItem('error', `Error: ${data.message || 'Unknown error'}`);
  });
  
  eventSource.addEventListener('error', (e: MessageEvent) => {
    const data = JSON.parse(e.data || '{}');
    addActivityItem('error', `Error: ${data.message || 'Connection error'}`);
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
    
    // If we haven't received any content, show error
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
    
    // If new chat form is visible and cwd is empty, show error
    const newChat = document.getElementById('newChat');
    if (newChat && !newChat.classList.contains('hidden') && !cwd) {
      showNewChatError('Please enter a working directory');
      return;
    }
    
    // Definitive model logging
    console.log('[MODEL] Client sending request with model:', model || '(undefined)');
    if (cwd) console.log('[CWD] New session cwd:', cwd);
    
    if (!message) return;
    
    // Disable form during streaming
    setFormEnabled(false);
    
    // Add user bubble immediately
    const hasImage = !!imageData;
    addUserBubble(message, hasImage);
    
    // Clear input and image
    input.value = '';
    removeImage();
    
    // Start streaming (pass cwd for new sessions)
    streamResponse(message, model, imageData, cwd);
  });
}
