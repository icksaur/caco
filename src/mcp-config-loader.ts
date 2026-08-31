/**
 * MCP Config Loader
 *
 * Reads ~/.copilot/mcp-config.json and injects OAuth tokens (from Caco's
 * own auth store, or as fallback from the Copilot CLI's mcp-oauth-config)
 * into remote server entries so the SDK can use them.
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getCliOAuthTokens } from './cli-oauth.js';
import { getMcpAuth } from './storage.js';
import { refreshAccessToken } from './mcp-auth-service.js';
import { serverIdFromUrl } from './mcp-discovery.js';

/**
 * Load MCP server config from ~/.copilot/mcp-config.json.
 * Injects OAuth tokens for remote servers. Returns undefined if no
 * config file exists or contains no servers.
 *
 * Best-effort: a parse/read error is swallowed and returns undefined (a fresh
 * session with a broken config legitimately gets no servers). The RELOAD path
 * must NOT use this — it cannot tell a parse failure from an absent config, and
 * would recreate a warm session with zero servers on a malformed edit. Use
 * `loadMcpServersStrict` there.
 */
export async function loadMcpServers(): Promise<Record<string, unknown> | undefined> {
  const strict = await loadMcpServersStrict();
  if (!strict.ok) {
    console.error('[MCP] Failed to load mcp-config.json:', strict.error);
    return undefined;
  }
  return strict.servers;
}

/**
 * Strict variant for the transactional config reload (spec-enable-tools-config-
 * freshness D1): distinguishes a PARSE/READ FAILURE (`{ ok:false }`) from an
 * absent-or-empty config (`{ ok:true, servers:undefined }`). The reload path gates
 * on `ok` so a malformed/partially-written file fails the whole reload as a no-op,
 * retaining every warm session's prior config, rather than recreating with zero
 * servers.
 */
export async function loadMcpServersStrict():
  Promise<{ ok: true; servers: Record<string, unknown> | undefined } | { ok: false; error: string }> {
  const configPath = join(homedir(), '.copilot', 'mcp-config.json');
  let raw: string;
  try {
    if (!existsSync(configPath)) return { ok: true, servers: undefined };
    raw = readFileSync(configPath, 'utf-8');
  } catch (e) {
    return { ok: false, error: `mcp-config.json unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
  let config: { mcpServers?: Record<string, Record<string, unknown>> };
  try {
    config = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `mcp-config.json is malformed: ${e instanceof Error ? e.message : String(e)}` };
  }
  // Valid JSON that isn't an object (e.g. `null`, a number, an array) has no mcpServers —
  // treat as absent (ok, no servers), matching loadMcpServers's prior best-effort behaviour
  // rather than throwing on a property access.
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { ok: true, servers: undefined };
  }
  if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
    // Token injection is isolated PER server (a malformed entry skips only its own token,
    // never throws out), so a single bad server URL can't fail the whole load or reload.
    await injectOAuthTokens(config.mcpServers);
    console.log(`[MCP] Loaded ${Object.keys(config.mcpServers).length} servers from mcp-config.json`);
    return { ok: true, servers: config.mcpServers };
  }
  return { ok: true, servers: undefined };
}

/**
 * Inject OAuth tokens into remote MCP server configs.
 * Checks Caco's own auth store first (refreshing if expired), then CLI tokens as fallback.
 */
async function injectOAuthTokens(servers: Record<string, Record<string, unknown>>): Promise<void> {
  const cacoAuth = getMcpAuth();

  for (const [name, server] of Object.entries(servers)) {
    try {
      await injectOneServerToken(name, server, cacoAuth);
    } catch (e) {
      // A single malformed entry (e.g. an unparseable URL) must not abort injection for
      // the OTHER servers, nor throw out of the loader. The entry passes through
      // untokenized — its pre-existing behaviour for a server without stored auth.
      console.error(`[MCP] token injection skipped for "${name}":`, e instanceof Error ? e.message : e);
    }
  }
}

async function injectOneServerToken(
  name: string,
  server: Record<string, unknown>,
  cacoAuth: ReturnType<typeof getMcpAuth>,
): Promise<void> {
  {
    const url = server.url as string | undefined;
    if (!url || server.type === 'local') return;

    const serverId = serverIdFromUrl(url);
    const cacoServer = cacoAuth.servers[serverId];
    if (cacoServer?.token) {
      const expired = cacoServer.expiresAt && cacoServer.expiresAt <= Date.now();
      if (expired && cacoServer.refreshToken) {
        const refreshed = await refreshAccessToken(serverId);
        if (refreshed) {
          const updated = getMcpAuth().servers[serverId];
          if (updated?.token) {
            const headers = (server.headers || {}) as Record<string, string>;
            headers['Authorization'] = `Bearer ${updated.token}`;
            server.headers = headers;
            console.log(`[MCP] Injected refreshed Caco token for ${name}`);
            return;
          }
        }
      } else if (!expired) {
        const headers = (server.headers || {}) as Record<string, string>;
        headers['Authorization'] = `Bearer ${cacoServer.token}`;
        server.headers = headers;
        console.log(`[MCP] Injected Caco token for ${name}`);
        return;
      }
    }

    // Fall back to CLI tokens
    const tokens = getCliOAuthTokens(url);
    if (!tokens) return;

    if (tokens.expiresAt && tokens.expiresAt < Date.now() / 1000) {
      console.log(`[MCP] Token expired for ${name}, skipping injection`);
      return;
    }

    const headers = (server.headers || {}) as Record<string, string>;
    headers['Authorization'] = `Bearer ${tokens.accessToken}`;
    server.headers = headers;
    console.log(`[MCP] Injected CLI token for ${name}`);
  }
}
