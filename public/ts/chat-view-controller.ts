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

import { setActiveSession, getActiveSessionId, getCurrentCwd, getSelectedModel, getAvailableModels, clearActiveSession, getNewChatCwd } from './app-state.js';
import { setFormEnabled as vcSetFormEnabled, setViewState, getViewState as vcGetViewState, showSessionPanel, type ViewState } from './view-controller.js';
import { renderStatus, clearStatus, clearContextFooter, clearContextUsage, restoreContextUsage, renderContextFooter, updateContextUsage } from './context-footer.js';
import { loadModels } from './model-selector.js';
import { historyLoader } from './history-loader.js';
import { reconnectIfNeeded, waitForConnect, subscribeToSession } from './websocket.js';
import { setSessionLoading, updateMenuIndicators } from './session-panel.js';
import { notifySessionChange } from './applet-runtime.js';
import { showToast } from './toast.js';
import { adHocBar } from './adhoc-bar.js';
import { fetchWithTimeout } from './fetch-timeout.js';
import { regions } from './dom-regions.js';

const RESUME_TIMEOUT_MS = 30000;

class ChatViewController {
  private lastPrompt = '';
  private lastPromptSessionId = '';
  private footerSessionId: string | null = null;

  getViewState(): ViewState {
    return vcGetViewState();
  }

  /**
   * The session that currently owns the footer. Footer updates for
   * other sessions are silently dropped.
   */
  getFooterSessionId(): string | null {
    return this.footerSessionId;
  }

  /**
   * Show the session list panel.
   */
  showSessions(): void {
    showSessionPanel();
  }

  /**
   * Show the new-chat view. Clears chat, footer, shows model selector.
   */
  showNewChat(): void {
    const lastCwd = getCurrentCwd();
    this.footerSessionId = null;
    clearActiveSession();
    regions.chat.clear();
    clearStatus();
    clearContextFooter();
    clearContextUsage();
    adHocBar.deactivate();
    setViewState('newChat');
    loadModels();
    
    if (typeof document !== 'undefined') {
      const cwdInput = document.getElementById('newChatCwd') as HTMLInputElement;
      if (cwdInput && lastCwd) {
        cwdInput.value = lastCwd;
        cwdInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
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
    if (this.isShowingSession(sessionId)) {
      adHocBar.activateSession(sessionId);
      return;
    }

    setSessionLoading(sessionId, true);

    try {
      const data = await this.resumeAndLoad(sessionId);
      this.showChat(sessionId, data.cwd || getCurrentCwd(), data.model, data.hasGit, data.name, data.sessionId, data.hasIcon, data.kind, data.currentIntent, data.gitBranch);
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
    cwd?: string; model?: string; cwdFallback?: string; hasGit?: boolean;
    name?: string; sessionId?: string; hasIcon?: boolean; kind?: string;
    currentIntent?: string; gitBranch?: string | null;
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
      name?: string;
      hasGit?: boolean;
      gitBranch?: string | null;
      hasIcon?: boolean;
      cwdFallback?: string;
      repairMessage?: string;
    };

    if (data.repairMessage) {
      showToast(`Session repaired: ${data.repairMessage}`, { type: 'info', autoHideMs: 8000 });
    }

    if (data.cwdFallback) {
      showToast(`Original directory is gone, using: ${data.cwdFallback}`, { type: 'info', autoHideMs: 5000 });
    }

    setActiveSession(data.sessionId, data.cwd || getCurrentCwd());
    this.footerSessionId = data.sessionId;
    await historyLoader.load(data.sessionId);

    return data;
  }

  /**
   * Transition to chatting view after successful load.
   */
  private showChat(sessionId: string, cwd: string, model?: string, hasGit = false, name?: string, _sessionId?: string, hasIcon?: boolean, kind?: string, currentIntent?: string, gitBranch?: string | null): void {
    this.footerSessionId = sessionId;
    updateMenuIndicators();
    notifySessionChange(sessionId, { sessionId, cwd, name, kind, model, currentIntent });
    this.updateStatus(cwd, model, hasGit, name, sessionId, hasIcon, gitBranch);
    restoreContextUsage(sessionId);
    adHocBar.activateSession(sessionId);
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
    adHocBar.activateSession(sessionId);
    setViewState('chatting');
  }

  /**
   * Reload history for the active session (e.g., after WS reconnect).
   * Resumes the session first in case the SDK session expired during disconnect.
   */
  async reloadHistory(sessionId: string): Promise<void> {
    try {
      await fetchWithTimeout(`/api/sessions/${sessionId}/resume`, {
        method: 'POST'
      }, RESUME_TIMEOUT_MS);
    } catch {
      // Resume failed — history load may still work from disk
    }
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
  updateStatus(cwd: string, modelId?: string, hasGit = false, name?: string, sessionId?: string, hasIcon?: boolean, gitBranch?: string | null): void {
    const id = modelId || getSelectedModel();
    const models = getAvailableModels();
    const model = models.find(m => m.id === id);
    const modelName = model?.name || id?.split('/').pop() || '';
    renderStatus(modelName, cwd, hasGit, name, sessionId, hasIcon, gitBranch);
  }

  /**
   * Clear the footer (both status and context files).
   */
  clearFooter(): void {
    clearStatus();
    clearContextFooter();
    clearContextUsage();
  }

  /**
   * Update context files in footer. Only applies if sessionId matches
   * the current footer owner.
   */
  updateContextFiles(sessionId: string, context: Record<string, string[] | undefined>): void {
    if (this.footerSessionId !== sessionId) return;
    renderContextFooter(context);
  }

  /**
   * Update context usage (token count) in footer. Only applies if
   * sessionId matches the current footer owner.
   */
  updateUsage(sessionId: string, data: { tokenLimit?: number; currentTokens?: number }): void {
    if (this.footerSessionId !== sessionId) return;
    updateContextUsage(data, sessionId);
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

  /**
   * Get last sent input for the current session (up-arrow recall).
   * Returns empty string if no history or session mismatch.
   */
  getLastInput(): string {
    const activeId = getActiveSessionId();
    if (!activeId || this.lastPromptSessionId !== activeId) return '';
    return this.lastPrompt;
  }
}

export const chatView = new ChatViewController();
export { ChatViewController };
