import { getMcpAuth, getMcpServerAuth, updateMcpServerAuth } from './storage.js';

/** How far ahead of actual expiry a token is considered "near expiry" and
 *  eligible for proactive refresh (spec-mcp-auth-keepalive). Generous enough
 *  that a refresh attempted on this tick has real margin before the access
 *  token the SDK is already holding actually stops working, without refreshing
 *  so early that a short-lived (~1h) token gets refreshed almost every tick. */
export const PROACTIVE_REFRESH_WINDOW_MS = 10 * 60 * 1000;

export async function refreshAccessToken(serverId: string): Promise<boolean> {
  const serverAuth = getMcpServerAuth(serverId);
  if (!serverAuth?.refreshToken || !serverAuth.tokenEndpoint || !serverAuth.clientId) {
    return false;
  }

  try {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: serverAuth.refreshToken,
      client_id: serverAuth.clientId,
    });
    if (serverAuth.scopes?.length) {
      params.set('scope', serverAuth.scopes.join(' '));
    }

    const res = await fetch(serverAuth.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: params.toString(),
    });

    if (!res.ok) {
      let msg = `Refresh failed: ${res.status}`;
      try { const d = await res.json() as { error_description?: string }; msg = d.error_description || msg; } catch { /* */ }
      console.warn(`[MCP-AUTH] Refresh failed for ${serverId}: ${msg}`);
      updateMcpServerAuth(serverId, prev => ({ ...prev!, needsAuth: true, error: msg }));
      return false;
    }

    const data = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!data.access_token) {
      updateMcpServerAuth(serverId, prev => ({ ...prev!, needsAuth: true, error: 'No access_token in refresh response' }));
      return false;
    }

    const expiresAt = data.expires_in ? Date.now() + (data.expires_in * 1000) : undefined;
    updateMcpServerAuth(serverId, prev => ({
      ...prev!,
      token: data.access_token,
      refreshToken: data.refresh_token || prev!.refreshToken,
      expiresAt,
      needsAuth: false,
      error: undefined,
    }));
    console.log(`[MCP-AUTH] Token refreshed for ${serverId}`);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[MCP-AUTH] Refresh error for ${serverId}: ${msg}`);
    updateMcpServerAuth(serverId, prev => ({ ...prev!, needsAuth: true, error: msg }));
    return false;
  }
}

/**
 * The server ids whose Caco-managed OAuth token is refreshable (has a
 * refreshToken) and within `PROACTIVE_REFRESH_WINDOW_MS` of (or past) expiry.
 * Pure — no I/O beyond the one `getMcpAuth()` read — so the selection logic is
 * unit-testable without mocking fetch/time against the real refresh flow.
 *
 * A server with no `expiresAt` (never actually authenticated, or an entry that
 * predates expiry tracking) is excluded: there is nothing to refresh toward,
 * and treating "unknown" as "expired" would churn refresh attempts against
 * servers that were never live. A server already flagged `needsAuth` (a prior
 * refresh attempt failed outright — bad refresh token, revoked grant) is also
 * excluded: retrying it on every tick forever would just repeat the same
 * failure and spam the log; the user must re-authenticate interactively via
 * the mcp-servers applet, which clears `needsAuth` on success.
 */
export function serversNeedingProactiveRefresh(nowMs: number = Date.now()): string[] {
  const { servers } = getMcpAuth();
  const ids: string[] = [];
  for (const [serverId, state] of Object.entries(servers)) {
    if (!state.refreshToken || state.needsAuth) continue;
    if (state.expiresAt === undefined) continue;
    if (state.expiresAt - nowMs <= PROACTIVE_REFRESH_WINDOW_MS) ids.push(serverId);
  }
  return ids;
}

/**
 * Proactively refresh every Caco-managed MCP server token nearing expiry
 * (spec-mcp-auth-keepalive). Unlike `refreshAccessToken` (called reactively at
 * session-creation time, when an expired token is already blocking a tool
 * call), this runs on a timer so a WARM session's already-injected header
 * never goes stale in the first place — closing the gap that made icm-mcp
 * tools "go unavailable" partway through a long-lived session with no path
 * back except a full Caco restart. Each server is refreshed independently (one
 * failure does not block the others); returns the ids that were successfully
 * refreshed, so the caller knows whether a warm-session MCP config reload is
 * worth doing at all.
 */
export async function refreshNearExpiryTokens(nowMs: number = Date.now()): Promise<string[]> {
  const candidates = serversNeedingProactiveRefresh(nowMs);
  const refreshed: string[] = [];
  for (const serverId of candidates) {
    try {
      if (await refreshAccessToken(serverId)) refreshed.push(serverId);
    } catch (e) {
      // refreshAccessToken already catches its own errors and records them on
      // the server's auth state; this is a belt-and-suspenders guard so one
      // unexpected throw can't stop the loop from reaching the remaining
      // candidates.
      console.warn(`[MCP-AUTH] Proactive refresh threw for ${serverId}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return refreshed;
}
