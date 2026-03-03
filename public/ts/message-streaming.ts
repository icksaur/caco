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
import { getActiveSessionId, setActiveSession, isLoadingHistory, getSelectedModel, getAvailableModels } from './app-state.js';
import { getNewChatCwd, showNewChatError } from './model-selector.js';
import { isViewState, setViewState, setFormEnabled } from './view-controller.js';
import { onEvent, onReconnect, subscribeToSession, type SessionEvent } from './websocket.js';
import { showToast } from './toast.js';
import { getAndClearPendingAppletState, getNavigationContext } from './applet-runtime.js';
import { resetTextareaHeight } from './multiline-input.js';
import { isTerminalEvent } from './terminal-events.js';
import { removeImage } from './image-paste.js';
import { markSessionObserved } from './session-observed.js';
import { handleContextEvent, renderStatus } from './context-footer.js';
import { ChatRegion, regions, CONTENT_EVENTS } from './dom-regions.js';
import { sessionTracker } from './session-state-tracker.js';
import { historyLoader } from './history-loader.js';
import { fetchWithTimeout } from './fetch-timeout.js';

let chatRegion: ChatRegion;
let noEventsTimer: ReturnType<typeof setTimeout> | null = null;
let lastSentPrompt = '';
let lastSentSessionId = '';
const NO_EVENTS_TIMEOUT_MS = 60000;

function startNoEventsWatchdog(): void {
  clearNoEventsWatchdog();
  noEventsTimer = setTimeout(() => {
    noEventsTimer = null;
    console.warn('[SEND] No events received after 60s — dispatch may have failed');
    
    const activeId = getActiveSessionId();
    if (activeId) sessionTracker.setBusy(activeId, false);
    setFormEnabled(true);
    
    // Only restore the message if the user is still on the same session
    if (lastSentPrompt && lastSentSessionId === activeId) {
      const input = document.querySelector('#chatForm textarea') as HTMLTextAreaElement;
      if (input) {
        input.value = lastSentPrompt;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    
    showToast('No response received — try again.');
  }, NO_EVENTS_TIMEOUT_MS);
}

function clearNoEventsWatchdog(): void {
  if (noEventsTimer) {
    clearTimeout(noEventsTimer);
    noEventsTimer = null;
  }
}

/**
 * Handle incoming SDK event (history or live)
 * Pure event router — no DOM queries or mutations on #chat children.
 * ChatRegion owns all #chat mutations; cross-region effects (scroll) stay here.
 */
function handleEvent(event: SessionEvent): void {
  let eventType = event.type;
  const data = event.data || {};
  
  // Any live event means the dispatch is working — cancel the no-events watchdog
  if (!isLoadingHistory()) {
    clearNoEventsWatchdog();
  }
  
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
    handleContextEvent(data as { context: Record<string, string[]> });
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
        }
      }
    }
  }
  
  // Reasoning finalization (special case)
  if (eventType === 'assistant.reasoning') {
    if (chatRegion.finalizeReasoning(event)) {
      scrollToBottom();
      return;
    }
  }
  
  // Render event (create/find elements + set content)
  chatRegion.renderEvent(event);
  scrollToBottom();
}

function registerWsHandlers(): void {
  onEvent(handleEvent);
  
  // Tracker drives form state for active session
  sessionTracker.onChange((sessionId, state) => {
    if (sessionId === getActiveSessionId() && !isLoadingHistory()) {
      setFormEnabled(!state.busy);
    }
  });
  
  onReconnect(() => {
    const sessionId = getActiveSessionId();
    if (!sessionId || !isViewState('chatting')) return;
    
    // Don't reload if activateSession is already loading history
    if (historyLoader.loading) return;
    
    void historyLoader.load(sessionId);
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
  
  setFormEnabled(true);
}

const SEND_TIMEOUT_MS = 30000;
const SESSION_CREATE_TIMEOUT_MS = 30000;

/**
 * Stream response via REST API + WebSocket
 */
export async function streamResponse(prompt: string, model: string, imageData: string, newChat: boolean, cwd?: string): Promise<void> {
  lastSentPrompt = prompt;
  lastSentSessionId = getActiveSessionId() || '';
  
  // Mark busy optimistically — tracker subscriber disables form.
  // For new chats (no active session yet), disable form directly.
  const currentId = getActiveSessionId();
  if (currentId) {
    sessionTracker.setBusy(currentId, true);
  } else {
    setFormEnabled(false);
  }
  
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
      lastSentSessionId = sessionId || '';
      console.log('[SEND] Session created:', sessionId);
      setActiveSession(sessionId, data.cwd);
      subscribeToSession(sessionId);
      setViewState('chatting');
      
      const modelId = getSelectedModel();
      const models = getAvailableModels();
      const modelMatch = models.find(m => m.id === modelId);
      renderStatus(modelMatch?.name || modelId?.split('/').pop() || '', data.cwd || '');
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
    startNoEventsWatchdog();
    
  } catch (error) {
    console.error('[SEND] Error:', error);
    clearNoEventsWatchdog();
    
    const activeId = getActiveSessionId();
    if (activeId) sessionTracker.setBusy(activeId, false);
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
  chatRegion = new ChatRegion(regions.chat);
  chatRegion.setupClickHandler();
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
    
    void streamResponse(message, model, imageData, isNewChat, cwd);
  });
}
