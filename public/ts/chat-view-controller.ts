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

import { setActiveSession, getActiveSessionId, getCurrentCwd, getSelectedModel, getAvailableModels, releaseActiveSessionForNewChat, getNewChatCwd } from './app-state.js';
import { setFormEnabled as vcSetFormEnabled, setViewState, getViewState as vcGetViewState, showSessionPanel, type ViewState } from './view-controller.js';
import { renderSessionStatus, renderNewChatStatus, clearStatus, clearContextFooter, clearContextUsage, restoreContextUsage, renderContextFooter, updateContextUsage } from './context-footer.js';
import { loadModels } from './model-selector.js';
import { historyLoader } from './history-loader.js';
import { reconnectIfNeeded, waitForConnect, subscribeToSession } from './websocket.js';
import { setSessionLoading, updateMenuIndicators } from './session-panel.js';
import { notifySessionChange } from './applet-runtime.js';
import { loadApplet } from './applet-loader.js';
import { showToast } from './toast.js';
import { setResponseOptions } from './message-streaming.js';
import { adHocBar } from './adhoc-bar.js';
import { fetchWithTimeout } from './fetch-timeout.js';
import { regions } from './dom-regions.js';
import { perfFlight } from './perf.js';
import { deleteDraft } from './chat-draft-api.js';
import type { ChatFormController } from './chat-form-controller.js';

const RESUME_TIMEOUT_MS = 30000;

class ChatViewController {
  /** Shared in-memory draft cache. Keyed by session ID or
   *  NEWCHAT_DRAFT_KEY. Each ChatFormController reads/writes here
   *  via getDraftCache/setDraftCache. The Map survives form
   *  rebinds, so session-switches see the prior draft instantly. */
  private sessionDrafts = new Map<string, string>();
  private sessionPrompts = new Map<string, string>();
  private footerSessionId: string | null = null;

  /** Per-view form controllers, bound after construction via
   *  bindForms(). main.ts constructs the instances and passes them
   *  in so the view controller does not have to reach into the DOM
   *  itself. */
  private newChatForm: ChatFormController | null = null;
  private chattingForm: ChatFormController | null = null;
  private activeForm: ChatFormController | null = null;

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

  /** Register the two per-view form controllers. Called once from
   *  main.ts after the controllers are constructed. */
  bindForms(forms: { newChat: ChatFormController; chatting: ChatFormController }): void {
    this.newChatForm = forms.newChat;
    this.chattingForm = forms.chatting;
  }

  /** The form whose view is currently visible. Used by
   *  setupFormHandler, setFormEnabled, prompt-template apply, and
   *  any other site that needs to target "the chat input." Null
   *  before bindForms runs. */
  getActiveForm(): ChatFormController | null {
    return this.activeForm;
  }

  // ── Draft cache helpers (used by ChatFormController) ─────────────────

  getDraftCache(key: string): string | undefined {
    return this.sessionDrafts.get(key);
  }

  setDraftCache(key: string, val: string): void {
    if (val.trim()) this.sessionDrafts.set(key, val);
    else this.sessionDrafts.delete(key);
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
    if (this.newChatForm) {
      this.activeForm = this.newChatForm;
      this.newChatForm.bind(null);
    }
    const lastCwd = getCurrentCwd();
    this.footerSessionId = null;
    releaseActiveSessionForNewChat();
    updateMenuIndicators();  // deselect prior session in the session list
    regions.chat.clear();
    clearStatus();
    clearContextFooter();
    clearContextUsage();
    setResponseOptions([]);
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

    const flight = perfFlight(`session.activate(${sessionId.slice(0, 8)})`);
    // (ChatFormController.bind() in showChat below will flush the
    // prior binding's pending debounce, so no explicit saveDraft
    // here.)
    setSessionLoading(sessionId, true);

    try {
      flight.span('resumeAndLoad');
      const data = await this.resumeAndLoad(sessionId, flight);
      flight.end('resumeAndLoad');

      flight.span('showChat');
      this.showChat(sessionId, data.cwd || getCurrentCwd(), data.model, data.hasGit, data.name, data.hasIcon, data.kind, data.currentIntent, data.gitBranch);
      setResponseOptions(data.responseOptions?.length ? data.responseOptions : []);
      flight.end('showChat');

      flight.span('restoreApplet');
      void this.restoreApplet(data.activeApplet, data.appletParams, data.appletPanelVisible).finally(() => flight.end('restoreApplet'));
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Network error';
      console.error('[CHAT] Error activating session:', msg);
      showToast(msg);
    } finally {
      setSessionLoading(sessionId, false);
      flight.done();
    }
  }

  /**
   * Resume session on server and load history. Single async operation.
   * Throws on failure — caller handles UI recovery.
   */
  private async resumeAndLoad(sessionId: string, flight?: ReturnType<typeof perfFlight>): Promise<{
    cwd?: string; model?: string; cwdFallback?: string; hasGit?: boolean;
    name?: string; sessionId?: string; hasIcon?: boolean; kind?: string;
    currentIntent?: string; gitBranch?: string | null; responseOptions?: string[];
    activeApplet?: string | null; appletParams?: Record<string, string> | null;
    appletPanelVisible?: boolean;
  }> {
    flight?.span('wsConnect');
    reconnectIfNeeded();
    await waitForConnect();
    flight?.end('wsConnect');

    flight?.span('resume.fetch');
    const response = await fetchWithTimeout(`/api/sessions/${sessionId}/resume`, {
      method: 'POST'
    }, RESUME_TIMEOUT_MS);
    flight?.end('resume.fetch');

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
      responseOptions?: string[];
      activeApplet?: string | null;
      appletParams?: Record<string, string> | null;
      appletPanelVisible?: boolean;
    };

    // repairMessage is intentionally not toasted: auto-repair is opportunistic
    // recovery from SDK validation drift (e.g. missing displayName) and the
    // user already sees their session work normally. The server logs the
    // repair in restart.log / server.log for diagnostics. If repair fails,
    // resume() throws and the user sees an error toast via the catch path.

    if (data.cwdFallback) {
      showToast(`Original directory is gone, using: ${data.cwdFallback}`, { type: 'info', autoHideMs: 5000 });
    }

    setActiveSession(data.sessionId, data.cwd || getCurrentCwd());
    this.footerSessionId = data.sessionId;
    flight?.span('history.load');
    await historyLoader.load(data.sessionId);
    flight?.end('history.load');

    return data;
  }

  /**
   * Restore the session's applet panel. Called after session resume.
   * Updates URL params, then loads the applet so its onUrlParamsChange
   * callback sees the correct params.
   * Only loads if the session has a saved activeApplet — respects current
   * panel visibility otherwise.
   */
  private async restoreApplet(activeApplet?: string | null, appletParams?: Record<string, string> | null, _panelVisible?: boolean): Promise<void> {
    if (!activeApplet) return;
    // Snapshot at fire-time so rapid session switches can abort late restores.
    const targetSessionId = getActiveSessionId();
    try {
      // Yield one microtask so a synchronously-following session activation
      // can land before we commit content/URL writes. This is the same
      // boundary the previous dynamic import('./router.js') provided.
      await Promise.resolve();
      if (getActiveSessionId() !== targetSessionId) return;

      // Best-effort URL hygiene. Wrapped separately so a missing window
      // (unit tests, headless contexts) doesn't block the content swap.
      try {
        if (typeof window !== 'undefined') {
          const params = new URLSearchParams();
          if (targetSessionId) params.set('session', targetSessionId);
          params.set('applet', activeApplet);
          for (const [k, v] of Object.entries(appletParams || {})) {
            params.set(k, v);
          }
          const newUrl = window.location.pathname + '?' + params.toString();
          if (newUrl !== window.location.pathname + window.location.search) {
            window.history.replaceState(null, '', newUrl);
          }
        }
      } catch { /* URL update is presentational; don't block content load */ }

      await loadApplet(activeApplet, appletParams || {}, { restore: true });

      // Visibility is intentionally NOT touched here. The applet panel is a
      // global UI state owned by the user's last tap on #appletBtn. Session
      // activation swaps content; it must not flip visibility, because that
      // races with rapid session clicks and surprises the operator. The old
      // per-session `appletPanelVisible` meta field is no longer applied
      // (still persisted for backward compat, ignored on restore).
    } catch (e) {
      console.warn('[CHAT] Failed to restore applet:', e);
    }
  }

  /**
   * Transition to chatting view after successful load.
   */
  private showChat(sessionId: string, cwd: string, model?: string, hasGit = false, name?: string, hasIcon?: boolean, kind?: string, currentIntent?: string, gitBranch?: string | null): void {
    if (this.chattingForm) {
      this.activeForm = this.chattingForm;
      this.chattingForm.bind(sessionId);
    }
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
    if (this.chattingForm) {
      this.activeForm = this.chattingForm;
      this.chattingForm.bind(sessionId);
    }
    setActiveSession(sessionId, cwd);
    subscribeToSession(sessionId);
    updateMenuIndicators();
    this.updateStatus(cwd);
    adHocBar.activateSession(sessionId);
    setViewState('chatting');
    // The send that created this session consumed the newchat draft.
    // The newChatForm's bind() already flushed any pending newchat
    // debounce when showNewChat ran. DELETE the disk file so a reload
    // doesn't resurrect it.
    void deleteDraft(null);
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
    if (sessionId) {
      renderSessionStatus({ modelName, cwd, hasGit, sessionName: name, sessionId, hasIcon, gitBranch });
    } else {
      renderNewChatStatus(modelName, cwd);
    }
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
    this.sessionPrompts.set(sessionId, prompt);
    this.sessionDrafts.delete(sessionId);
    // Disk: delegate to the active form (or chatting form by
    // identity, since send happens from chatting). The form's
    // clearOnSend cancels its own debounce and enqueues DELETE
    // via the per-key promise queue.
    if (this.chattingForm?.binding?.sessionId === sessionId) {
      this.chattingForm.clearOnSend();
    } else {
      // Race: send completes after the user switched away from
      // this session. The form is no longer bound to it; bypass
      // the form and DELETE directly.
      void deleteDraft(sessionId);
    }
  }

  restoreFailedPrompt(sessionId: string): void {
    const prompt = this.sessionPrompts.get(sessionId);
    if (!prompt) return;
    if (sessionId === getActiveSessionId()) {
      const ta = this.getActiveForm()?.textarea;
      if (ta) {
        ta.value = prompt;
        // The form controller's own suppressNextInput guard would
        // already swallow this — but it's a private field. The
        // public path: write the cache directly so the form's input
        // listener (which checks the cache before scheduling)
        // recognizes it as a synced value. Simplest: dispatch a
        // real input event and let the form's debounce drive the
        // PUT (the value WILL be persisted, which is desired on
        // a failed-send recovery — the user wants this text safe).
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else {
      this.sessionDrafts.set(sessionId, prompt);
    }
  }

  /**
   * Get last sent input for the current session (up-arrow recall).
   */
  getLastInput(): string {
    const activeId = getActiveSessionId();
    if (!activeId) return '';
    return this.sessionPrompts.get(activeId) || this.sessionDrafts.get(activeId) || '';
  }
}

export const chatView = new ChatViewController();
export { ChatViewController };
