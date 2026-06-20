/**
 * MCP server OAuth state store.
 *
 * Stored at ~/.caco/mcp-auth.json — global across all sessions.
 * Users authenticate to an MCP server once and reuse the token everywhere.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { STORAGE_ROOT, ensureDir } from './storage-paths.js';

export interface MCPAuthState {
  url: string;                      // MCP server URL
  authorizationEndpoint: string;    // OAuth authorize URL
  tokenEndpoint: string;            // OAuth token URL
  scopes?: string[];                // OAuth scopes
  clientId?: string | null;         // OAuth Application ID (required for auth)
  redirectUris?: string[];          // Allowed redirect URIs (from registration)
  token?: string;                   // Access token (if authenticated)
  refreshToken?: string;            // Refresh token (optional)
  expiresAt?: number;               // Unix timestamp ms
  needsAuth: boolean;               // True if auth required/expired
  needsClientId: boolean;           // True if clientId missing
  error?: string;                   // Last error message
}

export interface MCPAuthStore {
  servers: Record<string, MCPAuthState>;
}

const MCP_AUTH_FILE = join(STORAGE_ROOT, 'mcp-auth.json');

export function getMcpAuth(): MCPAuthStore {
  if (!existsSync(MCP_AUTH_FILE)) {
    return { servers: {} };
  }
  try {
    return JSON.parse(readFileSync(MCP_AUTH_FILE, 'utf-8')) as MCPAuthStore;
  } catch (error) {
    console.error('Failed to read mcp-auth.json:', error);
    return { servers: {} };
  }
}

export function setMcpAuth(store: MCPAuthStore): void {
  ensureDir(STORAGE_ROOT);
  writeFileSync(MCP_AUTH_FILE, JSON.stringify(store, null, 2), 'utf-8');
}

export function getMcpServerAuth(serverId: string): MCPAuthState | undefined {
  return getMcpAuth().servers[serverId];
}

export function setMcpServerAuth(serverId: string, state: MCPAuthState): void {
  const store = getMcpAuth();
  store.servers[serverId] = state;
  setMcpAuth(store);
}

/**
 * Atomic read-modify-write for a single server's auth state.
 *
 * The store is re-read immediately before `fn` runs and written immediately
 * after, with no `await` in between, so the merge base passed to `fn` is always
 * the freshest persisted value. Callers that do async work (token refresh, code
 * exchange, OAuth discovery) MUST keep that work OUTSIDE this call and merge the
 * result onto `prev` here — never onto a snapshot captured before the await.
 * Node's single-threaded model makes this synchronous section atomic with
 * respect to other in-process callers, which is what closes the lost-update
 * window between a refresh's read and its write.
 */
export function updateMcpServerAuth(
  serverId: string,
  fn: (prev: MCPAuthState | undefined) => MCPAuthState,
): MCPAuthState {
  const store = getMcpAuth();
  const next = fn(store.servers[serverId]);
  store.servers[serverId] = next;
  setMcpAuth(store);
  return next;
}

export function removeMcpServerAuth(serverId: string): void {
  const store = getMcpAuth();
  delete store.servers[serverId];
  setMcpAuth(store);
}
