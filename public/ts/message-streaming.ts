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
import { getActiveSessionId, isLoadingHistory, getSelectedModel, getNewChatCwd } from './app-state.js';
import { showNewChatError } from './model-selector.js';
import { isViewState } from './view-controller.js';
import { onEvent, onReconnect, type SessionEvent } from './websocket.js';
import { showToast } from './toast.js';
import { getAndClearPendingAppletState, getNavigationContext } from './applet-runtime.js';
import { resetTextareaHeight, tryExecuteSlashCommand } from './multiline-input.js';
import { isTerminalEvent } from './terminal-events.js';
import { removeImage } from './image-paste.js';
import { notifySessionComplete } from './notifications.js';
import { markSessionObserved } from './session-observed.js';
import { ChatRegion, regions, CONTENT_EVENTS } from './dom-regions.js';
import { sessionTracker } from './session-state-tracker.js';
import { adHocBar } from './adhoc-bar.js';
import { fetchWithTimeout } from './fetch-timeout.js';
import { chatView } from './chat-view-controller.js';

let chatRegion: ChatRegion;

/**
 * Handle incoming SDK event (history or live)
 * Pure event router — no DOM queries or mutations on #chat children.
 * ChatRegion owns all #chat mutations; cross-region effects (scroll) stay here.
 */
function handleEvent(event: SessionEvent): void {
  let eventType = event.type;
  const data = event.data || {};
  
  if (eventType === 'user.message' && data.source && data.source !== 'user') {
    eventType = `caco.${data.source}`;
  }
  
  // Hide thinking indicator when content events arrive
  if (CONTENT_EVENTS.has(eventType)) {
    chatRegion.removeThinking();
  }
  
  // DEBUG: Log all event types received
  console.log(`[EVENT] ${eventType}`, data);
  
  // Handle context footer updates (no UI element, just footer update)
  if (eventType === 'caco.context') {
    const activeId = getActiveSessionId();
    if (activeId) {
      chatView.updateContextFiles(activeId, (data as { context: Record<string, string[]> }).context ?? {});
    }
    return;
  }
  
  if (eventType === 'session.usage_info') {
    const activeId = getActiveSessionId();
    if (activeId) {
      chatView.updateUsage(activeId, data as { tokenLimit?: number; currentTokens?: number });
    }
    return;
  }
  
  // Handle page reload signal from reload_page tool
  if (eventType === 'caco.reload') {
    location.reload();
    return;
  }
  
  // Drop stale session.error events — if tracker says active session isn't busy,
  // this error is from a previous or stale dispatch
  if (eventType === 'session.error' && !isLoadingHistory()) {
    const activeId = getActiveSessionId();
    if (activeId && !sessionTracker.isBusy(activeId)) {
      console.warn('[EVENT] Dropping stale session.error (session not busy):', data);
      return;
    }
  }
  
  // Terminal events: update tracker (which drives form state via subscriber)
  if (isTerminalEvent(eventType)) {
    chatRegion.removeStreamingCursors();
    
    if (!isLoadingHistory()) {
      const sessionId = getActiveSessionId();
      if (sessionId) {
        sessionTracker.setBusy(sessionId, false);
        
        if (eventType === 'session.idle') {
          void markSessionObserved(sessionId);
          adHocBar.clearSession(sessionId);
          notifySessionComplete(sessionTracker.getIntent(sessionId) || '');
        }

        // Server says dispatch failed — restore the user's prompt
        if (eventType === 'session.error' && data.restorePrompt) {
          chatView.restoreFailedPrompt(sessionId);
        }
      }
    }
  }
  
  // Reasoning finalization (special case)
  if (eventType === 'assistant.reasoning') {
    if (chatRegion.finalizeReasoning(event)) {
      if (!isLoadingHistory()) scrollToBottom();
      return;
    }
  }
  
  // Render event (create/find elements + set content)
  chatRegion.renderEvent(event);
  if (!isLoadingHistory()) scrollToBottom();
}

function registerWsHandlers(): void {
  onEvent(handleEvent);
  
  // Tracker drives form state for active session
  sessionTracker.onChange((sessionId, state) => {
    if (sessionId === getActiveSessionId() && !isLoadingHistory()) {
      chatView.setFormEnabled(!state.busy);
    }
  });
  
  onReconnect(() => {
    const sessionId = getActiveSessionId();
    if (!sessionId || !isViewState('chatting')) return;
    if (chatView.getViewState() !== 'chatting') return;
    
    void chatView.reloadHistory(sessionId);
  });
}

/**
 * Stop streaming
 */
export function stopStreaming(): void {
  const sessionId = getActiveSessionId();
  if (sessionId) {
    sessionTracker.setBusy(sessionId, false);
    fetch(`/api/sessions/${sessionId}/cancel`, { method: 'POST' })
      .catch(err => console.error('Failed to cancel:', err));
  }
  
  chatView.setFormEnabled(true);
}

const SEND_TIMEOUT_MS = 30000;
const SESSION_CREATE_TIMEOUT_MS = 30000;

/**
 * Stream response via REST API + WebSocket
 */
export async function streamResponse(prompt: string, model: string, imageData: string, newChat: boolean, cwd?: string): Promise<void> {
  const currentId = getActiveSessionId();
  chatView.savePrompt(prompt, currentId || '');
  
  if (currentId) {
    sessionTracker.setBusy(currentId, true);
  } else {
    chatView.setFormEnabled(false);
  }
  
  scrollToBottom();
  
  try {
    const appletState = getAndClearPendingAppletState();
    const appletNavigation = getNavigationContext();
    
    let sessionId = getActiveSessionId();
    
    if (newChat || !sessionId) {
      regions.chat.clear();
      
      console.log('[SEND] Creating new session...');
      const res = await fetchWithTimeout('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, model })
      }, SESSION_CREATE_TIMEOUT_MS);
      
      if (!res.ok) {
        const error = await res.json().catch(() => ({ error: 'Session creation failed' }));
        throw new Error(error.error || `HTTP ${res.status}`);
      }
      
      const data = await res.json();
      sessionId = data.sessionId;
      chatView.savePrompt(prompt, sessionId || '');
      console.log('[SEND] Session created:', sessionId);
      chatView.onNewSessionCreated(sessionId || '', data.cwd);
    }
    
    const requestId = `req-${Date.now().toString(36)}`;
    console.log(`[SEND] Posting message to ${sessionId} (${requestId})`);
    const res = await fetchWithTimeout(`/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'X-Request-Id': requestId
      },
      body: JSON.stringify({ 
        prompt, 
        imageData,
        ...(appletState && { appletState }),
        appletNavigation
      })
    }, SEND_TIMEOUT_MS);
    
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(error.error || `HTTP ${res.status}`);
    }
    
    console.log(`[SEND] Message accepted (${requestId})`);
    
  } catch (error) {
    console.error('[SEND] Error:', error);
    
    // HTTP-level failure — POST itself failed, restore prompt
    const sendSessionId = getActiveSessionId();
    if (sendSessionId) {
      sessionTracker.setBusy(sendSessionId, false);
      chatView.restoreFailedPrompt(sendSessionId);
    }
    chatView.setFormEnabled(true);
    
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    showToast(errorMessage);
  }
}

// Setup

/**
 * Set up form submission handler
 */
export function setupFormHandler(): void {
  chatRegion = new ChatRegion(regions.chat);
  chatRegion.setupClickHandler();
  registerWsHandlers();
  
  const form = document.getElementById('chatForm') as HTMLFormElement;
  if (!form) return;
  
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    
    const input = form.querySelector('textarea[name="message"]') as HTMLTextAreaElement;
    const message = input.value.trim();
    const model = getSelectedModel();
    const imageData = (document.getElementById('imageData') as HTMLInputElement).value;
    
    const cwd = getNewChatCwd();
    const isNewChat = isViewState('newChat');
    
    if (isNewChat && !cwd) {
      showNewChatError('Please enter a working directory');
      return;
    }
    
    if (!message) return;
    
    if (message.startsWith('/')) {
      if (tryExecuteSlashCommand(message)) {
        input.value = '';
        resetTextareaHeight();
        return;
      }
    }
    
    chatView.setFormEnabled(false);
    
    input.value = '';
    resetTextareaHeight();
    removeImage();
    
    void streamResponse(message, model, imageData, isNewChat, cwd);
  });
}
