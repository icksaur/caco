/**
 * CLI OAuth Config Reader
 * 
 * Reads OAuth configuration and tokens stored by the Copilot CLI
 * at ~/.copilot/mcp-oauth-config/
 * 
 * File format:
 *   <sha256(serverUrl)>.json       - OAuth config (serverUrl, authorizationServerUrl, clientId, redirectUri)
 *   <sha256(serverUrl)>.tokens.json - Access token (accessToken, expiresAt, scope)
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';

const OAUTH_DIR = join(homedir(), '.copilot', 'mcp-oauth-config');

export interface CLIOAuthConfig {
  serverUrl: string;
  authorizationServerUrl: string;
  clientId: string;
  redirectUri: string;
}

export interface CLIOAuthTokens {
  accessToken: string;
  expiresAt?: number;
  scope?: string;
}

/**
 * Get the hash used for CLI OAuth config filenames
 */
export function urlHash(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

/**
 * Read CLI OAuth config for a server URL
 */
export function getCliOAuthConfig(serverUrl: string): CLIOAuthConfig | null {
  const configPath = join(OAUTH_DIR, `${urlHash(serverUrl)}.json`);
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8')) as CLIOAuthConfig;
  } catch {
    return null;
  }
}

/**
 * Read CLI OAuth tokens for a server URL
 */
export function getCliOAuthTokens(serverUrl: string): CLIOAuthTokens | null {
  const tokenPath = join(OAUTH_DIR, `${urlHash(serverUrl)}.tokens.json`);
  if (!existsSync(tokenPath)) return null;
  try {
    const data = JSON.parse(readFileSync(tokenPath, 'utf-8')) as CLIOAuthTokens;
    if (!data.accessToken) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * List all CLI OAuth configs (serverUrl + clientId + hasTokens)
 */
export function listCliOAuthConfigs(): Array<{ serverUrl: string; clientId: string; hasTokens: boolean; tokenExpired: boolean }> {
  if (!existsSync(OAUTH_DIR)) return [];
  const results: Array<{ serverUrl: string; clientId: string; hasTokens: boolean; tokenExpired: boolean }> = [];

  for (const file of readdirSync(OAUTH_DIR)) {
    if (!file.endsWith('.json') || file.endsWith('.tokens.json')) continue;
    try {
      const config = JSON.parse(readFileSync(join(OAUTH_DIR, file), 'utf-8')) as CLIOAuthConfig;
      const hash = file.replace('.json', '');
      const tokenPath = join(OAUTH_DIR, `${hash}.tokens.json`);
      let hasTokens = false;
      let tokenExpired = false;
      if (existsSync(tokenPath)) {
        hasTokens = true;
        try {
          const tokens = JSON.parse(readFileSync(tokenPath, 'utf-8')) as CLIOAuthTokens;
          if (tokens.expiresAt && tokens.expiresAt < Date.now() / 1000) {
            tokenExpired = true;
          }
        } catch { /* ignore */ }
      }
      results.push({ serverUrl: config.serverUrl, clientId: config.clientId, hasTokens, tokenExpired });
    } catch { /* ignore */ }
  }
  return results;
}
