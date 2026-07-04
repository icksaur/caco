/**
 * Observed MCP tool-definition size cache (spec-deferred-savings S2).
 *
 * An MCP tool's definition size (`estimateToolTokens`) is knowable only when its
 * schema was OBSERVED — resolved into a turn and sent to the model — because the
 * CLI assigns the `input_schema` and it is not locally available. A deferred or
 * never-used MCP tool has no live schema, so to price it we must remember its size
 * from when it WAS enabled. This store persists that: last-observed per-turn token
 * size, keyed by the model-facing `ToolKey` (the SAME key the exclusion set and
 * key-registry use, so a deferred key looks up its size directly).
 *
 * MCP-only by design: Caco tool schemas come from the local `cacoCatalog` and SDK
 * builtins from `tools.list`, so those sizes are computed directly and never cached
 * here (caching them would duplicate a source of truth).
 *
 * Mirrors `tool-key-registry` / `tool-usage-store` mechanics: lazy load, best-effort
 * persist (log-not-throw — it feeds the /servers + getToolCatalog paths and must
 * never throw into a request), test resets. Entries are bounded by the MCP tool
 * universe (one per learned key), so no eviction policy is needed.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import type { ToolKey } from './tool-key.js';
import { estimateToolTokens } from './tool-size.js';

const STORE_FILE = join(homedir(), '.caco', 'tool-size.json');

/** Reject absurd estimates from a one-off/garbage schema (a real tool definition is
 *  far under this). A value over the cap is ignored rather than poisoning the figure. */
const MAX_TOOL_TOKENS = 100_000;

const sizes = new Map<ToolKey, number>();
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(readFileSync(STORE_FILE, 'utf-8')) as Record<string, number>;
    for (const [k, v] of Object.entries(raw)) {
      if (Number.isFinite(v) && v > 0 && v <= MAX_TOOL_TOKENS) sizes.set(k as ToolKey, v);
    }
  } catch {
    // No file yet or unreadable — start empty.
  }
}

function persist(): void {
  try {
    mkdirSync(dirname(STORE_FILE), { recursive: true });
    writeFileSync(STORE_FILE, JSON.stringify(Object.fromEntries(sizes)), 'utf-8');
  } catch (e) {
    // Best-effort; a lost write just makes a tool show "unknown" until re-observed.
    console.error('[TOOLS] tool-size-store persist failed:', e instanceof Error ? e.message : e);
  }
}

/** Record an MCP tool's observed per-turn token size, keyed by its model-facing
 *  ToolKey. Rejects non-finite / ≤0 / absurd values so a garbage schema can't poison
 *  the figure; last valid value wins. Persists on change. */
/** Validate + set one entry in memory. Returns true if the stored value changed
 *  (so the caller can persist once for a batch). Rejects non-finite / ≤0 / absurd. */
function setSize(key: ToolKey, tokens: number): boolean {
  if (!Number.isFinite(tokens) || tokens <= 0 || tokens > MAX_TOOL_TOKENS) return false;
  ensureLoaded();
  if (sizes.get(key) === tokens) return false;
  sizes.set(key, tokens);
  return true;
}

/** Record an MCP tool's observed per-turn token size, keyed by its model-facing
 *  ToolKey. Rejects non-finite / ≤0 / absurd values so a garbage schema can't poison
 *  the figure; last valid value wins. Persists on change. */
export function recordToolSize(key: ToolKey, tokens: number): void {
  if (setSize(key, tokens)) persist();
}

/** The last-observed size for a key, or undefined if never observed. Callers must
 *  treat undefined as "unknown" (never priced), not zero. */
export function getToolSize(key: ToolKey): number | undefined {
  ensureLoaded();
  return sizes.get(key);
}

/** The whole key→size map (read-only view). */
export function getToolSizes(): ReadonlyMap<ToolKey, number> {
  ensureLoaded();
  return sizes;
}

/** Learn observed MCP tool sizes from a `getCurrentToolMetadata()` snapshot — the
 *  capture seam, called beside `learnFromMetadata` wherever a metadata snapshot is
 *  consumed. Records ONLY MCP entries (carrying server+tool identity) that have an
 *  `input_schema`, keyed by the model-facing name (== the MCP ToolKey), so the size
 *  store shares the exclusion set's key space. Non-MCP or schema-less entries are
 *  skipped (Caco/builtin sizes come from the local catalog, not this store). Only
 *  ENABLED tools appear in the metadata, so a size is only ever learned from a real
 *  observation — never fabricated. Persists ONCE per snapshot (only if something
 *  changed), so the first observation of N tools is one write, not N. */
export function recordObservedSizes(
  entries: Array<{ name: string; mcpServerName?: string; mcpToolName?: string; input_schema?: Record<string, unknown>; description?: string }>,
): void {
  let changed = false;
  for (const m of entries) {
    if (!m.mcpServerName || !m.mcpToolName || !m.input_schema) continue;
    if (setSize(m.name as ToolKey, estimateToolTokens({ name: m.name, description: m.description, parameters: m.input_schema }))) changed = true;
  }
  if (changed) persist();
}

/** Test-only: clear in-memory state + force reload on next access. */
export function _resetToolSizeStoreForTest(): void {
  sizes.clear();
  loaded = false;
}
