/**
 * Herd orchestration core (spec-session-orchestration).
 *
 * A "herd" is one PARENT session supervising CHILD sessions. The only DURABLE
 * herd state is each child's `orchestratedBy` bond (in the child's own meta);
 * the parent's role and child set are DERIVED. This module owns:
 *  - an in-memory, rebuildable membership index (parent → children) so we don't
 *    disk-scan every session on every idle;
 *  - pure derivations (signature, wake decision, summary);
 *  - `wakeParentIfNeeded`, a per-parent TRAILING-EDGE serialized re-evaluation
 *    that re-prompts an idle parent when a child needs attention.
 *
 * The stall guard (Guardrail 2) is layered on in Slice C; this module carries
 * the wake decision without the stall counter.
 */

export type HerdChildStatus = 'busy' | 'idle' | 'inactive';

export interface HerdChild {
  sessionId: string;
  name: string | null;
  status: HerdChildStatus;
  /** ISO of the child's last idle transition (the herd's "last stopped working"). */
  lastIdleAt: string | null;
}

// ---------------------------------------------------------------------------
// Membership index — in-memory, fully rederivable from the children's bonds.
// Not durable (the child's meta.orchestratedBy is the source of truth); this is
// a derived cache so "am I a parent / who are my children?" is O(1), not an
// O(N) disk scan on every session idle.
// ---------------------------------------------------------------------------

const parentToChildren = new Map<string, Set<string>>();
const childToParent = new Map<string, string>();

/** Rebuild the whole index from a snapshot of bonds (boot / full resync). */
export function rebuildHerdIndex(bonds: Array<{ childId: string; parentId: string }>): void {
  parentToChildren.clear();
  childToParent.clear();
  for (const { childId, parentId } of bonds) registerHerdBond(childId, parentId);
}

/** Record (or move) a child's bond to a parent. A child has exactly one parent. */
export function registerHerdBond(childId: string, parentId: string): void {
  const prev = childToParent.get(childId);
  if (prev && prev !== parentId) parentToChildren.get(prev)?.delete(childId);
  childToParent.set(childId, parentId);
  let set = parentToChildren.get(parentId);
  if (!set) { set = new Set(); parentToChildren.set(parentId, set); }
  set.add(childId);
  pruneEmpty(prev);
}

/** Remove a child's bond (disown / self-heal). */
export function clearHerdBond(childId: string): void {
  const prev = childToParent.get(childId);
  childToParent.delete(childId);
  if (prev) { parentToChildren.get(prev)?.delete(childId); pruneEmpty(prev); }
}

function pruneEmpty(parentId: string | undefined): void {
  if (parentId && parentToChildren.get(parentId)?.size === 0) parentToChildren.delete(parentId);
}

/** The child session ids of a parent (empty when not a parent). */
export function getHerdChildren(parentId: string): string[] {
  return [...(parentToChildren.get(parentId) ?? [])];
}

/** A session is a parent iff ≥1 child claims it (derived, never stored). */
export function isHerdParent(sessionId: string): boolean {
  return (parentToChildren.get(sessionId)?.size ?? 0) > 0;
}

/** The parent a child is bonded to (undefined if unbonded). */
export function getHerdParent(childId: string): string | undefined {
  return childToParent.get(childId);
}

// ---------------------------------------------------------------------------
// Pure derivations.
// ---------------------------------------------------------------------------

/** A cheap, order-independent hash of the herd's state — advances on any real
 *  change (a child re-idles → new lastIdleAt; status flip; add/remove). Keyed on
 *  `sessionId:status:lastIdleAt` so a re-run counts as progress (Guardrail 2). */
export function herdSignature(children: HerdChild[]): string {
  return children
    .map(c => `${c.sessionId}:${c.status}:${c.lastIdleAt ?? ''}`)
    .sort()
    .join('|');
}

export interface WakeDecision {
  wake: boolean;
  readyCount: number;
  reason: string;
}

/** The pure wake decision: wake an IDLE parent iff ≥1 child is not active. */
export function decideHerdWake(children: HerdChild[], parentBusy: boolean): WakeDecision {
  const ready = children.filter(c => c.status !== 'busy');
  if (parentBusy) return { wake: false, readyCount: ready.length, reason: 'parent-busy' };
  if (children.length === 0) return { wake: false, readyCount: 0, reason: 'no-children' };
  if (ready.length === 0) return { wake: false, readyCount: 0, reason: 'all-active' };
  return { wake: true, readyCount: ready.length, reason: 'ready' };
}

/** Compact herd-state text embedded in the `[system]` wake message. */
export function buildHerdSummary(children: HerdChild[]): string {
  const ready = children.filter(c => c.status !== 'busy');
  const lines = children
    .map(c => `- ${c.sessionId.slice(0, 8)} (${c.name ?? 'unnamed'}): ${c.status}`)
    .join('\n');
  return (
    `Your herd has ${ready.length} child session(s) awaiting attention ` +
    `(${children.length} total).\n${lines}\n` +
    "Call caco_herd_state for each child's full result, then resume or disown each."
  );
}

// ---------------------------------------------------------------------------
// wakeParentIfNeeded — per-parent trailing-edge serialized re-evaluation.
// ---------------------------------------------------------------------------

export interface WakeDeps {
  /** Live child statuses of the parent, re-read on every evaluation. */
  getChildren: (parentId: string) => HerdChild[] | Promise<HerdChild[]>;
  /** Whether the parent is currently busy (a wake is never injected into a busy parent). */
  isParentBusy: (parentId: string) => boolean;
  /** Inject the wake (POST/in-process dispatch of the `[system]` message). */
  dispatchWake: (parentId: string, readyCount: number, summary: string) => Promise<void>;
}

const wakeChains = new Map<string, Promise<void>>();

/**
 * Re-evaluate a parent's herd and inject a wake if needed. **Trailing-edge**
 * per-parent serialization (the `runTransition` pattern): concurrent triggers
 * chain and each re-reads live status, so a child that idles during an in-flight
 * "no wake" evaluation is still seen by the trailing evaluation (M1 liveness).
 */
export function wakeParentIfNeeded(parentId: string, deps: WakeDeps): Promise<void> {
  const prev = wakeChains.get(parentId) ?? Promise.resolve();
  const run = prev.then(() => evaluateAndWake(parentId, deps), () => evaluateAndWake(parentId, deps));
  wakeChains.set(parentId, run.then(() => {}, () => {}));
  return run;
}

async function evaluateAndWake(parentId: string, deps: WakeDeps): Promise<void> {
  if (deps.isParentBusy(parentId)) return;
  const children = await deps.getChildren(parentId);
  const decision = decideHerdWake(children, false);
  if (!decision.wake) return;
  await deps.dispatchWake(parentId, decision.readyCount, buildHerdSummary(children));
}

/** Test/reset seam: drop the in-memory wake chains (never durability-critical). */
export function _resetHerdWakeChains(): void {
  wakeChains.clear();
}

// ---------------------------------------------------------------------------
// Tool validation (pure) + status derivation.
// ---------------------------------------------------------------------------

/** Live session flags → a herd child status. */
export function deriveChildStatus(isBusy: boolean, isActive: boolean): HerdChildStatus {
  return isBusy ? 'busy' : isActive ? 'idle' : 'inactive';
}

/** Guardrail 1: a session that is itself a child cannot `create`/`acquire`
 *  children (herds are flat, depth 1). Returns an error message or null. */
export function herdParentActionError(callerOrchestratedBy: string | undefined): string | null {
  if (callerOrchestratedBy) {
    return `This session is itself a herd child (orchestrated by ${callerOrchestratedBy.slice(0, 8)}), so it cannot create or acquire children — herds are flat (one level deep).`;
  }
  return null;
}

/** `acquire` target validation: not self, exists, and not already another
 *  parent's child (one parent per child). Re-acquiring your own child is a no-op OK. */
export function herdAcquireError(opts: {
  callerId: string;
  targetId: string;
  targetExists: boolean;
  targetOrchestratedBy?: string;
}): string | null {
  if (opts.targetId === opts.callerId) return 'Cannot acquire yourself into your own herd.';
  if (!opts.targetExists) return `Session ${opts.targetId.slice(0, 8)} does not exist.`;
  if (opts.targetOrchestratedBy && opts.targetOrchestratedBy !== opts.callerId) {
    return `Session ${opts.targetId.slice(0, 8)} is already a herd child of ${opts.targetOrchestratedBy.slice(0, 8)}. A session has exactly one parent — disown it there first.`;
  }
  return null;
}

/** `resume`/`disown` target validation: the target must be a child of THIS herd. */
export function herdMemberError(opts: {
  action: 'resume' | 'disown';
  callerId: string;
  targetOrchestratedBy?: string;
}): string | null {
  if (opts.targetOrchestratedBy !== opts.callerId) {
    return `That session is not a child of your herd, so you cannot ${opts.action} it. Call caco_herd_state to see your children.`;
  }
  return null;
}

/**
 * Whether disowning a child also parks it for auto-archival (spec-soft-archive-folder).
 *
 * True only for a child the herd itself CREATED, identified by the write-once
 * `meta.herdOriginParent` stamp. A session the herd merely acquired pre-existed the
 * herd and is handed back untouched — releasing a borrowed session must not schedule
 * it for removal. Absent provenance (a legacy bond, or any session created outside
 * `caco_herd create`) fails safe to NOT parking, mirroring the reaper's
 * "unknown age ⇒ not eligible".
 *
 * Takes the stamp rather than a `SessionMeta` so the herd core stays free of the meta
 * schema, like `childIdleDecision`.
 */
export function shouldParkOnDisown(herdOriginParent: string | undefined): boolean {
  return herdOriginParent !== undefined;
}

export interface HerdStateEntry extends HerdChild {
  lastResponse: string;
}

/** The `caco_herd_state` payload: every child plus a count. */
export function buildHerdStatePayload(entries: HerdStateEntry[]): { count: number; children: HerdStateEntry[] } {
  return { count: entries.length, children: entries };
}

/** Pure decision for a child that just went idle (spec §Wake machinery):
 *  - not a herd child → skip;
 *  - parent read missing (deleted) → self-heal (clear the child's bond);
 *  - parent read corrupt (maybe transient) → skip, do NOT orphan;
 *  - parent present → wake it. */
export function childIdleDecision(
  orchestratedBy: string | undefined,
  parentRead: 'ok' | 'missing' | 'corrupt',
): 'skip' | 'self-heal' | 'wake' {
  if (!orchestratedBy) return 'skip';
  if (parentRead === 'missing') return 'self-heal';
  if (parentRead === 'corrupt') return 'skip';
  return 'wake';
}

