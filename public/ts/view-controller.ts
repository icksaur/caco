/**
 * View State Controller
 * 
 * SINGLE SOURCE OF TRUTH for which view is active.
 * Main panel: newChat | chatting (mutually exclusive)
 * Session panel: shown/hidden (orthogonal, toggled separately)
 * Applet panel: shown/hidden (orthogonal, toggled separately)
 * 
 * All view transitions must go through setViewState() to prevent invalid states.
 * This manages VIEW state only. For session/model/UI flags, see app-state.ts.
 */

import { scrollToBottom } from './ui-utils.js';
import { getPanelState } from './panel-state.js';

export type ViewState = 'newChat' | 'chatting';

let currentState: ViewState = 'newChat';

let appletExpanded = false;

interface ViewElements {
  chatView: HTMLElement | null;
  sessionView: HTMLElement | null;
  appletPanel: HTMLElement | null;
  appletView: HTMLElement | null;
  chat: HTMLElement | null;
  newChat: HTMLElement | null;
  footer: HTMLElement | null;
  menuBtn: HTMLElement | null;
  appletBtn: HTMLElement | null;
  expandBtn: HTMLElement | null;
}

let cachedElements: ViewElements | null = null;

function getElements(): ViewElements {
  if (!cachedElements) {
    cachedElements = {
      chatView: document.getElementById('chatScroll'),
      sessionView: document.getElementById('sessionView'),
      appletPanel: document.getElementById('appletPanel'),
      appletView: document.getElementById('appletView'),
      chat: document.getElementById('chat'),
      newChat: document.getElementById('newChat'),
      footer: document.getElementById('chatFooter'),
      menuBtn: document.getElementById('menuBtn'),
      appletBtn: document.getElementById('appletBtn'),
      expandBtn: document.getElementById('expandBtn'),
    };
  }
  return cachedElements;
}

export function getCachedElement(key: keyof ViewElements): HTMLElement | null {
  return getElements()[key];
}

export function getViewState(): ViewState {
  return currentState;
}

export function setFormEnabled(enabled: boolean): void {
  // R3 V1: two forms exist; only one is visible at a time. Apply
  // enable/disable to whichever is currently active by id; fallback
  // to whichever exists.
  const newChat = document.getElementById('newChatForm');
  const chatting = document.getElementById('chattingForm');
  const cursor = document.getElementById('workingCursor');
  const visible = currentState === 'chatting' ? chatting : newChat;
  if (!visible) return;

  if (enabled) {
    visible.classList.remove('busy');
    cursor?.classList.add('hidden');
    const input = visible.querySelector('textarea') as HTMLTextAreaElement | null;
    input?.focus();
  } else {
    visible.classList.add('busy');
    cursor?.classList.remove('hidden');
  }
}

export function setViewState(state: ViewState): void {
  const els = getElements();
  if (state === currentState) return;
  currentState = state;

  els.chat?.classList.add('hidden');
  els.newChat?.classList.add('hidden');
  els.footer?.classList.add('hidden');

  // R3 V1: two chat-input forms live in the footer. Show the right
  // one per view; hide the other. Use `hidden` attribute instead of
  // class so default-HTML state (chattingForm hidden) interoperates.
  const newChatForm = document.getElementById('newChatForm') as HTMLElement | null;
  const chattingForm = document.getElementById('chattingForm') as HTMLElement | null;

  switch (state) {
    case 'newChat':
      els.newChat?.classList.remove('hidden');
      els.footer?.classList.remove('hidden');
      if (newChatForm) newChatForm.hidden = false;
      if (chattingForm) chattingForm.hidden = true;
      setFormEnabled(true);
      // Reset newchat textarea to single-line height on view enter.
      // Direct DOM access here avoids importing chatView (circular).
      {
        const ta = newChatForm?.querySelector('textarea[name="message"]') as HTMLTextAreaElement | null;
        if (ta) { ta.style.height = 'auto'; ta.style.overflowY = 'hidden'; }
      }
      els.appletBtn?.classList.remove('hidden');
      break;

    case 'chatting':
      els.chat?.classList.remove('hidden');
      els.footer?.classList.remove('hidden');
      if (newChatForm) newChatForm.hidden = true;
      if (chattingForm) chattingForm.hidden = false;
      requestAnimationFrame(() => scrollToBottom());
      els.appletBtn?.classList.remove('hidden');
      break;
  }
  
  // expand-btn visibility is owned by the panel-state DOM binder.
  
  updateTitle();
}

export function showSessionPanel(): void {
  getPanelState().set({ session: true }, 'user-toggle-session');
}

export function hideSessionPanel(): void {
  getPanelState().set({ session: false }, 'user-toggle-session');
}

export function toggleSessionPanel(): void {
  const store = getPanelState();
  store.set({ session: !store.get().session }, 'user-toggle-session');
}

export function isSessionPanelVisible(): boolean {
  return getPanelState().get().session;
}

export function showAppletPanel(): void {
  getPanelState().set({ applet: true }, 'user-toggle-applet');
  // expanded class is independent state and lives on the panel itself
  const panel = document.getElementById('appletPanel');
  if (appletExpanded) panel?.classList.add('expanded');
  updateTitle();
}

export function hideAppletPanel(): void {
  getPanelState().set({ applet: false }, 'user-toggle-applet');
  updateTitle();
}

export function isAppletPanelVisible(): boolean {
  return getPanelState().get().applet;
}

export function toggleAppletExpanded(): void {
  const els = getElements();
  appletExpanded = !appletExpanded;
  els.appletPanel?.classList.toggle('expanded', appletExpanded);
  els.expandBtn?.classList.toggle('active', appletExpanded);
  
  const icon = document.querySelector('.expand-icon');
  if (icon) icon.textContent = appletExpanded ? '»' : '«';
}

export function isAppletExpanded(): boolean {
  return appletExpanded;
}

export function updateTitle(): void {
  document.title = 'Caco';
}

export function isViewState(state: ViewState): boolean {
  return currentState === state;
}

export function initViewState(): void {
  const els = getElements();
  
  let detectedState: ViewState;
  if (els.newChat && !els.newChat.classList.contains('hidden')) {
    detectedState = 'newChat';
  } else {
    detectedState = 'chatting';
  }
  
  currentState = detectedState === 'newChat' ? 'chatting' : 'newChat';
  setViewState(detectedState);
}
