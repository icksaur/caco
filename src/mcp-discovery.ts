/**
 * MCP OAuth Discovery
 * 
 * Discovers OAuth metadata for MCP servers using:
 * 1. RFC 8414 OAuth Authorization Server Metadata (.well-known/oauth-authorization-server)
 * 2. OpenID Connect Discovery (.well-known/openid-configuration) - used by Azure AD
 * 3. WWW-Authenticate header parsing (fallback)
 * 
 * See: doc/mcp-oauth-auth.md
 */

export interface OAuthMetadata {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  scopes_supported?: string[];
  client_id?: string;  // Some servers may provide a default client_id
}

// In-memory cache for discovery results (simple TTL cache)
const discoveryCache = new Map<string, { metadata: OAuthMetadata; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Discover OAuth metadata for an MCP server URL.
 * Tries multiple discovery mechanisms in order.
 */
export async function discoverOAuthMetadata(serverUrl: string): Promise<OAuthMetadata> {
  // Check cache first
  const cached = discoveryCache.get(serverUrl);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.metadata;
  }
  
  const baseUrl = new URL(serverUrl);
  const origin = baseUrl.origin;
  
  // Try RFC 8414 OAuth Authorization Server Metadata
  const oauthMetadata = await tryFetch(`${origin}/.well-known/oauth-authorization-server`);
  if (oauthMetadata) {
    cacheResult(serverUrl, oauthMetadata);
    return oauthMetadata;
  }
  
  // Try OpenID Connect Discovery (Azure AD uses this)
  const oidcMetadata = await tryFetch(`${origin}/.well-known/openid-configuration`);
  if (oidcMetadata) {
    cacheResult(serverUrl, oidcMetadata);
    return oidcMetadata;
  }
  
  // Try to extract from WWW-Authenticate header via a probe request
  const wwwAuthMetadata = await probeWWWAuthenticate(serverUrl);
  if (wwwAuthMetadata) {
    cacheResult(serverUrl, wwwAuthMetadata);
    return wwwAuthMetadata;
  }
  
  throw new Error(`OAuth discovery failed for ${serverUrl}: No metadata found at .well-known endpoints`);
}

/**
 * Try to fetch OAuth metadata from a discovery URL
 */
async function tryFetch(url: string): Promise<OAuthMetadata | null> {
  try {
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });
    
    if (!response.ok) {
      return null;
    }
    
    const data = await response.json() as Record<string, unknown>;
    
    // Validate required fields
    if (typeof data.authorization_endpoint === 'string' && typeof data.token_endpoint === 'string') {
      return {
        issuer: typeof data.issuer === 'string' ? data.issuer : undefined,
        authorization_endpoint: data.authorization_endpoint,
        token_endpoint: data.token_endpoint,
        scopes_supported: Array.isArray(data.scopes_supported) ? data.scopes_supported : undefined,
        client_id: typeof data.client_id === 'string' ? data.client_id : undefined,
      };
    }
    
    return null;
  } catch {
    return null;
  }
}

/**
 * Probe server with request and extract OAuth metadata from WWW-Authenticate header
 * 
 * Format: Bearer realm="...", authorization_uri="...", token_uri="..."
 * GitHub-style: Bearer realm="GitHub", authorization="https://..."
 */
async function probeWWWAuthenticate(serverUrl: string): Promise<OAuthMetadata | null> {
  try {
    const response = await fetch(serverUrl, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });
    
    // We expect 401 with WWW-Authenticate
    if (response.status !== 401) {
      return null;
    }
    
    const wwwAuth = response.headers.get('WWW-Authenticate');
    if (!wwwAuth) {
      return null;
    }
    
    return parseWWWAuthenticate(wwwAuth);
  } catch {
    return null;
  }
}

/**
 * Parse WWW-Authenticate header to extract OAuth endpoints
 * 
 * Supports multiple formats:
 * - Bearer authorization_uri="...", token_uri="..."
 * - Bearer realm="...", authorization="...", token="..."
 */
export function parseWWWAuthenticate(header: string): OAuthMetadata | null {
  if (!header.toLowerCase().startsWith('bearer')) {
    return null;
  }
  
  const params: Record<string, string> = {};
  
  // Parse key="value" pairs
  const regex = /(\w+)="([^"]+)"/g;
  let match;
  while ((match = regex.exec(header)) !== null) {
    params[match[1].toLowerCase()] = match[2];
  }
  
  // Try different parameter naming conventions
  const authEndpoint = params['authorization_uri'] || params['authorization'] || params['authorize'];
  const tokenEndpoint = params['token_uri'] || params['token'] || params['token_endpoint'];
  
  if (authEndpoint && tokenEndpoint) {
    return {
      authorization_endpoint: authEndpoint,
      token_endpoint: tokenEndpoint,
      client_id: params['client_id'],
    };
  }
  
  return null;
}

function cacheResult(serverUrl: string, metadata: OAuthMetadata): void {
  discoveryCache.set(serverUrl, {
    metadata,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

/**
 * Clear discovery cache (for testing)
 */
export function clearDiscoveryCache(): void {
  discoveryCache.clear();
}
