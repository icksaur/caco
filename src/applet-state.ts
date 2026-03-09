/**
 * Applet State
 * 
 * Minimal state for applet interactions, keyed by sessionId so
 * concurrent browser tabs / sessions don't clobber each other.
 */

export interface NavigationContext {
  stack: Array<{ slug: string; label: string }>;
  urlParams: Record<string, string>;
}

const DEFAULT_KEY = '_default';

const appletUserStates = new Map<string, Record<string, unknown>>();
const appletNavigations = new Map<string, NavigationContext>();
const activeSlugs = new Map<string, string | null>();
const pendingReloads = new Set<string>();

export function setAppletUserState(sessionId: string | undefined, state: Record<string, unknown>): void {
  const key = sessionId || DEFAULT_KEY;
  const prev = appletUserStates.get(key) || {};
  appletUserStates.set(key, { ...prev, ...state });
}

export function getAppletUserState(sessionId?: string): Record<string, unknown> {
  return appletUserStates.get(sessionId || DEFAULT_KEY) || {};
}

export function clearAppletUserState(sessionId?: string): void {
  appletUserStates.delete(sessionId || DEFAULT_KEY);
}

export function setAppletNavigation(sessionId: string | undefined, nav: NavigationContext): void {
  appletNavigations.set(sessionId || DEFAULT_KEY, nav);
}

export function getAppletNavigation(sessionId?: string): NavigationContext {
  return appletNavigations.get(sessionId || DEFAULT_KEY) || { stack: [], urlParams: {} };
}

export function getActiveAppletSlug(sessionId?: string): string | null {
  return activeSlugs.get(sessionId || DEFAULT_KEY) ?? null;
}

export function setActiveAppletSlug(sessionId: string | undefined, slug: string | null): void {
  activeSlugs.set(sessionId || DEFAULT_KEY, slug);
}

export function triggerReload(sessionId?: string): void {
  pendingReloads.add(sessionId || DEFAULT_KEY);
}

export function consumeReloadSignal(sessionId?: string): boolean {
  const key = sessionId || DEFAULT_KEY;
  if (pendingReloads.has(key)) {
    pendingReloads.delete(key);
    return true;
  }
  return false;
}
