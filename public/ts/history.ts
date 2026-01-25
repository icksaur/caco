/**
 * History and preferences loading
 */

import type { Preferences } from './types.js';
import { scrollToBottom } from './ui-utils.js';
import { applyModelPreference } from './model-selector.js';
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
        chat.innerHTML = html;
        // Render any markdown in loaded messages
        if (typeof window.renderMarkdown === 'function') {
          window.renderMarkdown();
        }
      }
      // Always scroll to bottom after loading history
      scrollToBottom();
    }
  } catch (error) {
    console.error('Failed to load history:', error);
  }
}

/**
 * Load and apply user preferences
 */
export async function loadPreferences(): Promise<void> {
  try {
    const response = await fetch('/api/preferences');
    if (response.ok) {
      const prefs: Preferences = await response.json();
      
      // Initialize state from preferences
      initFromPreferences(prefs);
      
      // Apply model to UI (placeholder text)
      applyModelPreference(prefs);
    }
  } catch (error) {
    console.error('Failed to load preferences:', error);
  }
}
