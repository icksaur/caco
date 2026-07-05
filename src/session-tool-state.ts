/**
 * The pure decision core for tool reveal/defer (spec-tool-reveal). No SDK, no
 * I/O, no state — the whole decision surface is unit-testable in isolation. The
 * stateful shell (session-tool-authority.ts) and the applet payload consume
 * these; none re-derive the three-axis state or the enable/defer rules.
 */

import type { ToolKey } from './tool-key.js';
import type { ToolCatalog } from './tool-catalog.js';

export type ToolState = 'enabled' | 'deferred' | 'disabled';

/** The single definition of the tool presentation axes.
 *  - `'disabled'`: permanent application-layer policy — a hard-disabled Caco tool
 *    (`DEFAULT_DISABLED_TOOLS`, filtered pre-registration) OR a policy-excluded /
 *    platform-absent builtin (`policyDisabled`, e.g. the shell family or
 *    powershell-on-Linux). Not sent to the model, contributes no per-turn tokens, and
 *    NOT re-enableable.
 *  - `'deferred'`: dynamically excluded this session (C2 auto-defer / D1 manual defer).
 *    Was contributing cost, now saving it; re-enableable live.
 *  - `'enabled'`: the model currently sees it.
 *  Policy is checked before the dynamic exclusion set, so a builtin that appears in both
 *  the base seed and `policyDisabled` classifies as `'disabled'`, never `'deferred'`. */
export function classifyTool(
  key: ToolKey,
  ctx: { excluded: ReadonlySet<ToolKey>; hardDisabled: boolean; policyDisabled?: ReadonlySet<ToolKey> },
): ToolState {
  if (ctx.hardDisabled) return 'disabled';
  if (ctx.policyDisabled?.has(key)) return 'disabled';
  if (ctx.excluded.has(key)) return 'deferred';
  return 'enabled';
}

export type ValidateEnableResult =
  | { ok: true; nextExcluded: Set<ToolKey> }
  | { ok: false; error: string };

export type ResolveEnableResult =
  | { ok: true; keys: ToolKey[] }
  | { ok: false; error: string };

/** Resolve agent-typed tool identifiers to canonical ToolKeys against the catalog.
 *  An identifier matches either a catalog entry's exact key (`server/tool`, `builtin:x`,
 *  `caco:x`) or its display name. Errors atomically (naming the offender) on an unknown
 *  identifier, or an ambiguous display name shared across origins (asks for the full
 *  key). Pure — the name→key seam for `caco_enable_tools`, kept out of the tool handler. */
export function resolveEnableTargets(names: string[], catalog: ToolCatalog): ResolveEnableResult {
  const keys: ToolKey[] = [];
  for (const name of names) {
    if (catalog.has(name as ToolKey)) {
      keys.push(name as ToolKey);
      continue;
    }
    const byName = [...catalog.values()].filter(t => t.name === name);
    if (byName.length === 0) return { ok: false, error: `unknown tool: ${name}` };
    if (byName.length > 1) {
      return { ok: false, error: `ambiguous tool name "${name}" (matches ${byName.map(t => t.key).join(', ')}); use the full key` };
    }
    keys.push(byName[0].key);
  }
  return { ok: true, keys };
}

/** Atomic pre-validation for `caco_enable_tools`: every key must exist, be
 *  currently deferred, and not be policy-disabled (hard-disabled Caco tool or a
 *  policy-excluded builtin — those are permanent app-layer policy, not re-enableable).
 *  Any invalid key rejects the WHOLE call with no mutation (a syntax mistake costs no
 *  cache-bust). On success returns the next exclusion set (current minus the enabled
 *  keys). Pure. */
export function validateEnable(
  keys: ToolKey[],
  catalog: ToolCatalog,
  excluded: ReadonlySet<ToolKey>,
  policyDisabled?: ReadonlySet<ToolKey>,
): ValidateEnableResult {
  for (const key of keys) {
    const tool = catalog.get(key);
    if (!tool) return { ok: false, error: `unknown tool: ${key}` };
    if (tool.hardDisabled || policyDisabled?.has(key)) return { ok: false, error: `tool is disabled and not re-enableable: ${key}` };
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
 * Render the session's DEFERRED tools as grouped discovery text for the
 * `caco_enable_tools` no-args mode — the agent's way to find a deferred capability
 * by name+description and re-enable it, without paying every tool's schema each
 * turn. Lists ONLY `deferred` tools (enabled ones are already visible; disabled
 * ones are not re-enableable). Groups: Caco, Built-in, then one section per MCP
 * server. Each line is `- <name> — <first-line description>`. A trailing footer
 * notes the COUNT of policy-disabled tools (names withheld — they cannot be
 * enabled). Empty deferred set ⇒ an explicit "no deferred tools" message. Pure.
 * Ordered by origin then insertion (catalog order).
 */
export function formatDeferredTools(catalog: ToolCatalog, excluded: ReadonlySet<ToolKey>, policyDisabled?: ReadonlySet<ToolKey>): string {
  const groups = new Map<string, string[]>();
  const order: string[] = [];
  const push = (group: string, line: string): void => {
    let lines = groups.get(group);
    if (!lines) { lines = []; groups.set(group, lines); order.push(group); }
    lines.push(line);
  };
  let disabledCount = 0;
  for (const t of catalog.values()) {
    const state = classifyTool(t.key, { excluded, hardDisabled: t.hardDisabled, policyDisabled });
    if (state === 'disabled') { disabledCount++; continue; }
    if (state !== 'deferred') continue;
    const desc = (t.description || '').split('\n')[0].trim();
    const group = t.origin === 'caco' ? 'Caco' : t.origin === 'builtin' ? 'Built-in' : `MCP: ${t.server ?? 'unknown'}`;
    push(group, `- \`${t.name}\` — ${desc || '(no description)'}`);
  }
  const footer = disabledCount > 0
    ? `\n\n${disabledCount} tool(s) are disabled by policy (e.g. the shell family) and cannot be enabled.`
    : '';
  if (order.length === 0) {
    return `# Deferred Tools\n\nNo deferred tools — every available tool is already enabled for this session.${footer}`;
  }
  const header = [
    '# Deferred Tools',
    '',
    'These tools are excluded this session to save per-turn tokens. Re-enable the ' +
      'ones you need with `caco_enable_tools({ names: ["<name>"] })` (batch related ' +
      'tools in ONE call); they become callable on your NEXT turn.',
  ].join('\n');
  const body = order.map(g => `## ${g}\n${(groups.get(g) as string[]).join('\n')}`).join('\n\n');
  return `${header}\n\n${body}${footer}`;
}
