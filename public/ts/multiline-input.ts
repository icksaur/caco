/**
 * Multiline Input
 * 
 * Auto-expanding textarea for chat input.
 * - Enter submits the form
 * - Shift+Enter adds a newline
 * - Auto-expands up to max height, then scrolls
 * - `/` triggers slash command popup
 * - `#` triggers file reference popup
 */

import { InputPopup, type PopupItem } from './input-popup.js';
import { getCommands, findCommand } from './command-registry.js';
import { getCurrentCwd } from './app-state.js';
import { fuzzyScore } from './ui-utils.js';

const MAX_HEIGHT = 180;
const FILE_CACHE_TTL_MS = 30_000;

let slashPopup: InputPopup | null = null;
let poundPopup: InputPopup | null = null;
let poundAnchorPos = -1;

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

function getAnchor(): HTMLElement {
  return document.querySelector('#chatForm .input-bar') as HTMLElement;
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

export function setupMultilineInput(): void {
  const textarea = document.querySelector('#chatForm textarea[name="message"]') as HTMLTextAreaElement;
  if (!textarea) return;

  const anchor = getAnchor();

  textarea.addEventListener('input', () => {
    autoResize(textarea);
    handleSlash(textarea, anchor);
    handlePound(textarea, anchor);
  });

  textarea.addEventListener('keydown', (e) => {
    if (slashPopup?.isVisible() && slashPopup.handleKey(e)) {
      e.preventDefault();
      return;
    }
    if (poundPopup?.isVisible() && poundPopup.handleKey(e)) {
      e.preventDefault();
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      if (slashPopup?.isVisible() || poundPopup?.isVisible()) return;
      e.preventDefault();
      const form = textarea.closest('form');
      if (form) form.requestSubmit();
    }
  });
}

function handleSlash(textarea: HTMLTextAreaElement, anchor: HTMLElement): void {
  const val = textarea.value;

  if (!val.startsWith('/')) {
    if (slashPopup?.isVisible()) {
      slashPopup.hide();
    }
    return;
  }

  if (!slashPopup) {
    slashPopup = new InputPopup({
      anchor,
      onSelect: (item) => {
        slashPopup!.hide();
        textarea.value = '';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        autoResize(textarea);
        const cmd = findCommand(item.id);
        if (cmd) void Promise.resolve(cmd.handler(''));
      },
      onDismiss: () => slashPopup!.hide()
    });
  }

  if (!slashPopup.isVisible()) {
    const items: PopupItem[] = getCommands().map(c => ({
      id: c.name,
      label: `/${c.name}`,
      description: c.description
    }));
    slashPopup.show(items);
  }

  const query = val.slice(1);
  slashPopup.filter(query);
}

function handlePound(textarea: HTMLTextAreaElement, anchor: HTMLElement): void {
  const cursorPos = textarea.selectionStart;
  const trigger = findPoundTrigger(textarea.value, cursorPos);

  if (!trigger) {
    if (poundPopup?.isVisible()) {
      poundPopup.hide();
      poundAnchorPos = -1;
    }
    return;
  }

  if (!poundPopup) {
    poundPopup = new InputPopup({
      anchor,
      onSelect: (item) => {
        poundPopup!.hide();
        const before = textarea.value.slice(0, poundAnchorPos);
        const after = textarea.value.slice(cursorPos);
        textarea.value = before + item.label + after;
        const newCursor = poundAnchorPos + item.label.length;
        textarea.setSelectionRange(newCursor, newCursor);
        poundAnchorPos = -1;
        autoResize(textarea);
      },
      onDismiss: () => {
        poundPopup!.hide();
        poundAnchorPos = -1;
      }
    });
  }

  poundAnchorPos = trigger.start;

  if (!poundPopup.isVisible()) {
    const cwd = getCurrentCwd();
    void fetchProjectFiles(cwd).then(files => {
      const items: PopupItem[] = files.map(f => ({ id: f, label: f }));
      poundPopup!.show(items);
      if (trigger.query) poundPopup!.filter(trigger.query);
    });
  } else {
    poundPopup.filter(trigger.query);
  }
}

function autoResize(textarea: HTMLTextAreaElement): void {
  textarea.style.height = 'auto';
  const newHeight = Math.min(textarea.scrollHeight, MAX_HEIGHT);
  textarea.style.height = `${newHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden';
}

export function resetTextareaHeight(): void {
  const textarea = document.querySelector('#chatForm textarea[name="message"]') as HTMLTextAreaElement;
  if (textarea) {
    textarea.style.height = 'auto';
    textarea.style.overflowY = 'hidden';
  }
}
