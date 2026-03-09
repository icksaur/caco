/**
 * Application State (non-view)
 * 
 * SINGLE SOURCE OF TRUTH for session, model, and UI flag state.
 * Does NOT manage view state - see view-controller.ts for that.
 * 
 * Design principles:
 * - State is private, accessed via getters
 * - Mutations are explicit functions with clear names
 * - Side effects (URL sync, WS sync) are handled in setters
 */

import type { ModelInfo } from './types.js';

export interface AppState {
  // === Session State
  activeSessionId: string | null;
  currentCwd: string;
  
  // === Model State 
  selectedModel: string;
  availableModels: ModelInfo[];
  
  // === UI Flags
  loadingHistory: boolean;
  autoScrollEnabled: boolean;
  hasImage: boolean;
}

export const DEFAULT_MODEL = 'claude-sonnet-4';

const state: AppState = {
  activeSessionId: null,
  currentCwd: '',
  selectedModel: DEFAULT_MODEL,
  availableModels: [],
  loadingHistory: false,
  autoScrollEnabled: true,
  hasImage: false
};

/** Get a shallow copy of entire state (for debugging) */
export function getState(): Readonly<AppState> {
  return { ...state };
}

/** Get active session ID */
export function getActiveSessionId(): string | null {
  return state.activeSessionId;
}

/** Get current working directory */
export function getCurrentCwd(): string {
  return state.currentCwd;
}

/** Get selected model */
export function getSelectedModel(): string {
  return state.selectedModel;
}

/** Get available models */
export function getAvailableModels(): readonly ModelInfo[] {
  return state.availableModels;
}

/** Check if loading history */
export function isLoadingHistory(): boolean {
  return state.loadingHistory;
}

/** Check if auto-scroll is enabled */
export function isAutoScrollEnabled(): boolean {
  return state.autoScrollEnabled;
}

/** Check if has image attachment */
export function hasImage(): boolean {
  return state.hasImage;
}

/**
 * Set active session (pure state mutation)
 * Callers should also call websocket.subscribeToSession() for WS sync
 */
export function setActiveSession(sessionId: string | null, cwd: string): void {
  state.activeSessionId = sessionId;
  state.currentCwd = cwd;
}

/**
 * Clear active session (for new chat)
 */
export function clearActiveSession(): void {
  state.activeSessionId = null;
  // Note: Don't clear cwd - it's useful as default for next session
}

/**
 * Set selected model
 */
export function setSelectedModel(modelId: string): void {
  state.selectedModel = modelId;
}

/**
 * Set available models
 */
export function setAvailableModels(models: ModelInfo[]): void {
  state.availableModels = [...models]; // Defensive copy
}

/**
 * Set loading history state
 */
export function setLoadingHistory(loading: boolean): void {
  state.loadingHistory = loading;
}

/**
 * Enable auto-scroll (called when sending a message)
 */
export function enableAutoScroll(): void {
  state.autoScrollEnabled = true;
}

/**
 * Disable auto-scroll (called when user scrolls up)
 */
export function disableAutoScroll(): void {
  state.autoScrollEnabled = false;
}

/**
 * Set image attachment state
 */
export function setHasImage(hasImage: boolean): void {
  state.hasImage = hasImage;
}

/**
 * Initialize from server preferences
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
  // Note: lastSessionId is NOT set here — activeSessionId is only set
  // by setActiveSession() inside resumeAndLoad() after the session is
  // actually loaded. Setting it prematurely causes commands like /model
  // to target a session that isn't loaded yet.
}

/**
 * Initialize from session API response
 */
export function initFromSession(data: {
  sessionId?: string | null;
  cwd?: string;
  activeSessionId?: string | null;
  currentCwd?: string;
}): void {
  const sessionId = data.sessionId ?? data.activeSessionId ?? null;
  const cwd = data.cwd ?? data.currentCwd ?? '';
  setActiveSession(sessionId, cwd);
}

/**
 * Get the cwd from the new chat form
 */
export function getNewChatCwd(): string {
  const cwdInput = document.getElementById('newChatCwd') as HTMLInputElement;
  return cwdInput?.value.trim() || '';
}

/**
 * Set the CWD in the new chat form
 */
export function setNewChatCwd(cwd: string): void {
  const cwdInput = document.getElementById('newChatCwd') as HTMLInputElement;
  if (cwdInput) {
    cwdInput.value = cwd;
    cwdInput.dispatchEvent(new Event('input'));
  }
}

// Debug

/** Log current state to console */
export function debugState(): void {
  console.log('[APP STATE]', getState());
}
