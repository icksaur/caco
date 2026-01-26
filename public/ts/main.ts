/**
 * Main entry point - ties all modules together
 */

import { setupImagePaste, removeImage } from './image-paste.js';
import { scrollToBottom } from './ui-utils.js';
import { loadHistory, loadPreferences } from './history.js';
import { toggleSessionPanel, switchSession, deleteSession, showSessionManager, showNewChatUI } from './session-panel.js';
import { selectModel, loadModels, showNewChat } from './model-selector.js';
import { toggleActivityBox } from './activity.js';
import { setupFormHandler, stopStreaming } from './response-streaming.js';

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

// Scroll to bottom when new messages arrive (HTMX)
document.body.addEventListener('htmx:afterSwap', () => {
  scrollToBottom();
});

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
  // Set up event handlers
  setupImagePaste();
  setupFormHandler();
  
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
  const hasActiveSession = await loadPreferences();
  
  if (hasActiveSession) {
    // Active session exists - show chat with history
    loadHistory();
  } else {
    // No active session - show session manager as landing page
    showSessionManager();
  }
});
