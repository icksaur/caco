/**
 * MCP Routes
 * 
 * Server status/tools + OAuth authentication for MCP servers.
 * 
 * Endpoints:
 *   GET  /api/mcp/servers       - List MCP servers with status and tools
 *   GET  /api/mcp/auth/servers  - List servers with auth status
 *   GET  /api/mcp/auth/start    - Initiate OAuth flow (opens in popup)
 *   GET  /api/mcp/auth/callback - OAuth callback (main-port flow)
 *   POST /api/mcp/auth/config   - Update server config (add client_id)
 */

import { Router, Request, Response } from 'express';
import { randomBytes, createHash } from 'crypto';
import { createServer } from 'http';
import { getMcpAuth, setMcpAuth, getMcpServerAuth, updateMcpServerAuth, type MCPAuthState } from '../storage.js';
import { listCliOAuthConfigs } from '../cli-oauth.js';
import { discoverOAuthMetadata, serverIdFromUrl } from '../mcp-discovery.js';

const router = Router();

// Pending OAuth state — maps state param to auth context
interface PendingAuth {
  serverId: string;
  codeVerifier: string;
  callbackUrl: string;
  clientId: string;
  tokenEndpoint: string;
  scopes: string[];
  expiresAt: number;
}
const pendingAuth = new Map<string, PendingAuth>();
const STATE_TTL_MS = 2 * 60 * 1000;

/**
 * GET /api/mcp/auth/servers
 * List all MCP servers with their auth status (for applet display).
 * Auto-merges CLI OAuth configs to pre-populate clientId and auth endpoints.
 */
router.get('/servers', (_req: Request, res: Response) => {
  const store = getMcpAuth();
  let changed = false;

  // Auto-register CLI OAuth servers that aren't in Caco's store yet
  const cliConfigs = listCliOAuthConfigs();
  for (const cli of cliConfigs) {
    const id = serverIdFromUrl(cli.serverUrl);
    if (!store.servers[id]) {
      store.servers[id] = {
        url: cli.serverUrl,
        authorizationEndpoint: '',
        tokenEndpoint: '',
        clientId: cli.clientId,
        needsAuth: !cli.hasTokens || cli.tokenExpired,
        needsClientId: false,
      };
      changed = true;
    } else if (!store.servers[id].clientId && cli.clientId) {
      store.servers[id].clientId = cli.clientId;
      store.servers[id].needsClientId = false;
      changed = true;
    }
  }
  if (changed) setMcpAuth(store);
  
  const servers = Object.entries(store.servers).map(([id, state]) => ({
    id,
    url: state.url,
    needsAuth: state.needsAuth,
    needsClientId: state.needsClientId,
    expiresAt: state.expiresAt ?? null,
    error: state.error ?? null,
  }));
  
  res.json({ servers });
});

/**
 * GET /api/mcp/auth/start
 * Initiate OAuth flow for a server
 * 
 * Query params:
 *   server - Server ID to authenticate
 * 
 * Redirects to OAuth provider's authorization endpoint
 */
router.get('/start', async (req: Request, res: Response) => {
  const serverId = req.query.server as string;
  const origin = req.query.origin as string | undefined;
  
  if (!serverId) {
    res.status(400).send(errorHtml('Missing server parameter'));
    return;
  }
  
  let serverAuth = getMcpServerAuth(serverId);
  if (!serverAuth) {
    res.status(404).send(errorHtml(`Server "${serverId}" not found`));
    return;
  }
  
  // Run discovery if endpoints, scopes, or clientId are missing
  if (!serverAuth.authorizationEndpoint || !serverAuth.scopes?.length || !serverAuth.clientId) {
    try {
      const metadata = await discoverOAuthMetadata(serverAuth.url);
      serverAuth = updateMcpServerAuth(serverId, prev => {
        const base = prev ?? serverAuth!;
        const next: MCPAuthState = {
          ...base,
          authorizationEndpoint: metadata.authorization_endpoint,
          tokenEndpoint: metadata.token_endpoint,
          scopes: metadata.scopes_supported,
        };
        if (metadata.client_id) next.clientId = metadata.client_id;
        if (metadata.redirect_uris) next.redirectUris = metadata.redirect_uris;
        return next;
      });
      console.log(`[MCP-AUTH] Discovered endpoints for ${serverId}: ${metadata.authorization_endpoint}` +
        (metadata.client_id ? ` (clientId from registration: ${metadata.client_id})` : ''));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).send(errorHtml(`OAuth discovery failed for "${serverId}": ${msg}`));
      return;
    }
  }

  if (!serverAuth.clientId) {
    res.status(400).send(errorHtml(`Server "${serverId}" requires a client_id. Configure it in the MCP Auth applet.`));
    return;
  }
  
  // PKCE
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = randomBytes(32).toString('base64url');

  // Determine callback URL:
  // - Servers with fixed redirect_uris from registration: use their localhost URI
  // - All others: use browser's origin + our /callback route (works through tunnels)
  let callbackUrl: string;
  const registeredRedirect = serverAuth.redirectUris?.find(u =>
    u.startsWith('http://localhost:') || u.startsWith('http://127.0.0.1:'));
  if (registeredRedirect) {
    callbackUrl = registeredRedirect;
  } else {
    const browserOrigin = origin || `http://localhost:${req.socket.localPort || 53000}`;
    callbackUrl = `${browserOrigin}/`;
  }

  const clientId = serverAuth.clientId!;
  const scopes = [...(serverAuth.scopes || [])];
  if (!scopes.includes('offline_access')) scopes.push('offline_access');

  // Store pending auth state
  pendingAuth.set(state, {
    serverId,
    codeVerifier,
    callbackUrl,
    clientId,
    tokenEndpoint: serverAuth.tokenEndpoint,
    scopes,
    expiresAt: Date.now() + STATE_TTL_MS,
  });
  cleanupExpiredStates();

  console.log(`[MCP-AUTH] Starting OAuth for ${serverId}, callback: ${callbackUrl}`);

  // Build authorization URL
  const authUrl = new URL(serverAuth.authorizationEndpoint);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', callbackUrl);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('scope', scopes.join(' '));

  // For registered redirects (e.g., localhost:3000), start a temp server to catch the callback.
  // For main-port callbacks, Express /callback handles it.
  if (registeredRedirect) {
    const parsed = new URL(registeredRedirect);
    const tempPort = parseInt(parsed.port, 10) || 0;
    const tempPath = parsed.pathname || '/';

    startTempTokenExchange(state, tempPort, tempPath, serverAuth);
  }

  res.redirect(authUrl.toString());
});

/**
 * GET /api/mcp/auth/callback
 * OAuth callback — exchanges authorization code for token.
 * Works through tunnels since the redirect hits the same Express server.
 */
router.get('/callback', async (req: Request, res: Response) => {
  const { code, state, error, error_description } = req.query as Record<string, string>;

  if (error) {
    res.send(callbackHtml(null, error_description || error));
    return;
  }

  if (!state || !code) {
    res.status(400).send(errorHtml('Missing code or state parameter'));
    return;
  }

  const pending = pendingAuth.get(state);
  if (!pending) {
    res.status(400).send(errorHtml('Invalid or expired state. Please try again.'));
    return;
  }
  pendingAuth.delete(state);

  if (pending.expiresAt < Date.now()) {
    res.status(400).send(errorHtml('Authentication timed out. Please try again.'));
    return;
  }

  const { serverId } = pending;
  const serverAuth = getMcpServerAuth(serverId);
  if (!serverAuth) {
    res.status(404).send(errorHtml(`Server "${serverId}" not found`));
    return;
  }

  try {
    const tokens = await exchangeCodeForToken(pending, code);
    updateMcpServerAuth(serverId, prev => ({
      ...(prev ?? serverAuth),
      token: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      needsAuth: false,
      error: undefined,
    }));
    console.log(`[MCP-AUTH] Token acquired for ${serverId}`);
    res.send(callbackHtml(serverId, null));
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Token exchange failed';
    updateMcpServerAuth(serverId, prev => ({ ...(prev ?? serverAuth), needsAuth: true, error: errorMessage }));
    res.send(callbackHtml(serverId, errorMessage));
  }
});

/**
 * POST /api/mcp/auth/config
 * Update server configuration (e.g., add client_id)
 */
router.post('/config', (req: Request, res: Response) => {
  const { serverId, clientId } = req.body as { serverId?: string; clientId?: string };
  
  if (!serverId) {
    res.status(400).json({ ok: false, error: 'serverId required' });
    return;
  }
  
  const existing = getMcpServerAuth(serverId);
  if (!existing) {
    res.status(404).json({ ok: false, error: 'Server not found' });
    return;
  }

  updateMcpServerAuth(serverId, prev => {
    const next: MCPAuthState = { ...(prev ?? existing) };
    if (clientId !== undefined) {
      next.clientId = clientId || null;
      next.needsClientId = !clientId;
    }
    return next;
  });
  
  res.json({ ok: true });
});

// ============================================================================
// Token Refresh
// ============================================================================

export { refreshAccessToken } from '../mcp-auth-service.js';

// ============================================================================
// Shared Token Exchange
// ============================================================================

interface TokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

async function exchangeCodeForToken(pending: PendingAuth, code: string): Promise<TokenResult> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: pending.callbackUrl,
    code_verifier: pending.codeVerifier,
    client_id: pending.clientId,
    scope: pending.scopes.join(' '),
  });

  const res = await fetch(pending.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: params.toString(),
  });

  if (!res.ok) {
    let msg = `Token exchange failed: ${res.status}`;
    try { const d = await res.json() as { error_description?: string; error?: string }; msg = d.error_description || d.error || msg; } catch { /* */ }
    throw new Error(msg);
  }

  const data = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error('No access_token in response');

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_in ? Date.now() + (data.expires_in * 1000) : undefined,
  };
}

// ============================================================================
// Temp Server for Registration-Mandated Redirect URIs
// ============================================================================

/**
 * Start a temp HTTP server for servers with fixed redirect URIs (from registration).
 * Catches the OAuth callback, exchanges code for token, then shuts down.
 * Runs in the background — /start has already redirected the browser.
 */
function startTempTokenExchange(expectedState: string, port: number, path: string, serverAuth: MCPAuthState): void {
  const server = createServer((req, resp) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== path) { resp.writeHead(404); resp.end(); return; }

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    const errorDesc = url.searchParams.get('error_description');

    server.close();

    if (error || !code || state !== expectedState) {
      const msg = errorDesc || error || 'Invalid state';
      resp.writeHead(200, { 'Content-Type': 'text/html' });
      resp.end(`<html><body><h3>Authentication failed</h3><p>${escapeHtml(msg)}</p></body></html>`);
      return;
    }

    const pending = pendingAuth.get(state);
    if (!pending) {
      resp.writeHead(200, { 'Content-Type': 'text/html' });
      resp.end('<html><body><h3>Expired</h3><p>Please try again.</p></body></html>');
      return;
    }
    pendingAuth.delete(state);

    void (async () => {
      try {
        const tokens = await exchangeCodeForToken(pending, code);
        updateMcpServerAuth(pending.serverId, prev => ({
          ...(prev ?? serverAuth),
          token: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
          needsAuth: false,
          error: undefined,
        }));
        console.log(`[MCP-AUTH] Token acquired for ${pending.serverId} (temp server)`);
        resp.writeHead(200, { 'Content-Type': 'text/html' });
        resp.end('<html><body><h3>Authenticated</h3><p>You can close this window.</p><script>window.close()</script></body></html>');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        updateMcpServerAuth(pending.serverId, prev => ({ ...(prev ?? serverAuth), needsAuth: true, error: msg }));
        resp.writeHead(200, { 'Content-Type': 'text/html' });
        resp.end(`<html><body><h3>Error</h3><p>${escapeHtml(msg)}</p></body></html>`);
      }
    })();
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(`[MCP-AUTH] Temp server failed on port ${port}: ${err.code || err.message}`);
  });

  server.listen(port, 'localhost', () => {
    console.log(`[MCP-AUTH] Temp callback server on port ${port}`);
  });

  // Auto-close after 2 minutes
  setTimeout(() => server.close(), STATE_TTL_MS);
}

// ============================================================================
// PKCE Helpers
// ============================================================================

/**
 * Generate a cryptographically random code verifier (43-128 chars)
 */
function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Generate code challenge from verifier (S256 method)
 */
function generateCodeChallenge(verifier: string): string {
  return createHash('sha256')
    .update(verifier)
    .digest('base64url');
}

// ============================================================================
// HTML Response Helpers
// ============================================================================

function errorHtml(message: string): string {
  return `<!DOCTYPE html>
<html>
<head><title>MCP Auth Error</title></head>
<body style="font-family: system-ui, sans-serif; padding: 2rem;">
  <h1>Authentication Error</h1>
  <p>${escapeHtml(message)}</p>
  <button onclick="window.close()">Close</button>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cleanupExpiredStates(): void {
  const now = Date.now();
  for (const [key, value] of pendingAuth.entries()) {
    if (value.expiresAt < now) pendingAuth.delete(key);
  }
}

function callbackHtml(serverId: string | null, error: string | null): string {
  if (error) {
    return `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;padding:2rem;">
<h3>Authentication failed</h3><p>${escapeHtml(error)}</p>
<p>You can close this window.</p>
<script>
if(window.opener){window.opener.postMessage({type:'mcp-auth-error',server:${serverId ? `'${escapeHtml(serverId)}'` : 'null'},error:'${escapeHtml(error)}'},window.opener.location.origin);}
</script></body></html>`;
  }
  return `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;padding:2rem;">
<h3>Authenticated</h3><p>You can close this window.</p>
<script>
if(window.opener){window.opener.postMessage({type:'mcp-auth-complete',server:'${escapeHtml(serverId || '')}'},window.opener.location.origin);}
window.close();
</script></body></html>`;
}

export { router };
