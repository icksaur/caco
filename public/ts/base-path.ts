/**
 * Base path (spec-portal-single-port, Phase A).
 *
 * A page may be served under a path prefix (`/peer/<key>/`) by a hub proxy. The
 * server injects `window.CACO_BASE` and a `<base href>` tag in that case, plus a
 * fetch wrapper (src/page-base.ts). Code that builds a URL outside `fetch`
 * (WebSocket, links, images, dynamic import) uses `withBase`.
 */

declare global {
  interface Window { CACO_BASE?: string }
}

function readBase(): string {
  const b = typeof window !== 'undefined' ? window.CACO_BASE : undefined;
  return typeof b === 'string' && b.startsWith('/') && b.endsWith('/') ? b : '/';
}

export const BASE = readBase();

/** Prefix a root-absolute path (`/x`) with the base path. Anything else
 *  (relative, `//host`, `http:`, `data:`, `blob:`) and any path already under
 *  the base is returned unchanged. */
export function withBase(path: string, base: string = BASE): string {
  if (base === '/' || !path.startsWith('/') || path.startsWith('//')) return path;
  if (path.startsWith(base)) return path;
  return base + path.slice(1);
}

/** A browser-storage key that is shared at `/` and per instance under a prefix,
 *  since proxied instances share the hub's origin. */
export function storageKey(key: string, base: string = BASE): string {
  return base === '/' ? key : `${key}@${base}`;
}
