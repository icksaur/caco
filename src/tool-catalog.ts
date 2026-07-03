/**
 * The single "what tools exist" view. Replaces the ad-hoc stitch of
 * `cacoToolCatalog` + `listBuiltinTools()` + `listMcpTools(server)` that used to
 * live only inside `buildMcpServerPayload`. The applet payload, the `caco_docs`
 * catalog, and `validateEnable` all consume this one catalog (spec-tool-reveal:
 * "one catalog assembly" invariant) rather than re-assembling sources.
 *
 * Pure: takes already-fetched sources and returns a Map keyed by ToolKey.
 * Dedupe is inherent (keyed) — the same tool arriving via both tools.list and the
 * exclusion list collapses to one entry (first wins, so a schema-bearing entry is
 * preferred over a bare one when listed first).
 */

import type { ToolKey } from './tool-key.js';
import { toolKey } from './tool-key.js';

export interface CatalogTool {
  key: ToolKey;
  /** Model-facing name (builtin: prefix stripped). */
  name: string;
  description: string;
  origin: 'caco' | 'builtin' | 'mcp';
  /** DEFAULT_DISABLED_TOOLS (filtered pre-registration) → not live-revealable. */
  hardDisabled: boolean;
  parameters?: Record<string, unknown>;
  /** Builtin tools may carry per-tool instructions (part of their wire definition,
   *  so they count toward the token estimate). */
  instructions?: string;
}

export type ToolCatalog = ReadonlyMap<ToolKey, CatalogTool>;

export interface CatalogSources {
  caco: Array<{ name: string; description: string; hardDisabled: boolean; parameters?: Record<string, unknown> }>;
  builtins: Array<{ name: string; description: string; parameters?: Record<string, unknown>; instructions?: string }>;
  mcp: Array<{ serverName: string; tools: Array<{ name: string; description: string }> }>;
}

export function buildToolCatalog(sources: CatalogSources): ToolCatalog {
  const map = new Map<ToolKey, CatalogTool>();
  const add = (t: CatalogTool): void => {
    if (!map.has(t.key)) map.set(t.key, t);
  };
  for (const c of sources.caco) {
    const key = toolKey({ origin: 'caco', name: c.name });
    add({ key, name: c.name, description: c.description, origin: 'caco', hardDisabled: c.hardDisabled, parameters: c.parameters });
  }
  for (const b of sources.builtins) {
    const key = toolKey({ origin: 'builtin', name: b.name });
    const name = b.name.startsWith('builtin:') ? b.name.slice('builtin:'.length) : b.name;
    add({ key, name, description: b.description, origin: 'builtin', hardDisabled: false, parameters: b.parameters, instructions: b.instructions });
  }
  for (const s of sources.mcp) {
    for (const t of s.tools) {
      const key = toolKey({ origin: 'mcp', serverName: s.serverName, toolName: t.name });
      add({ key, name: t.name, description: t.description, origin: 'mcp', hardDisabled: false });
    }
  }
  return map;
}
