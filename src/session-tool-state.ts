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

/**
 * The session's dynamically-deferred exclusion keys — the SAME selection
 * `formatDeferredTools` renders, but as bare keys and WITHOUT a catalog, so the
 * per-turn discovery reminder needs no SDK/MCP metadata RPC (spec-enable-tools-
 * discovery: synchronous source, one source of truth).
 *
 * A key is deferred iff it is in the live exclusion set and NOT a permanent policy
 * exclusion (the builtin shell family / platform-absent builtins). Hard-disabled
 * tools are filtered pre-registration and so are never in the exclusion set — the
 * exclusion set is by construction a subset of registered, non-hard-disabled tool
 * keys — which is why filtering `policyDisabled` alone yields exactly the deferred
 * set. A ToolKey IS the model-facing enable identifier (caco/mcp keys are the bare
 * name), so every returned key round-trips through `resolveEnableTargets` verbatim
 * and unambiguously (no display-name collision to resolve). Pure. Preserves the
 * exclusion set's iteration order.
 */
export function deferredToolKeys(excluded: Iterable<ToolKey>, policyDisabled: ReadonlySet<ToolKey>): ToolKey[] {
  return [...excluded].filter(k => !policyDisabled.has(k));
}

/**
 * The catalog keys `caco_enable_tools` can actually act on: everything except an MCP
 * entry whose model-facing key has never been observed (`excludable: false`), whose `key`
 * is a display-only `server/tool` id rather than a real exclusion string. A key that
 * cannot be excluded cannot be un-excluded. Pure.
 */
export function enableableToolKeys(catalog: ToolCatalog): Set<ToolKey> {
  const out = new Set<ToolKey>();
  for (const t of catalog.values()) if (t.excludable) out.add(t.key);
  return out;
}

/**
 * The synchronous D3 superset seed for `enableableKeysBySession`, built at
 * create/resume BEFORE the async warm (spec-enable-tools-config-freshness D3).
 *
 * A pure union across ALL enable-able origins so turn one never falls into the
 * "cache absent ⇒ advertise everything" fallback yet never over-hides:
 *  - Caco enable-able keys (known synchronously from the Caco catalog),
 *  - builtin enable-able keys (registered builtins minus policy-disabled),
 *  - every learned MCP key (`allLearnedKeys()` — the superset; no config filter),
 *  - every uncertain dynamically-excluded key of ANY origin (the session's seeded
 *    exclusions minus policy builtins) — because the builtin-name cache is populated
 *    fire-and-forget and may still be empty here, so an excluded builtin must still be
 *    advertised from its own reminder. Superset direction: an excluded key of unknown
 *    provenance is advertised, never silently dropped.
 *
 * Superset by construction ⇒ worst case one redundant advertise, never a hidden
 * tool. The async warm later refines it per-server (Stage 2). Pure.
 */
export function buildSyncSeed(args: {
  cacoEnableableKeys: Iterable<ToolKey>;
  builtinEnableableKeys: Iterable<ToolKey>;
  learnedMcpKeys: Iterable<ToolKey>;
  carriedExcluded: Iterable<ToolKey>;
}): Set<ToolKey> {
  const out = new Set<ToolKey>();
  for (const k of args.cacoEnableableKeys) out.add(k);
  for (const k of args.builtinEnableableKeys) out.add(k);
  for (const k of args.learnedMcpKeys) out.add(k);
  for (const k of args.carriedExcluded) out.add(k);
  return out;
}

/**
 * Whether the async warm may COMMIT its refined enable-able set for a session
 * (spec-enable-tools-config-freshness, lifecycle guard). Pure predicate extracted
 * so the write decision is unit-testable. True only when ALL hold:
 *  - `sessionId` is an explicitly-named session (the no-arg catalog variant resolves
 *    an arbitrary most-recent session and must not write another session's cache);
 *  - `enumerationOk` — the MCP enumeration actually happened (a failed enumeration
 *    must not write an MCP-free set, which would over-hide);
 *  - `activeAtEntry` — a session object was captured at entry; and
 *  - `activeAtEntry === activeNow` — the SAME session object is still active, so a
 *    teardown (or teardown + recreate under the same id) that raced the enumeration
 *    cannot inherit the dead session's catalog.
 */
export function shouldCommitWarmSet(args: {
  sessionId: string | undefined;
  enumerationOk: boolean;
  activeAtEntry: object | undefined;
  activeNow: object | undefined;
}): boolean {
  return (
    !!args.sessionId &&
    args.enumerationOk &&
    !!args.activeAtEntry &&
    args.activeAtEntry === args.activeNow
  );
}

/**
 * Intersect the deferred keys with the session's enable-able catalog keys, so the
 * discovery reminder never advertises a key `caco_enable_tools` would reject
 * (spec-enable-tools-catalog-divergence). The exclusion set is seeded from the
 * SYSTEM-WIDE learned-key registry and auto-defer latch, so it routinely contains keys
 * for MCP servers that are not loaded in this session; those exclude nothing and cannot
 * be enabled here.
 *
 * `undefined` means "the enable-able set is not known yet" and advertises everything —
 * the pre-existing behaviour. It must NEVER collapse to an empty set: over-advertising
 * costs the agent one bad enable attempt, while over-hiding silently strands a deferred
 * tool with no discovery path at all. Pure.
 */
export function advertisableToolKeys(keys: readonly ToolKey[], enableable: ReadonlySet<ToolKey> | undefined): ToolKey[] {
  if (!enableable) return [...keys];
  return keys.filter(k => enableable.has(k));
}

export interface EnablePartition {
  /** Names that resolve against the catalog (by key or display name). */
  resolvable: string[];
  /** Advertised by Caco but absent from this session's catalog — its MCP server is not
   *  loaded here. Caco's mistake, not the agent's. */
  phantom: string[];
  /** Neither resolvable nor advertised: a typo or a hallucinated name. */
  unknown: string[];
}

/**
 * Split requested names into the three classes `caco_enable_tools` must treat
 * differently (spec-enable-tools-catalog-divergence R2). A name is phantom rather than
 * unknown when it is unresolvable against the catalog but IS in the session's live
 * exclusion set — i.e. Caco advertised it in the deferred-tools reminder.
 *
 * The distinction exists because the remediation differs: an unknown name is an agent
 * error whose fix is to re-list, while a phantom name is a Caco error that re-listing
 * cannot fix (the no-args listing is built from the same catalog that just failed to
 * resolve it), so telling the agent to re-list sends it into a loop. Pure.
 */
export function partitionEnableNames(
  names: readonly string[],
  catalog: ToolCatalog,
  excluded: ReadonlySet<ToolKey>,
): EnablePartition {
  const byName = new Set<string>();
  for (const t of catalog.values()) byName.add(t.name);
  const out: EnablePartition = { resolvable: [], phantom: [], unknown: [] };
  for (const name of names) {
    if (catalog.has(name as ToolKey) || byName.has(name)) out.resolvable.push(name);
    else if (excluded.has(name as ToolKey)) out.phantom.push(name);
    else out.unknown.push(name);
  }
  return out;
}

/**
 * Render the change-triggered discovery reminder appended to the model prompt: the
 * deferred tool identifiers plus the one-line enable instruction. Caller guarantees
 * a non-empty key list (an empty deferred set emits no reminder). Names only — no
 * schemas — so the per-emission cost is a comma list, not the KBs of definitions
 * deferral omits. Pure.
 */
export function renderDeferredToolsReminder(keys: readonly ToolKey[]): string {
  return [
    '<deferred_tools>',
    'Available but deferred (definitions hidden to save tokens). Enable before use with caco_enable_tools({ names: [...] }); callable next turn.',
    keys.join(', '),
    '</deferred_tools>',
  ].join('\n');
}
