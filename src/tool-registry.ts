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
 *
 * `ask_user` is excluded too: it's a mid-turn "ask the human a question" tool that
 * Caco never wires up (no `onUserInputRequest` handler; `user_input.*` events are
 * filtered out), yet the CLI sends its full schema + instructions every turn
 * (~800 tokens of pure per-turn tax). See docs/research/ask-user-tool.md. If Caco
 * later wants a blocking in-turn clarification UX, this exclusion is removed as part
 * of that feature.
 *
 * `fetch_copilot_cli_documentation` is excluded: it fetches Copilot *CLI* docs, which
 * Caco does not use — Caco has its own `caco_docs` tool for project documentation. Pure
 * per-turn schema tax. NOTE: `str_replace_editor` is deliberately NOT excluded — it is
 * the SDK's actual view/edit/create tool (Caco has no replacement), so excluding it
 * would remove the agent's ability to edit files.
 */
export const DEFAULT_EXCLUDED_BUILTINS: string[] = [
  'builtin:bash', 'builtin:read_bash', 'builtin:stop_bash', 'builtin:list_bash',
  'builtin:powershell', 'builtin:read_powershell', 'builtin:stop_powershell', 'builtin:list_powershell',
  'builtin:local_shell',
  'builtin:ask_user',
  'builtin:fetch_copilot_cli_documentation',
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
 * Built-in Caco tools that may NEVER be auto-deferred. Everything else is
 * deferrable BY DEFAULT — the inversion of the former `DEFER_ELIGIBLE_CACO_TOOLS`
 * allowlist (see docs/archive/spec-defer-default-inversion.md).
 *
 * The default is the whole point. An allowlist of what MAY defer means forgetting
 * to list a new tool costs permanent, silent, per-turn rent in every session; a
 * blocklist of what may NOT means forgetting costs one recoverable enable
 * round-trip. Eight tools became permanently always-sent under the old default,
 * by omission rather than decision.
 *
 * Each entry needs a reason that outlives a usage argument:
 *  - `caco_enable_tools` — the only path back; deferring it is unrecoverable.
 *  - `caco_run_workflow` — the shell; used continuously.
 *  - `retrieve_output`   — shaped output leaves an `out_…` handle in the
 *    transcript that only this tool redeems, so deferring it strands a promise
 *    already made to the model.
 *  - `caco_docs` — a DISCOVERY tool. Usage-driven deferral is self-reinforcing
 *    for these (deferred ⇒ invisible ⇒ unused ⇒ stale forever), so its idle age
 *    measures the deferral, not disuse. A judgment call, not a proof: the
 *    `caco_enable_tools` listing does keep deferred tools nominally discoverable.
 */
export const NEVER_DEFER_CACO_TOOLS: string[] = [
  'caco_enable_tools',
  'caco_run_workflow',
  'retrieve_output',
  'caco_docs',
];

/**
 * Whether a Caco tool is eligible for auto-defer. THE single eligibility
 * predicate — the applet's `wouldDefer` badge and the resume-time decision both
 * call this with the same arguments, so the view cannot disagree with behaviour.
 *
 * Hard-disabled tools are never eligible: they already cost zero, so deferring
 * one would grow every session's exclusion set for no saving.
 */
export function isDeferEligibleCacoTool(name: string, opts?: { hardDisabled?: boolean }): boolean {
  if (opts?.hardDisabled) return false;
  return !NEVER_DEFER_CACO_TOOLS.includes(name);
}

/**
 * THE defer-eligibility verdict for a Caco catalog entry — the only form callers
 * should use, because it folds in the `origin` filter that a name-plus-flag check
 * cannot see. Extension tools are never eligible: a fixed name blocklist cannot
 * express a protection for a dynamic third-party tool set.
 *
 * Both the enumeration (`computeStaleDeferCandidates`) and the applet's
 * `wouldDefer` badge route through this, so the view cannot disagree with
 * behaviour. Reaching for `isDeferEligibleCacoTool` directly on a catalog entry
 * is how they drifted apart before.
 */
export function isDeferEligibleCacoEntry(
  entry: { name: string; hardDisabled: boolean; origin: 'builtin' | 'extension' },
): boolean {
  return entry.origin === 'builtin' && isDeferEligibleCacoTool(entry.name, { hardDisabled: entry.hardDisabled });
}

/**
 * Synthetic servers in the mcp-servers applet ("Caco", "Built-in") — not real MCP
 * servers. They have no learned keys, so manual defer against them is inert; the
 * name would still enter persisted state and render a misleading deferred badge.
 */
const PSEUDO_SERVER_NAMES: string[] = ['Caco', 'Built-in'];

export function isPseudoServer(name: string): boolean {
  return PSEUDO_SERVER_NAMES.includes(name);
}

/** Whether the SDK `skill` built-in tool is available to sessions. Skills run by asking
 *  the agent to call this tool, so a skill slash-command cannot work without it. Caco
 *  never excludes it by default; this guards the CACO_EXCLUDED_BUILTINS misconfiguration. */
export function skillToolEnabled(): boolean {
  return !excludedBuiltinNames().includes('builtin:skill');
}
