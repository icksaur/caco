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
import { setFormEnabled as vcSetFormEnabled, setViewState, getViewState as vcGetViewState, type ViewState } from './view-controller.js';
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
  private lastPrompt = '';
  private lastPromptSessionId = '';

  getViewState(): ViewState {
    return vcGetViewState();
  }

  /**
   * Show the session list panel.
   */
  showSessions(): void {
    setViewState('sessions');
  }

  /**
   * Show the new-chat view. Clears chat, footer, shows model selector.
   */
  showNewChat(): void {
    regions.chat.clear();
    clearStatus();
    clearContextFooter();
    setViewState('newChat');
    loadModels();
  }

  /**
   * Whether the chat is currently showing this session with content.
   */
  private isShowingSession(sessionId: string): boolean {
    const viewState = vcGetViewState();
    const activeId = getActiveSessionId();
    const hasContent = regions.chat.el.children.length > 0;
    const stale = historyLoader.isStale(sessionId);
    
    const result = viewState === 'chatting'
      && sessionId === activeId
      && hasContent
      && !stale;
    
    if (result) {
      console.log(`[CHAT] isShowingSession SHORT-CIRCUIT: view=${viewState} active=${activeId?.slice(0,8)} content=${hasContent} stale=${stale}`);
    }
    
    return result;
  }

  /**
   * Activate an existing session. Resume on server, load history, show chat.
   */
  async activateSession(sessionId: string): Promise<void> {
    console.log(`[CHAT] activateSession(${sessionId.slice(0, 8)}) viewState=${vcGetViewState()} activeId=${getActiveSessionId()?.slice(0,8)}`);
    if (this.isShowingSession(sessionId)) return;

    setSessionLoading(sessionId, true);

    try {
      const data = await this.resumeAndLoad(sessionId);
      this.showChat(sessionId, data.cwd || getCurrentCwd(), data.model);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Network error';
      console.error('[CHAT] Error activating session:', msg);
      showToast(msg);
    } finally {
      setSessionLoading(sessionId, false);
    }
  }

  /**
   * Resume session on server and load history. Single async operation.
   * Throws on failure — caller handles UI recovery.
   */
  private async resumeAndLoad(sessionId: string): Promise<{
    cwd?: string; model?: string; cwdFallback?: string;
  }> {
    reconnectIfNeeded();
    await waitForConnect();

    const response = await fetchWithTimeout(`/api/sessions/${sessionId}/resume`, {
      method: 'POST'
    }, RESUME_TIMEOUT_MS);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      throw new Error(errorData.error || `Failed to resume session (${response.status})`);
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
    await historyLoader.load(data.sessionId);

    return data;
  }

  /**
   * Transition to chatting view after successful load.
   */
  private showChat(sessionId: string, cwd: string, model?: string): void {
    updateMenuIndicators();
    notifySessionChange(sessionId, cwd);
    this.updateStatus(cwd, model);
    setViewState('chatting');
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
    if (vcGetViewState() === 'newChat') {
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
