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
import type { UserPreferences } from './types.js';

const PREFS_FILE = path.join(homedir(), '.copilot', 'web-preferences.json');

// Single source of truth for default model
export const DEFAULT_MODEL = 'claude-sonnet-4';

// Model aliases: map old/short names to current canonical IDs
const MODEL_ALIASES: Record<string, string> = {
  'claude-opus-4.5': 'claude-opus-4.6-1m',
  'claude-sonnet-4.5': 'claude-sonnet-4.6',
};

/** Resolve model aliases to canonical IDs */
export function resolveModelAlias(model: string): string {
  return MODEL_ALIASES[model] ?? model;
}

const defaultPreferences: UserPreferences = {
  lastCwd: process.cwd(),
  lastModel: DEFAULT_MODEL,
  lastSessionId: null,
  autoContinueEnabled: true
};

/** Whether auto-continuation is enabled given a preferences object (default on:
 *  only an explicit `false` disables it; a missing/undefined prefs object is
 *  treated as the default-on case). */
export function isAutoContinueEnabled(prefs: Pick<UserPreferences, 'autoContinueEnabled'> | undefined | null): boolean {
  return prefs?.autoContinueEnabled !== false;
}

/**
 * Get default preferences
 */
export function getDefaultPreferences(): UserPreferences {
  return { ...defaultPreferences };
}

/**
 * Load preferences from disk
 */
export async function loadPreferences(): Promise<UserPreferences> {
  try {
    if (existsSync(PREFS_FILE)) {
      const data = await readFile(PREFS_FILE, 'utf8');
      return { ...defaultPreferences, ...JSON.parse(data) };
    }
  } catch (e) {
    const _message = e instanceof Error ? e.message : String(e);
  }
  return { ...defaultPreferences };
}

/**
 * Save preferences to disk
 */
export async function savePreferences(prefs: UserPreferences): Promise<void> {
  try {
    await writeFile(PREFS_FILE, JSON.stringify(prefs, null, 2));
  } catch (e) {
    const _message = e instanceof Error ? e.message : String(e);
  }
}
