/**
 * ChatViewController
 * 
 * Single owner of chat view lifecycle. All view transitions go through this
 * class. Modules that need to affect the view call one API instead of
 * reaching into 4+ modules.
 * 
 * Composes: HistoryLoader, SessionStateTracker
 * Delegates to: view-controller (DOM), context-footer (DOM), model-selector (DOM)
 */

import { setActiveSession, getActiveSessionId, getCurrentCwd, getSelectedModel, getAvailableModels } from './app-state.js';
import { setFormEnabled as vcSetFormEnabled, setViewState, type ViewState } from './view-controller.js';
import { renderStatus, clearStatus, clearContextFooter } from './context-footer.js';
import { loadModels, getNewChatCwd } from './model-selector.js';
import { historyLoader } from './history-loader.js';
import { reconnectIfNeeded, waitForConnect, subscribeToSession } from './websocket.js';
import { setSessionLoading, updateMenuIndicators } from './session-panel.js';
import { notifySessionChange } from './applet-runtime.js';
import { showToast } from './toast.js';
import { fetchWithTimeout } from './fetch-timeout.js';
import { regions } from './dom-regions.js';

const RESUME_TIMEOUT_MS = 30000;

class ChatViewController {
  private _viewState: ViewState = 'sessions';
  private lastPrompt = '';
  private lastPromptSessionId = '';

  getViewState(): ViewState {
    return this._viewState;
  }

  /**
   * Show the session list panel.
   */
  showSessions(): void {
    this._viewState = 'sessions';
    setViewState('sessions');
  }

  /**
   * Show the new-chat view. Clears chat, footer, shows model selector.
   */
  showNewChat(): void {
    regions.chat.clear();
    clearStatus();
    clearContextFooter();
    this._viewState = 'newChat';
    setViewState('newChat');
    loadModels();
  }

  /**
   * Activate an existing session. Handles resume, history load, and view
   * transition atomically. Includes short-circuit when session is already
   * loaded and fresh.
   */
  async activateSession(sessionId: string): Promise<void> {
    // Short-circuit: same session, fresh history, AND chat has content
    const chatHasContent = regions.chat.el.children.length > 0;
    if (sessionId === getActiveSessionId() && !historyLoader.isStale(sessionId) && chatHasContent) {
      this._viewState = 'chatting';
      setViewState('chatting');
      return;
    }

    setSessionLoading(sessionId, true);

    try {
      reconnectIfNeeded();
      await waitForConnect();

      const response = await fetchWithTimeout(`/api/sessions/${sessionId}/resume`, {
        method: 'POST'
      }, RESUME_TIMEOUT_MS);

      setSessionLoading(sessionId, false);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
        showToast(errorData.error || `Failed to resume session (${response.status})`);
        return;
      }

      const data = await response.json() as {
        sessionId: string;
        cwd?: string;
        isBusy?: boolean;
        model?: string;
        cwdFallback?: string;
      };

      if (data.cwdFallback) {
        showToast(`Original directory is gone, using: ${data.cwdFallback}`, { type: 'info', autoHideMs: 5000 });
      }

      setActiveSession(data.sessionId, data.cwd || getCurrentCwd());
      updateMenuIndicators();
      notifySessionChange(data.sessionId, data.cwd || getCurrentCwd());
      this.updateStatus(data.cwd || getCurrentCwd(), data.model);

      await historyLoader.load(data.sessionId);

      this._viewState = 'chatting';
      setViewState('chatting');
    } catch (error) {
      setSessionLoading(sessionId, false);
      const msg = error instanceof Error ? error.message : 'Network error';
      console.error('[CHAT] Error activating session:', error);
      showToast(msg);
    }
  }

  /**
   * Called after streamResponse creates a new session.
   * Transitions to chatting view with the new session.
   */
  onNewSessionCreated(sessionId: string, cwd: string): void {
    setActiveSession(sessionId, cwd);
    subscribeToSession(sessionId);
    updateMenuIndicators();
    this.updateStatus(cwd);
    this._viewState = 'chatting';
    setViewState('chatting');
  }

  /**
   * Reload history for the active session (e.g., after WS reconnect).
   * Does NOT re-resume — just reloads the chat display.
   */
  async reloadHistory(sessionId: string): Promise<void> {
    await historyLoader.load(sessionId);
  }

  /**
   * Get the current working directory.
   * In newChat view: reads from the CWD input field.
   * In chatting view: reads from app-state (active session's CWD).
   */
  getCwd(): string {
    if (this._viewState === 'newChat') {
      return getNewChatCwd();
    }
    return getCurrentCwd();
  }

  /**
   * Update the footer status bar with model name and CWD.
   * Resolves model ID to friendly name from available models.
   */
  updateStatus(cwd: string, modelId?: string): void {
    const id = modelId || getSelectedModel();
    const models = getAvailableModels();
    const model = models.find(m => m.id === id);
    const name = model?.name || id?.split('/').pop() || '';
    renderStatus(name, cwd);
  }

  /**
   * Clear the footer (both status and context files).
   */
  clearFooter(): void {
    clearStatus();
    clearContextFooter();
  }

  /**
   * Enable/disable the chat form (streaming cursor, textarea).
   */
  setFormEnabled(enabled: boolean): void {
    vcSetFormEnabled(enabled);
  }

  /**
   * Save the last sent prompt for recovery on timeout/error.
   */
  savePrompt(prompt: string, sessionId: string): void {
    this.lastPrompt = prompt;
    this.lastPromptSessionId = sessionId;
  }

  /**
   * Restore the saved prompt to the textarea, but only if the user is
   * still viewing the same session. Prevents cross-session prompt leaks.
   */
  restorePromptIfSameSession(): void {
    if (!this.lastPrompt) return;
    if (this.lastPromptSessionId !== getActiveSessionId()) return;

    if (typeof document === 'undefined') return;
    const input = document.querySelector('#chatForm textarea') as HTMLTextAreaElement;
    if (input) {
      input.value = this.lastPrompt;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
}

export const chatView = new ChatViewController();
export { ChatViewController };
