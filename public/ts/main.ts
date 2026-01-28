/**
 * Main entry point - ties all modules together
 */

import { setupImagePaste, removeImage } from './image-paste.js';
import { scrollToBottom, setupScrollDetection } from './ui-utils.js';
import { loadPreferences, waitForHistoryComplete } from './history.js';
import { toggleSessionPanel, switchSession, deleteSession, showSessionManager, showNewChatUI } from './session-panel.js';
import { selectModel, loadModels } from './model-selector.js';
import { toggleActivityBox } from './activity.js';
import { setupFormHandler, stopStreaming } from './response-streaming.js';
import { setupMarkdownRenderer } from './markdown-renderer.js';
import { initViewState, setViewState, isViewState } from './view-controller.js';
import { initAppletRuntime, loadAppletFromUrl } from './applet-runtime.js';
import { setupMultilineInput } from './multiline-input.js';
import { connectAppletWs, waitForConnect } from './applet-ws.js';

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
    toggleActivityBox: typeof toggleActivityBox;
    stopStreaming: typeof stopStreaming;
    toggleApplet: typeof toggleApplet;
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
window.toggleActivityBox = toggleActivityBox;
window.stopStreaming = stopStreaming;
window.toggleApplet = toggleApplet;

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
  // Initialize view state from DOM
  initViewState();
  
  // Initialize applet runtime (exposes setAppletState globally)
  initAppletRuntime();
  
  // Set up event handlers
  setupImagePaste();
  setupFormHandler();
  setupMarkdownRenderer();
  setupMultilineInput();
  setupScrollDetection();
  
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
  
  // Check for ?applet=slug param early
  const hasAppletParam = new URLSearchParams(window.location.search).has('applet');
  
  if (prefs?.lastSessionId) {
    // Active session exists - connect WS and wait for history
    connectAppletWs(prefs.lastSessionId);
    await waitForConnect();
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
    // No active session
    if (hasAppletParam) {
      // Applet requested but no session - load applet anyway
      await loadAppletFromUrl();
    } else {
      // Show session manager as landing page
      showSessionManager();
    }
  }
});
