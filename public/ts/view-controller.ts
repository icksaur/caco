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

import { resetTextareaHeight } from './multiline-input.js';

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
  const form = document.getElementById('chatForm');
  const cursor = document.getElementById('workingCursor');
  if (!form) return;
  
  if (enabled) {
    form.classList.remove('streaming');
    cursor?.classList.add('hidden');
    const input = form.querySelector('textarea') as HTMLTextAreaElement;
    input?.focus();
  } else {
    form.classList.add('streaming');
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

  switch (state) {
    case 'newChat':
      els.newChat?.classList.remove('hidden');
      els.footer?.classList.remove('hidden');
      setFormEnabled(true);
      resetTextareaHeight();
      els.appletBtn?.classList.remove('hidden');
      break;
      
    case 'chatting':
      els.chat?.classList.remove('hidden');
      els.footer?.classList.remove('hidden');
      requestAnimationFrame(() => scrollToBottom());
      els.appletBtn?.classList.remove('hidden');
      break;
  }
  
  if (isAppletPanelVisible()) {
    els.expandBtn?.classList.remove('hidden');
  }
  
  updateTitle();
}

export function showSessionPanel(): void {
  const els = getElements();
  els.sessionView?.classList.remove('hidden');
  els.menuBtn?.classList.add('active');
}

export function hideSessionPanel(): void {
  const els = getElements();
  els.sessionView?.classList.add('hidden');
  els.menuBtn?.classList.remove('active');
}

export function toggleSessionPanel(): void {
  if (isSessionPanelVisible()) {
    hideSessionPanel();
  } else {
    showSessionPanel();
  }
}

export function isSessionPanelVisible(): boolean {
  const els = getElements();
  return !els.sessionView?.classList.contains('hidden');
}

export function showAppletPanel(): void {
  const els = getElements();
  els.appletPanel?.classList.remove('hidden');
  if (appletExpanded) {
    els.appletPanel?.classList.add('expanded');
  }
  els.appletBtn?.classList.remove('hidden');
  els.appletBtn?.classList.add('active');
  els.expandBtn?.classList.remove('hidden');
  updateTitle();
}

export function hideAppletPanel(): void {
  const els = getElements();
  els.appletPanel?.classList.add('hidden');
  els.appletBtn?.classList.remove('active');
  els.expandBtn?.classList.add('hidden');
  updateTitle();
}

export function isAppletPanelVisible(): boolean {
  const els = getElements();
  return !els.appletPanel?.classList.contains('hidden');
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
