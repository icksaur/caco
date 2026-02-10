# MCP OAuth Authentication Spec

## Status: Review

## Problem Statement

MCP servers requiring Azure AD (or other OAuth) authentication cannot complete interactive browser authentication flows when accessed through Caco. The Copilot SDK passes MCP configuration to the CLI, but there's no mechanism for:

1. Detecting when an MCP server requires authentication
2. Initiating interactive OAuth flows from the browser
3. Passing obtained tokens to the SDK for subsequent requests

**Current failure mode:** Tools appear available but fail silently when invoked, with no diagnostic visibility.

## Research Findings

### Relevant GitHub Issues

| Repository | Issue | Description |
|------------|-------|-------------|
| modelcontextprotocol/typescript-sdk | #941 | **OAuth scope parameter missing from token exchange - breaks Azure AD** |
| modelcontextprotocol/typescript-sdk | #1370 | OAuth retry logic should be in SDK (handles 401/403) |
| modelcontextprotocol/python-sdk | #2024 | Multi-protocol authentication with discovery |
| github/copilot-sdk | #163 | MCP server environment variables not read |
| github/copilot-sdk | #350 | Using built-in tools from SDK |

### SDK Capabilities

- **No discovery API**: SDK provides no way to list configured MCP servers or their auth status
- **Headers supported**: Remote MCP servers (HTTP/SSE) accept custom headers including `Authorization`
- **OAuth helpers exist**: `@modelcontextprotocol/client` provides `ClientCredentialsProvider`, `PrivateKeyJwtProvider`
- **Interactive pattern documented**: SDK examples show browser popup + local callback server pattern

### Python vs Node SDK

Both SDKs are essentially identical in architecture:
- Same transport types (stdio, Streamable HTTP, SSE)
- Same OAuth helper patterns
- Both at v2 pre-alpha (v1.x recommended for production)

## Goals

1. Enable MCP servers requiring OAuth to work in Caco browser context
2. Provide visibility into MCP server auth status
3. Support Azure AD, GitHub OAuth, and generic OAuth 2.0 providers
4. Store and refresh tokens per-session
5. Handle token expiry gracefully
6. **Graceful degradation**: When OAuth fails mid-session, continue with available tools and surface clear errors for unavailable ones

## Non-Goals

- Supporting non-HTTP MCP servers (stdio) for OAuth (they don't use it)
- Implementing our own MCP client (we delegate to Copilot SDK/CLI)
- Modifying the Copilot SDK itself

## Use Cases

### UC1: Agent Discovers OAuth-Protected Server (Pit of Success)

1. Agent tries to use MCP tool → SDK returns 401
2. Agent calls `register_mcp_server` tool with server URL
3. Tool does OAuth discovery, adds server to `~/.caco/mcp-auth.json` with `needsAuth: true`
4. Tool returns: "Server registered. Ask user to authenticate via MCP Auth applet"
5. Agent tells user: "Please authenticate [server] - open MCP Auth applet (/?applet=mcp-auth)"
6. User opens applet, clicks Authenticate, completes popup flow
7. Future tool calls work

**No upfront configuration.** Servers accumulate as failures are encountered.

### UC2: Token Expires

1. Token expires, next tool call fails with 401
2. Agent sees 401, tells user to re-authenticate
3. User opens applet, re-authenticates
4. (Future: silent refresh via refresh_token before expiry)

### UC3: User Cancels Auth

1. User closes popup or doesn't authenticate
2. Server remains in list with `needsAuth: true`
3. Agent can still use other tools, just not that server's

## Current State Analysis

### Where MCP Config Lives Today

**There is no MCP server config in the current Caco codebase.**

Current state:
- `session-manager.ts:34` defines `CreateSessionConfig` with: `model`, `streaming`, `systemMessage`, `tools`, `excludedTools`
- **No `mcpServers` field exists**
- The existing `/api/mcp/*` routes in `src/routes/mcp.ts` are file system wrappers, not MCP server management
- MCP tools are hardcoded in `/api/mcp/tools` endpoint (read_file, write_file, list_directory)

### SDK Interface

The Copilot SDK's `createSession` accepts MCP config:

```typescript
// From github/copilot-sdk docs/mcp/overview.md
const session = await client.createSession({
  model: "gpt-5",
  mcpServers: {
    "my-server": {
      type: "http",
      url: "https://...",
      headers: { "Authorization": "Bearer ${TOKEN}" },
      tools: ["*"],
    },
  },
});
```

### Required Code Changes

| File | Change |
|------|--------|
| `src/types.ts` | Add `MCPServerConfig`, `MCPAuthState` types |
| `src/storage.ts` | Add `getMcpAuth()`, `setMcpAuth()` for global `~/.caco/mcp-auth.json` |
| `src/session-manager.ts:263` | Pass `mcpServers` with injected auth headers to SDK |
| New: `src/mcp-auth-tools.ts` | Agent tool `register_mcp_server` for pit-of-success discovery |
| New: `src/routes/mcp-auth.ts` | OAuth endpoints (start, callback) |
| New: `src/mcp-discovery.ts` | OAuth metadata discovery (stateless, cacheable) |
| New: `applets/mcp-auth/` | Bundled applet for MCP server auth management |

### Agent Tool: `register_mcp_server`

When agent encounters a 401 from an MCP server, it uses this tool to register it for OAuth:

```typescript
{
  name: 'register_mcp_server',
  description: 'Register an MCP server that requires OAuth authentication. Call this when an MCP tool returns 401 Unauthorized.',
  parameters: {
    serverUrl: { type: 'string', description: 'The MCP server URL that returned 401' },
    serverId: { type: 'string', description: 'Identifier for this server (e.g., "azure-graph")' },
    clientId: { type: 'string', description: 'OAuth client_id (Application ID) - required for Azure AD. Ask user if not known.', optional: true },
  },
  handler: async ({ serverUrl, serverId, clientId }) => {
    // 1. Do OAuth discovery on serverUrl
    const metadata = await discoverOAuthMetadata(serverUrl);
    
    // 2. Check if discovery provides client_id (some servers do)
    const resolvedClientId = clientId || metadata.client_id || null;
    
    // 3. Add to ~/.caco/mcp-auth.json
    const auth = getMcpAuth();
    auth.servers[serverId] = {
      url: serverUrl,
      authorizationEndpoint: metadata.authorization_endpoint,
      tokenEndpoint: metadata.token_endpoint,
      clientId: resolvedClientId,
      needsAuth: true,
      needsClientId: !resolvedClientId,  // Flag if client_id still missing
    };
    setMcpAuth(auth);
    
    if (!resolvedClientId) {
      return {
        textResultForLlm: `Server "${serverId}" registered but requires a client_id (OAuth Application ID). ` +
          `Ask the user: "What is the OAuth client_id/Application ID for this server? ` +
          `This is typically found in Azure Portal > App Registrations."`
      };
    }
    
    return {
      textResultForLlm: `Server "${serverId}" registered for OAuth. ` +
        `Tell the user to authenticate by opening /?applet=mcp-auth`,
    };
  },
}
```

**About client_id:** This is a registered application identifier, NOT a user identifier. For Azure AD:
- Each organization must create an "App Registration" in Azure Portal
- The client_id (Application ID) identifies "Caco" as the app requesting access
- The redirect_uri must be configured to point to Caco's callback URL
- Some servers may provide client_id via OAuth discovery; most Azure AD won't

## Architecture

### OAuth Flow Sequence

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Caco Browser   │     │  Caco Server    │     │  MCP Server     │
│  (Frontend)     │     │  (Node.js)      │     │  (OAuth-secured)│
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         │ 1. List MCP servers   │                       │
         │──────────────────────>│                       │
         │                       │ 2. Check each server  │
         │                       │──────────────────────>│
         │                       │ 3. 401 + WWW-Auth     │
         │                       │<──────────────────────│
         │ 4. Server list        │                       │
         │    (auth required)    │                       │
         │<──────────────────────│                       │
         │                       │                       │
         │ 5. Start OAuth flow   │                       │
         │──────────────────────>│                       │
         │                       │ 6. Fetch OAuth        │
         │                       │    discovery          │
         │                       │──────────────────────>│
         │ 7. Authorize URL      │                       │
         │<──────────────────────│                       │
         │                       │                       │
         │ 8. Open popup to      │                       │
         │    OAuth provider     │                       │
         │===(user logs in)======│                       │
         │                       │                       │
         │ 9. Callback with code │                       │
         │──────────────────────>│                       │
         │                       │ 10. Exchange for      │
         │                       │     token             │
         │                       │──────────────────────>│
         │                       │ 11. Access token      │
         │                       │<──────────────────────│
         │ 12. Auth complete     │                       │
         │<──────────────────────│                       │
         │                       │                       │
         │ 13. Create session    │ 14. Session with      │
         │     with MCP          │     auth headers      │
         │──────────────────────>│──────────────────────>│
         │                       │ 15. Tools available   │
         │                       │<──────────────────────│
```

### Components

#### 1. MCP Auth State

```typescript
// Simple: no token = needs auth, token + expired = needs refresh, error = show message
interface MCPAuthState {
  token?: string;
  refreshToken?: string;
  expiresAt?: number;
  error?: string;
}

// Global storage at ~/.caco/mcp-auth.json
// Shared across all sessions
```

#### 2. API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/mcp/auth/servers` | GET | List servers from `mcp-auth.json` (for applet) |
| `/api/mcp/auth/start` | GET | Initiate OAuth flow, redirects to provider |
| `/api/mcp/auth/callback` | GET | OAuth callback, stores token, closes popup |
| `/api/mcp/auth/config` | POST | Update server config (add client_id) |

#### 3. Frontend (Applet)

See "MCP Auth Applet Specification" section below for full details.

### Configuration

MCP servers requiring OAuth are configured in session creation:

```typescript
const session = await createSession({
  mcpServers: {
    "azure-graph": {
      type: "http",
      url: "https://graph.mcp.example.com/mcp",
      oauth: {
        // Optional: Override discovery
        authorization_endpoint: "https://login.microsoftonline.com/.../authorize",
        token_endpoint: "https://login.microsoftonline.com/.../token",
        scopes: ["User.Read", "Mail.Read"],
        client_id: "your-app-client-id",
      },
      tools: ["*"],
    },
  },
});
```

If `oauth` is not specified, Caco attempts discovery via:
1. `/.well-known/oauth-authorization-server` (RFC 8414)
2. `/.well-known/openid-configuration` (OpenID Connect - used by Azure AD)
3. `WWW-Authenticate` header on 401 response

### Azure AD Specific Handling

Azure AD has quirks that differ from standard OAuth 2.0. Our implementation explicitly handles these:

#### 1. Scope in Token Exchange (SDK #941 Workaround)

The MCP TypeScript SDK has a bug where `scope` is missing from token exchange requests. Azure AD requires it. **We handle this ourselves:**

```typescript
// In token exchange (Phase 2, step 5)
const tokenParams = new URLSearchParams({
  grant_type: 'authorization_code',
  code: authCode,
  redirect_uri: callbackUrl,
  code_verifier: pkceState.codeVerifier,
  client_id: clientId,
  scope: requestedScopes.join(' '),  // ← REQUIRED for Azure AD
});
```

#### 2. Discovery URL Differences

Azure AD uses OpenID Connect discovery, not OAuth AS metadata:

| Provider | Discovery URL |
|----------|--------------|
| Standard OAuth | `{issuer}/.well-known/oauth-authorization-server` |
| Azure AD | `https://login.microsoftonline.com/{tenant}/.well-known/openid-configuration` |
| GitHub | `WWW-Authenticate` header with `resource_metadata` |

**Implementation:** Try both discovery URLs; parse whichever succeeds.

#### 3. Multi-Tenant Azure AD

For multi-tenant apps, the tenant in the URL can be:
- `common` - any Azure AD or Microsoft account
- `organizations` - any Azure AD account
- `consumers` - Microsoft accounts only
- `{tenant-id}` - specific tenant

**Configuration option:**
```typescript
oauth: {
  tenant: 'common',  // or specific tenant GUID
  scopes: ['https://graph.microsoft.com/.default'],
}
```

**Default behavior:** Use `common` if not specified, allowing any account.

#### 4. v1 vs v2 Endpoints

Azure AD has v1 and v2 endpoints with different behaviors:

| Aspect | v1 | v2 |
|--------|----|----|
| Parameter | `resource` | `scope` |
| Discovery | `/oauth2/.well-known/...` | `/v2.0/.well-known/...` |
| Token format | v1 claims | v2 claims |

**Implementation:** Detect from discovery response; support both, prefer v2.

## Implementation Plan

### Phase 1: OAuth Flow + Discovery (3 days)

**Victory Condition:** Complete OAuth flow via popup, obtain valid access token, store globally.

1. **Add MCP auth storage to `src/storage.ts`**
   - `getMcpAuth()` / `setMcpAuth()` for `~/.caco/mcp-auth.json`

2. **Create `src/mcp-discovery.ts`**
   - `discoverOAuthMetadata(serverUrl)` → try both `.well-known/oauth-authorization-server` and `.well-known/openid-configuration` (Azure AD)
   - `parseWWWAuthenticate(header)` → fallback for GitHub-style discovery
   - Simple in-memory cache

3. **Implement `/api/mcp/auth/start`**
   - Generate PKCE code verifier + challenge
   - Store state param temporarily (5-min TTL)
   - Return authorize URL for popup

4. **Implement `/api/mcp/auth/callback`**
   - Validate state parameter
   - Exchange code for tokens (include `scope` param for Azure AD per SDK #941)
   - Store tokens via `setMcpAuth()`
   - Return HTML that posts message to opener and closes

**Acceptance Test:** Mock OAuth server; complete flow via browser; token stored in `~/.caco/mcp-auth.json`.

### Phase 2: Agent Tool + SDK Integration (2 days)

**Victory Condition:** Agent can register servers via tool; sessions inject auth headers.

5. **Create `src/mcp-auth-tools.ts`**
   - `register_mcp_server` tool for agent to call on 401
   - Does OAuth discovery, stores server in `mcp-auth.json` with `needsAuth: true`
   - Returns instruction for agent to tell user to authenticate

6. **Modify `src/session-manager.ts:263`**
   - Before `createSession`, check if servers have tokens in `~/.caco/mcp-auth.json`
   - If token exists: add `Authorization: Bearer ${token}` to server headers
   - If token expired or `needsAuth`: skip that server (agent will handle 401)

**Acceptance Test:** Agent encounters 401, registers server, user authenticates, next session works.

### Phase 3: MCP Auth Applet (2 days)

**Victory Condition:** User can authenticate MCP servers via bundled applet.

7. **Create bundled applet `applets/mcp-auth/`**
   - `meta.json` with no required params
   - Fetch `/api/mcp/auth/servers` → lists servers from `mcp-auth.json`
   - Show "Needs Auth" for `needsAuth: true`, "Authenticated" otherwise

8. **Auth button + popup handler**
   - "Authenticate" button opens popup via `window.open('/api/mcp/auth/start?server=X')`
   - Listen for `postMessage` from callback
   - Refresh server list on success

9. **Error display**
   - Show error message if auth fails
   - "Re-authenticate" button

**Acceptance Test:** Full flow: agent hits 401 → registers server → user opens applet → authenticates → next tool call works.

**Total: 7 days**

## Security Considerations

- Tokens stored server-side only (not in browser)
- All OAuth flows use PKCE
- State parameter with 5-min TTL prevents CSRF
- Never log tokens

## Risks

- Popup blockers: Fall back to redirect flow
- SDK doesn't honor headers: Test in Phase 2 before Phase 3
- User closes browser mid-OAuth: 5-min TTL cleans up stale state

## Limitations (Known Blockers)

**This feature may not work for enterprise Azure AD MCP servers.**

Many internal/enterprise tools have OAuth configurations that will block Caco:

1. **Client allowlisting**: Azure AD app registrations can restrict which client_ids are allowed. If the server only accepts VS Code's client_id (`aebc6443-996d-45c2-90f0-388ff96faa56`), Caco cannot authenticate.

2. **Client certificates/secrets**: Some OAuth flows require client authentication (certificates, secrets) in addition to user authentication. Caco only supports public clients (PKCE, no secret).

3. **Redirect URI restrictions**: Azure AD apps must pre-register allowed redirect URIs. If only `vscode://...` or specific corporate URLs are registered, Caco's callback won't be accepted.

4. **Conditional Access policies**: Enterprise may require managed devices, specific locations, or MFA that blocks browser-based auth.

**What works:**
- MCP servers you control (can register Caco as allowed client)
- Public OAuth providers with open registration (GitHub public, generic OAuth)
- Servers that provide client_id via discovery

**What likely won't work:**
- Internal enterprise tools locked to VS Code/Visual Studio
- Servers requiring client certificates
- Highly restricted Azure AD tenants

This is a fundamental limitation of being a third-party client, not a bug in Caco.

## Testing

- Unit: OAuth discovery parsing, PKCE generation
- Integration: Mock OAuth server, full flow
- E2E: Browser popup with real OAuth provider

## Dependencies

- Express.js (existing)

## Design Decisions (from research)

### Token Storage Scope

**Decision:** Global tokens in `~/.caco/mcp-auth.json`, shared across all sessions.

**Rationale:**
- Authenticate once, all sessions use those tokens
- Per-session would require re-authenticating every new session - bad UX
- Single-user situated software doesn't need identity isolation between sessions
- Simple JSON file alongside existing `~/.caco/sessions/` and `~/.caco/applets/`

**Storage format:**
```json
{
  "servers": {
    "azure-graph": {
      "url": "https://graph.mcp.example.com/mcp",
      "authorizationEndpoint": "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      "tokenEndpoint": "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      "token": "eyJ...",
      "refreshToken": "0.AT...",
      "expiresAt": 1707500000000,
      "needsAuth": false
    },
    "github-copilot": {
      "url": "https://copilot.github.com/mcp",
      "authorizationEndpoint": "https://github.com/login/oauth/authorize",
      "tokenEndpoint": "https://github.com/login/oauth/access_token",
      "needsAuth": true
    }
  }
}
```

Servers with `needsAuth: true` appear in the applet as "Click to authenticate".

### UI Mechanism

**Decision:** Bundled applet at `applets/mcp-auth/` loaded via `/?applet=mcp-auth`.

**Rationale:**
- Applets run in same DOM context (not sandboxed iframe) - can open popups, receive postMessage
- Bundled applets are guaranteed available (shipped with Caco)
- Avoids synthetic chat events (historically buggy)
- Agent tells user to open applet when 401 encountered
- No upfront configuration needed

**Applet features:**
- List servers from `~/.caco/mcp-auth.json`
- "Authenticate" button for servers with `needsAuth: true`
- Shows token expiry, "Re-authenticate" button

### Auth Popup Flow

**Decision:** New window popup + server callback + postMessage.

**Flow:**
1. Applet calls `window.open('/api/mcp/auth/start?server=X&session=Y')` 
2. Server redirects to OAuth provider's authorize URL
3. User authenticates in popup
4. OAuth provider redirects to `/api/mcp/auth/callback?code=...&state=...`
5. Server exchanges code for tokens, stores in `~/.caco/mcp-auth.json`
6. Server returns HTML: `<script>window.opener.postMessage({type: 'mcp-auth-complete', server: 'X'}, '*'); window.close();</script>`
7. Applet receives message, updates UI

**Tunnel/external access:**
- Callback URL derived from `CACO_SERVER_URL` env var or `Origin` header
- If accessed via tunnel, user must register that redirect_uri with OAuth provider
- Popup stays in same browser context - postMessage works across origins for `window.opener`

**Why not iframe:**
- OAuth providers often set `X-Frame-Options: DENY` 
- Popups are the standard OAuth pattern

## MCP Auth Applet Specification

This section fully specifies the `mcp-auth` bundled applet.

### Location

`applets/mcp-auth/` - bundled with Caco, loaded via `/?applet=mcp-auth`

### Configuration File

**Path:** `~/.caco/mcp-auth.json`

**Purpose:** Stores all MCP servers that require interactive OAuth authentication. Servers are added by the agent's `register_mcp_server` tool when a 401 is encountered. Tokens are stored here after successful authentication.

**Schema:**
```json
{
  "servers": {
    "<serverId>": {
      "url": "string - MCP server URL",
      "authorizationEndpoint": "string - OAuth authorize URL",
      "tokenEndpoint": "string - OAuth token URL", 
      "scopes": ["string - optional scope list"],
      "clientId": "string|null - OAuth Application ID (required for auth)",
      "token": "string - access token (present if authenticated)",
      "refreshToken": "string - refresh token (optional)",
      "expiresAt": "number - Unix timestamp ms (optional)",
      "needsAuth": "boolean - true if auth required/expired",
      "needsClientId": "boolean - true if clientId missing and required"
    }
  }
}
```

**Example:**
```json
{
  "servers": {
    "azure-graph": {
      "url": "https://graph.mcp.example.com/mcp",
      "authorizationEndpoint": "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      "tokenEndpoint": "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      "scopes": ["User.Read", "Mail.Read"],
      "clientId": "abc123-def456-ghi789",
      "token": "eyJ0eXAiOiJKV1QiLCJhbGciOi...",
      "refreshToken": "0.ATcA...",
      "expiresAt": 1707500000000,
      "needsAuth": false,
      "needsClientId": false
    },
    "github-enterprise": {
      "url": "https://github.example.com/api/mcp",
      "authorizationEndpoint": "https://github.example.com/login/oauth/authorize",
      "tokenEndpoint": "https://github.example.com/login/oauth/access_token",
      "clientId": "gh-app-12345",
      "needsAuth": true,
      "needsClientId": false
    },
    "internal-tools": {
      "url": "https://tools.internal.corp/mcp",
      "authorizationEndpoint": "https://login.microsoftonline.com/tenant-id/oauth2/v2.0/authorize",
      "tokenEndpoint": "https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token",
      "clientId": null,
      "needsAuth": true,
      "needsClientId": true
    }
  }
}
```

### API for Applet

**GET `/api/mcp/auth/servers`**

Returns the full server list for display in the applet.

Response:
```json
{
  "servers": [
    {
      "id": "azure-graph",
      "url": "https://graph.mcp.example.com/mcp",
      "needsAuth": false,
      "needsClientId": false,
      "expiresAt": 1707500000000
    },
    {
      "id": "github-enterprise", 
      "url": "https://github.example.com/api/mcp",
      "needsAuth": true,
      "needsClientId": false,
      "expiresAt": null
    },
    {
      "id": "internal-tools",
      "url": "https://tools.internal.corp/mcp",
      "needsAuth": true,
      "needsClientId": true,
      "expiresAt": null
    }
  ]
}
```

Note: Tokens are NOT returned to the browser. Only auth status.

**GET `/api/mcp/auth/start?server=<serverId>`**

Initiates OAuth flow for the specified server. Opens in popup window.

1. Reads server config from `mcp-auth.json`
2. Generates PKCE code verifier + challenge
3. Stores state parameter with 5-min TTL
4. Redirects to `authorizationEndpoint` with:
   - `client_id` (from config or default)
   - `redirect_uri` (callback URL)
   - `response_type=code`
   - `scope` (from config)
   - `state` (CSRF token)
   - `code_challenge` + `code_challenge_method=S256`

**GET `/api/mcp/auth/callback`**

OAuth callback handler. Called by OAuth provider after user authenticates.

1. Validates `state` parameter
2. Exchanges `code` for tokens (includes `scope` for Azure AD - SDK #941)
3. Stores tokens in `mcp-auth.json`, sets `needsAuth: false`
4. Returns HTML that closes popup and notifies opener

**POST `/api/mcp/auth/config`**

Updates server configuration (e.g., to add client_id).

Request:
```json
{
  "serverId": "azure-graph",
  "clientId": "abc123-def456-..."
}
```

Response:
```json
{ "ok": true }
```

1. Reads server from `mcp-auth.json`
2. Updates `clientId` field
3. Sets `needsClientId: false`, `needsAuth: true`
4. Writes back to file

Error if server not found: `{ "ok": false, "error": "Server not found" }`

### Applet UI Specification

**Layout:** Single-column list of servers

```
┌─────────────────────────────────────────────────────┐
│  MCP Server Authentication                          │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ┌─────────────────────────────────────────────┐   │
│  │ azure-graph                           ✓ OK  │   │
│  │ https://graph.mcp.example.com/mcp           │   │
│  │ Expires: Feb 10, 2026 3:45 PM               │   │
│  │                          [Re-authenticate]  │   │
│  └─────────────────────────────────────────────┘   │
│                                                     │
│  ┌─────────────────────────────────────────────┐   │
│  │ github-enterprise              ⚠ Needs Auth │   │
│  │ https://github.example.com/api/mcp          │   │
│  │                             [Authenticate]  │   │
│  └─────────────────────────────────────────────┘   │
│                                                     │
│  ┌─────────────────────────────────────────────┐   │
│  │ internal-tools                   ⚠ Config  │   │
│  │ https://tools.internal.corp/mcp            │   │
│  │ Client ID: [________________________]      │   │
│  │            (from Azure App Registration)   │   │
│  │                                    [Save]  │   │
│  └─────────────────────────────────────────────┘   │
│                                                     │
│  No servers? They appear here when an MCP tool     │
│  returns 401 Unauthorized.                         │
│                                                     │
└─────────────────────────────────────────────────────┘
```

**Server States:**

| State | Badge | Button | Notes |
|-------|-------|--------|-------|
| Authenticated, not expired | `✓ OK` (green) | "Re-authenticate" | Shows expiry time |
| Authenticated, expired | `⚠ Expired` (yellow) | "Re-authenticate" | Token expired, needs refresh |
| Needs authentication | `⚠ Needs Auth` (yellow) | "Authenticate" | Has client_id, ready to auth |
| Needs client_id | `⚠ Config` (yellow) | "Save" | Shows text input for client_id |
| Error (discovery failed, etc.) | `✗ Error` (red) | "Retry" | Shows error message |

**Elements per server row:**
1. **Server ID** (bold) - from `servers` object key
2. **Status badge** - colored indicator (see table)
3. **URL** - smaller text, the MCP server URL
4. **Client ID input** - if `needsClientId: true`, show text input + "Save" button
5. **Expiry** - "Expires: [formatted date]" if token present, omit otherwise
6. **Error message** - if error state, show the error
7. **Action button** - right-aligned, appropriate to state

**Client ID input flow:**
1. Server registered without client_id → shows `⚠ Config` badge + text input
2. User enters client_id from their Azure App Registration
3. User clicks "Save" → POST to `/api/mcp/auth/config` (see below)
4. State changes to "Needs Auth" → user can now authenticate

**Empty state:** If `servers` object is empty, show:
> "No MCP servers registered. They appear here automatically when an MCP tool returns 401 Unauthorized."

### Applet Authentication Flow

When user clicks "Authenticate" or "Re-authenticate":

```javascript
// 1. Open popup to OAuth start endpoint
const popup = window.open(
  `/api/mcp/auth/start?server=${serverId}`,
  'mcp-auth',
  'width=500,height=700'
);

// 2. Listen for completion message
window.addEventListener('message', (event) => {
  if (event.data?.type === 'mcp-auth-complete') {
    // 3. Refresh server list
    fetchServerList();
    
    // 4. Show success toast
    showToast(`Authenticated ${event.data.server}`);
  }
  if (event.data?.type === 'mcp-auth-error') {
    // Show error in UI
    showError(event.data.server, event.data.error);
  }
});
```

**Callback HTML returned by server:**
```html
<!DOCTYPE html>
<html>
<body>
<script>
  window.opener.postMessage({
    type: 'mcp-auth-complete',
    server: 'azure-graph'
  }, '*');
  window.close();
</script>
</body>
</html>
```

On error:
```html
<!DOCTYPE html>
<html>
<body>
<script>
  window.opener.postMessage({
    type: 'mcp-auth-error',
    server: 'azure-graph',
    error: 'Token exchange failed: invalid_grant'
  }, '*');
  window.close();
</script>
</body>
</html>
```

### Applet Files

**`applets/mcp-auth/meta.json`:**
```json
{
  "slug": "mcp-auth",
  "name": "MCP Authentication",
  "description": "Authenticate MCP servers requiring OAuth",
  "params": {},
  "agentUsage": {
    "purpose": "User authenticates MCP servers here after agent encounters 401"
  }
}
```

**`applets/mcp-auth/content.html`:**
```html
<div id="server-list" class="server-list">
  <div class="loading">Loading servers...</div>
</div>
<div id="empty-state" class="empty-state" style="display:none">
  No MCP servers registered. They appear here automatically when an MCP tool returns 401 Unauthorized.
</div>
```

**`applets/mcp-auth/style.css`:**
```css
.server-list { display: flex; flex-direction: column; gap: 12px; }
.server-card { 
  padding: 12px; 
  border: 1px solid var(--border); 
  border-radius: 8px;
}
.server-header { display: flex; justify-content: space-between; align-items: center; }
.server-id { font-weight: 600; }
.server-url { font-size: 0.85em; color: var(--text-muted); margin-top: 4px; }
.server-expiry { font-size: 0.85em; color: var(--text-muted); }
.server-error { font-size: 0.85em; color: var(--error); margin-top: 4px; }
.badge-ok { color: var(--success); }
.badge-warn { color: var(--warning); }
.badge-error { color: var(--error); }
.auth-btn { margin-top: 8px; float: right; }
```

**`applets/mcp-auth/script.js`:**
```javascript
async function fetchServers() {
  const list = document.getElementById('server-list');
  const empty = document.getElementById('empty-state');
  
  try {
    const res = await fetch('/api/mcp/auth/servers');
    const data = await res.json();
    
    if (data.servers.length === 0) {
      list.style.display = 'none';
      empty.style.display = 'block';
      return;
    }
    
    list.innerHTML = data.servers.map(renderServer).join('');
    empty.style.display = 'none';
  } catch (err) {
    list.innerHTML = `<div class="error">Failed to load: ${err.message}</div>`;
  }
}

function renderServer(server) {
  const isOk = !server.needsAuth && (!server.expiresAt || server.expiresAt > Date.now());
  const isExpired = !server.needsAuth && server.expiresAt && server.expiresAt < Date.now();
  const needsAuth = server.needsAuth;
  
  let badge, btnText;
  if (isOk) {
    badge = '<span class="badge-ok">✓ OK</span>';
    btnText = 'Re-authenticate';
  } else if (isExpired) {
    badge = '<span class="badge-warn">⚠ Expired</span>';
    btnText = 'Re-authenticate';
  } else {
    badge = '<span class="badge-warn">⚠ Needs Auth</span>';
    btnText = 'Authenticate';
  }
  
  const expiry = server.expiresAt 
    ? `<div class="server-expiry">Expires: ${new Date(server.expiresAt).toLocaleString()}</div>`
    : '';
  
  return `
    <div class="server-card">
      <div class="server-header">
        <span class="server-id">${server.id}</span>
        ${badge}
      </div>
      <div class="server-url">${server.url}</div>
      ${expiry}
      <button class="auth-btn" onclick="authenticate('${server.id}')">${btnText}</button>
    </div>
  `;
}

function authenticate(serverId) {
  window.open(`/api/mcp/auth/start?server=${serverId}`, 'mcp-auth', 'width=500,height=700');
}

window.addEventListener('message', (event) => {
  if (event.data?.type === 'mcp-auth-complete') {
    fetchServers(); // Refresh list
  }
});

// Load on init
fetchServers();
```

## References

- [MCP OAuth Specification](https://spec.modelcontextprotocol.io/specification/2025-03-26/basic/authorization/)
- [modelcontextprotocol/typescript-sdk#941](https://github.com/modelcontextprotocol/typescript-sdk/issues/941) - Azure AD scope issue
- [RFC 7636 - PKCE](https://tools.ietf.org/html/rfc7636)
- [RFC 8414 - OAuth Server Metadata](https://tools.ietf.org/html/rfc8414)
- [simpleOAuthClient.ts example](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/simpleOAuthClient.ts)
