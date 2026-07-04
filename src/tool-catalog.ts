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
import { builtinKey, cacoKey } from './tool-key.js';

export interface CatalogTool {
  key: ToolKey;
  /** Model-facing name (builtin: prefix stripped). */
  name: string;
  description: string;
  origin: 'caco' | 'builtin' | 'mcp';
  /** MCP server name (origin==='mcp' only) — for grouping, since the key (a model-facing
   *  name) is no longer parseable into server+tool. */
  server?: string;
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
  /** MCP tools carry a PRE-RESOLVED model-facing `key` (from the tool-key-registry, via
   *  the caller). A tool whose key has not yet been learned is omitted by the caller
   *  rather than given a fabricated key — the catalog never reconstructs an MCP key. */
  mcp: Array<{ serverName: string; tools: Array<{ key: ToolKey; name: string; description: string }> }>;
}

export function buildToolCatalog(sources: CatalogSources): ToolCatalog {
  const map = new Map<ToolKey, CatalogTool>();
  const add = (t: CatalogTool): void => {
    if (!map.has(t.key)) map.set(t.key, t);
  };
  for (const c of sources.caco) {
    add({ key: cacoKey(c.name), name: c.name, description: c.description, origin: 'caco', hardDisabled: c.hardDisabled, parameters: c.parameters });
  }
  for (const b of sources.builtins) {
    const name = b.name.startsWith('builtin:') ? b.name.slice('builtin:'.length) : b.name;
    add({ key: builtinKey(b.name), name, description: b.description, origin: 'builtin', hardDisabled: false, parameters: b.parameters, instructions: b.instructions });
  }
  for (const s of sources.mcp) {
    for (const t of s.tools) {
      add({ key: t.key, name: t.name, description: t.description, origin: 'mcp', server: s.serverName, hardDisabled: false });
    }
  }
  return map;
}
