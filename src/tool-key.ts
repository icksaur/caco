/**
 * The one canonical tool identity. A branded string so a raw string cannot be
 * used where a key is required — routing through the key producers is enforced at
 * compile time (spec-tool-reveal: "one tool key" invariant). Leaf module: the
 * usage meter, the exclusion set, the catalog, and the classifier all import
 * ONLY this, so metering never depends on the catalog or the shell.
 *
 * A ToolKey IS the exact string the CLI's `excludedTools` denylist matches (verified
 * empirically via the C0 probe):
 *   - builtin → `builtin:<name>`   (the documented DEFAULT_EXCLUDED_BUILTINS form)
 *   - caco    → `<name>`           (bare model-facing name = the defineTool name)
 *   - mcp     → `<modelFacingName>` (the CLI-assigned model-facing name)
 *
 * Builtin and Caco keys are derivable here. An MCP key is NOT reconstructable from
 * (server, rawTool) — the model-facing name is authoritative and irregular (e.g.
 * `web_search` has no server prefix) — so MCP keys are DISCOVERED via tool-key-registry
 * and passed in as already-resolved model-facing names. This module never invents an MCP
 * key from parts.
 */

export type ToolKey = string & { readonly __brand: 'ToolKey' };

export type ToolOrigin = 'mcp' | 'builtin' | 'caco';

function stripBuiltinPrefix(name: string): string {
  return name.startsWith('builtin:') ? name.slice('builtin:'.length) : name;
}

/** Builtin exclusion key: `builtin:<name>` (idempotent if already prefixed). Throws empty. */
export function builtinKey(name: string): ToolKey {
  const bare = stripBuiltinPrefix(name);
  if (!bare) throw new Error('builtinKey: empty name');
  return `builtin:${bare}` as ToolKey;
}

/** Caco exclusion key: the bare model-facing (defineTool) name. Throws empty. */
export function cacoKey(name: string): ToolKey {
  if (!name) throw new Error('cacoKey: empty name');
  return name as ToolKey;
}

/** MCP exclusion key: the model-facing name verbatim (as DISCOVERED from observation —
 *  never reconstructed from server/tool here). Throws empty. */
export function mcpKey(modelFacingName: string): ToolKey {
  if (!modelFacingName) throw new Error('mcpKey: empty model-facing name');
  return modelFacingName as ToolKey;
}

/** Shape of a `tool.execution_start` event's data that identifies the tool.
 *  `mcpServerName`/`mcpToolName` are present only for MCP-backed tools; `toolName`
 *  is the model-facing name for ALL origins. */
export interface ToolStartEventShape {
  toolName?: string;
  mcpServerName?: string;
  mcpToolName?: string;
}

/**
 * Resolve a `tool.execution_start` event to its canonical ToolKey — the SAME key the
 * tool's `excludedTools` entry uses. `toolName` IS the model-facing name for every origin,
 * so MCP and Caco resolve to it directly and only builtins take the `builtin:` prefix.
 * Disambiguation: MCP iff `mcpServerName` present; else Caco iff the name is a known Caco
 * tool; else builtin. Throws on a missing `toolName` (never fabricates).
 */
export function toolKeyFromEvent(evt: ToolStartEventShape, cacoToolNames: ReadonlySet<string>): ToolKey {
  const name = evt.toolName;
  if (!name) throw new Error('toolKeyFromEvent: event carries no toolName');
  if (evt.mcpServerName) return mcpKey(name);
  if (cacoToolNames.has(name)) return cacoKey(name);
  return builtinKey(name);
}
