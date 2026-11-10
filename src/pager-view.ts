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

import type { SessionKind, WakeState } from './session-meta-store.js';

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
  /** The session's self-wake, if it has one (spec-session-wake). */
  wake?: WakeState;
  /** Staged in auto-archive: any wake is suspended, shown as "would wake". */
  archived?: boolean;
}

/** Just enough of a wake for the pager's badge: cadence, paused, failing, archived. */
export interface PagerWakeBadge {
  everyHours: number;
  pausedReason?: WakeState['pausedReason'];
  failed?: true;
  archived?: true;
}

export function pagerWakeBadge(wake: WakeState | undefined, archived = false): PagerWakeBadge | undefined {
  if (!wake) return undefined;
  const badge: PagerWakeBadge = { everyHours: wake.everyMinutes / 60 };
  if (wake.pausedReason) badge.pausedReason = wake.pausedReason;
  if (wake.lastResult === 'error') badge.failed = true;
  if (archived) badge.archived = true;
  return badge;
}

export interface PagerBusyEntry {
  sessionId: string;
  name: string;
  wake?: PagerWakeBadge;
}

export interface PagerWaitingEntry {
  sessionId: string;
  name: string;
  cwd: string | null;
  kind: SessionKind;
  idleAt: string | null;
  options: string[];
  wake?: PagerWakeBadge;
}

/** One session with a self-wake, for the read-only "Scheduled wakes" list. */
export interface PagerWakeEntry {
  sessionId: string;
  name: string;
  everyHours: number;
  nextWakeAt: string;
  note?: string;
  lastWakeAt?: string;
  lastResult?: WakeState['lastResult'];
  pausedReason?: WakeState['pausedReason'];
  /** Staged in auto-archive: suspended until the session is moved out. */
  archived?: true;
  /** The session is holding an offer on the board right now. */
  waiting?: true;
  busy?: true;
}

export interface PagerView {
  version: number;
  busyCount: number;
  busy: PagerBusyEntry[];
  waiting: PagerWaitingEntry[];
  waitingTruncated: boolean;
  wakes: PagerWakeEntry[];
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

/** Running rows: by the same string the page displays, then by session id.
 *  The `busy` array follows session-cache insertion order, which changes across a
 *  restart, and rows that reshuffle under a glance are worse than useless. */
function compareBusy(a: { sessionId: string; name: string }, b: { sessionId: string; name: string }): number {
  const an = a.name || a.sessionId;
  const bn = b.name || b.sessionId;
  if (an !== bn) return an < bn ? -1 : 1;
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
}

/** Display title for one entry. The server passes the session list's title ladder
 *  (spec-auto-name-sessions); it is called only for entries that reach the board,
 *  so a ladder that reads from disk costs nothing for undisplayed sessions. */
export type PagerTitleOf = (input: PagerSessionInput) => string;

const nameOnly: PagerTitleOf = i => i.name;

/** Terminal fallback, the same literal the session list shows. */
export const PAGER_NO_SUMMARY = 'No summary';
/** Workspace summaries can run to a paragraph; a card head needs a line. */
export const PAGER_TITLE_MAX_CHARS = 100;

function hasText(x: unknown): x is string {
  return typeof x === 'string' && x.trim().length > 0;
}

/**
 * The session list's title ladder (spec-auto-name-sessions): manual name, then the
 * SDK's workspace summary, then the first reported intent (`autoName`), then
 * "No summary". `summary` is a thunk so the disk read happens only when no manual
 * name exists.
 */
export function pagerTitle(name: string | undefined, summary: () => string | null | undefined, autoName: string | undefined): string {
  let title: string = PAGER_NO_SUMMARY;
  if (hasText(name)) title = name;
  else {
    const s = summary();
    if (hasText(s)) title = s;
    else if (hasText(autoName)) title = autoName;
  }
  return title.length > PAGER_TITLE_MAX_CHARS ? title.slice(0, PAGER_TITLE_MAX_CHARS) + '…' : title;
}

/** Newest offer first, tie-broken by session id so two renders of one state agree
 *  and cards never reorder under the user's cursor. */
function compareWaiting(a: PagerSessionInput, b: PagerSessionInput): number {
  const at = offerAtOf(a) ?? 0;
  const bt = offerAtOf(b) ?? 0;
  if (at !== bt) return bt - at;
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
}

/** Attach a wake badge only when there is one, so wake-less entries keep their old shape. */
function withWake<T extends object>(entry: T, input: PagerSessionInput): T & { wake?: PagerWakeBadge } {
  const badge = pagerWakeBadge(input.wake, !!input.archived);
  return badge ? { ...entry, wake: badge } : entry;
}

/** Build the full board. Always a complete snapshot — never a delta — which is
 *  what makes a missed wake-up self-correcting rather than corrupting. */
export function buildPagerView(
  inputs: PagerSessionInput[],
  busyCount: number,
  version: number,
  now: number,
  titleOf: PagerTitleOf = nameOnly,
): PagerView {
  const busy = inputs
    .filter(i => i.isBusy)
    .map(i => withWake({ sessionId: i.sessionId, name: titleOf(i) }, i))
    .sort(compareBusy);

  const triaged = inputs.filter(i => needsTriage(i, now)).sort(compareWaiting);
  const shown = new Set(triaged.slice(0, PAGER_MAX_WAITING).map(i => i.sessionId));

  return {
    version,
    busyCount,
    busy,
    waiting: triaged.slice(0, PAGER_MAX_WAITING).map(i => withWake({
      sessionId: i.sessionId,
      name: titleOf(i),
      cwd: i.cwd,
      kind: i.kind,
      idleAt: i.responseOptionsAt ?? i.lastIdleAt ?? null,
      options: i.responseOptions ?? [],
    }, i)),
    waitingTruncated: triaged.length > PAGER_MAX_WAITING,
    wakes: inputs
      .filter((i): i is PagerSessionInput & { wake: WakeState } => !!i.wake)
      .map(i => wakeEntry(i, titleOf(i), shown.has(i.sessionId)))
      .sort(compareWakes),
  };
}

function wakeEntry(i: PagerSessionInput & { wake: WakeState }, name: string, waiting: boolean): PagerWakeEntry {
  const w = i.wake;
  const e: PagerWakeEntry = { sessionId: i.sessionId, name, everyHours: w.everyMinutes / 60, nextWakeAt: w.nextWakeAt };
  if (w.note) e.note = w.note;
  if (w.lastWakeAt) e.lastWakeAt = w.lastWakeAt;
  if (w.lastResult) e.lastResult = w.lastResult;
  if (w.pausedReason) e.pausedReason = w.pausedReason;
  if (i.archived) e.archived = true;
  if (waiting) e.waiting = true;
  if (i.isBusy) e.busy = true;
  return e;
}

/** Wakes that will fire, soonest first; then archived (suspended); then paused. */
function wakeRank(e: PagerWakeEntry): number {
  return e.pausedReason ? 2 : e.archived ? 1 : 0;
}

function compareWakes(a: PagerWakeEntry, b: PagerWakeEntry): number {
  const ap = wakeRank(a);
  const bp = wakeRank(b);
  if (ap !== bp) return ap - bp;
  const at = parseTime(a.nextWakeAt) ?? Infinity;
  const bt = parseTime(b.nextWakeAt) ?? Infinity;
  if (at !== bt) return at < bt ? -1 : 1;
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
}
