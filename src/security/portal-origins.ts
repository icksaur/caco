import { DEFAULT_PORT } from '../config.js';

/**
 * Origins allowed to drive this instance's pager bridge when it is framed by a
 * portal on another origin (docs/spec-portal-pager.md). Exact origins only: the
 * bridge can send prompts, so no wildcard and no port ranges.
 *
 * Unset: the portal at the default Caco address on the browser's machine. Derived
 * from the DEFAULT port, not this instance's bound port, because the portal is
 * served by a different machine. Set: the list replaces the default; `none`
 * allows no other origin. The instance's own origin is always allowed client-side.
 */
export const DEFAULT_PORTAL_ORIGINS: readonly string[] = [
  `http://localhost:${DEFAULT_PORT}`,
  `http://127.0.0.1:${DEFAULT_PORT}`,
];

export function parsePortalOrigins(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [...DEFAULT_PORTAL_ORIGINS];
  if (raw.trim().toLowerCase() === 'none') return [];
  const out = new Set<string>();
  for (const part of raw.split(/[,\s]+/)) {
    const s = part.trim();
    if (!s) continue;
    try {
      const u = new URL(s);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      out.add(u.origin);
    } catch {
      // Ignore malformed entries rather than refusing to start.
    }
  }
  return [...out];
}

export const portalOrigins = parsePortalOrigins(process.env.CACO_PORTAL_ORIGINS);
