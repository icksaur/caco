/**
 * Main entry point - ties all modules together
 */

import { setupImagePaste, removeImage } from './image-paste.js';
import { scrollToBottom } from './ui-utils.js';
import { loadHistory, loadPreferences } from './history.js';
import { toggleSessionPanel, toggleNewChatForm, createNewSession, switchSession, deleteSession } from './session-panel.js';
import { toggleModelDropdown, selectModel, loadModels, setupModelDropdownClose } from './model-selector.js';
import { toggleActivityBox } from './activity.js';
import { setupFormHandler, stopStreaming } from './streaming.js';

// Export functions to global scope for onclick handlers in HTML
declare global {
  interface Window {
    removeImage: typeof removeImage;
    scrollToBottom: typeof scrollToBottom;
    toggleSessionPanel: typeof toggleSessionPanel;
    toggleNewChatForm: typeof toggleNewChatForm;
    createNewSession: typeof createNewSession;
    switchSession: typeof switchSession;
    deleteSession: typeof deleteSession;
    toggleModelDropdown: typeof toggleModelDropdown;
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
window.toggleNewChatForm = toggleNewChatForm;
window.createNewSession = createNewSession;
window.switchSession = switchSession;
window.deleteSession = deleteSession;
window.toggleModelDropdown = toggleModelDropdown;
window.selectModel = selectModel;
window.loadModels = loadModels;
window.toggleActivityBox = toggleActivityBox;
window.stopStreaming = stopStreaming;

// Scroll to bottom when new messages arrive (HTMX)
document.body.addEventListener('htmx:afterSwap', () => {
  scrollToBottom();
});

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  // Set up event handlers
  setupImagePaste();
  setupFormHandler();
  setupModelDropdownClose();
  
  // Load initial state
  loadPreferences();
  loadHistory();
});
