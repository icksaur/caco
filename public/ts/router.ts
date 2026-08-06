/**
 * Router - Single owner of URL and navigation state
 * 
 * Handles:
 * - Navigation API for SPA routing
 * - URL param management (?session=, ?applet=)
 * - Main panel state (sessions | newChat | chat)
 * - Applet panel visibility
 * 
 * Philosophy: URL is for bookmarking, not state destruction.
 * - Adding ?session= or ?applet= loads content
 * - Removing them does NOT destroy loaded content
 */

import { debug } from './debug.js';
import { toggleAppletExpanded } from './view-controller.js';
import { getActiveSessionId } from './app-state.js';
import { getActiveAppletSlug, hasAppletContent } from './applet-runtime.js';
import { loadApplet } from './applet-loader.js';
import { initAppletButton } from './applet-button.js';
import { onButton } from './button-gestures.js';
import { showSessionManager } from './session-panel.js';
import { chatView } from './chat-view-controller.js';
import { getPanelState, deviceClass } from './panel-state.js';

// Navigation API types (not yet in TypeScript lib)
interface NavigateEvent extends Event {
  canIntercept: boolean;
  downloadRequest: string | null;
  hashChange: boolean;
  navigationType: 'push' | 'replace' | 'reload' | 'traverse';
  destination: { url: string };
  intercept(options: { handler: () => Promise<void> }): void;
}

interface Navigation {
  addEventListener(type: 'navigate', listener: (event: NavigateEvent) => void): void;
  navigate(url: string, options?: { state?: unknown; history?: 'auto' | 'push' | 'replace' }): { committed: Promise<void>; finished: Promise<void> };
}

declare global {
  interface Window {
    navigation?: Navigation;
  }
}

/**
 * Initialize router - set up Navigation API handler
 * Call once at app startup
 */
export function initRouter(): void {
  const nav = window.navigation;
  if (!nav) {
    console.warn('[ROUTER] Navigation API not available, falling back to popstate');
    window.addEventListener('popstate', handlePopState);
    return;
  }

  nav.addEventListener('navigate', (event: NavigateEvent) => {
    // Debug: uncomment to verify event fires
    // alert('navigate: ' + event.navigationType + ' ' + event.destination.url);
    debug('ROUTER', 'navigate event:', event.navigationType, event.destination.url, 'canIntercept:', event.canIntercept);
    
    // Skip if we can't intercept
    if (!event.canIntercept) {
      debug('ROUTER', 'Cannot intercept, skipping');
      return;
    }
    
    // Skip downloads, hash-only changes, reloads
    if (event.downloadRequest !== null || event.hashChange) return;
    if (event.navigationType === 'reload') return;

    // A link out of the SPA (e.g. /pager.html) must reach the browser: this
    // handler can only swap content within the current document.
    if (!shouldInterceptNavigation(event.destination.url, new URL(window.location.href))) {
      debug('ROUTER', 'Different document, leaving to the browser:', event.destination.url);
      return;
    }

    const url = new URL(event.destination.url);

    debug('ROUTER', 'Intercepting navigation to:', url.toString());
    
    event.intercept({
      handler: async () => {
        await handleNavigation(url, event.navigationType as NavigationKind);
      }
    });
  });
  
  debug('ROUTER', 'Navigation API handler installed');
  
  // Set up applet button with gesture callbacks
  initAppletButton({
    onPress: () => toggleApplet(),
    onLongPress: () => {
      const currentApplet = new URL(window.location.href).searchParams.get('applet');
      if (currentApplet !== 'applet-browser') {
        debug('ROUTER', 'Long press, opening applet-browser');
        nav.navigate('?applet=applet-browser');
      }
    }
  });
  
  // Set up expand button click handler
  onButton('expandBtn', { onPress: toggleAppletExpanded });
}

/**
 * Whether the SPA router should take over a navigation.
 *
 * Only a change WITHIN this document belongs to the router: `handleNavigation`
 * reads `?session`/`?applet` and swaps content in place, so it cannot service a
 * different document. Intercepting one — a link to `/pager.html`, say — commits
 * the URL and then renders nothing, so the address bar changes while the page
 * stays put. Pathname is therefore the discriminator, not origin alone.
 */
export function shouldInterceptNavigation(destination: string, current: URL): boolean {
  let url: URL;
  try {
    url = new URL(destination);
  } catch {
    return false;
  }
  if (url.origin !== current.origin) return false;
  return url.pathname === current.pathname;
}

/**
 * Decide whether a navigation event should reveal the applet panel.
 *
 * Pure, side-effect-free, testable. The discriminator is `navigationType`:
 *   - 'replace': URL housekeeping by code (e.g. restoreApplet's
 *     replaceState). Never reveals the panel.
 *   - 'push': user clicked an applet link, or programmatic nav.navigate()
 *     (e.g. applet-browser long-press). Reveals the panel if the URL has
 *     an applet slug.
 *   - 'traverse': back/forward to a URL with an applet param. Treat as
 *     "user wants that view back", reveal.
 *   - 'reload': caller filters this out before reaching us.
 */
export type NavigationKind = 'push' | 'replace' | 'traverse' | 'reload';
export function shouldShowAppletOnNavigation(
  appletSlug: string | null,
  navigationType: NavigationKind,
): boolean {
  if (!appletSlug) return false;
  if (navigationType === 'replace') return false;
  return true;
}

/**
 * Handle navigation to a URL
 * Called by Navigation API intercept or popstate fallback
 */
async function handleNavigation(url: URL, navigationType: NavigationKind = 'push'): Promise<void> {
  const sessionId = url.searchParams.get('session');
  const appletSlug = url.searchParams.get('applet');

  // Handle session param
  if (sessionId && sessionId !== getActiveSessionId()) {
    await chatView.activateSession(sessionId);
  }

  // Handle applet param. Content loading and panel visibility are
  // independent decisions:
  //   - content: load if slug changed
  //   - visibility: shouldShowAppletOnNavigation() decides based on
  //     navigation type. User-initiated nav (push/traverse) shows the
  //     panel; replaceState housekeeping does not.
  if (appletSlug && appletSlug !== getActiveAppletSlug()) {
    const urlParams: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      if (key !== 'applet' && key !== 'session') urlParams[key] = value;
    });
    await loadApplet(appletSlug, urlParams);
  } else if (appletSlug && appletSlug === getActiveAppletSlug()) {
    // Same applet, only URL params changed. Notify the applet so it can
    // react to the new params.
    window.dispatchEvent(new PopStateEvent('popstate'));
    void syncAppletParamsToMeta();
  }

  if (shouldShowAppletOnNavigation(appletSlug, navigationType)) {
    getPanelState().set({ applet: true }, 'deep-link');
  }
  // !appletSlug case: do nothing on visibility. The applet content
  // remains loaded for re-show if user taps the toggle.
}

/**
 * Push current URL params (excluding session, applet) to session meta.
 * Used when applet stays the same but params change via URL navigation.
 */
async function syncAppletParamsToMeta(): Promise<void> {
  const sessionId = getActiveSessionId();
  if (!sessionId) return;
  const appletParams: Record<string, string> = {};
  new URL(window.location.href).searchParams.forEach((value, key) => {
    if (key !== 'applet' && key !== 'session') appletParams[key] = value;
  });
  try {
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/applet`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appletParams }),
    });
  } catch { /* best-effort */ }
}

/**
 * Fallback for browsers without Navigation API
 */
function handlePopState(): void {
  const url = new URL(window.location.href);
  // popstate fires for back/forward in browsers without Navigation API.
  void handleNavigation(url, 'traverse');
}

export function toggleSessions(): void {
  const store = getPanelState();
  if (store.get().session) {
    store.set({ session: false }, 'user-toggle-session');
  } else {
    showSessionManager();
  }
}

export async function sessionClick(sessionId: string): Promise<void> {
  await chatView.activateSession(sessionId);
  // Write a clean URL containing only session=NEW. We deliberately use
  // history.pushState (not the Navigation API) so we don't fire
  // handleNavigation — that intercept would race restoreApplet, see the
  // stale applet from the previous session, and force-show the panel.
  // restoreApplet rewrites the URL via replaceState if the new session
  // has its own applet, so this is the safe baseline.
  const clean = new URL(window.location.href);
  clean.search = '';
  clean.searchParams.set('session', sessionId);
  history.pushState(null, '', clean.toString());
  // Auto-dismiss the picker only on mobile widths. On desktop, keep the
  // session list visible so the user can scrub through sessions.
  if (deviceClass() === 'mobile') {
    getPanelState().set({ session: false }, 'user-session-pick');
  }
}

export function newSessionClick(): void {
  chatView.showNewChat();
  updateUrl({ session: null });
}

export function onSessionCreated(sessionId: string): void {
  updateUrl({ session: sessionId });
}

/**
 * Toggle applet visibility
 * On mobile: toggles between showing main panel and applet
 * On desktop: applet panel is always visible when loaded, this is no-op
 * If no applet loaded, opens applet-browser
 */
export function toggleApplet(): void {
  if (!hasAppletContent()) {
    // No applet loaded - open applet browser
    debug('ROUTER', 'No applet loaded, opening applet-browser');
    const nav = window.navigation;
    if (nav) {
      nav.navigate('?applet=applet-browser');
    } else {
      window.location.search = '?applet=applet-browser';
    }
    return;
  }

  const store = getPanelState();
  store.set({ applet: !store.get().applet }, 'user-toggle-applet');
}

/**
 * Update URL with new params
 * Uses Navigation API if available for proper back button support
 * @param push - If true, creates history entry (back button works). If false, replaces current entry.
 */
function updateUrl(params: { session?: string | null; applet?: string | null }, push = false): void {
  const url = new URL(window.location.href);
  
  if ('session' in params) {
    if (params.session) {
      url.searchParams.set('session', params.session);
    } else {
      url.searchParams.delete('session');
    }
  }
  
  if ('applet' in params) {
    if (params.applet) {
      url.searchParams.set('applet', params.applet);
    } else {
      url.searchParams.delete('applet');
    }
  }
  
  const nav = window.navigation;
  
  if (push && nav) {
    // Use Navigation API for proper traverse interception
    nav.navigate(url.toString(), { history: 'push' });
  } else if (push) {
    history.pushState(null, '', url.toString());
  } else {
    history.replaceState(null, '', url.toString());
  }
}

export function getUrlParams(): { session: string | null; applet: string | null } {
  const url = new URL(window.location.href);
  return {
    session: url.searchParams.get('session'),
    applet: url.searchParams.get('applet')
  };
}
