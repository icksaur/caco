import { getMcpServerAuth, setMcpServerAuth } from './storage.js';

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
      setMcpServerAuth(serverId, { ...serverAuth, needsAuth: true, error: msg });
      return false;
    }

    const data = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!data.access_token) {
      setMcpServerAuth(serverId, { ...serverAuth, needsAuth: true, error: 'No access_token in refresh response' });
      return false;
    }

    const expiresAt = data.expires_in ? Date.now() + (data.expires_in * 1000) : undefined;
    setMcpServerAuth(serverId, {
      ...serverAuth,
      token: data.access_token,
      refreshToken: data.refresh_token || serverAuth.refreshToken,
      expiresAt,
      needsAuth: false,
      error: undefined,
    });
    console.log(`[MCP-AUTH] Token refreshed for ${serverId}`);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[MCP-AUTH] Refresh error for ${serverId}: ${msg}`);
    setMcpServerAuth(serverId, { ...serverAuth, needsAuth: true, error: msg });
    return false;
  }
}
