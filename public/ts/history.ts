/**
 * History and preferences loading
 */

import type { Preferences } from './types.js';
import { applyModelPreference, loadModels } from './model-selector.js';
import { initFromPreferences } from './app-state.js';
import { setLoadingHistory } from './message-streaming.js';
import { setFormEnabled } from './view-controller.js';
import { onHistoryComplete, getConnectionId } from './websocket.js';
import { clearContextFooter } from './context-footer.js';
import { regions } from './dom-regions.js';

const HISTORY_TIMEOUT_MS = 15000;

let historyPending = false;
let lastHistoryConnectionId = -1;

/**
 * Whether a history request is in-flight (waiting for historyComplete).
 * Used by reconnect logic to re-issue lost requests.
 */
export function isHistoryPending(): boolean {
  return historyPending;
}

/**
 * Whether the WS connection has changed since the last history load.
 * If true, the chat DOM may be stale (events missed during disconnect).
 */
export function isHistoryStale(): boolean {
  return getConnectionId() !== lastHistoryConnectionId;
}

/**
 * Wait for history to stream via WebSocket
 * Sets loadingHistory=true and clears chat.
 * 
 * During history loading, terminal events (session.idle) are guarded
 * from changing form state (see message-streaming.ts). The authoritative
 * busy state comes from the historyComplete message's isBusy flag.
 * 
 * Times out after 15 seconds to prevent permanent UI hang if the
 * WebSocket drops during history streaming.
 */
export function waitForHistoryComplete(): Promise<void> {
  setLoadingHistory(true);
  historyPending = true;
  
  // Clear existing chat and context footer before loading new history
  regions.chat.clear();
  clearContextFooter();
  
  return new Promise<void>((resolve) => {
    let settled = false;
    
    const finish = (data?: { isBusy?: boolean }) => {
      if (settled) return;
      settled = true;
      historyPending = false;
      lastHistoryConnectionId = getConnectionId();
      unsubscribe();
      clearTimeout(timer);
      setLoadingHistory(false);
      
      // Sync form/cursor state with session's actual busy status.
      // This is the authoritative state after history replay — overrides
      // any stale state from history terminal events or prior setFormEnabled calls.
      const isBusy = data?.isBusy ?? false;
      setFormEnabled(!isBusy);
      
      // If no messages loaded, show model selector
      if (regions.chat.el.children.length === 0) {
        loadModels();
      }
      resolve();
    };
    
    const unsubscribe = onHistoryComplete(finish);
    
    const timer = setTimeout(() => {
      console.warn('[HISTORY] Timed out waiting for historyComplete');
      finish();
    }, HISTORY_TIMEOUT_MS);
  });
}

/**
 * Load and apply user preferences
 * Returns the preferences (no side effects beyond initializing state)
 */
export async function loadPreferences(): Promise<Preferences | null> {
  try {
    const response = await fetch('/api/preferences');
    if (response.ok) {
      const prefs: Preferences = await response.json();
      
      // Initialize state from preferences
      initFromPreferences(prefs);
      
      // Apply model to UI (placeholder text)
      applyModelPreference(prefs);
      
      return prefs;
    }
  } catch (error) {
    console.error('Failed to load preferences:', error);
  }
  return null;
}
