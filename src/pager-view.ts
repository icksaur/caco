/**
 * Pager read model (spec-pager) — pure.
 *
 * Decides which sessions are waiting on the user and shapes the board the pager
 * page renders. Every rule that could drift lives here: the triage predicate, the
 * offer's age, and the ordering. No I/O, no globals, and no clock — `now` is
 * passed in, which keeps the module pure and makes the freshness boundary exactly
 * testable.
 *
 * The unit of work is the OFFER, not the session. The pager deliberately does NOT
 * consult unobserved state: that answers "has a human looked at this session?",
 * is a single flag shared by every client, and gating on it meant a second
 * machine viewing the session silently emptied the board.
 */

import type { SessionKind } from './session-meta-store.js';

/** Max waiting cards in one snapshot; beyond this `waitingTruncated` is set. */
export const PAGER_MAX_WAITING = 50;

/**
 * How long an offer stays on the board. An offer references a state of the world;
 * weeks later that world has moved and the actions are probably wrong, so decay
 * keeps the board honest with no gardening. It is also what makes the board
 * usable on adoption: without it, every historical offer would appear at once.
 */
export const PAGER_MAX_OFFER_AGE_MS =
  Number(process.env.CACO_PAGER_MAX_OFFER_AGE_MS) || 7 * 24 * 60 * 60 * 1000;

/**
 * Session kinds whose offers never reach the board.
 *
 * A herd child is driven and drained by its parent, and a swarm session by the
 * agent that spawned it — neither is waiting on a human, so a card for one is
 * noise the user cannot meaningfully act on. This exclusion used to be an
 * accident of gating on `isUnobserved` (only a source-less user turn marks a
 * session unobserved); dropping that gate would have silently admitted them, so
 * it is now stated outright.
 *
 * `scheduled` is deliberately NOT excluded: a run that finished overnight with
 * nobody watching is exactly what a pager is for. The old coupling hid those too.
 */
const EXCLUDED_KINDS: ReadonlySet<SessionKind> = new Set(['agent', 'swarm'] as SessionKind[]);

export interface PagerSessionInput {
  sessionId: string;
  name: string;
  cwd: string | null;
  kind: SessionKind;
  isBusy: boolean;
  /** Set when this session is a herd child: its parent drives and drains it, so
   *  it is never waiting on a human. */
  orchestratedBy?: string;
  /** Absent when the last turn offered nothing — the write is guarded on length,
   *  so this is never an empty array, and every read must tolerate absence. */
  responseOptions?: string[];
  /** When the current options were written. Absent on offers predating the field. */
  responseOptionsAt?: string;
  /** Monotonic dismissal watermark; an offer at or before it is hidden. */
  pagerDismissedAt?: string;
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

/** Epoch ms of a timestamp, or null when absent or unparseable. */
function parseTime(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * When this session's offer was made, or null if unknowable.
 *
 * Falls back to `lastIdleAt` for offers written before `responseOptionsAt`
 * existed. That is a stand-in rather than a guess: options are only ever written
 * during a turn, and `lastIdleAt` is stamped when that same turn ends, so for a
 * session still holding options the two describe the same moment. Without the
 * fallback every pre-existing offer would be invisible forever.
 */
export function offerAtOf(input: PagerSessionInput): number | null {
  return parseTime(input.responseOptionsAt) ?? parseTime(input.lastIdleAt);
}

/**
 * Whether a session is waiting on the user: stopped, holding offered next steps,
 * that offer not already dismissed, and the offer still fresh.
 *
 * An unknown offer time is treated as NOT fresh, matching the archive reaper's
 * "unknown ⇒ not eligible" stance: on missing information, never surface.
 */
export function needsTriage(input: PagerSessionInput, now: number): boolean {
  if (input.isBusy) return false;
  if (EXCLUDED_KINDS.has(input.kind)) return false;
  if (input.orchestratedBy) return false; // a herd child, whatever its kind
  if ((input.responseOptions?.length ?? 0) === 0) return false;

  const offerAt = offerAtOf(input);
  if (offerAt === null) return false;
  if (now - offerAt > PAGER_MAX_OFFER_AGE_MS) return false;

  const dismissedAt = parseTime(input.pagerDismissedAt);
  return dismissedAt === null || offerAt > dismissedAt;
}

/** Newest offer first, tie-broken by session id so two renders of one state agree
 *  and cards never reorder under the user's cursor. */
function compareWaiting(a: PagerSessionInput, b: PagerSessionInput): number {
  const at = offerAtOf(a) ?? 0;
  const bt = offerAtOf(b) ?? 0;
  if (at !== bt) return bt - at;
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
}

/** Build the full board. Always a complete snapshot — never a delta — which is
 *  what makes a missed wake-up self-correcting rather than corrupting. */
export function buildPagerView(
  inputs: PagerSessionInput[],
  busyCount: number,
  version: number,
  now: number,
): PagerView {
  const busy = inputs
    .filter(i => i.isBusy)
    .map(i => ({ sessionId: i.sessionId, name: i.name }));

  const triaged = inputs.filter(i => needsTriage(i, now)).sort(compareWaiting);

  return {
    version,
    busyCount,
    busy,
    waiting: triaged.slice(0, PAGER_MAX_WAITING).map(i => ({
      sessionId: i.sessionId,
      name: i.name,
      cwd: i.cwd,
      kind: i.kind,
      idleAt: i.responseOptionsAt ?? i.lastIdleAt ?? null,
      options: i.responseOptions ?? [],
    })),
    waitingTruncated: triaged.length > PAGER_MAX_WAITING,
  };
}
