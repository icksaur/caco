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

import { debug } from './debug.js';
import { scrollToBottom } from './ui-utils.js';
import { getActiveSessionId, isLoadingHistory, getSelectedModel, notifyMessageSent, onSessionArchived } from './app-state.js';
import { isViewState } from './view-controller.js';
import { onEvent, onReconnect, type SessionEvent } from './websocket.js';
import { showToast } from './toast.js';
import { getAndClearPendingAppletState, getNavigationContext } from './applet-runtime.js';
import { isTerminalEvent } from './terminal-events.js';
import { hasInserter } from './dom-regions.js';
import { notifySessionComplete } from './notifications.js';
import { markSessionObserved } from './session-observed.js';
import { ChatRegion, regions, CONTENT_EVENTS } from './dom-regions.js';
import { sessionTracker } from './session-state-tracker.js';
import { adHocBar } from './adhoc-bar.js';
import { fetchWithTimeout } from './fetch-timeout.js';
import { chatView } from './chat-view-controller.js';
import { formStateStore } from './form-state-store.js';
import { dropCachedTranscript } from './transcript-cache.js';

let chatRegion: ChatRegion;

export function setResponseOptions(options: string[]): void {
  formStateStore.set({ options });
}

/** Dispatch a prompt via the streaming pipeline. Used by
 *  ChatFormController.handleSubmit. */
export function dispatchPrompt(args: {
  message: string;
  imageData: string;
  newChat: boolean;
  cwd?: string;
}): void {
  const model = getSelectedModel();
  void streamResponse(args.message, model, args.imageData, args.newChat, args.cwd);
}

/** POST a steer to a busy session. Used by
 *  ChatFormController.handleSubmit. */
export function dispatchSteer(sessionId: string, message: string): Promise<Response> {
  return fetch(`/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: message, mode: 'immediate' }),
  });
}

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

  if (eventType === 'caco.throughput') {
    const activeId = getActiveSessionId();
    if (activeId) {
      chatView.updateThroughputData(activeId, data as Record<string, unknown>);
    }
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
    chatRegion.removeThinking();
    
    if (!isLoadingHistory()) {
      const sessionId = getActiveSessionId();
      if (sessionId) {
        sessionTracker.setBusy(sessionId, false);
        
        if (eventType === 'session.idle') {
          void markSessionObserved(sessionId);
          adHocBar.clearSession(sessionId);
          notifySessionComplete(sessionTracker.getIntent(sessionId) || '');
          chatView.getChattingForm()?.resetSteerCount();
          // Final settle-scroll: the last streaming event scrolled before the
          // assistant message's markdown/code finished reflowing, so it can
          // undershoot. Defer past two frames so layout has settled, then snap
          // to the very bottom.
          requestAnimationFrame(() => requestAnimationFrame(() => scrollToBottom()));
          void fetch(`/api/sessions/${sessionId}/state`).then(r => r.json()).then(d => {
            if (d.responseOptions?.length) {
              formStateStore.set({ options: d.responseOptions });
            }
          }).catch(() => {});
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
  
  // Skip turn_start during history replay (ephemeral indicator, no value in replay)
  // and after session went idle (prevents ghost "Thinking..." from late events)
  if (eventType === 'assistant.turn_start') {
    if (isLoadingHistory()) return;
    const activeId = getActiveSessionId();
    if (activeId && !sessionTracker.isBusy(activeId)) return;
  }

  // Render event (create/find elements + set content). Only scroll if the
  // event actually maps to a chat-region inserter — otherwise side-channel
  // events like caco.edit, caco.usage, caco.fs.changed unnecessarily yank
  // the chat scrollbar to the bottom on every poll.
  chatRegion.renderEvent(event);
  if (!isLoadingHistory() && hasInserter(eventType)) scrollToBottom();
}

let messageStreamingInitialized = false;
const wsHandlerDisposers: Array<() => void> = [];

function registerWsHandlers(): void {
  const disposers: Array<() => void> = [];
  try {
    disposers.push(onEvent(handleEvent));

    // Tracker drives form state for active session
    disposers.push(sessionTracker.onChange((sessionId, state) => {
      if (sessionId === getActiveSessionId() && !isLoadingHistory()) {
        chatView.setFormEnabled(!state.busy);
      }
    }));

    disposers.push(onReconnect(() => {
      const sessionId = getActiveSessionId();
      if (!sessionId || !isViewState('chatting')) return;
      if (chatView.getViewState() !== 'chatting') return;

      void chatView.reloadHistory(sessionId);
    }));

    wsHandlerDisposers.push(...disposers);
  } catch (e) {
    for (const d of disposers.reverse()) { try { d(); } catch { /* ignore */ } }
    throw e;
  }
}

/**
 * Stop streaming
 */
export function stopStreaming(): void {
  const sessionId = getActiveSessionId();
  if (sessionId) {
    fetch(`/api/sessions/${sessionId}/cancel`, { method: 'POST' })
      .then(r => r.json())
      .then(data => {
        if (data.forced) {
          showToast('Session force-stopped', { type: 'info', autoHideMs: 3000 });
        }
      })
      .catch(err => {
        console.error('Failed to cancel:', err);
        showToast('Failed to stop session');
      });
  }
}

const SEND_TIMEOUT_MS = 30000;
const SESSION_CREATE_TIMEOUT_MS = 30000;

/**
 * Stream response via REST API + WebSocket
 */
export async function streamResponse(prompt: string, model: string, imageData: string, newChat: boolean, cwd?: string): Promise<void> {
  const currentId = getActiveSessionId();
  const launchActiveId = currentId;
  let targetSessionId: string | null = currentId;
  chatView.savePrompt(prompt, currentId || '');
  if (currentId) notifyMessageSent(currentId);
  
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
      
      debug('SEND', 'Creating new session...');
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
      targetSessionId = sessionId;
      // Session-keyed state is always applied — it is correct wherever the user
      // navigated and is required for failure recovery. Only the view switch
      // (onNewSessionCreated) is gated: if the user moved to another session
      // during create, the new session still dispatches in the background but
      // does not yank the view.
      chatView.savePrompt(prompt, sessionId || '');
      if (sessionId) notifyMessageSent(sessionId);
      debug('SEND', 'Session created:', sessionId);
      const superseded = getActiveSessionId() !== launchActiveId;
      if (!superseded) {
        chatView.onNewSessionCreated(sessionId || '', data.cwd);
      }
      sessionTracker.setBusy(sessionId!, true);
    }
    
    const requestId = `req-${Date.now().toString(36)}`;
    debug('SEND', `Posting message to ${sessionId} (${requestId})`);
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
    
    debug('SEND', `Message accepted (${requestId})`);
    
  } catch (error) {
    console.error('[SEND] Error:', error);
    
    // HTTP-level failure — POST itself failed, restore prompt. Recovery targets
    // the dispatch target (captured at send time), not whatever session is
    // active now — the user may have navigated away mid-flight.
    const failedSessionId = targetSessionId;
    if (failedSessionId) {
      sessionTracker.setBusy(failedSessionId, false);
      chatView.restoreFailedPrompt(failedSessionId);
    } else {
      // New-chat create failed before a session id existed; the form/draft was
      // cleared on send, so put the text back if still on the new-chat surface.
      chatView.restoreNewChatPrompt(prompt);
    }
    // Only re-enable the form the user is actually looking at: the new-chat
    // surface (no active session), or the dispatch target if still active.
    const stillOnTarget = failedSessionId === null
      ? getActiveSessionId() === null
      : failedSessionId === getActiveSessionId();
    if (stillOnTarget) {
      chatView.setFormEnabled(true);
    }
    
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    showToast(errorMessage);
  }
}

// Setup

/**
 * Initialize WS-driven message streaming.
 *
 * R3.5: This used to be `setupFormHandler` and also wired all the
 * per-form submit/stop/options listeners — those are now owned by
 * ChatFormController.attach(). What remains here is the chatRegion
 * setup and WS handler registration, which are application-scoped
 * (one chat surface, one WS connection).
 */
export function initMessageStreaming(): void {
  if (messageStreamingInitialized) return;
  chatRegion = new ChatRegion(regions.chat);
  chatRegion.setupClickHandler();
  registerWsHandlers();
  // Evict a session's cached transcript when it is archived/deleted so a reused
  // id can never re-render a gone session's history.
  wsHandlerDisposers.push(onSessionArchived(id => dropCachedTranscript(id)));
  messageStreamingInitialized = true;
}

/**
 * Tear down the WS/tracker subscriptions registered by initMessageStreaming so
 * the next init re-wires cleanly. Test seam + future soft-reload hook; no
 * production caller today. Does NOT undo ChatRegion's click handler (it owns no
 * disposer yet), so a real reload path must add one before relying on this.
 */
export function disposeMessageStreaming(): void {
  for (const dispose of wsHandlerDisposers.splice(0)) {
    try { dispose(); } catch { /* ignore */ }
  }
  messageStreamingInitialized = false;
}
