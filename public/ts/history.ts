/**
 * Preferences loading
 */

import type { Preferences } from './types.js';
import { applyModelPreference } from './model-selector.js';
import { initFromPreferences } from './app-state.js';

/**
 * Load and apply user preferences
 */
export async function loadPreferences(): Promise<Preferences | null> {
  try {
    const response = await fetch('/api/preferences');
    if (response.ok) {
      const prefs: Preferences = await response.json();
      initFromPreferences(prefs);
      applyModelPreference(prefs);
      return prefs;
    }
  } catch (error) {
    console.error('Failed to load preferences:', error);
  }
  return null;
}
