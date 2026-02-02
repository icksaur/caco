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
import { setActiveSession as setWsActiveSession } from './websocket.js';

export interface AppState {
  // === Session State
  activeSessionId: string | null;
  currentCwd: string;
  
  // === Model State 
  selectedModel: string;
  availableModels: ModelInfo[];
  
  // === UI Flags
  isStreaming: boolean;
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
  isStreaming: false,
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

/** Check if streaming */
export function isStreaming(): boolean {
  return state.isStreaming;
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
 * Set active session and sync to WebSocket
 * URL is managed by router.ts
 */
export function setActiveSession(sessionId: string | null, cwd: string): void {
  state.activeSessionId = sessionId;
  state.currentCwd = cwd;
  setWsActiveSession(sessionId);
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
  
  // Sync to hidden form input (DOM side effect)
  if (typeof document !== 'undefined') {
    const input = document.getElementById('selectedModel') as HTMLInputElement | null;
    if (input) {
      input.value = modelId;
    }
  }
}

/**
 * Set available models
 */
export function setAvailableModels(models: ModelInfo[]): void {
  state.availableModels = [...models]; // Defensive copy
}

/**
 * Set streaming state
 */
export function setStreaming(streaming: boolean): void {
  state.isStreaming = streaming;
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
  if (prefs.lastSessionId !== undefined) {
    state.activeSessionId = prefs.lastSessionId;
  }
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

// Debug

/** Log current state to console */
export function debugState(): void {
  console.log('[APP STATE]', getState());
}
