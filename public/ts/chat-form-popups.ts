/**
 * FormPopups — per-form popup trio (slash, pound, picker).
 *
 * Each ChatFormController owns one FormPopups instance. Encapsulates
 * all popup state that previously lived as module-level singletons in
 * multiline-input.ts (which caused the popup-wrong-textarea regression
 * after R3 V1's two-form split). Per-form ownership makes that bug
 * class structurally impossible.
 *
 * See docs/chat-form-r3.5.md §R3.5a.
 */

import { InputPopup, type PopupItem } from './input-popup.js';
import { getCommands, findCommand } from './command-registry.js';
import { chatView } from './chat-view-controller.js';
import { poundProviders } from './multiline-input.js';

const MAX_HEIGHT = 180;
const FILE_CACHE_TTL_MS = 30_000;

// Module-level file cache — correctly cross-form: keyed by cwd.
let cachedFiles: string[] = [];
let cacheTimestamp = 0;
let cacheCwd = '';

async function fetchProjectFiles(cwd: string): Promise<string[]> {
  if (cachedFiles.length && cwd === cacheCwd && Date.now() - cacheTimestamp < FILE_CACHE_TTL_MS) {
    return cachedFiles;
  }
  try {
    const resp = await fetch(`/api/project-files?cwd=${encodeURIComponent(cwd)}`);
    if (!resp.ok) return cachedFiles;
    const data = await resp.json();
    cachedFiles = data.files || [];
    cacheTimestamp = Date.now();
    cacheCwd = cwd;
  } catch { /* keep stale cache */ }
  return cachedFiles;
}

function findPoundTrigger(text: string, cursorPos: number): { start: number; query: string } | null {
  for (let i = cursorPos - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === '#') {
      if (i === 0 || ' \t\n'.includes(text[i - 1])) {
        return { start: i, query: text.slice(i + 1, cursorPos) };
      }
      return null;
    }
    if (ch === ' ' || ch === '\n' || ch === '\t') return null;
  }
  return null;
}

/** Resize a textarea to fit content up to MAX_HEIGHT. Exported so
 *  any caller that programmatically sets textarea.value can resize
 *  without a synthetic input event. */
export function autoResize(textarea: HTMLTextAreaElement): void {
  textarea.style.height = 'auto';
  const newHeight = Math.min(textarea.scrollHeight, MAX_HEIGHT);
  textarea.style.height = `${newHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden';
}

export function formatSlashPickerValue(cmdName: string, picked: PopupItem): string {
  return `/${cmdName} ${picked.value ?? picked.id}`;
}

// `registerPoundProvider` is intentionally NOT re-exported here.
// Callers register pound providers via the canonical
// `multiline-input.ts` module to keep a single import surface for
// extension authors.

export class FormPopups {
  readonly textarea: HTMLTextAreaElement;
  readonly anchor: HTMLElement;
  private slash: InputPopup | null = null;
  private pound: InputPopup | null = null;
  private picker: InputPopup | null = null;
  private poundAnchorPos = -1;

  constructor(textarea: HTMLTextAreaElement, anchor: HTMLElement) {
    this.textarea = textarea;
    this.anchor = anchor;
  }

  /** Install input + keydown listeners. The input listener handles
   *  autoresize and slash/pound triggers; the keydown listener
   *  forwards navigation keys to whichever popup is visible. */
  attach(): void {
    this.textarea.addEventListener('input', () => {
      autoResize(this.textarea);
      this.handleSlash();
      this.handlePound();
    });
  }

  /** True if any of the three popups is visible. Used by the
   *  controller's keydown handler to decide whether to intercept
   *  Enter / Arrow keys. */
  isAnyVisible(): boolean {
    return !!(this.slash?.isVisible() || this.pound?.isVisible() || this.picker?.isVisible());
  }

  /** Forward a keydown to the visible popup. Returns true if the
   *  popup consumed the event. */
  handleKey(e: KeyboardEvent): boolean {
    if (this.picker?.isVisible() && this.picker.handleKey(e)) return true;
    if (this.slash?.isVisible() && this.slash.handleKey(e)) return true;
    if (this.pound?.isVisible() && this.pound.handleKey(e)) return true;
    return false;
  }

  /** Open a slash-command picker. Used by the controller's
   *  tryExecuteSlashCommand when the user typed `/cmd<enter>` with
   *  no args. FormPopups owns the command-registry lookup so the
   *  caller passes only the name. */
  async openPicker(cmdName: string): Promise<void> {
    const cmd = findCommand(cmdName);
    if (!cmd?.picker) return;
    const items = await Promise.resolve(cmd.picker());
    if (this.picker) this.picker.hide();
    this.picker = new InputPopup({
      anchor: this.anchor,
      onSelect: (picked) => {
        this.picker!.hide();
        this.textarea.value = formatSlashPickerValue(cmdName, picked);
        autoResize(this.textarea);
        this.textarea.focus();
      },
      onDismiss: () => {
        this.picker!.hide();
        this.textarea.value = `/${cmdName} `;
        autoResize(this.textarea);
        setTimeout(() => this.textarea.focus(), 0);
      },
    });
    this.picker.show(items);
  }

  private handleSlash(): void {
    const val = this.textarea.value;

    if (this.picker?.isVisible()) {
      this.picker.filter(val);
      return;
    }

    if (!val.startsWith('/')) {
      if (this.slash?.isVisible()) this.slash.hide();
      return;
    }

    const query = val.slice(1);
    const hasArgs = query.includes(' ');

    if (hasArgs) {
      if (this.slash?.isVisible()) this.slash.hide();
      return;
    }

    if (!this.slash) {
      this.slash = new InputPopup({
        anchor: this.anchor,
        onSelect: (item) => {
          this.slash!.hide();
          this.textarea.value = `/${item.id} `;
          autoResize(this.textarea);
          this.textarea.focus();
        },
        onDismiss: () => this.slash!.hide(),
      });
    }

    if (!this.slash.isVisible()) {
      const items: PopupItem[] = getCommands().map(c => ({
        id: c.name,
        label: `/${c.name}`,
        description: c.description,
      }));
      this.slash.show(items);
    }

    this.slash.filter(query);
  }

  private handlePound(): void {
    const cursorPos = this.textarea.selectionStart;
    const trigger = findPoundTrigger(this.textarea.value, cursorPos);

    if (!trigger) {
      if (this.pound?.isVisible()) {
        this.pound.hide();
        this.poundAnchorPos = -1;
      }
      return;
    }

    if (!this.pound) {
      this.pound = new InputPopup({
        anchor: this.anchor,
        onSelect: (item) => {
          this.pound!.hide();
          const currentCursor = this.textarea.selectionStart;
          const before = this.textarea.value.slice(0, this.poundAnchorPos);
          const after = this.textarea.value.slice(currentCursor);
          const insertion = item.value ?? ('`' + item.label + '`');
          this.textarea.value = before + insertion + after;
          const newCursor = this.poundAnchorPos + insertion.length;
          this.textarea.setSelectionRange(newCursor, newCursor);
          this.poundAnchorPos = -1;
          autoResize(this.textarea);
        },
        onDismiss: () => {
          this.pound!.hide();
          this.poundAnchorPos = -1;
        },
      });
    }

    this.poundAnchorPos = trigger.start;

    if (!this.pound.isVisible()) {
      const cwd = chatView.getCwd();
      void fetchProjectFiles(cwd).then(files => {
        const fileItems: PopupItem[] = files.map(f => ({ id: f, label: f }));
        const extItems = poundProviders.flatMap(p => { try { return p(); } catch { return []; } });
        this.pound!.show([...extItems, ...fileItems]);
        if (trigger.query) this.pound!.filter(trigger.query);
      });
    } else {
      this.pound.filter(trigger.query);
    }
  }
}
