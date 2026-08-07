/**
 * Herd runtime glue (spec-session-orchestration Slice B: B2, B4, B7).
 *
 * Impure wiring around the pure herd core (src/herd.ts): rebuild the membership
 * index from disk, the child-idle / parent-idle hook, the wake dispatch, and the
 * post-listen boot scan. Kept separate from herd-tools.ts (which pulls in the SDK
 * defineTool) so the dispatch path (session-messages.ts) can import the hook
 * without the tool surface.
 */

import { SERVER_URL } from './config.js';
import { listSessionIds } from './sdk-session-store.js';
import { sessionManager } from './session-manager.js';
import { getSessionMeta, readSessionMeta, updateSessionMeta, markSessionIdle } from './storage.js';
import {
  rebuildHerdIndex,
  registerHerdBond,
  clearHerdBond,
  getHerdChildren,
  isHerdParent,
  getHerdParent,
  deriveChildStatus,
  childIdleDecision,
  wakeParentIfNeeded,
  type HerdChild,
  type WakeDeps,
} from './herd.js';

/** Rebuild the in-memory membership index by scanning every session's bond.
 *  Called on boot (and re-derivable any time). */
export function rebuildHerdIndexFromDisk(): void {
  const bonds: Array<{ childId: string; parentId: string }> = [];
  for (const id of listSessionIds()) {
    const meta = getSessionMeta(id);
    if (meta?.orchestratedBy) bonds.push({ childId: id, parentId: meta.orchestratedBy });
  }
  rebuildHerdIndex(bonds);
}

/** Live child snapshot for a parent (status from the runtime). */
function gatherChildren(parentId: string): HerdChild[] {
  return getHerdChildren(parentId).map(id => {
    const meta = getSessionMeta(id);
    return {
      sessionId: id,
      name: meta?.name ?? null,
      status: deriveChildStatus(sessionManager.isBusy(id), sessionManager.isActive(id)),
      lastIdleAt: meta?.lastIdleAt ?? null,
    };
  });
}

/** POST the `[system]` wake into an idle parent. source:'system' needs no
 *  fromSession/correlationId (the route's agent-guard does not apply). */
async function dispatchWake(parentId: string, _readyCount: number, summary: string): Promise<void> {
  try {
    await fetch(`${SERVER_URL}/api/sessions/${parentId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: summary, source: 'system' }),
    });
  } catch {
    /* best-effort; the parent-idle trigger / boot scan will retry */
  }
}

const wakeDeps: WakeDeps = {
  getChildren: gatherChildren,
  isParentBusy: (id) => sessionManager.isBusy(id),
  dispatchWake,
};

/** Wake a parent if any of its children need attention (trailing-edge serialized). */
export function wakeParent(parentId: string): Promise<void> {
  return wakeParentIfNeeded(parentId, wakeDeps);
}

/**
 * The child-idle / parent-idle hook — call on every `session.idle`.
 * Stamps `lastIdleAt` unconditionally (so agent-sourced children report a fresh
 * idle time), then: if the session is a herd child, resolve its parent and
 * self-heal (missing) / skip (corrupt) / wake (present); if the session is
 * itself a parent, re-evaluate its own herd.
 *
 * This stamp is a COLDNESS signal only. It deliberately does not decide the
 * unobserved badge — that verdict is persisted by the tracker, which the
 * authority calls only for idles a human is owed (spec-observation-authority).
 */
export async function onSessionIdle(sessionId: string): Promise<void> {
  // A caco_enable_tools reveal-idle is NOT a real idle: the session is about to
  // auto-continue in a fresh dispatch (spec-idle-authority). Skip the herd stamp
  // and parent wake so a herd child that reveals a tool does not wake its parent
  // mid-work. Belt-and-suspenders: the idle authority already routes false idles
  // away from this hook; this guard also protects any other future caller.
  if (sessionManager.hasPendingAutoContinue(sessionId)) return;

  markSessionIdle(sessionId);

  const meta = getSessionMeta(sessionId);
  const orchestratedBy = meta?.orchestratedBy;
  if (orchestratedBy) {
    const parentRead = readSessionMeta(orchestratedBy);
    const kind = parentRead.ok ? 'ok' : parentRead.kind;
    const decision = childIdleDecision(orchestratedBy, kind);
    if (decision === 'self-heal') {
      updateSessionMeta(sessionId, m => { m.orchestratedBy = undefined; });
      clearHerdBond(sessionId);
    } else if (decision === 'wake') {
      // The index may be cold for a freshly-bonded child; ensure membership.
      registerHerdBond(sessionId, orchestratedBy);
      await wakeParent(orchestratedBy);
    }
  }

  // A parent that just went idle re-evaluates its own herd (drain-all enforcement).
  if (isHerdParent(sessionId)) {
    await wakeParent(sessionId);
  }
}

/**
 * Post-listen boot scan: rebuild the index, then wake every parent with a
 * non-active child and self-heal any child whose parent is gone. Restart/crash
 * recovery. MUST run after the server is listening (the wake POSTs the route).
 */
export async function scanHerdsOnBoot(): Promise<void> {
  rebuildHerdIndexFromDisk();

  // Self-heal orphaned children (parent gone while the server was down).
  for (const id of listSessionIds()) {
    const meta = getSessionMeta(id);
    const parentId = meta?.orchestratedBy;
    if (!parentId) continue;
    const parentRead = readSessionMeta(parentId);
    if (!parentRead.ok && parentRead.kind === 'missing') {
      updateSessionMeta(id, m => { m.orchestratedBy = undefined; });
      clearHerdBond(id);
    }
  }

  // Wake each parent that still has children needing attention.
  const parents = new Set<string>();
  for (const id of listSessionIds()) {
    const p = getHerdParent(id);
    if (p) parents.add(p);
  }
  for (const parentId of parents) {
    await wakeParent(parentId);
  }
}

/** Clean up a parent's children when the parent is deleted (orphan prevention). */
function disownChildrenOf(parentId: string): void {
  for (const childId of getHerdChildren(parentId)) {
    updateSessionMeta(childId, m => { m.orchestratedBy = undefined; });
    clearHerdBond(childId);
  }
}

/**
 * Herd cleanup for a DELETED session. Handles both roles in one call so neither
 * is forgotten: (1) if the session was a parent, disown its children; (2) if the
 * session was itself a child, clear its own bond from the index — otherwise the
 * deleted child lingers as a "ghost" in the in-memory index (its meta.json is
 * gone, so it reads as inactive → perpetually "ready"), which would re-wake its
 * parent every idle (Slice B has no stall guard) and could never be disowned.
 */
export function onSessionDeleted(sessionId: string): void {
  disownChildrenOf(sessionId);
  clearHerdBond(sessionId);
}
