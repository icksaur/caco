/**
 * ChatFormController
 *
 * Per-view chat-input form controller. Each visible chat view
 * (newChat, chatting) gets its own instance with its own textarea,
 * its own debounce timer, its own draft binding, and its own
 * suppressNextInput / capWarning state.
 *
 * Eliminates the shared-textarea race that caused the chat-draft
 * bleed bug (docs/chat-draft-postmortem.md): each form's input
 * listener routes to that form's own binding, set at view
 * activation. No mid-transition global mutation can reach across
 * to corrupt the other form's state.
 *
 * In-memory draft cache (`sessionDrafts` Map) and disk I/O queue
 * stay on ChatViewController — shared across both forms because
 * the cache key (session ID or NEWCHAT_KEY) is global. Disk
 * operations go through chat-draft-api which serializes per key.
 *
 * See docs/chat-form-refactor.md §"Phase R3".
 */

import { getDraft, putDraft, deleteDraft } from './chat-draft-api.js';
import { showToast } from './toast.js';
import { FormPopups, autoResize } from './chat-form-popups.js';
import { findCommand } from './command-registry.js';
import { chatView } from './chat-view-controller.js';
import { computeFormState } from './form-state.js';
import { formStateStore } from './form-state-store.js';
import { sessionTracker } from './session-state-tracker.js';
import { getActiveSessionId, getNewChatCwd, notifyMessageSent } from './app-state.js';
import { isViewState } from './view-controller.js';
import { dispatchPrompt, dispatchSteer } from './message-streaming.js';
import { showNewChatError } from './model-selector.js';
import { removeImage } from './image-paste.js';

const DRAFT_DEBOUNCE_MS = 1000;
const DRAFT_BODY_CAP = 1024 * 1024;  // 1 MiB; matches server limit
const NEWCHAT_DRAFT_KEY = '__newchat__';

/** Render response-option buttons into the given container. Lifted
 *  from message-streaming.ts so each form owns its own #responseOptions
 *  rendering off its own click handler. */
function renderResponseOptions(container: HTMLElement, options: string[], muted: boolean): void {
  if (options.length === 0) { container.style.display = 'none'; return; }
  container.style.display = '';
  container.innerHTML = options.map(o =>
    `<button class="response-option-btn${muted ? ' muted' : ''}" data-prompt="${o.replace(/"/g, '&quot;')}">${o.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</button>`
  ).join('');
}

/** Binding identifies which key the form's input routes drafts under.
 *  sessionId === null = newchat (key = NEWCHAT_DRAFT_KEY). */
export interface Binding {
  readonly sessionId: string | null;
  readonly key: string;
}

/** Subset of ChatViewController this form needs access to: the shared
 *  in-memory draft cache. Kept as a structural interface so the
 *  controller can be tested without the full chatView. */
export interface DraftCache {
  getDraftCache(key: string): string | undefined;
  setDraftCache(key: string, val: string): void;
}

export class ChatFormController {
  readonly view: 'newChat' | 'chatting';
  readonly form: HTMLFormElement;
  readonly textarea: HTMLTextAreaElement;
  readonly imageDataInput: HTMLInputElement;

  /** Per-form popup trio (slash, pound, picker). R3.5 lifted this
   *  off module-level singletons in multiline-input.ts. */
  readonly popups: FormPopups;

  /** Current binding. Set by bind() at view activation; never read
   *  from a global. Null until first bind. */
  binding: Binding | null = null;

  private cache: DraftCache;
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  private draftTimerKey: string | null = null;

  /** Suppress the next input event so programmatic value-sets
   *  (restore, hydrate, prompt-template apply, etc.) don't echo into
   *  onInput and schedule a wasteful redundant disk write. */
  private suppressNextInput = false;

  /** True once we've warned about exceeding the 1 MiB cap. Reset
   *  when the value drops back under cap. */
  private capWarningShown = false;

  /** Number of in-flight steers (chatting form only). Shown as the
   *  parenthesized count on the Stop button. */
  private steerCount = 0;

  /** True between submit and dispatch resolution; blocks double-fire
   *  while a steer/send is still in flight. */
  private submitting = false;

  /** Keys this controller has already hydrated from disk this page-
   *  load. Restore-on-bind is a one-shot per key. */
  private hydrated = new Set<string>();

  constructor(form: HTMLFormElement, view: 'newChat' | 'chatting', cache: DraftCache) {
    this.form = form;
    this.view = view;
    this.cache = cache;
    const ta = form.querySelector('textarea[name="message"]') as HTMLTextAreaElement | null;
    if (!ta) throw new Error(`ChatFormController(${view}): no textarea`);
    this.textarea = ta;
    const anchor = form.querySelector('.input-bar') as HTMLElement | null;
    if (!anchor) throw new Error(`ChatFormController(${view}): no .input-bar anchor`);
    this.popups = new FormPopups(ta, anchor);
    const imageDataEl = form.querySelector('input[name="imageData"]') as HTMLInputElement | null;
    if (!imageDataEl) throw new Error(`ChatFormController(${view}): no imageData input`);
    this.imageDataInput = imageDataEl;
  }

  /** Install input + keydown + submit + stop listeners. R3.5 boot
   *  calls this exactly once per controller. */
  attach(): void {
    this.popups.attach();
    this.textarea.addEventListener('input', () => this.onInput());
    this.textarea.addEventListener('keydown', (e) => this.onKeydown(e));

    const stopBtn = this.form.querySelector('.stop-btn') as HTMLButtonElement | null;
    stopBtn?.addEventListener('click', () => {
      const sessionId = getActiveSessionId();
      if (sessionId) void fetch(`/api/sessions/${sessionId}/cancel`, { method: 'POST' });
    });

    const optionsEl = this.form.querySelector('#responseOptions') as HTMLElement | null;
    optionsEl?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.response-option-btn') as HTMLElement | null;
      if (!btn || btn.classList.contains('muted')) return;
      const prompt = btn.dataset.prompt;
      if (!prompt) return;
      formStateStore.set({ options: [] });
      this.textarea.value = prompt;
      this.textarea.dispatchEvent(new Event('input', { bubbles: true }));
      this.form.requestSubmit();
    });

    this.form.addEventListener('submit', (e) => this.handleSubmit(e));

    if (this.view === 'chatting') {
      formStateStore.subscribe(() => this.refreshButton());
      sessionTracker.onChange(() => {
        const id = getActiveSessionId();
        const busy = id ? (sessionTracker.get(id)?.busy ?? false) : false;
        formStateStore.set({ sessionBusy: busy });
      });
    }
  }

  /** Reset the steer counter and refresh the button. Called by
   *  message-streaming when a session reaches idle. */
  resetSteerCount(): void {
    this.steerCount = 0;
    this.refreshButton();
  }

  /** Refresh send/stop button + placeholder + options visibility
   *  from the current store + steerCount. Only meaningful on the
   *  chatting form; newchat has no #responseOptions / .stop-btn. */
  refreshButton(): void {
    const input = this.form.querySelector('textarea[name="message"]') as HTMLTextAreaElement | null;
    const sendBtn = this.form.querySelector('.send-btn') as HTMLButtonElement | null;
    const stopBtn = this.form.querySelector('.stop-btn') as HTMLButtonElement | null;
    const optionsEl = this.form.querySelector('#responseOptions') as HTMLElement | null;
    const isBusy = formStateStore.get().sessionBusy;
    const hasText = (input?.value.trim().length ?? 0) > 0;
    const currentOptions = formStateStore.get().options;
    const state = computeFormState(isBusy, hasText, currentOptions.length > 0);

    if (sendBtn) {
      if (state.buttonLabel === 'send' || state.buttonLabel === 'steer') {
        sendBtn.style.display = '';
        sendBtn.textContent = state.buttonLabel === 'send' ? 'Send' : 'Steer';
        sendBtn.disabled = !state.buttonEnabled;
      } else {
        // 'stop' state: the Stop button takes over below.
        sendBtn.style.display = 'none';
      }
    }
    if (stopBtn) {
      if (state.buttonLabel === 'stop') {
        stopBtn.style.display = 'flex';
        stopBtn.textContent = this.steerCount > 0 ? `Stop (${this.steerCount})` : 'Stop';
      } else {
        stopBtn.style.display = 'none';
      }
    }
    if (input) input.placeholder = state.placeholder;
    this.form.classList.toggle('busy', isBusy);

    if (optionsEl) {
      if (state.optionsVisible || state.optionsMuted) {
        renderResponseOptions(optionsEl, currentOptions.slice(), state.optionsMuted);
      } else {
        optionsEl.style.display = 'none';
      }
    }
  }

  private handleSubmit(e: SubmitEvent): void {
    e.preventDefault();
    if (this.submitting) return;

    const message = this.textarea.value.trim();
    const sessionId = getActiveSessionId();
    const isBusy = formStateStore.get().sessionBusy;
    const state = computeFormState(isBusy, !!message);

    if (message.startsWith('/')) {
      if (this.tryExecuteSlashCommand(message)) {
        this.textarea.value = '';
        this.resetTextareaHeight();
        this.clearDraft();
        this.refreshButton();
        return;
      }
    }

    if (!message) return;

    if (state.buttonAction === 'steer' && sessionId) {
      // L2 fix: snapshot the binding at dispatch time. The user may
      // switch sessions during the await; if restoreFailedInput runs
      // after a rebind, the text must go to the launch session's
      // cache, not bleed into whatever session is now bound.
      const launchBinding = this.binding;
      this.textarea.value = '';
      this.resetTextareaHeight();
      this.clearDraft();
      this.steerCount++;
      this.submitting = true;
      this.refreshButton();
      void (async () => {
        try {
          const res = await dispatchSteer(sessionId, message);
          if (res.ok) {
            notifyMessageSent(sessionId);
          } else {
            const data = await res.json().catch(() => ({ error: 'Steer failed' }));
            showToast(data.error || 'Steer failed');
            this.restoreFailedInput(message, launchBinding);
            this.steerCount = Math.max(0, this.steerCount - 1);
            this.refreshButton();
          }
        } catch {
          showToast('Steer failed');
          this.restoreFailedInput(message, launchBinding);
          this.steerCount = Math.max(0, this.steerCount - 1);
          this.refreshButton();
        } finally {
          this.submitting = false;
        }
      })();
      return;
    }

    const imageData = this.imageDataInput.value;
    const cwd = getNewChatCwd();
    const isNewChat = isViewState('newChat');

    if (isNewChat && !cwd) {
      showNewChatError('Please enter a working directory');
      return;
    }

    chatView.setFormEnabled(false);
    this.steerCount = 0;
    formStateStore.set({ options: [] });
    this.refreshButton();

    this.textarea.value = '';
    this.resetTextareaHeight();
    this.clearDraft();
    removeImage();

    dispatchPrompt({ message, imageData, newChat: isNewChat, cwd });
  }

  /** Reset textarea height to single-line. Called after submit, on
   *  session switch, and on clear. R3.5 owns this on the controller
   *  so callers don't reach into multiline-input. */
  resetTextareaHeight(): void {
    this.textarea.style.height = 'auto';
    this.textarea.style.overflowY = 'hidden';
  }

  /** Restore an input string after a failed dispatch.
   *
   *  If the form's binding is still the one in effect at dispatch
   *  time (`launchBinding`), restore via the normal textarea +
   *  input-event path so the user sees the recovered text and the
   *  draft cache + debounced PUT re-persist it.
   *
   *  If the binding has changed (user switched sessions during the
   *  async wait), the restored text MUST go to the launch session's
   *  cache, not the currently-bound session's textarea. Otherwise
   *  the failed steer for session A would bleed into session B.
   *  Route directly through the cache + disk PUT. */
  private restoreFailedInput(message: string, launchBinding: Binding | null): void {
    if (!launchBinding) return;

    const sameBinding = this.binding?.key === launchBinding.key;
    if (sameBinding) {
      if (this.textarea.value.trim()) return;
      this.textarea.value = message;
      this.resetTextareaHeight();
      this.textarea.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    // Cross-binding restore: write to the launch session's cache +
    // disk directly. Don't touch the textarea (it belongs to a
    // different session now).
    this.cache.setDraftCache(launchBinding.key, message);
    void putDraft(launchBinding.sessionId, message);
  }

  /** Try to execute a leading slash-command in the given message.
   *  Returns true if the message was a command (caller should NOT
   *  send it as a prompt). If the command is a picker with no args
   *  the picker opens via this.popups; otherwise the command's
   *  handler runs immediately. */
  tryExecuteSlashCommand(message: string): boolean {
    const match = message.match(/^\/(\S+)\s*([\s\S]*)/);
    if (!match) return false;
    const [, name, args] = match;
    const cmd = findCommand(name);
    if (!cmd) return false;

    if (cmd.picker && !args.trim()) {
      void this.popups.openPicker(name);
      return true;
    }

    void Promise.resolve(cmd.handler(args.trim()));
    return true;
  }

  private onKeydown(e: KeyboardEvent): void {
    if (this.popups.handleKey(e)) {
      e.preventDefault();
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      // If a popup is visible the popup consumed its own key above;
      // otherwise Enter submits.
      if (this.popups.isAnyVisible()) return;
      e.preventDefault();
      this.form.requestSubmit();
    }

    if (e.key === 'ArrowUp' && !this.textarea.value) {
      const last = chatView.getLastInput();
      if (last) {
        e.preventDefault();
        this.textarea.value = last;
        autoResize(this.textarea);
        this.textarea.setSelectionRange(last.length, last.length);
      }
    }
  }

  /** Bind (or rebind) the form to a session (or null for newchat).
   *  Flushes any pending debounce for the prior binding, then sets
   *  the new binding, restores from in-memory cache, kicks off a
   *  one-shot disk hydrate if not already done for this key. */
  bind(sessionId: string | null): void {
    this.flushPending();
    const key = sessionId ?? NEWCHAT_DRAFT_KEY;
    this.binding = { sessionId, key };
    this.restoreFromCache(key);
    void this.hydrateFromDisk(sessionId, key);
  }

  /** Flush any pending debounced draft for the currently-scheduled
   *  key. Used on rebind and (optionally) on send. The per-key
   *  promise queue in chat-draft-api guarantees ordering. */
  flushPending(): void {
    if (!this.draftTimer || !this.draftTimerKey) return;
    const key = this.draftTimerKey;
    this.cancelTimer();
    const text = this.cache.getDraftCache(key) ?? '';
    const sessionId = key === NEWCHAT_DRAFT_KEY ? null : key;
    if (text.trim() && this.isWithinCap(text)) void putDraft(sessionId, text);
    else if (!text.trim()) void deleteDraft(sessionId);
    // If over-cap and non-empty: skip (consistent with onInput).
  }

  /** Send-time: cancel any pending PUT, clear in-memory cache for
   *  this form's current binding, enqueue disk DELETE. The per-key
   *  queue in chat-draft-api guarantees DELETE observes any in-flight
   *  PUT for the same key (it runs after). Idempotent.
   *
   *  Called by handleSubmit on every path that consumes the user's
   *  input: regular send, steer, and slash-command. The form owns
   *  its own draft lifecycle — clearing on its own consume action,
   *  instead of relying on downstream code (streamResponse,
   *  savePrompt) to clear the right key. */
  clearDraft(): void {
    if (!this.binding) return;
    const { sessionId, key } = this.binding;
    this.cancelTimer();
    this.cache.setDraftCache(key, '');
    void deleteDraft(sessionId);
  }

  /** @deprecated Use clearDraft. Retained as alias for any external caller. */
  clearOnSend(): void {
    this.clearDraft();
  }

  private cancelTimer(): void {
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = null;
    this.draftTimerKey = null;
  }

  private isWithinCap(text: string): boolean {
    if (typeof Blob === 'undefined') return text.length <= DRAFT_BODY_CAP;
    return new Blob([text]).size <= DRAFT_BODY_CAP;
  }

  private onInput(): void {
    // Keep the send/steer/stop button in sync with the live textarea
    // on EVERY input. Without this the button never updates while
    // typing: idle+text wouldn't reveal Send, and busy+text wouldn't
    // flip Stop→Steer (the refactor dropped this sync). Runs first so
    // programmatic restores (suppressNextInput) still refresh the
    // button. Chatting-only: newchat's button isn't store-driven.
    if (this.view === 'chatting') this.refreshButton();

    if (this.suppressNextInput) {
      this.suppressNextInput = false;
      return;  // programmatic restore; not a user gesture
    }
    if (!this.binding) return;  // not yet bound
    const { sessionId, key } = this.binding;
    const val = this.textarea.value;

    // In-memory cache mirrors immediately.
    this.cache.setDraftCache(key, val);

    if (!this.isWithinCap(val)) {
      if (!this.capWarningShown) {
        this.capWarningShown = true;
        try { showToast('Draft exceeds 1 MB; persistence paused until shorter.'); }
        catch { console.warn('[chat-draft] cap exceeded; persistence paused'); }
      }
      return;
    }
    this.capWarningShown = false;

    this.scheduleWrite(sessionId, key, val);
  }

  private scheduleWrite(sessionId: string | null, key: string, text: string): void {
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => {
      this.draftTimer = null;
      this.draftTimerKey = null;
      if (text.trim()) void putDraft(sessionId, text);
      else void deleteDraft(sessionId);
    }, DRAFT_DEBOUNCE_MS);
    this.draftTimerKey = key;
  }

  private restoreFromCache(key: string): void {
    const cached = this.cache.getDraftCache(key) ?? '';
    if (this.textarea.value === cached) return;
    this.textarea.value = cached;
    this.suppressNextInput = true;
    this.textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  private async hydrateFromDisk(sessionId: string | null, key: string): Promise<void> {
    if (this.hydrated.has(key)) return;
    this.hydrated.add(key);
    if (this.cache.getDraftCache(key) !== undefined) return;  // in-memory wins
    const text = await getDraft(sessionId);
    if (text === null || text === '') return;
    // Race-safe: re-check that the cache is still empty AND the
    // textarea is still empty before adopting (user may have typed
    // since fetch started; binding may have changed mid-flight).
    if (this.cache.getDraftCache(key) !== undefined) return;
    if (this.binding?.key !== key) return;
    if (this.textarea.value) return;
    this.cache.setDraftCache(key, text);
    this.textarea.value = text;
    this.suppressNextInput = true;
    this.textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }
}
