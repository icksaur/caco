/**
 * History and preferences loading
 */

import type { Preferences } from './types.js';
import { scrollToBottom } from './ui-utils.js';
import { applyModelPreference, showNewChat, hideNewChat } from './model-selector.js';
import { initFromPreferences } from './state.js';

// Declare renderMarkdown as a global function from markdown-renderer.js
declare global {
  interface Window {
    renderMarkdown?: () => void;
  }
}

/**
 * Load conversation history on page load
 */
export async function loadHistory(): Promise<void> {
  try {
    const response = await fetch('/api/history');
    if (response.ok) {
      const html = await response.text();
      const chat = document.getElementById('chat');
      if (chat && html.trim()) {
        // Has messages - show chat, hide new chat form
        chat.innerHTML = html;
        hideNewChat();
        // Render any markdown in loaded messages
        if (typeof window.renderMarkdown === 'function') {
          window.renderMarkdown();
        }
        // Scroll to bottom after loading history
        scrollToBottom();
      } else {
        // No messages - show new chat form
        showNewChat();
      }
    } else {
      // Error loading - show new chat form
      showNewChat();
    }
  } catch (error) {
    console.error('Failed to load history:', error);
    showNewChat();
  }
}

/**
 * Load and apply user preferences
 * @returns true if there's an active session
 */
export async function loadPreferences(): Promise<boolean> {
  try {
    const response = await fetch('/api/preferences');
    if (response.ok) {
      const prefs: Preferences = await response.json();
      
      // Initialize state from preferences
      initFromPreferences(prefs);
      
      // Apply model to UI (placeholder text)
      applyModelPreference(prefs);
      
      // Return whether we have an active session
      return prefs.lastSessionId != null;
    }
  } catch (error) {
    console.error('Failed to load preferences:', error);
  }
  return false;
}
