/**
 * Main entry point - ties all modules together
 */

import { setupImagePaste, removeImage } from './image-paste.js';
import { scrollToBottom } from './ui-utils.js';
import { loadPreferences, waitForHistoryComplete } from './history.js';
import { toggleSessionPanel, switchSession, deleteSession, showSessionManager, showNewChatUI } from './session-panel.js';
import { selectModel, loadModels } from './model-selector.js';
import { setupFormHandler, stopStreaming } from './message-streaming.js';
import { setupMarkdownRenderer } from './markdown-renderer.js';
import { initViewState, setViewState, isViewState } from './view-controller.js';
import { initAppletRuntime, loadAppletFromUrl } from './applet-runtime.js';
import { initInputRouter } from './input-router.js';
import { setupMultilineInput } from './multiline-input.js';
import { connectWs, setActiveSession, requestHistory, waitForConnect, reconnectIfNeeded } from './websocket.js';
import { hideToast } from './toast.js';
import { initHostnameHash } from './hostname-hash.js';

/**
 * Toggle between chatting and applet views
 */
function toggleApplet(): void {
  if (isViewState('applet')) {
    setViewState('chatting');
  } else {
    setViewState('applet');
  }
}

// Export functions to global scope for onclick handlers in HTML
declare global {
  interface Window {
    removeImage: typeof removeImage;
    scrollToBottom: typeof scrollToBottom;
    toggleSessionPanel: typeof toggleSessionPanel;
    showNewChat: typeof showNewChatUI;
    switchSession: typeof switchSession;
    deleteSession: typeof deleteSession;
    selectModel: typeof selectModel;
    loadModels: typeof loadModels;
    toggleActivityBox?: (el: HTMLElement) => void;
    stopStreaming: typeof stopStreaming;
    toggleApplet: typeof toggleApplet;
    hideToast: typeof hideToast;
  }
}

// Attach to window for HTML onclick handlers
window.removeImage = removeImage;
window.scrollToBottom = scrollToBottom;
window.toggleSessionPanel = toggleSessionPanel;
window.showNewChat = showNewChatUI;
window.switchSession = switchSession;
window.deleteSession = deleteSession;
window.selectModel = selectModel;
window.loadModels = loadModels;
// toggleActivityBox is set by setupFormHandler()
window.stopStreaming = stopStreaming;
window.toggleApplet = toggleApplet;
window.hideToast = hideToast;

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
  // Initialize view state from DOM
  initViewState();
  
  // Initialize input router (global keyboard event routing)
  initInputRouter();
  
  // Initialize applet runtime (exposes setAppletState globally)
  initAppletRuntime();
  
  // Connect WebSocket once on page load
  connectWs();
  await waitForConnect();
  
  // Reconnect WS when page becomes visible (e.g., returning from another tab)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      reconnectIfNeeded();
    }
  });
  
  // Additional reconnection triggers for laptop sleep/lock scenarios (Windows compatibility)
  window.addEventListener('focus', () => {
    reconnectIfNeeded();
  });
  
  window.addEventListener('online', () => {
    reconnectIfNeeded();
  });
  
  // Set up event handlers
  setupImagePaste();
  setupFormHandler();
  setupMarkdownRenderer();
  setupMultilineInput();
  
  // Initialize hostname-based favicon and button colors
  initHostnameHash();
  
  // Fetch models once on page load
  try {
    const response = await fetch('/api/sessions');
    if (response.ok) {
      const data = await response.json();
      if (data.models && data.models.length > 0) {
        const { setAvailableModels } = await import('./model-selector.js');
        setAvailableModels(data.models);
      }
    }
  } catch (e) {
    console.error('Failed to fetch models on startup:', e);
  }
  
  // Load preferences to check for active session
  const prefs = await loadPreferences();
  
  // Check URL params
  const urlParams = new URLSearchParams(window.location.search);
  const hasAppletParam = urlParams.has('applet');
  const sessionParam = urlParams.get('session');
  
  // Determine which session to load: URL param takes priority over preferences
  const targetSessionId = sessionParam || prefs?.lastSessionId;
  
  if (targetSessionId) {
    // Session specified - set active and request history
    setActiveSession(targetSessionId);
    requestHistory(targetSessionId);
    await waitForHistoryComplete();
    
    // Set view based on URL param (applet takes priority)
    if (hasAppletParam) {
      await loadAppletFromUrl();
    } else {
      // No applet - show chat or new chat based on history
      const chat = document.getElementById('chat');
      if (chat && chat.children.length > 0) {
        setViewState('chatting');
      } else {
        setViewState('newChat');
      }
    }
  } else {
    // No session specified
    if (hasAppletParam) {
      // Applet requested but no session - load applet anyway
      await loadAppletFromUrl();
    } else {
      // Show session manager as landing page
      showSessionManager();
    }
  }
});
