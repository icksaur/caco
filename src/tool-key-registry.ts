/**
 * MCP tool-key registry (spec-tool-reveal Phase K; extended by
 * spec-enable-tools-config-freshness for identity correlation).
 *
 * `excludedTools` matches a tool's MODEL-FACING name. For builtins/Caco that name is
 * derivable (see tool-key.ts), but an MCP tool's model-facing name is assigned by the CLI
 * and is NOT reconstructable from its (server, rawTool) identity — usually
 * `<server>-<rawTool>` but not always (e.g. `web_search` is bare). So MCP keys must be
 * DISCOVERED from observation, never built.
 *
 * This registry is the single authority mapping raw MCP identity → the model-facing
 * ToolKey. It is learned continuously from the two runtime sources that carry the
 * authoritative name alongside the raw identity: `getCurrentToolMetadata()` and the
 * `tool.execution_start` event. Persisted system-wide under ~/.caco so learned keys
 * survive restarts (and so a DEFERRED tool — absent from getCurrentToolMetadata — keeps a
 * resolvable key).
 *
 * The registry's server name is the SDK METADATA server name (from
 * `getCurrentToolMetadata`). That is NOT necessarily the `mcp.discover` config key.
 * A separate correlation map (metadata name → config key) is learned when both
 * identities are simultaneously observable (spec C6), so freshness narrowing can
 * decide "removed vs down" against the authoritative `mcp.discover` inventory.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import type { ToolKey } from './tool-key.js';

const REGISTRY_FILE = join(homedir(), '.caco', 'tool-key-registry.json');
/** metadata-server-name → mcp.discover config-key (spec C6 correlation). */
const CORRELATION_FILE = join(homedir(), '.caco', 'tool-server-correlation.json');

// composite (server \u0000 rawTool) → model-facing ToolKey
const registry = new Map<string, ToolKey>();
// SDK metadata server name → mcp.discover config key (unique linkage only).
const correlation = new Map<string, string>();
let loaded = false;
// Durability: when a persist write fails, memory has changed but disk hasn't. Mark
// the store dirty so the NEXT persist attempt re-writes it (retry-until-durable),
// closing the memory-vs-disk divergence that would otherwise resurrect stale/purged
// state on restart. `persist*Ok` returns the true durability status (dirty ⇒ false).
let registryDirty = false;
let correlationDirty = false;

function composite(serverName: string, rawTool: string): string {
  return `${serverName}\u0000${rawTool}`;
}

/** The SDK metadata server name from a composite registry key. */
function serverOfComposite(compositeKey: string): string {
  const nul = compositeKey.indexOf('\u0000');
  return nul >= 0 ? compositeKey.slice(0, nul) : compositeKey;
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8')) as Record<string, string>;
    for (const [k, v] of Object.entries(raw)) registry.set(k, v as ToolKey);
  } catch {
    // No file yet or unreadable — start empty.
  }
  try {
    const raw = JSON.parse(readFileSync(CORRELATION_FILE, 'utf-8')) as Record<string, string>;
    for (const [k, v] of Object.entries(raw)) correlation.set(k, v);
  } catch {
    // No correlation file yet — start empty; it fills in as tools are observed.
  }
}

/** Write the current registry to disk. Clears/sets the dirty flag; returns whether
 *  the on-disk copy now matches memory. */
function persistOk(): boolean {
  try {
    mkdirSync(dirname(REGISTRY_FILE), { recursive: true });
    writeFileSync(REGISTRY_FILE, JSON.stringify(Object.fromEntries(registry)), 'utf-8');
    registryDirty = false;
    return true;
  } catch {
    registryDirty = true; // retry on the next persist so disk eventually matches memory.
    return false;
  }
}

function persistCorrelationOk(): boolean {
  try {
    mkdirSync(dirname(CORRELATION_FILE), { recursive: true });
    writeFileSync(CORRELATION_FILE, JSON.stringify(Object.fromEntries(correlation)), 'utf-8');
    correlationDirty = false;
    return true;
  } catch {
    correlationDirty = true;
    return false;
  }
}

/** Record the model-facing key for one MCP tool's raw identity. Persists on change. */
export function learnMcpKey(serverName: string, rawTool: string, modelFacingName: string): void {
  if (!serverName || !rawTool || !modelFacingName) return;
  ensureLoaded();
  const key = composite(serverName, rawTool);
  const val = modelFacingName as ToolKey;
  if (registry.get(key) === val) {
    if (registryDirty) persistOk(); // recover from a prior failed write
    return;
  }
  registry.set(key, val);
  persistOk();
}

/** The learned model-facing ToolKey for a raw MCP identity, or undefined if never
 *  observed. Callers must NOT fabricate a key on a miss. */
export function lookupMcpKey(serverName: string, rawTool: string): ToolKey | undefined {
  ensureLoaded();
  return registry.get(composite(serverName, rawTool));
}

/** Learn from a getCurrentToolMetadata snapshot (only MCP entries carry server+raw). */
export function learnFromMetadata(
  entries: Array<{ name: string; mcpServerName?: string; mcpToolName?: string }>,
): void {
  for (const m of entries) {
    if (m.mcpServerName && m.mcpToolName) learnMcpKey(m.mcpServerName, m.mcpToolName, m.name);
  }
}

/** All learned model-facing keys for one MCP server (used by manual/auto defer to
 *  resolve "defer this whole server" into its currently-known exclusion keys). */
export function keysForServer(serverName: string): ToolKey[] {
  ensureLoaded();
  const prefix = `${serverName}\u0000`;
  const out: ToolKey[] = [];
  for (const [composite, key] of registry) {
    if (composite.startsWith(prefix)) out.push(key);
  }
  return out;
}

/** All learned model-facing keys across every MCP server (the auto-defer candidate
 *  universe for MCP: only tools whose exclusion key has been discovered can be
 *  deferred). Deduped. */
export function allLearnedKeys(): ToolKey[] {
  ensureLoaded();
  return [...new Set(registry.values())];
}

/**
 * Reverse lookup: the SDK metadata server name(s) whose learned keys equal this
 * model-facing key. A key can be supplied by more than one server (rare, but a name
 * like `web_search` could collide). Empty when the key was never learned.
 * (spec C6: the raw supplier identities, still in the METADATA namespace — correlate
 * to config keys via `configKeyForServer`.)
 */
export function serversForKey(modelFacingKey: ToolKey): string[] {
  ensureLoaded();
  const out = new Set<string>();
  for (const [compositeKey, val] of registry) {
    if (val === modelFacingKey) out.add(serverOfComposite(compositeKey));
  }
  return [...out];
}

/**
 * Record the correlation between an SDK metadata server name and its `mcp.discover`
 * config key, observed while BOTH identities are simultaneously live (spec C6).
 *
 * A live observation is authoritative and CURRENT, so it REPLACES any prior mapping
 * (a server legitimately reconfigured to a new config key must not stay frozen on a
 * stale key — that would let freshness narrow a live tool against a removed config
 * key, an over-hide). Idempotent on a repeat. The "never guess" rule (C6) is enforced
 * by the CALLER, which must only call this with a provably-unique metadata↔config
 * linkage from a single observation; this function trusts that and always records the
 * latest proven mapping. Persists on change.
 */
export function learnServerCorrelation(metadataName: string, configKey: string): void {
  if (!metadataName || !configKey) return;
  ensureLoaded();
  // Idempotent — but if a PRIOR write failed (dirty), still flush so disk converges.
  if (correlation.get(metadataName) === configKey) {
    if (correlationDirty) persistCorrelationOk();
    return;
  }
  correlation.set(metadataName, configKey);                // latest proven mapping wins
  persistCorrelationOk();
}

/** The `mcp.discover` config key correlated to an SDK metadata server name, or
 *  undefined when the correlation was never established (the uncorrelated case). */
export function configKeyForServer(metadataName: string): string | undefined {
  ensureLoaded();
  return correlation.get(metadataName);
}

/**
 * Purge all learned keys (and their correlation) for a set of SDK metadata server
 * names — the operator "forget unknown tools" path (spec C6 legacy repair). Only way
 * to converge a stranded server whose identity can no longer be correlated via
 * `mcp.discover`. Returns `{ removed, persisted }`: `removed` is the count of registry
 * entries dropped, `persisted` is false if EITHER persist write failed (the caller
 * must surface that — an unpersisted purge lets the phantoms return on restart).
 */
export function purgeServers(metadataNames: Iterable<string>): { removed: number; persisted: boolean } {
  ensureLoaded();
  const targets = new Set(metadataNames);
  let removed = 0;
  let touchedCorrelation = false;
  for (const compositeKey of [...registry.keys()]) {
    if (targets.has(serverOfComposite(compositeKey))) {
      registry.delete(compositeKey);
      removed++;
    }
  }
  for (const name of targets) {
    if (correlation.delete(name)) touchedCorrelation = true;
  }
  // Always flush a store whose memory changed here OR was left dirty by a prior
  // failed write — so a purge retry after a transient failure actually re-writes
  // the on-disk file (no silent "persisted:true" over a stale disk copy).
  const okRegistry = (removed > 0 || registryDirty) ? persistOk() : true;
  const okCorrelation = (touchedCorrelation || correlationDirty) ? persistCorrelationOk() : true;
  return { removed, persisted: okRegistry && okCorrelation };
}

/** All SDK metadata server names known to the registry OR the correlation map
 *  (deduped). Includes correlation-only orphans so stale mappings stay purgeable. */
export function knownServers(): string[] {
  ensureLoaded();
  const out = new Set<string>();
  for (const compositeKey of registry.keys()) out.add(serverOfComposite(compositeKey));
  for (const name of correlation.keys()) out.add(name);
  return [...out];
}

/** Test-only: clear in-memory state + force reload on next access. */
export function _resetRegistryForTest(): void {
  registry.clear();
  correlation.clear();
  loaded = false;
  registryDirty = false;
  correlationDirty = false;
}
