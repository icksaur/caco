/**
 * History and preferences loading
 */

import type { Preferences } from './types.js';
import { scrollToBottom } from './ui-utils.js';
import { applyModelPreference, loadModels } from './model-selector.js';
import { initFromPreferences } from './state.js';
import { setViewState } from './view-controller.js';
import { restoreOutputsFromHistory } from './display-output.js';
import { setLoadingHistory } from './response-streaming.js';
import { onHistoryComplete } from './applet-ws.js';

// Declare renderMarkdown as a global function from markdown-renderer.js
declare global {
  interface Window {
    renderMarkdown?: () => void;
  }
}

/**
 * Wait for history to stream via WebSocket
 * Assumes WS is already connected and streaming has started
 */
export function waitForHistoryComplete(): Promise<void> {
  setLoadingHistory(true);
  
  return new Promise<void>((resolve) => {
    const unsubscribe = onHistoryComplete(() => {
      unsubscribe();
      setLoadingHistory(false);
      finishHistoryLoad();
      resolve();
    });
    
    // Timeout fallback (5 seconds)
    setTimeout(() => {
      unsubscribe();
      setLoadingHistory(false);
      finishHistoryLoad();
      resolve();
    }, 5000);
  });
}

/**
 * Load conversation history via HTTP (fallback for non-WS)
 */
export async function loadHistoryHttp(): Promise<void> {
  try {
    const response = await fetch('/api/history');
    if (response.ok) {
      const html = await response.text();
      const chat = document.getElementById('chat');
      if (chat && html.trim()) {
        chat.innerHTML = html;
        setViewState('chatting');
        if (typeof window.renderMarkdown === 'function') {
          window.renderMarkdown();
        }
        await restoreOutputsFromHistory();
      } else {
        setViewState('newChat');
        loadModels();
      }
    } else {
      setViewState('newChat');
      loadModels();
    }
  } catch (error) {
    console.error('Failed to load history:', error);
    setViewState('newChat');
    loadModels();
  }
}

/**
 * Finish history loading (after WS streaming completes)
 */
function finishHistoryLoad(): void {
  const chat = document.getElementById('chat');
  if (chat && chat.children.length > 0) {
    setViewState('chatting');
    if (typeof window.renderMarkdown === 'function') {
      window.renderMarkdown();
    }
    restoreOutputsFromHistory().catch(err => 
      console.error('Failed to restore outputs:', err)
    );
    scrollToBottom(true);
  } else {
    setViewState('newChat');
    loadModels();
  }
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
