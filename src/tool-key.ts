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
