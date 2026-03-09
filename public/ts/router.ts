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

import { getViewState, setViewState, showAppletPanel, hideAppletPanel, isAppletPanelVisible, isAppletExpanded, toggleAppletExpanded, toggleSessionPanel, showSessionPanel, hideSessionPanel, isSessionPanelVisible, type ViewState } from './view-controller.js';
import { getActiveSessionId } from './app-state.js';
import { getActiveAppletSlug, hasAppletContent, pushApplet, type AppletContent } from './applet-runtime.js';
import { initAppletButton } from './applet-button.js';
import { onButton } from './button-gestures.js';
import { showSessionManager, loadSessions } from './session-panel.js';
import { chatView } from './chat-view-controller.js';

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

/**
 * Initialize router - set up Navigation API handler
 * Call once at app startup
 */
export function initRouter(): void {
  const nav = (window as unknown as { navigation?: Navigation }).navigation;
  if (!nav) {
    console.warn('[ROUTER] Navigation API not available, falling back to popstate');
    window.addEventListener('popstate', handlePopState);
    return;
  }

  nav.addEventListener('navigate', (event: NavigateEvent) => {
    // Debug: uncomment to verify event fires
    // alert('navigate: ' + event.navigationType + ' ' + event.destination.url);
    console.log('[ROUTER] navigate event:', event.navigationType, event.destination.url, 'canIntercept:', event.canIntercept);
    
    // Skip if we can't intercept
    if (!event.canIntercept) {
      console.log('[ROUTER] Cannot intercept, skipping');
      return;
    }
    
    // Skip downloads, hash-only changes, reloads
    if (event.downloadRequest !== null || event.hashChange) return;
    if (event.navigationType === 'reload') return;
    
    const url = new URL(event.destination.url);
    
    // Only intercept same-origin
    if (url.origin !== window.location.origin) return;
    
    console.log('[ROUTER] Intercepting navigation to:', url.toString());
    
    event.intercept({
      handler: async () => {
        await handleNavigation(url);
      }
    });
  });
  
  console.log('[ROUTER] Navigation API handler installed');
  
  // Set up applet button with gesture callbacks
  initAppletButton({
    onPress: () => toggleApplet(),
    onLongPress: () => {
      const currentApplet = new URL(window.location.href).searchParams.get('applet');
      if (currentApplet !== 'applet-browser') {
        console.log('[ROUTER] Long press, opening applet-browser');
        nav.navigate('?applet=applet-browser');
      }
    }
  });
  
  // Set up expand button click handler
  onButton('expandBtn', { onPress: toggleAppletExpanded });
}

/**
 * Handle navigation to a URL
 * Called by Navigation API intercept or popstate fallback
 */
async function handleNavigation(url: URL): Promise<void> {
  const sessionId = url.searchParams.get('session');
  const appletSlug = url.searchParams.get('applet');
  
  // Handle session param
  if (sessionId && sessionId !== getActiveSessionId()) {
    await chatView.activateSession(sessionId);
  }
  
  // Handle applet param
  if (appletSlug && appletSlug !== getActiveAppletSlug()) {
    await loadApplet(appletSlug);
  } else if (appletSlug && appletSlug === getActiveAppletSlug()) {
    showAppletPanel();
    window.dispatchEvent(new PopStateEvent('popstate'));
  } else if (!appletSlug && isAppletPanelVisible()) {
    // URL has no applet param - hide panel (but preserve content)
    hideAppletPanel();
  }
}

/**
 * Fallback for browsers without Navigation API
 */
function handlePopState(): void {
  const url = new URL(window.location.href);
  void handleNavigation(url);
}

/**
 * Toggle sessions overlay
 */
export function toggleSessions(): void {
  if (isSessionPanelVisible()) {
    hideSessionPanel();
  } else {
    showSessionManager();
  }
}

/**
 * Handle session item click
 * Switches to session, loads history, updates URL
 */
export async function sessionClick(sessionId: string): Promise<void> {
  await chatView.activateSession(sessionId);
  updateUrl({ session: sessionId }, true);
}

/**
 * Handle new session click from session list
 */
export function newSessionClick(): void {
  chatView.showNewChat();
  updateUrl({ session: null });
}

/**
 * Handle model selector send (first message creates session)
 * Called after POST /api/chat returns with sessionId
 */
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
    console.log('[ROUTER] No applet loaded, opening applet-browser');
    const nav = (window as unknown as { navigation?: Navigation }).navigation;
    if (nav) {
      nav.navigate('?applet=applet-browser');
    } else {
      window.location.search = '?applet=applet-browser';
    }
    return;
  }
  
  // Toggle applet panel visibility
  // CSS handles the responsive behavior (mobile: full screen, desktop: split)
  if (isAppletPanelVisible()) {
    hideAppletPanel();
  } else {
    showAppletPanel();
  }
}

/**
 * Load an applet by slug
 * Does NOT modify URL - caller is responsible for URL state
 * (Navigation API intercept already has correct URL, page load already has param)
 */
export async function loadApplet(slug: string, urlParams?: Record<string, string>): Promise<void> {
  try {
    console.log(`[ROUTER] Loading applet: ${slug}`);
    
    const response = await fetch(`/api/applets/${encodeURIComponent(slug)}/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urlParams })
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    
    const data = await response.json();
    
    const content: AppletContent = {
      html: data.html,
      js: data.js,
      css: data.css,
      title: data.title
    };
    
    pushApplet(slug, data.title || slug, content);
    showAppletPanel();
    
    console.log(`[ROUTER] Applet loaded: ${data.title || slug}`);
  } catch (error) {
    console.error(`[ROUTER] Failed to load applet "${slug}":`, error);
    throw error;
  }
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
  
  const nav = (window as unknown as { navigation?: Navigation }).navigation;
  
  if (push && nav) {
    // Use Navigation API for proper traverse interception
    nav.navigate(url.toString(), { history: 'push' });
  } else if (push) {
    history.pushState(null, '', url.toString());
  } else {
    history.replaceState(null, '', url.toString());
  }
}

/**
 * Update the footer status bar with model name and cwd.
 * Looks up friendly model name from available models.
 */
/**
 * Get current URL params
 */
export function getUrlParams(): { session: string | null; applet: string | null } {
  const url = new URL(window.location.href);
  return {
    session: url.searchParams.get('session'),
    applet: url.searchParams.get('applet')
  };
}

