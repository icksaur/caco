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
