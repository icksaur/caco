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
 * See: doc/mcp-oauth-auth.md
 */

import { Router, Request, Response } from 'express';
import { randomBytes, createHash } from 'crypto';
import { getMcpAuth, setMcpAuth, getMcpServerAuth, setMcpServerAuth, type MCPAuthState } from '../storage.js';
import { SERVER_URL } from '../config.js';

const router = Router();

// In-memory store for OAuth state (CSRF protection + PKCE)
// Map: state -> { serverId, codeVerifier, expiresAt }
interface PendingAuth {
  serverId: string;
  codeVerifier: string;
  expiresAt: number;
}
const pendingAuth = new Map<string, PendingAuth>();
const STATE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * GET /api/mcp/auth/servers
 * List all MCP servers with their auth status (for applet display)
 */
router.get('/servers', (_req: Request, res: Response) => {
  const store = getMcpAuth();
  
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
router.get('/start', (req: Request, res: Response) => {
  const serverId = req.query.server as string;
  
  if (!serverId) {
    res.status(400).send(errorHtml('Missing server parameter'));
    return;
  }
  
  const serverAuth = getMcpServerAuth(serverId);
  if (!serverAuth) {
    res.status(404).send(errorHtml(`Server "${serverId}" not found`));
    return;
  }
  
  if (!serverAuth.clientId) {
    res.status(400).send(errorHtml(`Server "${serverId}" requires a client_id. Configure it in the MCP Auth applet.`));
    return;
  }
  
  // Generate PKCE code verifier and challenge
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  
  // Generate state parameter for CSRF protection
  const state = randomBytes(32).toString('base64url');
  
  // Store pending auth state
  pendingAuth.set(state, {
    serverId,
    codeVerifier,
    expiresAt: Date.now() + STATE_TTL_MS,
  });
  
  // Clean up expired states
  cleanupExpiredStates();
  
  // Build authorization URL
  const callbackUrl = `${SERVER_URL}/api/mcp/auth/callback`;
  const authUrl = new URL(serverAuth.authorizationEndpoint);
  authUrl.searchParams.set('client_id', serverAuth.clientId);
  authUrl.searchParams.set('redirect_uri', callbackUrl);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  
  if (serverAuth.scopes && serverAuth.scopes.length > 0) {
    authUrl.searchParams.set('scope', serverAuth.scopes.join(' '));
  }
  
  // Redirect to OAuth provider
  res.redirect(authUrl.toString());
});

/**
 * GET /api/mcp/auth/callback
 * OAuth callback handler
 * 
 * Query params:
 *   code  - Authorization code from OAuth provider
 *   state - State parameter for CSRF validation
 *   error - OAuth error (if auth failed)
 */
router.get('/callback', async (req: Request, res: Response) => {
  const { code, state, error, error_description } = req.query as Record<string, string>;
  
  // Handle OAuth errors
  if (error) {
    const message = error_description || error;
    res.send(errorPostMessage(null, message));
    return;
  }
  
  if (!state || !code) {
    res.status(400).send(errorHtml('Missing code or state parameter'));
    return;
  }
  
  // Validate state parameter
  const pending = pendingAuth.get(state);
  if (!pending) {
    res.status(400).send(errorHtml('Invalid or expired state parameter. Please try again.'));
    return;
  }
  
  if (pending.expiresAt < Date.now()) {
    pendingAuth.delete(state);
    res.status(400).send(errorHtml('Authentication timed out. Please try again.'));
    return;
  }
  
  // Clean up state immediately
  pendingAuth.delete(state);
  
  const { serverId, codeVerifier } = pending;
  const serverAuth = getMcpServerAuth(serverId);
  
  if (!serverAuth) {
    res.status(404).send(errorHtml(`Server "${serverId}" not found`));
    return;
  }
  
  // Exchange code for tokens
  try {
    const callbackUrl = `${SERVER_URL}/api/mcp/auth/callback`;
    
    // Build token request
    // NOTE: Include scope in token exchange for Azure AD (SDK #941 workaround)
    const tokenParams = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: callbackUrl,
      code_verifier: codeVerifier,
      client_id: serverAuth.clientId!,
    });
    
    if (serverAuth.scopes && serverAuth.scopes.length > 0) {
      tokenParams.set('scope', serverAuth.scopes.join(' '));
    }
    
    const tokenResponse = await fetch(serverAuth.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: tokenParams.toString(),
    });
    
    if (!tokenResponse.ok) {
      // Try to parse error response
      let errorMessage = `Token exchange failed: ${tokenResponse.status}`;
      try {
        const errorData = await tokenResponse.json() as { error?: string; error_description?: string };
        errorMessage = errorData.error_description || errorData.error || errorMessage;
      } catch {
        // Ignore JSON parse errors
      }
      
      // Update server state with error
      setMcpServerAuth(serverId, {
        ...serverAuth,
        needsAuth: true,
        error: errorMessage,
      });
      
      res.send(errorPostMessage(serverId, errorMessage));
      return;
    }
    
    // Parse token response
    // Handle both JSON and URL-encoded responses (per SDK #759)
    let tokenData: { access_token?: string; refresh_token?: string; expires_in?: number };
    const contentType = tokenResponse.headers.get('content-type') || '';
    
    if (contentType.includes('application/json')) {
      tokenData = await tokenResponse.json() as typeof tokenData;
    } else {
      // URL-encoded response (GitHub style)
      const text = await tokenResponse.text();
      const params = new URLSearchParams(text);
      tokenData = {
        access_token: params.get('access_token') || undefined,
        refresh_token: params.get('refresh_token') || undefined,
        expires_in: params.get('expires_in') ? parseInt(params.get('expires_in')!, 10) : undefined,
      };
    }
    
    if (!tokenData.access_token) {
      const errorMessage = 'No access_token in response';
      setMcpServerAuth(serverId, {
        ...serverAuth,
        needsAuth: true,
        error: errorMessage,
      });
      res.send(errorPostMessage(serverId, errorMessage));
      return;
    }
    
    // Calculate expiry time
    const expiresAt = tokenData.expires_in 
      ? Date.now() + (tokenData.expires_in * 1000)
      : undefined;
    
    // Update server state with tokens
    setMcpServerAuth(serverId, {
      ...serverAuth,
      token: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt,
      needsAuth: false,
      needsClientId: false,
      error: undefined,
    });
    
    // Return success HTML that notifies opener
    res.send(successPostMessage(serverId));
    
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Token exchange failed';
    setMcpServerAuth(serverId, {
      ...serverAuth,
      needsAuth: true,
      error: errorMessage,
    });
    res.send(errorPostMessage(serverId, errorMessage));
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
// State Management
// ============================================================================

/**
 * Clean up expired pending auth states
 */
function cleanupExpiredStates(): void {
  const now = Date.now();
  for (const [key, value] of pendingAuth.entries()) {
    if (value.expiresAt < now) {
      pendingAuth.delete(key);
    }
  }
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

function successPostMessage(serverId: string): string {
  return `<!DOCTYPE html>
<html>
<body>
<script>
  window.opener.postMessage({
    type: 'mcp-auth-complete',
    server: '${escapeJs(serverId)}'
  }, location.origin);
  window.close();
</script>
</body>
</html>`;
}

function errorPostMessage(serverId: string | null, error: string): string {
  return `<!DOCTYPE html>
<html>
<body>
<script>
  window.opener.postMessage({
    type: 'mcp-auth-error',
    server: ${serverId ? `'${escapeJs(serverId)}'` : 'null'},
    error: '${escapeJs(error)}'
  }, location.origin);
  window.close();
</script>
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

function escapeJs(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n');
}

export default router;
