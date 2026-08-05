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
  /** Whether `key` is the tool's REAL exclusion string (learned/derivable). False only
   *  for an MCP tool whose model-facing key hasn't been observed yet: it is shown (so the
   *  operator/agent sees it exists) but cannot be deferred/enabled until first observed —
   *  `key` is then a display-only `server/tool` id, never sent to excludedTools. */
  excludable: boolean;
  /** DEFAULT_DISABLED_TOOLS (filtered pre-registration) → not live-revealable. */
  hardDisabled: boolean;
  /** Caco tools only: the defer-eligibility verdict, decided by the projector that
   *  holds the full catalog entry (`isDeferEligibleCacoEntry`) rather than re-derived
   *  from name + hardDisabled here, which cannot see builtin-vs-extension. Absent for
   *  builtin/MCP tools, which have their own eligibility rules. */
  deferEligible?: boolean;
  parameters?: Record<string, unknown>;
  /** Builtin tools may carry per-tool instructions (part of their wire definition,
   *  so they count toward the token estimate). */
  instructions?: string;
}

export type ToolCatalog = ReadonlyMap<ToolKey, CatalogTool>;

export interface CatalogSources {
  caco: Array<{ name: string; description: string; hardDisabled: boolean; parameters?: Record<string, unknown>; deferEligible?: boolean }>;
  builtins: Array<{ name: string; description: string; parameters?: Record<string, unknown>; instructions?: string }>;
  /** MCP tools carry a `key` and `excludable`. When the model-facing key has been learned
   *  (from the tool-key-registry) `key` is that real exclusion string and `excludable` is
   *  true; otherwise `key` is a display-only `server/tool` id and `excludable` is false
   *  (shown, but not deferrable until observed). The catalog never fabricates an
   *  *exclusion* key. */
  mcp: Array<{ serverName: string; tools: Array<{ key: ToolKey; name: string; description: string; excludable: boolean }> }>;
}

export function buildToolCatalog(sources: CatalogSources): ToolCatalog {
  const map = new Map<ToolKey, CatalogTool>();
  const add = (t: CatalogTool): void => {
    if (!map.has(t.key)) map.set(t.key, t);
  };
  for (const c of sources.caco) {
    add({ key: cacoKey(c.name), name: c.name, description: c.description, origin: 'caco', excludable: true, hardDisabled: c.hardDisabled, parameters: c.parameters, deferEligible: c.deferEligible });
  }
  for (const b of sources.builtins) {
    const name = b.name.startsWith('builtin:') ? b.name.slice('builtin:'.length) : b.name;
    add({ key: builtinKey(b.name), name, description: b.description, origin: 'builtin', excludable: true, hardDisabled: false, parameters: b.parameters, instructions: b.instructions });
  }
  for (const s of sources.mcp) {
    for (const t of s.tools) {
      add({ key: t.key, name: t.name, description: t.description, origin: 'mcp', server: s.serverName, excludable: t.excludable, hardDisabled: false });
    }
  }
  return map;
}
