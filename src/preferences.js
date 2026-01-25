/**
 * Preferences Manager
 * 
 * Handles loading and saving of user preferences (model, excludedTools)
 * to a JSON file.
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { homedir } from 'os';

const PREFS_FILE = path.join(homedir(), '.copilot', 'web-preferences.json');

const defaultPreferences = {
  lastCwd: process.cwd(),
  lastModel: 'claude-sonnet-4',
  lastSessionId: null
};

/**
 * Get default preferences
 * @returns {Object} Default preferences
 */
export function getDefaultPreferences() {
  return { ...defaultPreferences };
}

/**
 * Load preferences from disk
 * @returns {Promise<Object>} Current preferences
 */
export async function loadPreferences() {
  try {
    if (existsSync(PREFS_FILE)) {
      const data = await readFile(PREFS_FILE, 'utf8');
      return { ...defaultPreferences, ...JSON.parse(data) };
    }
  } catch (e) {
    console.warn('Could not load preferences:', e.message);
  }
  return { ...defaultPreferences };
}

/**
 * Save preferences to disk
 * @param {Object} prefs - Full preferences object to save
 */
export async function savePreferences(prefs) {
  try {
    await writeFile(PREFS_FILE, JSON.stringify(prefs, null, 2));
  } catch (e) {
    console.warn('Could not save preferences:', e.message);
  }
}
