/**
 * The pure decision core for tool reveal/defer (spec-tool-reveal). No SDK, no
 * I/O, no state — the whole decision surface is unit-testable in isolation. The
 * stateful shell (session-tool-authority.ts) and the applet payload consume
 * these; none re-derive the three-axis state or the enable/defer rules.
 */

import type { ToolKey } from './tool-key.js';
import type { ToolCatalog } from './tool-catalog.js';

export type ToolState = 'enabled' | 'deferred' | 'off';

/** The single definition of the three tool axes. hardDisabled (filtered
 *  pre-registration) is not live-revealable → 'off'; a registered-but-excluded
 *  tool is 'deferred' (revealable); everything else the model currently sees is
 *  'enabled'. */
export function classifyTool(
  key: ToolKey,
  ctx: { excluded: ReadonlySet<ToolKey>; hardDisabled: boolean },
): ToolState {
  if (ctx.hardDisabled) return 'off';
  if (ctx.excluded.has(key)) return 'deferred';
  return 'enabled';
}

export type ValidateEnableResult =
  | { ok: true; nextExcluded: Set<ToolKey> }
  | { ok: false; error: string };

/** Atomic pre-validation for `caco_enable_tools`: every key must exist, be
 *  currently deferred, and not be hard-disabled. Any invalid key rejects the
 *  WHOLE call with no mutation (a syntax mistake costs no cache-bust). On success
 *  returns the next exclusion set (current minus the enabled keys). Pure. */
export function validateEnable(
  keys: ToolKey[],
  catalog: ToolCatalog,
  excluded: ReadonlySet<ToolKey>,
): ValidateEnableResult {
  for (const key of keys) {
    const tool = catalog.get(key);
    if (!tool) return { ok: false, error: `unknown tool: ${key}` };
    if (tool.hardDisabled) return { ok: false, error: `tool is disabled and not revealable: ${key}` };
    if (!excluded.has(key)) return { ok: false, error: `tool is already enabled: ${key}` };
  }
  const nextExcluded = new Set(excluded);
  for (const key of keys) nextExcluded.delete(key);
  return { ok: true, nextExcluded };
}

/** Cold-resume auto-defer decision. Returns the keys to exclude, or `[]` when
 *  the session is not cold — so "a warm session is never auto-mutated" is a pure,
 *  directly-testable return value, not just age math. A candidate is stale (and
 *  thus deferred) when its active-seconds age EXCEEDS the threshold; a never-used
 *  tool (no stamp) is treated as maximally stale. Pure. */
export function computeColdResumeExclusions(args: {
  isCold: boolean;
  tools: ToolKey[];
  lastUsed: ReadonlyMap<ToolKey, number>;
  nowActiveSeconds: number;
  threshold: number;
}): ToolKey[] {
  if (!args.isCold) return [];
  const out: ToolKey[] = [];
  for (const key of args.tools) {
    // A never-used tool is maximally stale → always a defer candidate on a cold
    // resume, independent of how far the active clock has advanced. (Using `?? 0`
    // here would wrongly keep never-used tools on an early cold resume where
    // nowActiveSeconds <= threshold.)
    if (!args.lastUsed.has(key)) {
      out.push(key);
      continue;
    }
    const age = args.nowActiveSeconds - (args.lastUsed.get(key) as number);
    if (age > args.threshold) out.push(key);
  }
  return out;
}

/**
 * Render a ToolCatalog as grouped, state-annotated discovery text for
 * `caco_docs section="tools"` — the agent's way to find a deferred capability by
 * name+description without paying its schema in every turn. Groups: Caco,
 * Built-in, then one section per MCP server. Each line is
 * `- <camel_name> — <first-line description> [<state>]`, state from the single
 * `classifyTool`. Pure. Ordered by origin then insertion (catalog order).
 */
export function formatToolCatalog(catalog: ToolCatalog, excluded: ReadonlySet<ToolKey>): string {
  const groups = new Map<string, string[]>();
  const order: string[] = [];
  const push = (group: string, line: string): void => {
    let lines = groups.get(group);
    if (!lines) { lines = []; groups.set(group, lines); order.push(group); }
    lines.push(line);
  };
  for (const t of catalog.values()) {
    const state = classifyTool(t.key, { excluded, hardDisabled: t.hardDisabled });
    const desc = (t.description || '').split('\n')[0].trim();
    const group = t.origin === 'caco' ? 'Caco' : t.origin === 'builtin' ? 'Built-in' : `MCP: ${t.key.split('/')[0]}`;
    push(group, `- \`${t.name}\` — ${desc || '(no description)'} [${state}]`);
  }
  const header = [
    '# Caco Tool Catalog',
    '',
    'Every tool available to this session. **enabled** = the model sees it now; ' +
      '**deferred** = excluded this session to save per-turn tokens (re-enable it with ' +
      '`caco_enable_tools({ names: ["<name>"] })` when you need it); **off** = ' +
      'hard-disabled and NOT re-enableable.',
    '',
    'To use a deferred tool: call `caco_enable_tools` with its name(s) in ONE call ' +
      '(batch related tools together), then call the tool on a later turn.',
  ].join('\n');
  const body = order.map(g => `## ${g}\n${(groups.get(g) as string[]).join('\n')}`).join('\n\n');
  return `${header}\n\n${body}`;
}
