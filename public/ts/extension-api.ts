/**
 * Client Extension API
 *
 * Factory that creates a sandboxed API surface for each client extension.
 */

import { regions } from './dom-regions.js';
import { onGlobalEvent, wsSendRaw } from './websocket.js';
import { sessionClick } from './router.js';
import { showToast } from './toast.js';
import { registerCommand, type Command } from './command-registry.js';
import { registerPoundProvider } from './multiline-input.js';
import type { PopupItem } from './input-popup.js';
import type { SessionEvent } from './types.js';

export interface ClientExtensionAPI {
  footer: {
    addLeft(id: string, render: () => HTMLElement | string): () => void;
    addRight(id: string, render: () => HTMLElement | string): () => void;
    update(id: string, content: HTMLElement | string): void;
  };
  header: {
    addLeft(id: string, render: () => HTMLElement | string): () => void;
    addRight(id: string, render: () => HTMLElement | string): () => void;
  };
  on(event: string, handler: (e: SessionEvent) => void): () => void;
  registerShortcut(combo: string, handler: () => void): () => void;
  switchSession(index: number): void;
  switchSessionById(id: string): void;
  send(type: string, data?: unknown): void;
  getState<T>(key: string): T | undefined;
  setState<T>(key: string, value: T): void;
  toast(message: string): void;
  registerCommand(name: string, opts: { description?: string; handler: () => void }): () => void;
  registerPoundItems(provider: () => Array<{ label: string; description?: string; value: string }>): () => void;
}

function renderInto(wrapper: HTMLElement, content: HTMLElement | string): void {
  wrapper.innerHTML = '';
  if (typeof content === 'string') {
    wrapper.textContent = content;
  } else {
    wrapper.appendChild(content);
  }
}

function addSlot(
  container: HTMLElement,
  slug: string,
  id: string,
  render: () => HTMLElement | string,
  position: 'first' | 'last',
): () => void {
  const wrapper = document.createElement('span');
  wrapper.dataset.extSlot = `${slug}:${id}`;
  renderInto(wrapper, render());
  if (position === 'first') {
    container.insertBefore(wrapper, container.firstChild);
  } else {
    container.appendChild(wrapper);
  }
  return () => wrapper.remove();
}

/** Auto-tracked extension API: every disposer returned by an API
 *  method is also captured in `autoDispose`. The loader composes
 *  this with the extension's own dispose fn at reload time so that
 *  registrations (commands, providers, listeners, slots) are
 *  guaranteed to be torn down, even if the extension forgot to
 *  return its own dispose or registered something it doesn't track.
 *
 *  L3 fix (docs/research/global-leak-audit.md): prior to this, the
 *  registerCommand wrapper returned a no-op disposer, so a reloaded
 *  extension that removed a command left the orphan command in the
 *  registry running stale closure-captured code. */
export function createExtensionAPI(slug: string): { api: ClientExtensionAPI; autoDispose: () => void } {
  const tracked: Array<() => void> = [];
  const track = <T extends () => void>(fn: T): T => {
    tracked.push(fn);
    return fn;
  };
  const api: ClientExtensionAPI = {
    footer: {
      addLeft(id, render) {
        const container = regions.footer.query('.context-links');
        if (!container) return () => {};
        return track(addSlot(container, slug, id, render, 'last'));
      },
      addRight(id, render) {
        const container = regions.footer.query('.context-status');
        if (!container) return () => {};
        return track(addSlot(container, slug, id, render, 'last'));
      },
      update(id, content) {
        const el = regions.footer.query(`[data-ext-slot="${slug}:${id}"]`);
        if (el) renderInto(el, content);
      },
    },
    header: {
      addLeft(id, render) {
        const bar = document.querySelector('.header-bar') as HTMLElement | null;
        if (!bar) return () => {};
        return track(addSlot(bar, slug, id, render, 'first'));
      },
      addRight(id, render) {
        const bar = document.querySelector('.header-bar') as HTMLElement | null;
        if (!bar) return () => {};
        return track(addSlot(bar, slug, id, render, 'last'));
      },
    },
    on(event, handler) {
      return track(onGlobalEvent((e) => {
        if (e.type === event) handler(e);
      }));
    },
    registerShortcut(combo, handler) {
      const parts = combo.toLowerCase().split('+');
      const key = parts.pop()!;
      const mods = new Set(parts);
      const listener = (e: KeyboardEvent) => {
        if (e.key.toLowerCase() !== key) return;
        if (mods.has('ctrl') !== (e.ctrlKey || e.metaKey)) return;
        if (mods.has('alt') !== e.altKey) return;
        if (mods.has('shift') !== e.shiftKey) return;
        e.preventDefault();
        handler();
      };
      document.addEventListener('keydown', listener);
      return track(() => document.removeEventListener('keydown', listener));
    },
    switchSession(index) {
      const items = document.querySelectorAll('.session-item[data-session-id]');
      const el = items[index] as HTMLElement | undefined;
      if (el?.dataset.sessionId) void sessionClick(el.dataset.sessionId);
    },
    switchSessionById(id) {
      void sessionClick(id);
    },
    send(type, data) {
      wsSendRaw({ type, data });
    },
    getState<T>(key: string): T | undefined {
      const raw = localStorage.getItem(`ext:${slug}:${key}`);
      if (raw === null) return undefined;
      try { return JSON.parse(raw) as T; }
      catch { return undefined; }
    },
    setState<T>(key: string, value: T): void {
      localStorage.setItem(`ext:${slug}:${key}`, JSON.stringify(value));
    },
    toast(message) {
      showToast(message);
    },
    registerCommand(name, opts) {
      const cmd: Command = {
        name,
        description: opts.description || '',
        source: 'extension' as const,
        handler: opts.handler,
      };
      return track(registerCommand(cmd));
    },
    registerPoundItems(provider) {
      return track(registerPoundProvider(() =>
        provider().map((item): PopupItem => ({
          id: `${slug}:${item.label}`,
          label: item.label,
          description: item.description,
          value: item.value,
        }))
      ));
    },
  };
  const autoDispose = (): void => {
    for (const fn of tracked.splice(0)) {
      try { fn(); } catch (err) { console.error(`[EXT:${slug}] auto-dispose error:`, err); }
    }
  };
  return { api, autoDispose };
}
