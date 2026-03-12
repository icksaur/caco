/**
 * MCP OAuth Authentication Routes
 * 
 * Handles OAuth flow for MCP servers requiring interactive authentication.
 * 
 * Endpoints:
 *   GET  /api/mcp/auth/servers  - List servers with auth status
 *   GET  /api/mcp/auth/start    - Initiate OAuth flow (opens in popup)
 *   GET  /api/mcp/auth/callback - OAuth callback handler
 *   POST /api/mcp/auth/config   - Update server config (add client_id)
 * 
 * See: EXTENSIONS.md (MCP OAuth section)
 */

import { Router, Request, Response } from 'express';
import { randomBytes, createHash } from 'crypto';
import { createServer, type Server as HttpServer } from 'http';
import { getMcpAuth, setMcpAuth, getMcpServerAuth, setMcpServerAuth, type MCPAuthState } from '../storage.js';
import { listCliOAuthConfigs } from '../cli-oauth.js';
import { discoverOAuthMetadata } from '../mcp-discovery.js';

const router = Router();

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
    const id = new URL(cli.serverUrl).hostname.replace(/\./g, '-');
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
      serverAuth = {
        ...serverAuth,
        authorizationEndpoint: metadata.authorization_endpoint,
        tokenEndpoint: metadata.token_endpoint,
        scopes: metadata.scopes_supported,
      };
      // Use registration-provided clientId + redirect_uris if available
      if (metadata.client_id) serverAuth.clientId = metadata.client_id;
      if (metadata.redirect_uris) serverAuth.redirectUris = metadata.redirect_uris;
      setMcpServerAuth(serverId, serverAuth);
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

  // Determine redirect URI: prefer discovered redirect_uris, fall back to random port
  let callbackPort = 0;
  let callbackPath = '/';
  const localhostRedirect = serverAuth.redirectUris?.find(u => u.startsWith('http://127.0.0.1:') || u.startsWith('http://localhost:'));
  if (localhostRedirect) {
    const parsed = new URL(localhostRedirect);
    callbackPort = parseInt(parsed.port, 10) || 0;
    callbackPath = parsed.pathname || '/';
  }

  let tempResult;
  try {
    tempResult = await startTempCallbackServer(state, callbackPort, callbackPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).send(errorHtml(`Failed to start OAuth callback: ${msg}`));
    return;
  }
  const { port, callbackPromise, server: tempServer } = tempResult;
  const callbackUrl = `http://localhost:${port}${callbackPath}`;

  console.log(`[MCP-AUTH] Temp callback server on port ${port} for ${serverId}`);

  // Build authorization URL — use discovered clientId if available
  const clientId = serverAuth.clientId!;
  const authUrl = new URL(serverAuth.authorizationEndpoint);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', callbackUrl);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  const scopes = [...(serverAuth.scopes || [])];
  if (!scopes.includes('offline_access')) scopes.push('offline_access');
  authUrl.searchParams.set('scope', scopes.join(' '));

  // Redirect browser to OAuth provider
  res.redirect(authUrl.toString());

  // Wait for the callback (or timeout)
  try {
    const { code, error } = await callbackPromise;
    
    if (error || !code) {
      setMcpServerAuth(serverId, { ...serverAuth, needsAuth: true, error: error || 'No code received' });
      return;
    }

    // Exchange code for token
    const tokenParams = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: callbackUrl,
      code_verifier: codeVerifier,
      client_id: clientId,
      scope: scopes.join(' '),
    });

    const tokenResponse = await fetch(serverAuth.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: tokenParams.toString(),
    });

    if (!tokenResponse.ok) {
      let errorMessage = `Token exchange failed: ${tokenResponse.status}`;
      try {
        const errorData = await tokenResponse.json() as { error?: string; error_description?: string };
        errorMessage = errorData.error_description || errorData.error || errorMessage;
      } catch { /* ignore */ }
      setMcpServerAuth(serverId, { ...serverAuth, needsAuth: true, error: errorMessage });
      console.error(`[MCP-AUTH] Token exchange failed for ${serverId}: ${errorMessage}`);
      return;
    }

    const tokenData = await tokenResponse.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!tokenData.access_token) {
      setMcpServerAuth(serverId, { ...serverAuth, needsAuth: true, error: 'No access_token in response' });
      return;
    }

    const expiresAt = tokenData.expires_in ? Date.now() + (tokenData.expires_in * 1000) : undefined;
    setMcpServerAuth(serverId, {
      ...serverAuth,
      token: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt,
      needsAuth: false,
      error: undefined,
    });
    console.log(`[MCP-AUTH] Token acquired for ${serverId}`);
  } finally {
    tempServer.close();
    activeTempServer = null;
  }
});

// Track active temp auth servers to prevent port conflicts
let activeTempServer: HttpServer | null = null;

/**
 * Start a temporary HTTP server to receive the OAuth callback.
 * Uses a specific port if provided (to match CLI's registered redirect URI).
 * Closes any previously active temp server first.
 */
function startTempCallbackServer(expectedState: string, preferredPort = 0, callbackPath = '/callback'): Promise<{
  port: number;
  callbackPromise: Promise<{ code?: string; error?: string }>;
  server: HttpServer;
}> {
  // Close any previous temp server
  if (activeTempServer) {
    activeTempServer.close();
    activeTempServer = null;
  }

  return new Promise((resolveSetup, rejectSetup) => {
    let resolveCallback: (value: { code?: string; error?: string }) => void;
    const callbackPromise = new Promise<{ code?: string; error?: string }>((resolve) => {
      resolveCallback = resolve;
    });

    const TIMEOUT_MS = 120_000;
    const timeout = setTimeout(() => {
      resolveCallback({ error: 'Authentication timed out' });
      server.close();
    }, TIMEOUT_MS);

    const server = createServer((req, resp) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname !== callbackPath) {
        resp.writeHead(404);
        resp.end();
        return;
      }

      const code = url.searchParams.get('code') || undefined;
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error') || undefined;
      const errorDesc = url.searchParams.get('error_description') || undefined;

      // Respond to browser immediately
      resp.writeHead(200, { 'Content-Type': 'text/html' });
      if (error) {
        resp.end(`<html><body><h3>Authentication failed</h3><p>${escapeHtml(errorDesc || error)}</p><p>You can close this window.</p></body></html>`);
      } else {
        resp.end('<html><body><h3>Authenticated</h3><p>You can close this window.</p><script>window.close()</script></body></html>');
      }

      clearTimeout(timeout);

      if (state !== expectedState) {
        resolveCallback({ error: 'Invalid state parameter' });
      } else if (error) {
        resolveCallback({ error: errorDesc || error });
      } else {
        resolveCallback({ code });
      }
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      activeTempServer = null;
      rejectSetup(new Error(`Failed to start callback server: ${err.code || err.message}`));
    });

    server.listen(preferredPort, 'localhost', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      activeTempServer = server;
      resolveSetup({ port, callbackPromise, server });
    });
  });
}

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
  
  const serverAuth = getMcpServerAuth(serverId);
  if (!serverAuth) {
    res.status(404).json({ ok: false, error: 'Server not found' });
    return;
  }
  
  // Update configuration
  const updatedState: MCPAuthState = {
    ...serverAuth,
  };
  
  if (clientId !== undefined) {
    updatedState.clientId = clientId || null;
    updatedState.needsClientId = !clientId;
  }
  
  setMcpServerAuth(serverId, updatedState);
  
  res.json({ ok: true });
});

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

export default router;
