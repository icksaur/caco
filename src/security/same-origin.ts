/**
 * Same-origin request guard (shared by HTTP middleware and the WS upgrade).
 *
 * Caco acts as the user — every command is dangerous by design. The only thing to
 * keep out is a *foreign browser page* driving the local server (CSRF / Cross-Site
 * WebSocket Hijacking). Loopback binding already excludes remote machines; local
 * non-browser processes already run as the user. So the boundary is uniform, not
 * per-resource: "only my own browser tab, from a host I trust."
 *
 * Rule (every request, HTTP + ws):
 *   allow ⇔ Origin absent, OR (URL(origin).host === Host AND host ∈ trustedHosts)
 *
 * - Absent Origin ⇒ allow: server self-calls (`fetch(${SERVER_URL}/...)` send no
 *   Origin — confirmed on Node v26), top-level navigations, the OAuth GET, and local
 *   CLI tools. A cross-site browser request can never omit Origin, so this is safe.
 * - host ∈ trustedHosts is the DNS-rebinding guard (after evil.com→127.0.0.1, Origin
 *   and Host both read evil.com and pass a pure same-origin check). trustedHosts is
 *   the loopback set by default; Dev Tunnels rewrite Host→localhost by default so this
 *   is zero-config over a tunnel too (see docs/research/devtunnel-host-findings.md).
 */

import type { Request, Response, NextFunction } from 'express';

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'] as const;

/** Loopback defaults plus an additive, opt-in `CACO_TRUSTED_HOSTS` comma list. Never
 *  derived from SERVER_URL (that is the server's self-call address, must stay loopback). */
export function parseTrustedHosts(raw: string | undefined): ReadonlySet<string> {
  const set = new Set<string>(LOOPBACK_HOSTS);
  if (raw) {
    for (const part of raw.split(',')) {
      const h = part.trim().toLowerCase();
      if (h) set.add(h);
    }
  }
  return set;
}

/** Default port for a URL scheme, or null if not a default-bearing scheme. */
function defaultPortFor(protocol: string): string | null {
  if (protocol === 'http:') return '80';
  if (protocol === 'https:') return '443';
  return null;
}

/** Bare hostname (no port), lowercased, for trusted-set membership. */
function hostnameOf(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isSameOriginRequest(
  origin: string | undefined,
  host: string | undefined,
  trustedHosts: ReadonlySet<string>,
): boolean {
  if (origin === undefined) return true;
  if (!host) return false;

  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }

  // `URL.host` already drops the origin scheme's default port; normalize the raw
  // Host header by stripping ONLY that same scheme's default port. Stripping both
  // :80 and :443 unconditionally would false-accept e.g. origin http://h:443 vs
  // Host h (different ports, same after a naive strip).
  const originHost = originUrl.host.toLowerCase();
  const defaultPort = defaultPortFor(originUrl.protocol);
  let normalizedHost = host.toLowerCase();
  if (defaultPort) {
    normalizedHost = normalizedHost.replace(new RegExp(`:${defaultPort}$`), '');
  }
  if (originHost !== normalizedHost) return false;

  const hostname = hostnameOf(host);
  return hostname !== null && trustedHosts.has(hostname);
}

/** Process-wide trusted-host set, resolved once from the environment. */
export const trustedHosts = parseTrustedHosts(process.env.CACO_TRUSTED_HOSTS);

/** Intentional cross-origin routes (portal session transfer) governed by their own
 *  CORS handlers, not this guard. Matched on the full request path (unscoped mount). */
function isCarveOut(path: string): boolean {
  return path === '/api/sessions/import' || /^\/api\/sessions\/[^/]+\/export$/.test(path);
}

/** Express middleware: reject foreign-origin requests with 403 (fail loud). */
export function requireSameOrigin(req: Request, res: Response, next: NextFunction): void {
  if (isCarveOut(req.path)) {
    next();
    return;
  }
  if (isSameOriginRequest(req.headers.origin, req.headers.host, trustedHosts)) {
    next();
    return;
  }
  console.warn(
    `[SECURITY] Rejected cross-origin request: ${req.method} ${req.path} ` +
    `origin=${req.headers.origin ?? '(none)'} host=${req.headers.host ?? '(none)'}`,
  );
  res.status(403).json({ error: 'Cross-origin request rejected' });
}

/** WS upgrade guard. Logs rejects so a misconfigured tunnel isn't a silent dead socket. */
export function verifyWsUpgrade(origin: string | undefined, host: string | undefined): boolean {
  const ok = isSameOriginRequest(origin, host, trustedHosts);
  if (!ok) {
    console.warn(
      `[SECURITY] Rejected cross-origin ws upgrade: origin=${origin ?? '(none)'} host=${host ?? '(none)'}`,
    );
  }
  return ok;
}
