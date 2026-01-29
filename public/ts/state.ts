/**
 * Client State Store
 * 
 * Single source of truth for client-side application state.
 * All mutable state lives here; modules import getters/setters.
 */

import type { ModelInfo } from './types.js';
import { setActiveSession as setWsActiveSession, isWsConnected, getActiveSessionId as getWsActiveSession } from './websocket.js';

// ============================================================
// State Interface
// ============================================================

export interface AppState {
  // Session state (synced from server)
  activeSessionId: string | null;
  currentCwd: string;
  
  // Model state
  selectedModel: string;
  
  // Streaming state (transient)
  isStreaming: boolean;
  
  // Image attachment state
  hasImage: boolean;
}

// ============================================================
// Constants
// ============================================================

// Single source of truth for default model (client-side)
export const DEFAULT_MODEL = 'claude-sonnet-4';

// ============================================================
// State Store (singleton)
// ============================================================

const state: AppState = {
  activeSessionId: null,
  currentCwd: '',
  selectedModel: DEFAULT_MODEL,
  isStreaming: false,
  hasImage: false
};

// ============================================================
// State Accessors (read-only access)
// ============================================================

/**
 * Get a shallow copy of current state (for debugging/inspection)
 */
export function getState(): Readonly<AppState> {
  return { ...state };
}

/**
 * Get current active session ID
 */
export function getActiveSessionId(): string | null {
  return state.activeSessionId;
}

/**
 * Get current working directory
 */
export function getCurrentCwd(): string {
  return state.currentCwd;
}

/**
 * Get currently selected model
 */
export function getSelectedModel(): string {
  return state.selectedModel;
}

/**
 * Check if currently streaming
 */
export function isStreaming(): boolean {
  return state.isStreaming;
}

/**
 * Check if image is attached
 */
export function hasImage(): boolean {
  return state.hasImage;
}

// ============================================================
// State Mutations (explicit, trackable)
// ============================================================

/**
 * Set active session (from server response)
 * Also sets WebSocket active session for message filtering
 */
export function setActiveSession(sessionId: string | null, cwd: string): void {
  state.activeSessionId = sessionId;
  state.currentCwd = cwd;
  
  // Set WebSocket active session for message filtering
  setWsActiveSession(sessionId);
}

/**
 * Clear active session (for new chat - ensures messages don't go to old session)
 */
export function clearActiveSession(): void {
  state.activeSessionId = null;
}

/**
 * Set selected model and sync to hidden input
 */
export function setSelectedModel(modelId: string): void {
  state.selectedModel = modelId;
  
  // Sync to hidden form input
  const input = document.getElementById('selectedModel') as HTMLInputElement | null;
  if (input) {
    input.value = modelId;
  }
}

/**
 * Set streaming state
 */
export function setStreaming(streaming: boolean): void {
  state.isStreaming = streaming;
}

/**
 * Set image attachment state
 */
export function setHasImage(hasImage: boolean): void {
  state.hasImage = hasImage;
}

// ============================================================
// Initialization
// ============================================================

/**
 * Initialize state from server preferences
 * Does NOT connect WebSocket - caller should do that explicitly
 */
export function initFromPreferences(prefs: { 
  lastModel?: string; 
  lastCwd?: string;
  lastSessionId?: string | null;
}): void {
  if (prefs.lastModel) {
    setSelectedModel(prefs.lastModel);
  }
  if (prefs.lastCwd) {
    state.currentCwd = prefs.lastCwd;
  }
  if (prefs.lastSessionId !== undefined) {
    state.activeSessionId = prefs.lastSessionId;
  }
}

/**
 * Initialize from session response
 */
export function initFromSession(data: {
  sessionId?: string | null;
  cwd?: string;
  activeSessionId?: string | null;
  currentCwd?: string;
}): void {
  // Handle both /api/session and /api/sessions response formats
  const sessionId = data.sessionId ?? data.activeSessionId ?? null;
  const cwd = data.cwd ?? data.currentCwd ?? '';
  
  setActiveSession(sessionId, cwd);
}
