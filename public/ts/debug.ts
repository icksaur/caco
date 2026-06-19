/**
 * Namespaced front-end debug logging.
 *
 * Debug logs are OFF by default so the console stays quiet in normal use.
 * They remain available on demand for diagnosing flaky session/WS behavior.
 *
 * Enable from the browser console (persists in localStorage, no reload):
 *   cacoDebug('*')            // everything
 *   cacoDebug('WS,PERF')      // only those namespaces
 *   cacoDebug(false)          // off
 *
 * Namespaces in use: WS, PERF, ROUTER, CHAT, APPLET, APPLET-LOADER,
 * SESSION-PANEL, SCHEDULE, SEND, MODEL, OBSERVED, APP-STATE.
 *
 * console.warn / console.error are intentionally NOT routed through here —
 * those are always-on operational signals, not debug noise.
 */

type Enabled = boolean | Set<string>;

const STORAGE_KEY = 'cacoDebug';

function parse(spec: string | null): Enabled {
  if (!spec) return false;
  const trimmed = spec.trim();
  if (trimmed === '*' || trimmed === '1' || trimmed === 'true') return true;
  if (trimmed === '0' || trimmed === 'false') return false;
  return new Set(trimmed.split(',').map(s => s.trim()).filter(Boolean));
}

function readStored(): Enabled {
  try {
    return parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    return false;
  }
}

let enabled: Enabled = readStored();

function isEnabled(ns: string): boolean {
  if (enabled === true) return true;
  return enabled instanceof Set && enabled.has(ns);
}

/**
 * Create a logger bound to a namespace. The namespace tag is prepended
 * automatically, so call sites pass only the message.
 */
export function makeDebug(ns: string): (...args: unknown[]) => void {
  const tag = `[${ns}]`;
  return (...args: unknown[]): void => {
    if (isEnabled(ns)) console.log(tag, ...args);
  };
}

/**
 * Log under a namespace. Equivalent to makeDebug(ns)(...args) but convenient
 * for files that emit under more than one namespace.
 */
export function debug(ns: string, ...args: unknown[]): void {
  if (isEnabled(ns)) console.log(`[${ns}]`, ...args);
}

/**
 * Like makeDebug but for console.table output (grouped under the namespace).
 */
export function debugTable(ns: string, label: string, rows: unknown): void {
  if (!isEnabled(ns)) return;
  console.log(`[${ns}] ${label}`);
  console.table(rows);
}

function setDebug(spec: string | boolean | null): void {
  const normalized = spec === true ? '*' : spec === false ? null : spec;
  try {
    if (normalized) localStorage.setItem(STORAGE_KEY, normalized);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage unavailable — fall back to in-memory only
  }
  enabled = parse(typeof normalized === 'string' ? normalized : null);
}

declare global {
  interface Window {
    cacoDebug: typeof setDebug;
  }
}

if (typeof window !== 'undefined') {
  window.cacoDebug = setDebug;
}
