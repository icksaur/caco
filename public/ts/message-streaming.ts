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
import { getActiveSessionId, setActiveSession, setLoadingHistory, isLoadingHistory, getSelectedModel, getAvailableModels } from './app-state.js';
import { getNewChatCwd, showNewChatError } from './model-selector.js';
import { isViewState, setViewState, setFormEnabled } from './view-controller.js';
import { onEvent, onReconnect, subscribeToSession, requestHistory, type SessionEvent } from './websocket.js';
import { showToast } from './toast.js';
import { getAndClearPendingAppletState, getNavigationContext } from './applet-runtime.js';
import { resetTextareaHeight } from './multiline-input.js';
import { isTerminalEvent } from './terminal-events.js';
import { removeImage } from './image-paste.js';
import { markSessionObserved } from './session-observed.js';
import { handleContextEvent, renderStatus } from './context-footer.js';
import { ChatRegion, regions, CONTENT_EVENTS } from './dom-regions.js';
import { isHistoryPending, waitForHistoryComplete } from './history.js';

// Re-export for external callers
export { setLoadingHistory };

let chatRegion: ChatRegion;
let noEventsTimer: ReturnType<typeof setTimeout> | null = null;
let lastSentPrompt = '';
const NO_EVENTS_TIMEOUT_MS = 60000;

function startNoEventsWatchdog(): void {
  clearNoEventsWatchdog();
  noEventsTimer = setTimeout(() => {
    noEventsTimer = null;
    console.warn('[SEND] No events received after 60s — dispatch may have failed');
    setFormEnabled(true);
    
    const input = document.querySelector('#chatForm textarea') as HTMLTextAreaElement;
    if (input && lastSentPrompt) {
      input.value = lastSentPrompt;
      input.dispatchEvent(new Event('input', { bubbles: true }));
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
  
  // Drop stale session.error events (e.g., timeout watchdog firing after idle).
  // If we're not loading history and the form is already enabled, we're not
  // streaming — so this error is from a previous or stale dispatch.
  if (eventType === 'session.error' && !isLoadingHistory()) {
    const form = document.querySelector('#chatForm textarea') as HTMLElement | null;
    const formEnabled = form && !form.closest('fieldset[disabled]') && !(form as HTMLTextAreaElement).disabled;
    if (formEnabled) {
      console.warn('[EVENT] Dropping stale session.error (form already enabled):', data);
      return;
    }
  }
  
  // Re-enable form on terminal events (streaming complete)
  // Check BEFORE outer/inner logic since terminal events may not have display elements
  if (isTerminalEvent(eventType)) {
    chatRegion.removeStreamingCursors();
    
    // Only change form state for LIVE events, not history replay.
    // History contains past session.idle events that would incorrectly
    // re-enable the form for a currently-busy session. The authoritative
    // busy state comes from historyComplete's isBusy flag instead.
    if (!isLoadingHistory()) {
      setFormEnabled(true);
      
      // Mark session as observed - user has seen the completed response
      if (eventType === 'session.idle') {
        const sessionId = getActiveSessionId();
        if (sessionId) {
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
  
  onReconnect(() => {
    const sessionId = getActiveSessionId();
    if (!sessionId || !isViewState('chatting')) return;
    
    // Re-request history if a request was in-flight when the WS dropped
    if (isHistoryPending()) {
      console.log('[WS] Re-requesting history after reconnect');
      requestHistory(sessionId);
      return;
    }
    
    // If we were streaming live and the WS dropped (e.g., server restart),
    // the partial DOM content is stale. Reload full history from disk
    // so the user sees the completed (or partial) response.
    void reloadAfterReconnect(sessionId);
  });
}

/**
 * Reload session history after a WS reconnect.
 * Syncs form state and replays history to recover from missed events.
 */
async function reloadAfterReconnect(sessionId: string): Promise<void> {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/state`);
    if (!res.ok) return;
    const data = await res.json() as { isBusy?: boolean };
    
    subscribeToSession(sessionId);
    requestHistory(sessionId);
    await waitForHistoryComplete();
    
    // If session is still busy, keep form disabled (live events will resume)
    if (data.isBusy) {
      setFormEnabled(false);
    }
  } catch {
    // Network error — leave UI as-is
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
 * Fetch with timeout. Rejects with a descriptive error if the request
 * doesn't complete within the given time.
 */
function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    fetch(url, { ...options, signal: controller.signal })
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}

const SEND_TIMEOUT_MS = 30000;
const SESSION_CREATE_TIMEOUT_MS = 30000;

/**
 * Stream response via REST API + WebSocket
 */
export async function streamResponse(prompt: string, model: string, imageData: string, newChat: boolean, cwd?: string): Promise<void> {
  setFormEnabled(false);
  lastSentPrompt = prompt;
  
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
      console.log('[SEND] Session created:', sessionId);
      setActiveSession(sessionId, data.cwd);
      subscribeToSession(sessionId);
      setViewState('chatting');
      
      const modelId = getSelectedModel();
      const models = getAvailableModels();
      const modelMatch = models.find(m => m.id === modelId);
      renderStatus(modelMatch?.name || modelId?.split('/').pop() || '', data.cwd || '');
    }
    
    console.log('[SEND] Posting message to', sessionId);
    const res = await fetchWithTimeout(`/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    
    console.log('[SEND] Message accepted by server');
    startNoEventsWatchdog();
    
  } catch (error) {
    console.error('[SEND] Error:', error);
    clearNoEventsWatchdog();
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
