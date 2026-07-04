/**
 * MCP tool-key registry (spec-tool-reveal Phase K).
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
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import type { ToolKey } from './tool-key.js';

const REGISTRY_FILE = join(homedir(), '.caco', 'tool-key-registry.json');

// composite (server \u0000 rawTool) → model-facing ToolKey
const registry = new Map<string, ToolKey>();
let loaded = false;

function composite(serverName: string, rawTool: string): string {
  return `${serverName}\u0000${rawTool}`;
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
}

function persist(): void {
  try {
    mkdirSync(dirname(REGISTRY_FILE), { recursive: true });
    writeFileSync(REGISTRY_FILE, JSON.stringify(Object.fromEntries(registry)), 'utf-8');
  } catch {
    // Best-effort; a failed write just means we re-learn next session.
  }
}

/** Record the model-facing key for one MCP tool's raw identity. Persists on change. */
export function learnMcpKey(serverName: string, rawTool: string, modelFacingName: string): void {
  if (!serverName || !rawTool || !modelFacingName) return;
  ensureLoaded();
  const key = composite(serverName, rawTool);
  const val = modelFacingName as ToolKey;
  if (registry.get(key) === val) return;
  registry.set(key, val);
  persist();
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

/** Test-only: clear in-memory state + force reload on next access. */
export function _resetRegistryForTest(): void {
  registry.clear();
  loaded = false;
}
