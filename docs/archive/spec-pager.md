# spec-pager

**Status:** done — all 12 plan rows shipped. As-built in `src/pager-view.ts`
(read model), `src/activity-version.ts` (long-poll parking), `src/routes/pager.ts`
(`GET /api/pager`, `POST /api/sessions/:id/pager-dismiss`) and `public/pager.html`.
Archived; `README.md` and `API.md` are the living documentation.

## Goals

A standalone page at `/pager.html` where the user triages finished work. It shows
how many sessions are working right now, and a card per session that has stopped
and is holding an unhandled offer of next-step actions. Each card shows the session
name and the full text of every offered action; clicking one sends that text to
that session so the work continues. The board updates on its own — no reload —
and a session leaves it as soon as it is acted on or dismissed.

The point is triage away from the main UI: a small surface that answers "who is
waiting on me?" and lets the user unblock them one click at a time. Mobile is the
primary consumer, so type and tap targets are sized for a phone first.

**The pager's unit of work is the OFFER, not the session**, and it is deliberately
INDEPENDENT of unobserved state. "Unobserved" answers *"has a human looked at this
session?"*; the pager asks *"has this offer been dealt with?"* Those are different
questions, and the first version wrongly coupled them by gating on `isUnobserved`.
That broke in both directions: another client viewing the session on a second
machine consumed the flag and the card silently vanished from the phone, while
dismissing on the phone cleared the unobserved dot on every desktop. Measured on
the live machine: 8 sessions held offers and **0** appeared on the board.

## Design

**The server already produces the data.** No new parsing is needed:

- `src/offer-action-parse.ts` `extractActionOptions(message)` applies the
  final-trailer rule to an assistant message and returns ≤4 options of ≤200 chars.
- `src/dispatch-events.ts:145-149` writes that to `meta.responseOptions` **only when
  the list is non-empty**.
- `src/routes/session-messages.ts:175,255,684` clear it to `undefined` whenever a new
  message is sent, so options never outlive the turn that offered them.
- `unobservedTracker` already tracks "finished but not looked at", durably
  (`meta.lastIdleAt` / `meta.lastObservedAt`).
- `dispatchState.isBusy` / `getActiveCount()` already answer "who is working".

So this feature is a **read model over existing state plus a way to wait on it**.

**`responseOptions` is non-empty-or-absent, never `[]`.** The write is guarded on
`options.length > 0` and the clear sets `undefined`, so the field is either a
populated array or missing. Every read must null-guard
(`(meta.responseOptions?.length ?? 0) > 0`); treating it as always-an-array throws on
the common case of a turn that offered nothing.

**Agent-driven sessions are excluded by kind and bond, not by accident.** In the
first version this fell out of gating on `isUnobserved`: `session-messages.ts:314`
passes `needsObservation: !source` and `idle-authority.ts:82` marks idle only under
that flag, so nothing agent-driven ever became unobserved. Dropping that gate would
have silently admitted every herd child and delegate reply to the board, so the
exclusion is now stated outright: `kind` of `agent` or `swarm`, or an
`orchestratedBy` bond, is never triaged — such a session is drained by whoever
drives it and is not the user's to action. `scheduled` is deliberately NOT excluded:
a run that finished overnight with nobody watching is precisely what a pager is for,
and the old coupling hid those too. All of them still count toward `busyCount`,
which comes from `dispatchState` and sees every dispatch.

A delegate TARGET is an ordinary interactive session, so its offers do appear. That
is intended — the offer is a real next step someone may want to take — and it is
observable in practice: of the 9 sessions holding offers on the live machine, one is
a standing reviewer session that was delegated to.

**One endpoint, not two.** The request describes a GET and a hanging GET returning
the same payload. Two endpoints returning an identical shape is code that must be
kept in sync. Instead: `GET /api/pager` with an optional `wait` — `wait=0` (or
absent) answers immediately, `wait>0` holds. This is exactly the shape
`GET /api/idle` already uses (`src/routes/idle.ts`), so it is the established
convention here rather than a new one.

**State snapshot, not an event feed.** `src/idle-feed.ts` is an append-only ring
with cursors and a `reset` flag, because its consumers must not miss an individual
idle. The pager has the opposite requirement: it only ever needs *the current
board*. Modelling it as a versioned snapshot removes ring capacity, eviction, and
reset semantics entirely, and is **self-healing** — a missed wake-up costs latency,
never correctness, because the next response carries full truth.

That property is load-bearing: it is why the instrumentation below does not have to
be provably exhaustive.

**Do not extend `/api/idle`.** Its documented contract is "a session reached a real
idle", and out-of-process automation already consumes it (spec-idle-notifications).
Adding busy transitions would change the meaning of a feed that has readers.

**Version-gated long poll.** A process-global counter increments on any transition
that can change the board. `GET /api/pager?since=<v>&wait=<ms>`:

- `since` absent or `since < version` → answer immediately.
- `since > version` → answer immediately. The counter resets when the server
  restarts, so a client holding a pre-restart version must not hang for the full
  cap. (`idle-feed.ts` treats `after > head` as stale the same way.)
- `since === version` → park until the version moves, `wait` elapses, or the client
  disconnects.

`wait` is clamped to `PAGER_WAIT_CAP_MS = 10_000`. The cap is not only a timeout:
it bounds how long a parked request can delay a graceful restart (the restart path
waits for in-flight work, `server.ts:232`), and it is the backstop that makes a
missed version bump self-correct within 10s.

Parked waiters are capped (`PAGER_WAITER_CAP = 256`, mirroring `IDLE_WAITER_CAP`);
over the cap the read answers immediately rather than accumulating waiters.

**Module split** follows the repo's pure-core/impure-runtime convention
(`herd.ts` vs `herd-runtime.ts`, `plugin-directories.ts` vs
`plugin-directories-apply.ts`):

- `src/pager-view.ts` — pure. `needsTriage(input)` and `buildPagerView(inputs, activeCount)`.
  No I/O, no clock, no globals. This is where every rule that could drift lives.
- `src/activity-version.ts` — impure. The counter, `bump()`, and `read({since, wait, signal})`
  with the parking/settle logic modelled on `IdleFeed`.
- `src/routes/pager.ts` — the route; a thin adapter, with query parsing exported pure
  so the clamp contract is testable without Express (as `parseIdleQuery` is).

**Input type — do not use `SessionListItem`.** `sessionManager.list()` returns
none of `responseOptions`, `responseOptionsAt`, `pagerDismissedAt` or `lastIdleAt`
— the predicate's terms, the card text, and the ordering key. Widening
`SessionListItem` would grow the list payload for every client that does not need
it; reading meta twice (once via `list()`, once for the missing fields) would be
wasteful. So the route gathers a purpose-built input directly:

```ts
interface PagerSessionInput {
  sessionId: string; name: string; cwd: string | null; kind: SessionKind;
  isBusy: boolean;
  responseOptions?: string[];    // absent when the turn offered nothing
  responseOptionsAt?: string;    // absent for offers predating the field
  pagerDismissedAt?: string;
  lastIdleAt?: string;
}
```

`isUnobserved` is deliberately absent: the pager does not consult it, and carrying
it would invite a future change to gate on it again.

A new `SessionManager.listForPager(): PagerSessionInput[]` builds these from the same
`sessionCache` iteration as `list()`, reading `getSessionMeta` once per session and
skipping the two `existsSync` icon probes `list()` performs — so it is strictly
cheaper than `list()` and does not touch `events.jsonl`.

**Triage predicate** (the single definition of "needs me"). A session appears iff
ALL hold — note that unobserved state is not among them:

- not busy;
- not agent-driven: `kind` is neither `agent` nor `swarm`, and no `orchestratedBy`
  bond (a herd child is drained by its parent, not by the user);
- `(responseOptions?.length ?? 0) > 0`;
- the offer is UNHANDLED: `offerAt > pagerDismissedAt` (or never dismissed);
- the offer is FRESH: `now - offerAt <= PAGER_MAX_OFFER_AGE_MS` (7 days).

`offerAt` is `responseOptionsAt ?? lastIdleAt`. `responseOptionsAt` is stamped in
the same meta write that persists the options. The fallback exists for offers
written before that field. It is a close approximation, not an identity: options
are only ever written during a turn and `lastIdleAt` is stamped when that same turn
ends, so the two normally describe the same moment — but any later idle that does
not clear the options would advance `lastIdleAt` and make a legacy offer read
fresher than it is. Self-limiting: it applies only to offers predating the field,
and the 7-day window caps how far it can mislead. Without the fallback every pre-existing offer would be
invisible forever; with it, the two genuinely recent ones show immediately.

**Freshness is semantic, not just a cold-start guard.** An offer references a
state of the world; three weeks on, that world has moved and the actions are
probably wrong. Decay keeps the board honest with no gardening. It is also what
makes adoption safe: of the 8 sessions holding offers on the live machine, 6 are
10–76 days old and only 2 fall inside the window.

**Dismissal is a watermark, not a flag.** Dismiss writes `pagerDismissedAt = now`
and touches nothing else — in particular it does NOT mark the session observed.
A later offer beats the watermark by timestamp, so a card returns exactly when
there is genuinely new work and never merely because time passed. Nothing has to
clear the watermark, so there is no second piece of state to keep in sync.

**Snapshot shape:**

- `version: number`
- `busyCount: number` — `dispatchState.getActiveCount()`
- `busy: [{ sessionId, name }]` — for the working indicator
- `waiting: [{ sessionId, name, cwd, kind, idleAt, options: string[] }]`
- `waitingTruncated: boolean` — `waiting` is capped at `PAGER_MAX_WAITING = 50`

**Bump sites call `activityVersion.bump()` directly** at each transition:
`dispatchState.start()` and `end()`, the `responseOptions` write in
`dispatch-events.ts`, the pager dismiss, and session create/delete. The unobserved
mark/observe bump is REMOVED: the board no longer depends on that state, so waking
every poller for it is pure churn. Aging out at the 7-day boundary raises no bump
and needs none — the route rebuilds the snapshot on every response, including a
timed-out park, so a card disappears within one poll cycle. A
`'change'` event plus a subscriber would be an extra layer that does nothing a
direct call does not, and would be inert until someone remembered to wire the
listener. Missing a site degrades latency to ≤10s, never correctness.

**Wake coalescing is required, not optional.** The counter is process-global, so
every dispatch start/end in *any* session wakes *every* parked poller, and each wake
rebuilds the snapshot. Under exactly the workload this page exists to watch — a
swarm or herd churning dispatches — that is many wakes per second, multiplied by open
tabs. `bump()` therefore schedules the settle at most once per
`PAGER_COALESCE_MS = 250`: bursts collapse into one wake, bounding wake frequency to
≤4/s regardless of churn while keeping perceived latency far under the ~1s target.
The 10s cap bounds *staleness*; coalescing bounds *work*. They are different limits
and both are needed.

**The page** follows `public/portal.html`: one self-contained HTML file with inline
vanilla JS, served automatically by `express.static('public')` (`server.ts:169`),
no build step and no new esbuild entry point. This is deliberate, not lazy: a new
`public/ts/*.ts` file is automatically added to the frontend coverage denominator
(`scripts/check-frontend-coverage.mjs`) and would **break the 73% floor** unless
accompanied by DOM tests. All logic worth testing is on the server in
`pager-view.ts`, where it is cheap to test properly; the page stays a renderer.

**Page layout — three zones, no chrome.** The page is glanced at on a phone, so
everything that is not information is removed:

1. **A small "live" badge, top centre.** The only persistent chrome. It reports the
   poll's health (`live` / `reconnecting`), which is the one thing the board itself
   cannot convey: a frozen board and an up-to-date empty board look identical, so
   without it the user cannot trust what they are seeing.
2. **One row per running session**, each with its own throbber and the session's
   name. Replaces the aggregate count and the single joined line — names run
   together on one row were unreadable, which was the actual complaint, and a count
   answers "how many" when the useful question is "which one".
3. **The action cards**, unchanged.

Removed: the "Pager" heading (the page has one purpose and its title bar already
says so) and the running count (`busyCount`), which is now unused by the page.

**`busyCount` stays in the snapshot** even though the page stops rendering it —
but not because it carries information `busy` lacks. It does not: the only two
`dispatchState.start()` callers (the message path and `archiveCore`) both operate
on a session already in `sessionCache`, and the one window where the two diverge
(inside `archiveCore`, between the cache delete and the dispatch end) contains no
`await`, so no route handler can build a snapshot inside it. In every observable
snapshot `busyCount === busy.length`. It stays because it is a shipped, documented
API field that out-of-process readers may consume, and removing it would be a
gratuitous breaking change for no gain. Nothing observable is lost by dropping it
from the page.

**Running rows are ordered in `buildPagerView`, not the page** — by
`name || sessionId` then `sessionId`, for the same reason cards are: the underlying
`busy` array follows session-cache insertion order, which changes across a restart,
and rows that reshuffle under a glance are worse than useless. Sorting on the same
string the page displays keeps a nameless session from sorting under `''` while
showing an id. Ordering is a rule, so it lives in the pure module with the others.

**Acting on an option** is `POST /api/sessions/:id/messages` with `{ prompt: <exact
option text> }` and no `source` — the plain user-message path
(`src/routes/session-messages.ts:120`). The session then becomes busy and its
`responseOptions` are cleared, so it leaves the board on the next poll without any
client-side removal.

**Dismiss** is `POST /api/sessions/:id/pager-dismiss`, which writes only
`pagerDismissedAt`. It does NOT mark the session observed — that would clear the
dot on every other client from a phone tap. Included because without it a card the
user does not want to act on would sit on the board until it aged out.

## Invariants

- **The triage rule has one definition.** `needsTriage` in `src/pager-view.ts` is the
  only place that decides what appears; the page never re-derives it. The snapshot
  and any future consumer therefore cannot disagree.
- **The pager never reads or writes unobserved state.** It does not gate on
  `isUnobserved`, and dismiss does NOT call `markObserved`. That state answers a
  different question and is shared with every other client; coupling them is what
  made cards vanish when a second machine viewed the session, and made a phone
  dismissal clear a desktop dot.
- **A click is bound to session id and option text, never to list position.** The
  card element carries the session id and the button carries its own option text, so
  a re-render between paint and click cannot retarget the action. **No automated
  oracle** — see Acceptance.
- **Model-derived strings are inserted as text, never as HTML.** Session names and
  option text are untrusted model output.
- **Ordering is deterministic**, and owned by `buildPagerView`: cards by `offerAt`
  descending then `sessionId`; running rows by name then `sessionId`. Two renders of
  the same state produce the same order, so nothing jumps under the user's cursor or
  reshuffles across a restart.
- **Dismissal is monotonic.** `pagerDismissedAt` only ever moves forward and is
  never cleared; a card returns only because a NEWER offer outranks it, never
  because state was reset.
- **The response is always a full snapshot.** No delta, no cursor, no client-side
  merge — this is what makes a missed bump self-correcting.
- **`since` is read and the waiter registered in one synchronous block**, so no
  transition can land between the version read and the parking (single-threaded;
  an `await` inserted between them would reintroduce a lost-wakeup window).
- **`/api/idle`'s contract is unchanged** — no busy events are appended to it.

## Considerations

- **Restart interaction.** A parked request delays graceful restart until it
  settles. Bounded two ways: the 10s cap, and aborting on client disconnect via
  `req.on('close')` exactly as `routes/idle.ts:42` does.
- **Version read vs snapshot build.** Report the version read at the moment the
  snapshot is built, not the version that woke the waiter — otherwise the reported
  version can lag the data and the client re-polls needlessly.
- **`responseOptions` is absent or non-empty, never `[]`** (the write is guarded on
  length), so every read must null-guard. Getting this wrong throws on the *common*
  case: a session whose last turn offered nothing.
- **A busy session cannot legitimately have options** (they are cleared on send),
  but the predicate checks `!isBusy` explicitly rather than relying on that
  coupling holding forever.
- **Acting on a session that just became busy** returns 409 `SESSION_BUSY`
  (`session-messages.ts:192`). This is a real race — the pager shows a moment-old
  view. Surface it as a transient, non-destructive message and refresh; do not
  retry automatically.
- **A session deleted between render and click** returns 404. Same handling.
- **Snapshot cost.** `listForPager()` reads `getSessionMeta` once per session and
  never touches `events.jsonl`. It deliberately does not reuse `list()`, which
  additionally stats for an icon per session — work the pager has no use for and
  would pay on every wake.
- **Freshness needs a clock, so `now` is a parameter.** `buildPagerView` takes the
  current time rather than calling `Date.now()`, keeping the module pure and the
  age boundary exactly testable.
- **A malformed timestamp must not admit a card.** An unparseable `offerAt` is
  treated as unknown age and therefore NOT fresh, matching the reaper's existing
  "unknown ⇒ not eligible" stance: on missing information, never surface.
- **An archive shows as a running row.** `archiveCore` holds a dispatch, so a
  session being archived is `isBusy` until its cache entry is dropped. It used to
  be an anonymous +1 in the count; per-session rows promote it to a named,
  throbbing row — a maintenance op that reads as work. Pre-existing and rare
  (seconds), accepted rather than special-cased, since suppressing it would mean
  the page knowing about dispatch reasons.
- **Empty board.** With nothing waiting, the page shows an explicit resting state
  ("nothing waiting") rather than a blank panel, alongside a busy indicator reading
  zero. This is the state the board is in most of the time and must not look broken
  or still-loading.
- **Multiple pager tabs** are independent pollers; nothing is shared or leased.
- **Option text is untrusted model output** and must be inserted as text, never as
  HTML.

## Risks and Mitigations

- **Wake storm.** The version is global, so churn in any session wakes every parked
  poller and rebuilds a snapshot. Mitigated by coalescing bumps into one settle per
  250ms and by `listForPager()` being cheaper than `list()`. Without coalescing the
  cost is dispatch-churn × open-tabs × session-count, worst exactly when a swarm is
  running — the case the page exists for.
- **A forgotten bump site leaves the board stale.** Mitigated structurally: the 10s
  cap plus full-snapshot responses bound staleness at 10s regardless of
  instrumentation. This is why the design is snapshot-based.
- **Adding an emit to `dispatchState.start()` disturbs existing behaviour.** Avoided
  entirely: `bump()` is called directly, so no new event exists and the `'idle'`
  emit and its suppression logic are untouched.
- **Long-poll storm from many tabs.** Mitigated by the waiter cap (immediate answer
  over the cap) and by the fact that a wake-up serves all parked waiters from one
  snapshot build.
- **Unbounded response growth** with many waiting sessions. Mitigated by
  `PAGER_MAX_WAITING` with an explicit `waitingTruncated` flag rather than a silent
  cut.
- **Clicking sends the wrong text** if an option is HTML-escaped or trimmed on the
  way through the DOM. Mitigated by sending the exact string from the snapshot held
  in JS state rather than re-read from the DOM. Residual: manual signoff only.
- **XSS via option or session name.** Mitigated by text-node insertion only, plus a
  static assertion that the page contains no HTML sink.

## Acceptance

- Observable: with the server running, open `http://localhost:53000/pager.html`.
  While a session is working, one throbber row per running session names it, and
  the "live" badge sits small and centred above them. When a session
  finishes a turn ending in a `caco-actions` block, a card appears within ~1s with
  no reload, showing the session name and every option in full. Clicking an option
  sends it and the card disappears; the target session starts working. Dismiss
  removes the card without sending anything. **Requires visual signoff.**
- Budgets: a parked request holds ≤10s; wakes are coalesced to ≤4/s regardless of
  dispatch churn; the snapshot performs no `events.jsonl` reads and no icon stats.
- Gates: `npm run build` (the full parallel gate: typecheck ×2, lint:strict, knip,
  2600+ tests with coverage floors, scan:pii, check:specs) green.
- Oracles:
  - **needsTriage hand table** — every combination of {busy, options absent /
    empty / non-empty, offer newer vs older than dismissal, offer inside vs outside
    the freshness window} mapped to a hand-computed expected boolean, written
    before the implementation. Pins that unobserved state is NOT consulted: a row
    with `isUnobserved` absent from the input type cannot compile if it creeps back.
  - **agent-driven exclusion** — `kind: agent`, `kind: swarm`, and an
    `orchestratedBy` bond each keep a session off the board even when it holds a
    fresh undismissed offer; `kind: scheduled` does NOT.
  - **offer age boundary** — an offer exactly at `PAGER_MAX_OFFER_AGE_MS` is fresh
    and one millisecond older is not, with `now` injected.
  - **offerAt fallback** — a session with `responseOptions` but no
    `responseOptionsAt` uses `lastIdleAt`; one with neither is not fresh and does
    not appear.
  - **dismissal watermark** — an offer at or before `pagerDismissedAt` is hidden; a
    strictly newer offer for the same session reappears. Proves a card returns for
    new work and not for the passage of time.
  - **dismiss does not observe** — the pager dismiss endpoint writes
    `pagerDismissedAt` and leaves `lastObservedAt` and the unobserved set untouched
    (asserted against the tracker, not just the meta write).
  - **buildPagerView reference** — a fixed input list compared against an
    independently constructed expected snapshot (hand-written, not derived from the
    production function), covering ordering, the `MAX_WAITING` cap with
    `waitingTruncated`, and exact option-text passthrough.
  - **deterministic ordering** — cards with equal `offerAt` fall back to a stable
    `sessionId` tie-break, and running rows with equal names likewise; shuffling
    either input does not change the output order.
  - **immediate vs parked** — `since < version` answers without waiting;
    `since === version` parks and resolves on `bump()`; `since > version` (restart)
    answers immediately rather than hanging.
  - **wait clamp** — `wait=60000` is clamped to 10_000; `wait` absent or 0 answers
    immediately. Pure query-parse test, no Express.
  - **coalescing** — N rapid `bump()`s inside one `PAGER_COALESCE_MS` window settle a
    parked reader exactly once, and a bump after the window settles again.
  - **abort** — an aborted signal settles the parked read and clears its timer (no
    leaked timer; assert via the same seam `IdleFeed` tests use).
  - **waiter cap** — the 257th concurrent read answers immediately instead of parking.
  - **bump coverage** — dispatch start, dispatch end, `markIdle`, `markObserved`, and
    a `responseOptions` write each move the version.
  - **no raw HTML sink** — a static assertion over `public/pager.html` that it
    contains no `innerHTML`/`insertAdjacentHTML`/`document.write`, so model-derived
    text cannot reach an HTML sink. Cheap, automated, and catches the regression that
    matters; it does not prove correct rendering.
  - **RESIDUAL, no automated oracle — covered by manual signoff only:** that the DOM
    actually renders option text inertly, that a click posts the byte-exact option
    string, and that a click targets the card's own session after a re-render. These
    are only violable inside the page's inline script, which the server-side oracles
    above do not execute. Testing them would require a jsdom harness for an inline
    script; the deliberate trade is to keep the page trivial enough to eyeball and to
    hold every decidable rule server-side. Signoff must exercise: an option
    containing `<script>` and backticks, an option with non-ASCII punctuation, and a
    click made immediately after a board re-render. Also, since three of the four
    layout changes have no automated oracle: the badge is small and top-centre, no
    title is present, and each running session gets its own readable throbber row.

## Plan

All 12 rows are SHIPPED; this table is the as-built record, not remaining work.

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 1 | Pure `needsTriage` + `buildPagerView` + `PagerSessionInput` + constants (`PAGER_MAX_WAITING`) | `src/pager-view.ts`, `tests/unit/pager-view.test.ts` | needsTriage hand table (incl. absent options); buildPagerView reference; deterministic ordering | one-definition; deterministic-order |
| 2 | `ActivityVersion`: counter, `bump()` with `PAGER_COALESCE_MS` settle window, `read({since,wait,signal})`, waiter park/settle | `src/activity-version.ts`, `tests/unit/activity-version.test.ts` | immediate vs parked; restart-stale; wait clamp; coalescing; abort; waiter cap | full-snapshot; sync-register |
| 3 | Call `activityVersion.bump()` at each transition: dispatch start/end, responseOptions write, session create/delete (**row 9 removes the unobserved bump added here**) | `src/dispatch-state.ts`, `src/unobserved-tracker.ts`, `src/dispatch-events.ts`, `src/session-manager.ts`, `tests/unit/activity-version-wiring.test.ts` | bump coverage | idle-feed-unchanged |
| 4 | `SessionManager.listForPager(): PagerSessionInput[]` — same cache iteration as `list()`, one meta read, no icon stat | `src/session-manager.ts`, `tests/unit/session-manager-pager-inputs.test.ts` | returns options, responseOptionsAt, pagerDismissedAt, orchestratedBy and lastIdleAt; performs no events.jsonl read | snapshot-cost |
| 5 | `GET /api/pager` route with exported pure query parser; abort on client close; mount in the router index | `src/routes/pager.ts`, `src/routes/index.ts`, `tests/unit/pager-route.test.ts` | wait clamp (pure); snapshot shape | full-snapshot |
| 6 | `public/pager.html` — self-contained page: busy indicator + count, cards, click-to-send, dismiss, explicit empty state, poll loop with backoff on error | `public/pager.html`, `tests/unit/pager-page-static.test.ts` | no-raw-HTML-sink static assertion; **manual visual signoff** for rendering, click payload, and re-render targeting | not-observing; click-bound-to-id; text-not-html |
| 7 | Document the endpoint and the page | `README.md`, `API.md` | - | - |
| 8 | Re-gate on the offer: add `SessionMeta.responseOptionsAt` (stamped with the options) and `pagerDismissedAt`; `needsTriage` drops `isUnobserved` and gains the dismissal watermark + 7-day freshness with injected `now` | `src/session-meta-store.ts`, `src/dispatch-events.ts`, `src/pager-view.ts`, `src/session-manager.ts` (thread the new fields through `listForPager`, drop `isUnobserved`), `tests/unit/pager-view.test.ts` | needsTriage hand table; offer age boundary; offerAt fallback; dismissal watermark | pager-ignores-unobserved; dismissal-monotonic |
| 9 | `POST /api/sessions/:id/pager-dismiss` writing only `pagerDismissedAt`; drop the unobserved bump; point the page's Dismiss at it | `src/routes/pager.ts`, `src/unobserved-tracker.ts`, `public/pager.html`, `tests/unit/pager-route.test.ts` | dismiss-does-not-observe | pager-ignores-unobserved |
| 10 | Size type and tap targets for a phone (mobile is the primary consumer) | `public/pager.html` | manual visual signoff | - |
| 11 | Order the `busy` array by name then `sessionId` in `buildPagerView` | `src/pager-view.ts`, `tests/unit/pager-view.test.ts` | running-row ordering oracle | deterministic-order |
| 12 | Strip the header to a small centred "live" badge; drop the title and the running count; render one throbber row per running session. The page reads `busyCount` in THREE places — the count text, the spinner state, and the two-state empty message — so all three must move to `(view.busy \|\| []).length` or be removed, or the static oracle passes while the empty-state distinction silently regresses | `public/pager.html`, `README.md` (the Pager section still promises "how many sessions are working"), `tests/unit/pager-page-static.test.ts` | static assertion that the page no longer reads `busyCount`; **manual visual signoff** (badge small + top-centre, no title, one readable throbber row per running session) | - |

## Rationale (optional, skippable)

The original framing asked for three pieces: extend the status API with actions, add
a hanging variant, then build the page. Investigation showed the first piece is
already built — `meta.responseOptions` is parsed, persisted, cleared on send, and
already returned by two existing routes. What is genuinely missing is a *view* over
it and a way to wait on changes.

The main judgement call is snapshot-versus-feed. A feed (like `idle-feed.ts`) is the
right model when a consumer must not miss any individual event — that is why the
idle feed carries cursors, eviction detection, and a `reset` flag. A pager has no
such need: it is a board, and the only question is what it looks like now. Choosing a
versioned snapshot deletes an entire class of bugs (cursor drift, ring eviction,
partial merges) and makes the 10s cap do double duty as a correctness backstop, so
the instrumentation is allowed to be imperfect.

Keeping the page build-free is the second judgement call. It looks like a shortcut
but is the opposite: the repo's frontend coverage gate would treat a new
`public/ts/*.ts` file as untested surface and fail the push. Rather than write
jsdom tests for what is essentially a `fetch` loop and a list renderer, the design
pushes every decidable rule to `pager-view.ts`, where oracles are cheap and exact,
and leaves the page with nothing worth asserting.
