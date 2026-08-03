# spec-pager

## Goals

A standalone page at `/pager.html` where the user triages finished work. It shows
how many sessions are working right now, and a card per session that has stopped,
has not been looked at, and offered next-step actions. Each card shows the session
name and the full text of every offered action; clicking one sends that text to
that session so the work continues. The board updates on its own — no reload —
and a session leaves it as soon as it is acted on or dismissed.

The point is triage away from the main UI: a small surface that answers "who is
waiting on me?" and lets the user unblock them one click at a time.

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

**Only a source-less user turn can make a session unobserved.**
`session-messages.ts:314` passes `needsObservation: !source`, and
`idle-authority.ts:82` calls `markIdle` only under that flag (`markIdle` also skips
`kind === 'swarm'`, `unobserved-tracker.ts:59`). Delegates, herd children, scheduled
runs and auto-continuations therefore never become unobserved and never produce a
card — they are already excluded upstream, so the pager needs no kind-filtering of
its own. They still count toward `busyCount`, which comes from `dispatchState` and
sees every dispatch. This is why `isUnobserved` is the load-bearing term in the
predicate, and it is exactly the "waiting on *me*" semantic the board wants.

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

**Input type — do not use `SessionListItem`.** `sessionManager.list()`
(`session-manager.ts:1591`, type at `:312`) returns **neither** `responseOptions` nor
`lastIdleAt`, which are the predicate's third term, the card text, and the ordering
key. Widening `SessionListItem` would grow the list payload for every client that
does not need it; reading meta twice (once via `list()`, once for the missing
fields) would be wasteful. So the route gathers a purpose-built input directly:

```ts
interface PagerSessionInput {
  sessionId: string; name: string; cwd: string | null; kind: SessionKind;
  isBusy: boolean; isUnobserved: boolean;
  responseOptions?: string[];   // absent when the turn offered nothing
  lastIdleAt?: string;
}
```

A new `SessionManager.listForPager(): PagerSessionInput[]` builds these from the same
`sessionCache` iteration as `list()`, reading `getSessionMeta` once per session and
skipping the two `existsSync` icon probes `list()` performs — so it is strictly
cheaper than `list()` and does not touch `events.jsonl`.

**Triage predicate** (the single definition of "needs me"), all three required:
not busy, unobserved, and `(responseOptions?.length ?? 0) > 0`.

**Snapshot shape:**

- `version: number`
- `busyCount: number` — `dispatchState.getActiveCount()`
- `busy: [{ sessionId, name }]` — for the working indicator
- `waiting: [{ sessionId, name, cwd, kind, idleAt, options: string[] }]`
- `waitingTruncated: boolean` — `waiting` is capped at `PAGER_MAX_WAITING = 50`

**Bump sites call `activityVersion.bump()` directly** at each transition:
`dispatchState.start()` and `end()`, `unobservedTracker.markIdle`/`markObserved`,
the `responseOptions` write in `dispatch-events.ts`, and session create/delete. A
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

**Acting on an option** is `POST /api/sessions/:id/messages` with `{ prompt: <exact
option text> }` and no `source` — the plain user-message path
(`src/routes/session-messages.ts:120`). The session then becomes busy and its
`responseOptions` are cleared, so it leaves the board on the next poll without any
client-side removal.

**Dismiss** is `POST /api/sessions/:id/observe`, which already exists
(`src/routes/sessions.ts:603`). It clears unobserved, so the card leaves the board.
Included because without it a card the user does not want to act on would sit on
the board permanently.

## Invariants

- **The triage rule has one definition.** `needsTriage` in `src/pager-view.ts` is the
  only place that decides what appears; the page never re-derives it. The snapshot
  and any future consumer therefore cannot disagree.
- **Viewing the pager is not observing.** Rendering a card must never call
  `markObserved` or otherwise clear unobserved state; only an explicit click does.
  Otherwise opening the pager would silently clear every unobserved dot in the app.
- **A click is bound to session id and option text, never to list position.** The
  card element carries the session id and the button carries its own option text, so
  a re-render between paint and click cannot retarget the action. **No automated
  oracle** — see Acceptance.
- **Model-derived strings are inserted as text, never as HTML.** Session names and
  option text are untrusted model output.
- **Ordering is deterministic**: `lastIdleAt` descending, tie-broken by `sessionId`.
  Two renders of the same state produce the same order, so cards do not jump under
  the user's cursor.
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
  While a session is working the busy count and indicator are live. When a session
  finishes a turn ending in a `caco-actions` block, a card appears within ~1s with
  no reload, showing the session name and every option in full. Clicking an option
  sends it and the card disappears; the target session starts working. Dismiss
  removes the card without sending anything. **Requires visual signoff.**
- Budgets: a parked request holds ≤10s; wakes are coalesced to ≤4/s regardless of
  dispatch churn; the snapshot performs no `events.jsonl` reads and no icon stats.
- Gates: `npm run build` (the full parallel gate: typecheck ×2, lint:strict, knip,
  2600+ tests with coverage floors, scan:pii, check:specs) green.
- Oracles:
  - **needsTriage hand table** — every combination of {busy, unobserved, options
    absent / empty-array / non-empty} mapped to a hand-computed expected boolean,
    written before the implementation. Pins that all three conditions are required
    and that an absent `responseOptions` is handled without throwing.
  - **buildPagerView reference** — a fixed input list compared against an
    independently constructed expected snapshot (hand-written, not derived from the
    production function), covering ordering, the `MAX_WAITING` cap with
    `waitingTruncated`, and exact option-text passthrough.
  - **deterministic ordering** — a list with equal `lastIdleAt` values produces a
    stable `sessionId` tie-break; shuffling the input does not change the output.
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
    click made immediately after a board re-render.

## Plan

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 1 | Pure `needsTriage` + `buildPagerView` + `PagerSessionInput` + constants (`PAGER_MAX_WAITING`) | `src/pager-view.ts`, `tests/unit/pager-view.test.ts` | needsTriage hand table (incl. absent options); buildPagerView reference; deterministic ordering | one-definition; deterministic-order |
| 2 | `ActivityVersion`: counter, `bump()` with `PAGER_COALESCE_MS` settle window, `read({since,wait,signal})`, waiter park/settle | `src/activity-version.ts`, `tests/unit/activity-version.test.ts` | immediate vs parked; restart-stale; wait clamp; coalescing; abort; waiter cap | full-snapshot; sync-register |
| 3 | Call `activityVersion.bump()` at each transition: dispatch start/end, unobserved mark/observe, responseOptions write, session create/delete | `src/dispatch-state.ts`, `src/unobserved-tracker.ts`, `src/dispatch-events.ts`, `src/session-manager.ts`, `tests/unit/activity-version-wiring.test.ts` | bump coverage | idle-feed-unchanged |
| 4 | `SessionManager.listForPager(): PagerSessionInput[]` — same cache iteration as `list()`, one meta read, no icon stat | `src/session-manager.ts`, `tests/unit/session-manager-pager-inputs.test.ts` | returns options + lastIdleAt; performs no events.jsonl read | snapshot-cost |
| 5 | `GET /api/pager` route with exported pure query parser; abort on client close; mount in the router index | `src/routes/pager.ts`, `src/routes/index.ts`, `tests/unit/pager-route.test.ts` | wait clamp (pure); snapshot shape | full-snapshot |
| 6 | `public/pager.html` — self-contained page: busy indicator + count, cards, click-to-send, dismiss, explicit empty state, poll loop with backoff on error | `public/pager.html`, `tests/unit/pager-page-static.test.ts` | no-raw-HTML-sink static assertion; **manual visual signoff** for rendering, click payload, and re-render targeting | not-observing; click-bound-to-id; text-not-html |
| 7 | Document the endpoint and the page | `README.md` | - | - |

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
