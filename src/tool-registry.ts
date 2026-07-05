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
  'caco_session_store_sql', // cross-session history SQL — power tool, rarely used
  // MCP OAuth registration — the ONLY agent path that creates an MCP auth-store
  // entry (the applet /start + /config routes 404 without one). Disabled here
  // because it auto-opens OAuth browser tabs; to add a new OAuth MCP server,
  // re-enable temporarily (drop from this list or unset via CACO_DISABLED_TOOLS).
  'register_mcp_server',
];

/**
 * Tools that must NEVER be hard-disabled, whatever `DEFAULT_DISABLED_TOOLS` or
 * `CACO_DISABLED_TOOLS` say. `caco_enable_tools` is the SOLE always-on escape hatch
 * (it both lists deferred tools and re-enables them); disabling it would make every
 * deferred capability — including `caco_docs` — unrecoverable. Stripped from the
 * disabled set in `parseDisabledToolNames` so an operator misconfig cannot deadlock
 * capability recovery. Mirrors `skillToolEnabled`'s guard against a bad
 * `CACO_EXCLUDED_BUILTINS`. */
export const PROTECTED_TOOLS: string[] = ['caco_enable_tools'];

export function parseDisabledToolNames(defaults: string[], env: string | undefined): Set<string> {
  const names = [...defaults];
  if (env) {
    for (const raw of env.split(',')) {
      const name = raw.trim();
      if (name) names.push(name);
    }
  }
  const protectedLower = new Set(PROTECTED_TOOLS.map(n => n.toLowerCase()));
  return new Set(names.map(n => n.toLowerCase()).filter(n => !protectedLower.has(n)));
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

/**
 * Caco `defineTool` tools that cold-resume auto-defer (Phase C) MAY hide. A fixed
 * allowlist keyed by tool name — everything NOT listed is always kept, so the
 * escape-hatch (`caco_docs`/`caco_enable_tools`) and the session/agent/memory/
 * workflow/index/retrieve tools can never auto-defer themselves out of reach.
 *
 * Contents = the browser tools (`src/browser-tools.ts`), the applet-state tools
 * (`src/applet-tools.ts`), and the surface tools (`src/surface-tools.ts`). Kept in
 * sync with those three modules by hand (spec-tool-reveal C1). `restart_server`
 * lives in applet-tools.ts but is deliberately EXCLUDED: it's a privileged
 * control-plane action used mid-workflow, and keeping it always-on avoids an
 * enable round-trip before a restart at the cost of a single always-sent tool.
 */
export const DEFER_ELIGIBLE_CACO_TOOLS: string[] = [
  'caco_docs',
  'caco_browser_ensure_running', 'caco_browser_navigate', 'caco_browser_snapshot',
  'caco_browser_screenshot', 'caco_browser_action', 'caco_browser_eval',
  'get_applet_state', 'set_applet_state',
  'caco_get_surface', 'caco_get_surface_changes', 'caco_mutate_surface', 'caco_set_surface_style',
];

/** Whether a Caco tool (by name) is eligible for cold-resume auto-defer. */
export function isDeferEligibleCacoTool(name: string): boolean {
  return DEFER_ELIGIBLE_CACO_TOOLS.includes(name);
}

/** Whether the SDK `skill` built-in tool is available to sessions. Skills run by asking
 *  the agent to call this tool, so a skill slash-command cannot work without it. Caco
 *  never excludes it by default; this guards the CACO_EXCLUDED_BUILTINS misconfiguration. */
export function skillToolEnabled(): boolean {
  return !excludedBuiltinNames().includes('builtin:skill');
}
