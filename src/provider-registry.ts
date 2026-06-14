/**
 * Provider Registry — BYOK (bring-your-own-key) multi-provider support.
 *
 * Caco-owned config at ~/.caco/providers.json (NOT a Copilot CLI file — the
 * SDK never reads it). We parse it, surface BYOK models alongside GitHub
 * models, and construct the SDK `ProviderConfig` passed to createSession /
 * resumeSession.
 *
 * Design invariant: every failure mode here must collapse to "GitHub-only,
 * as today". A user with no config file sees byte-for-byte unchanged behavior;
 * the only new code that runs for them is hasProviders() returning false.
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { ProviderConfig } from '@github/copilot-sdk';
import type { SDKModelInfo } from './session-manager.js';

const CONFIG_PATH = join(homedir(), '.caco', 'providers.json');

const DEFAULT_AGENT_MODEL = 'claude-sonnet-4.6';

interface ProviderModelEntry {
  id: string;
  name?: string;
  agentModel?: string;
  contextWindow?: number;
  inputPerMtok?: number;
  outputPerMtok?: number;
  cachePerMtok?: number;
}

interface ProviderProfile {
  type?: 'openai' | 'azure' | 'anthropic';
  baseUrl: string;
  apiKeyEnv?: string;
  bearerTokenEnv?: string;
  headersEnv?: Record<string, string>;
  azure?: { apiVersion?: string };
  models?: ProviderModelEntry[];
}

interface ProvidersFile {
  providers?: Record<string, ProviderProfile>;
}

export interface ResolvedModel {
  /** The namespaced Caco id (persisted in meta, shown in UI). */
  cacoId: string;
  /** Model id passed as SDKConfig.model — a Copilot-known model for agent config. */
  sdkModel: string;
  /** Provider key, undefined for GitHub models. */
  providerId?: string;
  /** SDK provider config (credentials resolved), undefined for GitHub models. */
  provider?: ProviderConfig;
}

let cache: Record<string, ProviderProfile> | null = null;

/**
 * Load and validate ~/.caco/providers.json. Cached after first read.
 * Any parse/validation failure logs and yields an empty registry (GitHub-only).
 * Providers whose key contains ':' are rejected (breaks namespace split).
 */
function load(): Record<string, ProviderProfile> {
  if (cache) return cache;
  cache = {};
  try {
    if (!existsSync(CONFIG_PATH)) return cache;
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as ProvidersFile;
    const providers = parsed.providers;
    if (!providers || typeof providers !== 'object') return cache;

    for (const [id, profile] of Object.entries(providers)) {
      if (id.includes(':')) {
        console.warn(`[BYOK] Provider id '${id}' contains ':' — skipped (breaks model-id namespacing)`);
        continue;
      }
      if (!profile || typeof profile.baseUrl !== 'string' || !profile.baseUrl) {
        console.warn(`[BYOK] Provider '${id}' missing baseUrl — skipped`);
        continue;
      }
      cache[id] = profile;
    }
    const count = Object.keys(cache).length;
    if (count > 0) console.log(`[BYOK] Loaded ${count} provider(s) from providers.json`);
  } catch (e) {
    console.error('[BYOK] Failed to load providers.json — continuing GitHub-only:', e);
    cache = {};
  }
  return cache;
}

/** True when at least one valid BYOK provider is configured. Gates onListModels attachment. */
export function hasProviders(): boolean {
  return Object.keys(load()).length > 0;
}

/** Force a re-read on next access (e.g., after the user edits the config). */
export function reloadProviders(): void {
  cache = null;
}

function perMtokToTokenPrices(entry: ProviderModelEntry): SDKModelInfo['billing'] {
  const hasCost = entry.inputPerMtok !== undefined || entry.outputPerMtok !== undefined || entry.cachePerMtok !== undefined;
  if (!hasCost) return undefined;
  return {
    multiplier: 1,
    tokenPrices: {
      inputPrice: entry.inputPerMtok,
      outputPrice: entry.outputPerMtok,
      cachePrice: entry.cachePerMtok,
      batchSize: 1_000_000,
      contextMax: entry.contextWindow,
    },
  };
}

/**
 * BYOK models as SDKModelInfo so they flow through modelCostSummary and the
 * model picker identically to GitHub models. Listing never resolves env keys
 * (a model with a missing key still lists; it fails only at session-create).
 */
export function listByokModels(): SDKModelInfo[] {
  const out: SDKModelInfo[] = [];
  for (const [providerId, profile] of Object.entries(load())) {
    for (const entry of profile.models ?? []) {
      if (!entry || typeof entry.id !== 'string' || !entry.id) {
        console.warn(`[BYOK] Provider '${providerId}' has a model entry without an id — skipped`);
        continue;
      }
      out.push({
        id: `${providerId}:${entry.id}`,
        name: entry.name ?? entry.id,
        capabilities: {
          supports: { vision: false, reasoningEffort: false },
          limits: { max_context_window_tokens: entry.contextWindow ?? 0 },
        },
        billing: perMtokToTokenPrices(entry),
      });
    }
  }
  return out;
}

function resolveEnv(name: string | undefined, providerId: string, what: string): string | undefined {
  if (!name) return undefined;
  const value = process.env[name];
  if (!value) {
    throw new Error(`${what} env var '${name}' is not set (provider '${providerId}')`);
  }
  return value;
}

/**
 * Resolve a Caco model id to its SDK model + (for BYOK) provider config.
 *
 * - No ':' → GitHub model: { cacoId, sdkModel: cacoId }, no provider.
 * - 'providerId:wireModel' where providerId is configured → BYOK: builds the
 *   ProviderConfig with credentials resolved from env (throws if a named env
 *   var is missing).
 * - ':' present but providerId not configured → treated as a GitHub model
 *   (bare passthrough); the SDK rejects it if truly invalid.
 *
 * Credential resolution happens here, so create/resume fail fast with a clear
 * message; listing (listByokModels) never calls this.
 */
export function resolveModel(cacoId: string): ResolvedModel {
  const idx = cacoId.indexOf(':');
  if (idx === -1) return { cacoId, sdkModel: cacoId };

  const providerId = cacoId.slice(0, idx);
  const profile = load()[providerId];
  if (!profile) return { cacoId, sdkModel: cacoId };

  const wireModel = cacoId.slice(idx + 1);
  const entry = (profile.models ?? []).find(m => m.id === wireModel);
  const sdkModel = entry?.agentModel ?? DEFAULT_AGENT_MODEL;

  const apiKey = resolveEnv(profile.apiKeyEnv, providerId, 'API key');
  const bearerToken = resolveEnv(profile.bearerTokenEnv, providerId, 'Bearer token');

  let headers: Record<string, string> | undefined;
  if (profile.headersEnv) {
    headers = {};
    for (const [header, envName] of Object.entries(profile.headersEnv)) {
      const value = resolveEnv(envName, providerId, `Header '${header}'`);
      if (value) headers[header] = value;
    }
  }

  const provider: ProviderConfig = {
    type: profile.type ?? 'openai',
    baseUrl: profile.baseUrl,
    modelId: sdkModel,
    wireModel,
    ...(apiKey && { apiKey }),
    ...(bearerToken && { bearerToken }),
    ...(headers && Object.keys(headers).length > 0 && { headers }),
    ...(profile.azure && { azure: profile.azure }),
  };

  return { cacoId, sdkModel, providerId, provider };
}
