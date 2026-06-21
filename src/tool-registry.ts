/**
 * Tool-diet disable switch. A single place to drop a tool from the per-session
 * tool surface, cutting its name + description + parameter schema from every
 * model turn. Re-adding is a one-line edit (remove from DEFAULT_DISABLED_TOOLS)
 * or an env tweak — no behavior is deleted, only hidden, so git/flag restores it.
 *
 * Educated-guess defaults (no telemetry yet): low-frequency, easily-re-added
 * tools. Override or extend at runtime with CACO_DISABLED_TOOLS (comma-separated
 * tool names); the env list is unioned with the defaults.
 */

/**
 * Names disabled by default. Conservative, high-confidence cuts: niche tools a
 * typical coding session never calls, each trivially re-enabled. NOT capability
 * deletions — the code stays; only registration is skipped.
 */
export const DEFAULT_DISABLED_TOOLS: string[] = [
  'embed_media',            // media embeds (YouTube/Spotify/etc) — rare in coding work
  'caco_extensions',        // extension discovery — niche; docs cover it
  'caco_session_store_sql', // cross-session history SQL — power tool, rarely used
  'caco_session_swarm',     // parallel session fan-out — the built-in task tool suffices
  // MCP OAuth registration — the ONLY agent path that creates an MCP auth-store
  // entry (the applet /start + /config routes 404 without one). Disabled here
  // because it auto-opens OAuth browser tabs; to add a new OAuth MCP server,
  // re-enable temporarily (drop from this list or unset via CACO_DISABLED_TOOLS).
  'register_mcp_server',
];

export function parseDisabledToolNames(defaults: string[], env: string | undefined): Set<string> {
  const names = [...defaults];
  if (env) {
    for (const raw of env.split(',')) {
      const name = raw.trim();
      if (name) names.push(name);
    }
  }
  return new Set(names.map(n => n.toLowerCase()));
}

export interface NamedTool { name: string; }

export function filterDisabledTools<T extends NamedTool>(
  tools: T[],
  disabled: Set<string>,
): { kept: T[]; removed: string[] } {
  const kept: T[] = [];
  const removed: string[] = [];
  for (const tool of tools) {
    if (disabled.has(tool.name.toLowerCase())) removed.push(tool.name);
    else kept.push(tool);
  }
  return { kept, removed };
}

/** The disabled-tool set for this process (defaults ∪ CACO_DISABLED_TOOLS). */
export function disabledToolNames(): Set<string> {
  return parseDisabledToolNames(DEFAULT_DISABLED_TOOLS, process.env.CACO_DISABLED_TOOLS);
}

/**
 * Built-in SDK tools excluded from sessions via SessionConfig.excludedTools
 * (a separate mechanism from DEFAULT_DISABLED_TOOLS, which only filters Caco's
 * own defineTool tools). C1 "shell wrapping": the shell built-ins have unbounded
 * output, so route all shell through caco.sh inside caco_run_workflow (bounded
 * output, fewer calls, in-script summarization). Reverting is one config edit or
 * CACO_EXCLUDED_BUILTINS="". Search/read tools (grep/glob/view) are intentionally
 * NOT excluded here — a separate future effort (index_multiread).
 */
export const DEFAULT_EXCLUDED_BUILTINS: string[] = [
  'builtin:bash', 'builtin:read_bash', 'builtin:stop_bash', 'builtin:list_bash',
  'builtin:powershell', 'builtin:read_powershell', 'builtin:stop_powershell', 'builtin:list_powershell',
  'builtin:local_shell',
];

/** Parse CACO_EXCLUDED_BUILTINS (comma-separated) and union with the defaults. */
export function parseExcludedBuiltins(defaults: string[], env: string | undefined): string[] {
  const names = [...defaults];
  if (env) {
    for (const raw of env.split(',')) {
      const name = raw.trim();
      if (name) names.push(name);
    }
  }
  return [...new Set(names)];
}

/** Built-in tools to exclude from every session (defaults ∪ CACO_EXCLUDED_BUILTINS). */
export function excludedBuiltinNames(): string[] {
  return parseExcludedBuiltins(DEFAULT_EXCLUDED_BUILTINS, process.env.CACO_EXCLUDED_BUILTINS);
}
