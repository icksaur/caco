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

import { debug } from './debug.js';
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

export function getState(): Readonly<AppState> {
  return { ...state };
}

export function getActiveSessionId(): string | null {
  return state.activeSessionId;
}

export function getCurrentCwd(): string {
  return state.currentCwd;
}

export function getSelectedModel(): string {
  return state.selectedModel;
}

export function getAvailableModels(): readonly ModelInfo[] {
  return state.availableModels;
}

export function isLoadingHistory(): boolean {
  return state.loadingHistory;
}

export function isAutoScrollEnabled(): boolean {
  return state.autoScrollEnabled;
}

export function hasImage(): boolean {
  return state.hasImage;
}

/**
 * Set active session (pure state mutation)
 * Callers should also call websocket.subscribeToSession() for WS sync
 */
export function setActiveSession(sessionId: string | null, cwd: string): void {
  const prev = state.activeSessionId;
  state.activeSessionId = sessionId;
  state.currentCwd = cwd;
  if (prev !== sessionId) notifyActiveSessionChange(prev, sessionId);
}

const activeSessionListeners: Array<(prev: string | null, next: string | null) => void> = [];

/** Register a listener for active-session-pointer changes. Fires
 *  whenever setActiveSession or releaseActiveSessionForNewChat
 *  changes the active id. Used by image-paste to clear staged
 *  images on session switch. Returns an unsubscribe fn. */
export function onActiveSessionChange(
  fn: (prev: string | null, next: string | null) => void
): () => void {
  activeSessionListeners.push(fn);
  return () => {
    const idx = activeSessionListeners.indexOf(fn);
    if (idx >= 0) activeSessionListeners.splice(idx, 1);
  };
}

function notifyActiveSessionChange(prev: string | null, next: string | null): void {
  for (const fn of activeSessionListeners) {
    try { fn(prev, next); } catch (e) { console.error('[app-state] active-session listener:', e); }
  }
}

// ── Lifecycle events ────────────────────────────────────────────
//
// Canonical hooks for session-scoped state. Any module holding
// state that is logically scoped to a session (drafts, applet
// state, staged images, swarm progress, etc.) should subscribe to
// the relevant hook here to clear/prune at the right boundary.
//
// See `docs/global-leak-audit.md` for the audit that motivated
// this consolidation and `docs/code-quality.md` for the rule that
// any module-level `let`/Map keyed by session id MUST declare its
// LIFECYCLE in a comment and subscribe to one of these events.

const messageSentListeners: Array<(sessionId: string) => void> = [];
const sessionArchivedListeners: Array<(sessionId: string) => void> = [];

/** Fires when the user successfully consumes input via send / steer
 *  / slash-command for a specific session. Subscribers: anything
 *  with per-action transient state that should be discarded on
 *  send (pendingAppletState, staged input lookups, etc.). */
export function onMessageSent(fn: (sessionId: string) => void): () => void {
  messageSentListeners.push(fn);
  return () => {
    const idx = messageSentListeners.indexOf(fn);
    if (idx >= 0) messageSentListeners.splice(idx, 1);
  };
}

export function notifyMessageSent(sessionId: string): void {
  for (const fn of messageSentListeners) {
    try { fn(sessionId); } catch (e) { console.error('[app-state] message-sent listener:', e); }
  }
}

/** Fires when a session is archived/deleted and will not return.
 *  Subscribers: Map<sessionId,…> caches that should prune on
 *  removal (sessionDrafts, sessionPrompts, usageCache, swarm
 *  progress, hydrated set). */
export function onSessionArchived(fn: (sessionId: string) => void): () => void {
  sessionArchivedListeners.push(fn);
  return () => {
    const idx = sessionArchivedListeners.indexOf(fn);
    if (idx >= 0) sessionArchivedListeners.splice(idx, 1);
  };
}

export function notifySessionArchived(sessionId: string): void {
  for (const fn of sessionArchivedListeners) {
    try { fn(sessionId); } catch (e) { console.error('[app-state] session-archived listener:', e); }
  }
}

/**
 * Transitional state used by `showNewChat` between view teardown and
 * the next session binding. Subsequent re-binding happens in
 * `setActiveSession` (via `onNewSessionCreated` after first message,
 * or via session activation).
 */
export function releaseActiveSessionForNewChat(): void {
  const prev = state.activeSessionId;
  state.activeSessionId = null;
  // Note: Don't clear cwd - it's useful as default for next session
  if (prev !== null) notifyActiveSessionChange(prev, null);
}

export function setSelectedModel(modelId: string): void {
  state.selectedModel = modelId;
}

export function setAvailableModels(models: ModelInfo[]): void {
  state.availableModels = [...models]; // Defensive copy
}

export function setLoadingHistory(loading: boolean): void {
  state.loadingHistory = loading;
}

export function enableAutoScroll(): void {
  state.autoScrollEnabled = true;
}

export function disableAutoScroll(): void {
  state.autoScrollEnabled = false;
}

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

export function getNewChatCwd(): string {
  const cwdInput = document.getElementById('newChatCwd') as HTMLInputElement;
  return cwdInput?.value.trim() || '';
}

export function setNewChatCwd(cwd: string): void {
  const cwdInput = document.getElementById('newChatCwd') as HTMLInputElement;
  if (cwdInput) {
    cwdInput.value = cwd;
    cwdInput.dispatchEvent(new Event('input'));
  }
}

export function debugState(): void {
  debug('APP-STATE', getState());
}
