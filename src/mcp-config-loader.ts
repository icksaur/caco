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
 */
export async function loadMcpServers(): Promise<Record<string, unknown> | undefined> {
  try {
    const configPath = join(homedir(), '.copilot', 'mcp-config.json');
    if (!existsSync(configPath)) return undefined;
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
      await injectOAuthTokens(config.mcpServers);
      console.log(`[MCP] Loaded ${Object.keys(config.mcpServers).length} servers from mcp-config.json`);
      return config.mcpServers;
    }
  } catch (e) {
    console.error('[MCP] Failed to load mcp-config.json:', e);
  }
  return undefined;
}

/**
 * Inject OAuth tokens into remote MCP server configs.
 * Checks Caco's own auth store first (refreshing if expired), then CLI tokens as fallback.
 */
async function injectOAuthTokens(servers: Record<string, Record<string, unknown>>): Promise<void> {
  const cacoAuth = getMcpAuth();

  for (const [name, server] of Object.entries(servers)) {
    const url = server.url as string | undefined;
    if (!url || server.type === 'local') continue;

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
            continue;
          }
        }
      } else if (!expired) {
        const headers = (server.headers || {}) as Record<string, string>;
        headers['Authorization'] = `Bearer ${cacoServer.token}`;
        server.headers = headers;
        console.log(`[MCP] Injected Caco token for ${name}`);
        continue;
      }
    }

    // Fall back to CLI tokens
    const tokens = getCliOAuthTokens(url);
    if (!tokens) continue;

    if (tokens.expiresAt && tokens.expiresAt < Date.now() / 1000) {
      console.log(`[MCP] Token expired for ${name}, skipping injection`);
      continue;
    }

    const headers = (server.headers || {}) as Record<string, string>;
    headers['Authorization'] = `Bearer ${tokens.accessToken}`;
    server.headers = headers;
    console.log(`[MCP] Injected CLI token for ${name}`);
  }
}
