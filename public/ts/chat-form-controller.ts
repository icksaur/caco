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

const DRAFT_DEBOUNCE_MS = 1000;
const DRAFT_BODY_CAP = 1024 * 1024;  // 1 MiB; matches server limit
const NEWCHAT_DRAFT_KEY = '__newchat__';

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
  }

  /** Install input listener. Idempotent — only the first call wires. */
  attach(): void {
    this.textarea.addEventListener('input', () => this.onInput());
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

  /** Send-time: cancel any pending PUT, enqueue DELETE. The per-key
   *  queue in chat-draft-api guarantees DELETE observes any in-flight
   *  PUT for the same key (it runs after). */
  clearOnSend(): void {
    if (!this.binding) return;
    this.cancelTimer();
    void deleteDraft(this.binding.sessionId);
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
