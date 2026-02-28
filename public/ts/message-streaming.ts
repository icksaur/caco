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

/**
 * Handle incoming SDK event (history or live)
 * Pure event router — no DOM queries or mutations on #chat children.
 * ChatRegion owns all #chat mutations; cross-region effects (scroll) stay here.
 */
function handleEvent(event: SessionEvent): void {
  let eventType = event.type;
  const data = event.data || {};
  
  // Transform user.message with non-user source to synthetic type
  // This allows applet/agent/scheduler messages to have distinct styling
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
 * Stream response via REST API + WebSocket
 */
export async function streamResponse(prompt: string, model: string, imageData: string, newChat: boolean, cwd?: string): Promise<void> {
  setFormEnabled(false);
  
  try {
    const appletState = getAndClearPendingAppletState();
    const appletNavigation = getNavigationContext();
    
    let sessionId = getActiveSessionId();
    
    if (newChat || !sessionId) {
      // Clear chat history for new session
      regions.chat.clear();
      
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, model })
      });
      
      if (!res.ok) {
        const error = await res.json().catch(() => ({ error: 'Session creation failed' }));
        throw new Error(error.error || `HTTP ${res.status}`);
      }
      
      const data = await res.json();
      sessionId = data.sessionId;
      setActiveSession(sessionId, data.cwd);
      subscribeToSession(sessionId);
      setViewState('chatting');
      
      // Show model + cwd in footer status bar
      const modelId = getSelectedModel();
      const models = getAvailableModels();
      const modelMatch = models.find(m => m.id === modelId);
      renderStatus(modelMatch?.name || modelId?.split('/').pop() || '', data.cwd || '');
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
