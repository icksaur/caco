/**
 * Pager read model (spec-pager) — pure.
 *
 * Decides which sessions are waiting on the user and shapes the board the pager
 * page renders. Every rule that could drift lives here: the triage predicate and
 * the ordering. No I/O, no clock, no globals — the route supplies the inputs, the
 * active count, and the version.
 */

import type { SessionKind } from './session-meta-store.js';

/** Max waiting cards in one snapshot; beyond this `waitingTruncated` is set. */
export const PAGER_MAX_WAITING = 50;

/**
 * What the pager needs per session. Deliberately NOT `SessionListItem`, which
 * carries neither `responseOptions` (the third predicate term and the card text)
 * nor `lastIdleAt` (the ordering key).
 */
export interface PagerSessionInput {
  sessionId: string;
  name: string;
  cwd: string | null;
  kind: SessionKind;
  isBusy: boolean;
  isUnobserved: boolean;
  /** Absent when the last turn offered nothing — the write is guarded on length,
   *  so this is never an empty array, and every read must tolerate absence. */
  responseOptions?: string[];
  lastIdleAt?: string;
}

export interface PagerBusyEntry {
  sessionId: string;
  name: string;
}

export interface PagerWaitingEntry {
  sessionId: string;
  name: string;
  cwd: string | null;
  kind: SessionKind;
  idleAt: string | null;
  options: string[];
}

export interface PagerView {
  version: number;
  busyCount: number;
  busy: PagerBusyEntry[];
  waiting: PagerWaitingEntry[];
  waitingTruncated: boolean;
}

/**
 * Whether a session is waiting on the user: finished, not yet looked at, and
 * holding offered next steps. All three are required.
 *
 * Only a source-less user turn can make a session unobserved
 * (`needsObservation: !source`), so delegates, herd children and scheduled runs
 * are excluded upstream and need no filtering here.
 */
export function needsTriage(input: PagerSessionInput): boolean {
  return !input.isBusy && input.isUnobserved && (input.responseOptions?.length ?? 0) > 0;
}

/** Newest idle first, tie-broken by session id so two renders of one state agree
 *  and cards never reorder under the user's cursor. A session with no recorded
 *  idle sorts last rather than being dropped. */
function compareWaiting(a: PagerSessionInput, b: PagerSessionInput): number {
  const at = a.lastIdleAt ?? '';
  const bt = b.lastIdleAt ?? '';
  if (at !== bt) return at < bt ? 1 : -1;
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
}

/** Build the full board. Always a complete snapshot — never a delta — which is
 *  what makes a missed wake-up self-correcting rather than corrupting. */
export function buildPagerView(inputs: PagerSessionInput[], busyCount: number, version: number): PagerView {
  const busy = inputs
    .filter(i => i.isBusy)
    .map(i => ({ sessionId: i.sessionId, name: i.name }));

  const triaged = inputs.filter(needsTriage).sort(compareWaiting);

  return {
    version,
    busyCount,
    busy,
    waiting: triaged.slice(0, PAGER_MAX_WAITING).map(i => ({
      sessionId: i.sessionId,
      name: i.name,
      cwd: i.cwd,
      kind: i.kind,
      idleAt: i.lastIdleAt ?? null,
      options: i.responseOptions ?? [],
    })),
    waitingTruncated: triaged.length > PAGER_MAX_WAITING,
  };
}
