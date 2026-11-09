/**
 * Origins allowed to drive this instance's pager bridge when it is framed by a
 * portal on another origin (docs/spec-portal-pager.md). Exact origins only: the
 * bridge can send prompts, so no wildcard and no loopback default.
 */
export function parsePortalOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
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
