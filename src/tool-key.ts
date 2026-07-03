/**
 * The one canonical tool identity. A branded string so a raw string cannot be
 * used where a key is required — routing through `toolKey()` is enforced at
 * compile time (spec-tool-reveal: "one tool key" invariant). Leaf module: the
 * usage meter, the exclusion set, the catalog, and the classifier all import
 * ONLY this, so metering never depends on the catalog or the authority shell.
 *
 * Canonical forms are IDENTICAL to the SDK's `excludedTools` strings for the two
 * excludable origins, so a ToolKey is the exclusion string with no boundary
 * conversion: MCP → `server/tool` (the SDK namespacedName), builtin →
 * `builtin:name` (the DEFAULT_EXCLUDED_BUILTINS form). Caco → `caco:name`
 * (Caco tools are hard-disabled pre-registration, not excluded, but still get a
 * stable stamp key).
 */

export type ToolKey = string & { readonly __brand: 'ToolKey' };

export type ToolOrigin = 'mcp' | 'builtin' | 'caco';

export type ToolDescriptor =
  | { origin: 'mcp'; serverName: string; toolName: string }
  | { origin: 'builtin'; name: string }
  | { origin: 'caco'; name: string };

/** Resolve a tool descriptor (origin known) to its canonical key. Throws on
 *  missing identity fields rather than fabricating a key under a fallback. */
export function toolKey(d: ToolDescriptor): ToolKey {
  switch (d.origin) {
    case 'mcp': {
      if (!d.serverName || !d.toolName) {
        throw new Error(`toolKey: mcp descriptor missing serverName/toolName (${d.serverName}/${d.toolName})`);
      }
      return `${d.serverName}/${d.toolName}` as ToolKey;
    }
    case 'builtin': {
      const bare = stripBuiltinPrefix(d.name);
      if (!bare) throw new Error('toolKey: builtin descriptor missing name');
      return `builtin:${bare}` as ToolKey;
    }
    case 'caco': {
      if (!d.name) throw new Error('toolKey: caco descriptor missing name');
      return `caco:${d.name}` as ToolKey;
    }
  }
}

function stripBuiltinPrefix(name: string): string {
  return name.startsWith('builtin:') ? name.slice('builtin:'.length) : name;
}

/** Shape of a `tool.execution_start` event's data that identifies the tool.
 *  `mcpServerName`/`mcpToolName` are present only for MCP-backed tools. */
export interface ToolStartEventShape {
  toolName?: string;
  mcpServerName?: string;
  mcpToolName?: string;
}

/**
 * Resolve a `tool.execution_start` event to its canonical ToolKey — the SAME key
 * the tool's `excludedTools` entry and catalog entry use. This is the risky seam
 * the whole feature hinges on: a mis-resolved key silently mis-fires auto-defer.
 *
 * Disambiguation (only `tool.execution_start` carries identity — `complete` does not):
 * - MCP: `mcpServerName` AND `mcpToolName` present → `server/tool` (raw MCP name, not
 *   the model-facing `toolName`, so it matches the namespacedName in `excludedTools`).
 * - Caco vs builtin: a bare `toolName` is a Caco tool iff it is in `cacoToolNames`
 *   (the known registered set) → `caco:name`; otherwise a SDK builtin → `builtin:name`.
 * Throws on a missing `toolName` rather than fabricating a key.
 */
export function toolKeyFromEvent(evt: ToolStartEventShape, cacoToolNames: ReadonlySet<string>): ToolKey {
  if (evt.mcpServerName && evt.mcpToolName) {
    return toolKey({ origin: 'mcp', serverName: evt.mcpServerName, toolName: evt.mcpToolName });
  }
  const name = evt.toolName;
  if (!name) throw new Error('toolKeyFromEvent: event carries no toolName');
  if (cacoToolNames.has(name)) return toolKey({ origin: 'caco', name });
  return toolKey({ origin: 'builtin', name });
}
