/**
 * MCP OAuth Discovery
 * 
 * Discovers OAuth metadata for MCP servers using the MCP OAuth spec:
 * 1. POST to server → 401 with WWW-Authenticate: Bearer resource_metadata="<url>"
 * 2. GET resource metadata → scopes_supported, authorization_servers
 * 3. GET authorization server OIDC config → authorization_endpoint, token_endpoint
 * 
 * Fallbacks:
 * - RFC 8414 (.well-known/oauth-authorization-server) on server origin
 * - Direct WWW-Authenticate header parsing (legacy)
 */

export interface OAuthMetadata {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  scopes_supported?: string[];
  client_id?: string;
  redirect_uris?: string[];
  registration_endpoint?: string;
}

// In-memory cache for discovery results (simple TTL cache)
const discoveryCache = new Map<string, { metadata: OAuthMetadata; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Discover OAuth metadata for an MCP server URL.
 * Follows the MCP OAuth Protected Resource spec.
 */
export async function discoverOAuthMetadata(serverUrl: string): Promise<OAuthMetadata> {
  const cached = discoveryCache.get(serverUrl);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.metadata;
  }

  // Step 1: Probe server for resource_metadata link
  const mcpMetadata = await discoverViaMcpProtocol(serverUrl);
  if (mcpMetadata) {
    cacheResult(serverUrl, mcpMetadata);
    return mcpMetadata;
  }

  // Fallback: RFC 8414 on origin
  const origin = new URL(serverUrl).origin;
  const rfcMetadata = await tryFetchAuthServerMetadata(`${origin}/.well-known/oauth-authorization-server`);
  if (rfcMetadata) {
    cacheResult(serverUrl, rfcMetadata);
    return rfcMetadata;
  }

  // Fallback: OIDC on origin
  const oidcMetadata = await tryFetchAuthServerMetadata(`${origin}/.well-known/openid-configuration`);
  if (oidcMetadata) {
    cacheResult(serverUrl, oidcMetadata);
    return oidcMetadata;
  }

  throw new Error(`OAuth discovery failed for ${serverUrl}: No metadata found`);
}

/**
 * MCP OAuth Protected Resource discovery flow:
 * POST → 401 → resource_metadata URL → scopes + auth server → OIDC config
 */
async function discoverViaMcpProtocol(serverUrl: string): Promise<OAuthMetadata | null> {
  try {
    // Probe with POST (MCP uses POST for JSON-RPC)
    const probe = await fetch(serverUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: '{}',
    });

    if (probe.status !== 401) return null;

    const wwwAuth = probe.headers.get('WWW-Authenticate') || '';
    const resourceMetadataUrl = extractParam(wwwAuth, 'resource_metadata');
    if (!resourceMetadataUrl) return null;

    // Fetch protected resource metadata
    const resourceRes = await fetch(resourceMetadataUrl, { headers: { 'Accept': 'application/json' } });
    if (!resourceRes.ok) return null;

    const resource = await resourceRes.json() as {
      scopes_supported?: string[];
      authorization_servers?: string[];
    };

    const authServerUrl = resource.authorization_servers?.[0];
    if (!authServerUrl) return null;

    // Fetch auth server OIDC configuration
    const oidcUrl = `${authServerUrl.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const oidcRes = await fetch(oidcUrl, { headers: { 'Accept': 'application/json' } });
    if (!oidcRes.ok) return null;

    const oidc = await oidcRes.json() as {
      issuer?: string;
      authorization_endpoint?: string;
      token_endpoint?: string;
      registration_endpoint?: string;
    };

    if (!oidc.authorization_endpoint || !oidc.token_endpoint) return null;

    const result: OAuthMetadata = {
      issuer: oidc.issuer,
      authorization_endpoint: oidc.authorization_endpoint,
      token_endpoint: oidc.token_endpoint,
      scopes_supported: resource.scopes_supported,
    };

    // Try dynamic client registration to get clientId + redirect_uris
    const origin = new URL(serverUrl).origin;
    const regUrl = oidc.registration_endpoint || `${origin}/register`;
    try {
      const regRes = await fetch(regUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: '{}',
      });
      if (regRes.ok) {
        const reg = await regRes.json() as {
          client_id?: string;
          redirect_uris?: string[];
          scope?: string;
        };
        if (reg.client_id) result.client_id = reg.client_id;
        if (reg.redirect_uris) result.redirect_uris = reg.redirect_uris;
        if (reg.scope && !result.scopes_supported?.length) {
          result.scopes_supported = [reg.scope];
        }
        result.registration_endpoint = regUrl;
      }
    } catch { /* registration optional */ }

    return result;
  } catch {
    return null;
  }
}

/**
 * Fetch auth server metadata (RFC 8414 or OIDC)
 */
async function tryFetchAuthServerMetadata(url: string): Promise<OAuthMetadata | null> {
  try {
    const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!response.ok) return null;

    const data = await response.json() as Record<string, unknown>;
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

/** Extract a named parameter from a WWW-Authenticate header */
function extractParam(header: string, name: string): string | null {
  const regex = new RegExp(`${name}="([^"]+)"`);
  const match = regex.exec(header);
  return match ? match[1] : null;
}

/**
 * Parse WWW-Authenticate header to extract OAuth endpoints (legacy fallback)
 */
export function parseWWWAuthenticate(header: string): OAuthMetadata | null {
  if (!header.toLowerCase().startsWith('bearer')) return null;

  const params: Record<string, string> = {};
  const regex = /(\w+)="([^"]+)"/g;
  let match;
  while ((match = regex.exec(header)) !== null) {
    params[match[1].toLowerCase()] = match[2];
  }

  const authEndpoint = params['authorization_uri'] || params['authorization'] || params['authorize'];
  const tokenEndpoint = params['token_uri'] || params['token'] || params['token_endpoint'];

  if (authEndpoint && tokenEndpoint) {
    return { authorization_endpoint: authEndpoint, token_endpoint: tokenEndpoint, client_id: params['client_id'] };
  }
  return null;
}

function cacheResult(serverUrl: string, metadata: OAuthMetadata): void {
  discoveryCache.set(serverUrl, { metadata, expiresAt: Date.now() + CACHE_TTL_MS });
}

export function clearDiscoveryCache(): void {
  discoveryCache.clear();
}
