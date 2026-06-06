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
import { getDraft, putDraft, deleteDraft } from './chat-draft-api.js';

const RESUME_TIMEOUT_MS = 30000;

const DRAFT_DEBOUNCE_MS = 1000;
const DRAFT_BODY_CAP = 1024 * 1024;  // 1 MiB; matches server limit
const NEWCHAT_DRAFT_KEY = '__newchat__';

class ChatViewController {
  private sessionDrafts = new Map<string, string>();
  private sessionPrompts = new Map<string, string>();
  private footerSessionId: string | null = null;

  /** Keys (session ID or NEWCHAT_DRAFT_KEY) that have already been
   *  fetched from disk this page-load. Restore-on-activation is a
   *  one-shot per key; subsequent activations use the in-memory Map. */
  private draftsRehydrated = new Set<string>();

  /** Pending debounce timer for the active draft key, plus the key
   *  it belongs to. Single global timer — only one textarea, only
   *  one active key at a time. */
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  private draftTimerKey: string | null = null;

  /** Captured at view activation; never reads getActiveSessionId() at
   *  draft-write time. Prevents the mid-transition global-mutation race
   *  documented in docs/chat-draft-postmortem.md. */
  private activeBinding: { sessionId: string | null; key: string } | null = null;

  /** True once we've installed the input-listener on the textarea.
   *  The listener is installed lazily because the textarea may not
   *  exist at controller construction time. */
  private draftListenerWired = false;

  /** True once we've warned about exceeding the 1 MiB cap; suppresses
   *  repeat warnings on every keystroke past the cap. Reset when text
   *  drops back under cap. */
  private capWarningShown = false;

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

  private getTextarea(): HTMLTextAreaElement | null {
    return typeof document !== 'undefined'
      ? document.querySelector('#chatForm textarea[name="message"]') as HTMLTextAreaElement | null
      : null;
  }

  private saveDraft(): void {
    const id = getActiveSessionId();
    const ta = this.getTextarea();
    if (!id || !ta) return;
    const val = ta.value.trim();
    if (val) this.sessionDrafts.set(id, ta.value);
    else this.sessionDrafts.delete(id);
  }

  /** True while restoreDraft or hydrateDraft is programmatically
   *  setting the textarea value. Guards onDraftInput against echoing
   *  the just-restored content as a debounced PUT/DELETE. */
  private suppressNextInput = false;

  private restoreDraft(sessionId: string): void {
    const ta = this.getTextarea();
    if (!ta) return;
    const draft = this.sessionDrafts.get(sessionId) || '';
    ta.value = draft;
    // Suppress the input-listener echo: restoring the textarea to its
    // last-known value is not a user gesture and must not enqueue a
    // disk write (which would otherwise debounce a spurious PUT/DELETE).
    this.suppressNextInput = true;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // ── Disk-backed draft persistence ──────────────────────────────────
  //
  // The Map (sessionDrafts) is the in-page cache. Disk is the cross-
  // reload truth. Lifecycle:
  //   - Activation: GET disk → seed Map (one-shot per key) → restoreDraft
  //   - Input: debounce 1s → enqueued PUT (or DELETE if empty)
  //   - Send: cancel timer → enqueued DELETE
  // The chat-draft-api per-key queue guarantees PUT/DELETE ordering;
  // we just need to schedule them in the right place.

  /** Map key used to persist the new-chat draft (no session ID yet). */
  private get NEWCHAT_KEY(): string { return NEWCHAT_DRAFT_KEY; }

  /** True if the textarea's content fits within the persistence cap.
   *  Uses UTF-8 byte count (Blob.size) to match the server's
   *  express.text({limit:'1mb'}) parser, which measures bytes. A
   *  JS `.length` check would be UTF-16 code units and would let
   *  e.g. emoji-heavy text pass the client but 413 at the server. */
  private isWithinCap(text: string): boolean {
    if (typeof Blob === 'undefined') return text.length <= DRAFT_BODY_CAP;
    return new Blob([text]).size <= DRAFT_BODY_CAP;
  }

  /** Returns sessionId | null for current view; mirrors the
   *  active/newchat distinction the rest of the controller already
   *  makes. */
  /** Bind (or rebind) the controller's draft routing to a session
   *  (or null for newchat). Called at view-activation time, never
   *  from inside an input listener. The binding is the source of
   *  truth for which key onDraftInput writes to — NOT
   *  getActiveSessionId(), which mutates mid-transition. */
  private setActiveBinding(sessionId: string | null): void {
    const key = sessionId ?? this.NEWCHAT_KEY;
    this.activeBinding = { sessionId, key };
  }

  /** Install the textarea input listener once. Called from activation
   *  paths (existing session + new-chat) since the textarea is in the
   *  page on both. Subsequent calls are no-ops. */
  private ensureDraftListener(): void {
    if (this.draftListenerWired) return;
    const ta = this.getTextarea();
    if (!ta) return;
    ta.addEventListener('input', () => this.onDraftInput());
    this.draftListenerWired = true;
  }

  /** Last textarea value the controller has processed. Lets us
   *  bail on synthetic input events that don't actually change the
   *  value — e.g. setResponseOptions in message-streaming, which
   *  fires `dispatchEvent('input')` for unrelated reasons during
   *  showNewChat/showChat. Without this, those events would race
   *  the activeSessionId transition and route the prior-session
   *  text into NEWCHAT_KEY. */
  private lastSeenInputValue = '';

  private onDraftInput(): void {
    if (this.suppressNextInput) {
      this.suppressNextInput = false;
      const ta0 = this.getTextarea();
      if (ta0) this.lastSeenInputValue = ta0.value;
      return;  // synthetic event from restoreDraft/hydrateDraft; not a user gesture
    }
    const ta = this.getTextarea();
    if (!ta) return;
    const val = ta.value;
    if (val === this.lastSeenInputValue) return;  // unrelated synthetic event; no real change
    if (!this.activeBinding) return;  // not yet bound; drop without poisoning lastSeenInputValue
    this.lastSeenInputValue = val;
    const { sessionId, key } = this.activeBinding;

    // In-memory Map mirrors immediately (so up-arrow recall, session
    // switches, etc., see the current text without waiting on the
    // debounce). Whitespace-only counts as empty per existing
    // saveDraft semantics.
    if (val.trim()) this.sessionDrafts.set(key, val);
    else this.sessionDrafts.delete(key);

    if (!this.isWithinCap(val)) {
      if (!this.capWarningShown) {
        this.capWarningShown = true;
        try { showToast('Draft exceeds 1 MB; persistence paused until shorter.'); }
        catch { console.warn('[chat-draft] cap exceeded; persistence paused'); }
      }
      return;  // skip PUT but keep in-memory text intact
    }
    this.capWarningShown = false;

    this.scheduleDraftWrite(sessionId, key, val);
  }

  private scheduleDraftWrite(sessionId: string | null, key: string, text: string): void {
    // Single global timer: if the user switches session mid-debounce,
    // the prior timer is for the prior key and is no longer relevant.
    // Cancel it and start a new one for the current key. This is fine
    // because the prior key's last PUT/DELETE already enqueued whatever
    // text was there at switch time via the activation path.
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => {
      this.draftTimer = null;
      this.draftTimerKey = null;
      if (text.trim()) void putDraft(sessionId, text);
      else void deleteDraft(sessionId);
    }, DRAFT_DEBOUNCE_MS);
    this.draftTimerKey = key;
  }

  /** Cancel any pending debounce timer (e.g. before sending). The
   *  caller is responsible for issuing whatever request reflects the
   *  desired post-cancel state (typically DELETE on send). */
  private cancelDraftTimer(): void {
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = null;
    this.draftTimerKey = null;
  }

  /** Flush any pending debounced draft for the currently-scheduled
   *  key. Used on session-switch and showNewChat so the OUTGOING key's
   *  last 0-1 s of typing isn't dropped when we cancel its timer to
   *  start the INCOMING key's timer. Sends the current in-memory
   *  value (PUT if non-empty, DELETE if whitespace-only). The per-key
   *  queue in chat-draft-api guarantees ordering vs follow-up writes. */
  private flushPendingDraft(): void {
    if (!this.draftTimer || !this.draftTimerKey) return;
    const key = this.draftTimerKey;
    this.cancelDraftTimer();
    const text = this.sessionDrafts.get(key) ?? '';
    const sessionId = key === this.NEWCHAT_KEY ? null : key;
    if (text.trim() && this.isWithinCap(text)) void putDraft(sessionId, text);
    else if (!text.trim()) void deleteDraft(sessionId);
    // If over-cap and non-empty: skip (consistent with onDraftInput).
  }

  /** Fetch the disk draft for `key` once per page-load and seed the
   *  in-memory Map. After completion, re-call restoreDraft so the
   *  textarea picks up the disk value if the Map was empty. */
  private async hydrateDraft(sessionId: string | null, key: string): Promise<void> {
    if (this.draftsRehydrated.has(key)) return;
    this.draftsRehydrated.add(key);
    if (this.sessionDrafts.has(key)) return;  // in-memory wins; nothing to load
    const text = await getDraft(sessionId);
    if (text === null || text === '') return;
    // Only adopt the disk draft if the textarea is still empty AND
    // the Map is still empty — otherwise the user has typed something
    // since we kicked off the fetch and we'd clobber it.
    if (this.sessionDrafts.has(key)) return;
    this.sessionDrafts.set(key, text);
    const ta = this.getTextarea();
    if (ta && !ta.value) {
      ta.value = text;
      this.suppressNextInput = true;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
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
    // Flush outgoing key's pending debounce — see showChat.
    this.flushPendingDraft();
    // Set the binding BEFORE releaseActiveSessionForNewChat so the
    // binding flip is part of this view-transition step rather than
    // a side effect of the global mutation that follows.
    // flushPendingDraft reads draftTimerKey (not the binding or the
    // global), so the ordering does not affect flush correctness.
    this.setActiveBinding(null);
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
    // Restore in-memory new-chat draft first (instant), then hydrate
    // from disk if not seen this page-load.
    this.restoreDraft(this.NEWCHAT_KEY);
    this.ensureDraftListener();
    void this.hydrateDraft(null, this.NEWCHAT_KEY);
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
    this.saveDraft();
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
    // Flush the outgoing key's pending debounce BEFORE we replace
    // the timer with the incoming key's. Otherwise the prior
    // session's last <1s of typing would be lost from disk (still
    // safe in the in-memory Map until reload).
    this.flushPendingDraft();
    this.setActiveBinding(sessionId);
    this.footerSessionId = sessionId;
    updateMenuIndicators();
    notifySessionChange(sessionId, { sessionId, cwd, name, kind, model, currentIntent });
    this.updateStatus(cwd, model, hasGit, name, sessionId, hasIcon, gitBranch);
    restoreContextUsage(sessionId);
    adHocBar.activateSession(sessionId);
    setViewState('chatting');
    this.restoreDraft(sessionId);
    this.ensureDraftListener();
    void this.hydrateDraft(sessionId, sessionId);
  }

  /**
   * Called after streamResponse creates a new session.
   * Transitions to chatting view with the new session.
   */
  onNewSessionCreated(sessionId: string, cwd: string): void {
    this.setActiveBinding(sessionId);
    setActiveSession(sessionId, cwd);
    subscribeToSession(sessionId);
    updateMenuIndicators();
    this.updateStatus(cwd);
    adHocBar.activateSession(sessionId);
    setViewState('chatting');
    // The send that created this session consumed the newchat draft.
    // Cancel any debounced PUT and DELETE the disk file so a reload
    // doesn't resurrect it. Map entry is cleared by savePrompt.
    if (this.draftTimerKey === this.NEWCHAT_KEY) this.cancelDraftTimer();
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
    // Disk: cancel any pending debounced PUT for this key, then
    // enqueue a DELETE. The chat-draft-api per-key queue guarantees
    // the DELETE runs after any PUT already on the wire.
    if (this.draftTimerKey === sessionId) this.cancelDraftTimer();
    void deleteDraft(sessionId);
  }

  restoreFailedPrompt(sessionId: string): void {
    const prompt = this.sessionPrompts.get(sessionId);
    if (!prompt) return;
    if (sessionId === getActiveSessionId()) {
      const ta = this.getTextarea();
      if (ta) {
        ta.value = prompt;
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
