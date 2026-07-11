# spec-idle-notifications

## Goals

External automation on a persistent machine — a bash/python/powershell script,
not a browser — can observe when a session it drives goes idle and read that
session's final response text, without speaking the WebSocket protocol. This
enables: a server that reacts to external signals (PRs, commits, tickets) by
driving a session and acting on the result; a publisher that extracts structured
output (code/API blocks) from the final response; a minimal "pager" front-end
that only needs inbox + offer-actions and reports done/blocked by string match;
and a bounded retry ("Ralph") loop that re-runs a prompt until a sentinel appears
or the loop is exhausted.

The notification fires ONLY for externally/human-driven work. It never fires for
herd children, delegate targets, or tool-enable auto-continuations — those are
already observed by an in-process actor.

## Design

**Idle event log (`src/idle-feed.ts`) — in-memory, append-only, monotonic seq,
bounded ring.** ONE global log multiplexes ALL sessions: each `IdleEvent
{ seq, sessionId, idleAt, response, truncated, kind, correlationId? }` carries its
`sessionId`, and `seq` is a single monotonic counter across every session, giving
a total order. The module owns the ring, a `head` seq counter, a per-session
`lastSeq` map (highest seq ever appended for each session), and a set of parked
long-poll waiters. `append(sessionId, response, kind, correlationId?)` assigns
`++head`, records `lastSeq[sessionId]=head`, pushes (evicting the oldest past
capacity), and resolves every waiter whose filter matches. `read({ after,
session, wait })` returns the retained events with `seq > after` (filtered by
`session` when given), the current `cursor` (= `head`), and a `reset` flag (see
below). When nothing matches and `wait > 0`, it parks a waiter resolved by the
next matching `append` or a timeout (returns empty `events` + unchanged `cursor`
on timeout, for a clean re-loop).
**Non-miss registration contract:** the empty-scan and the waiter insert happen
with NO `await` between them (both synchronous), and the waiter re-scans once
immediately after insertion — so an `append` that lands exactly at the
registration boundary can never be lost between the scan and the park.
**`reset` rule (filter-aware).** An unfiltered read resets when `after` predates
the oldest retained seq or exceeds `head` (restart). A `session`-filtered read
resets ONLY when it could have missed one of THAT session's events:
`after < oldestRetainedSeq AND after < lastSeq[session]`. When
`after >= lastSeq[session]` (or the session never appeared) the reader is provably
caught up for that session, so a global eviction driven by OTHER sessions never
triggers a spurious `reset` — the single-session consumers (Ralph loop, pager)
are insulated from noisy neighbors.

**Hook — the idle authority, gated on `needsObservation`.** `handleSessionIdle`
already runs real-idle effects and already gates the user-observation effect
(`markIdle`) on `ctx.needsObservation`. Add one more injected real-idle effect,
`notifyExternalIdle(sessionId)`, called inside that SAME `needsObservation`
branch (after the `willFire && started` false-idle return). The classifier is
`needsObservation` and nothing else: the feed fires for exactly the dispatches
Caco already considers "needs an out-of-band observer." The default message route
computes `needsObservation = !source` (`session-messages.ts:270`) — so a
herd-child turn (`source:'agent'|'system'`), a delegate turn (`source:'agent'`),
and an auto-continuation (`source:'system'`, and a false idle anyway) are excluded
— but `needsObservation` is NOT universally `!source`: other dispatch entry points
set it explicitly (e.g. skill-invoke passes `needsObservation:true`,
`sessions.ts:456`; resume passes `true`), and those user-driven idles SHOULD
appear on the feed. So the contract is stated purely in terms of
`needsObservation`, never in terms of `source`. The route wires
`notifyExternalIdle` to a closure that reads `getLastAssistantMessage(sessionId)`
(`src/session-history.ts`, already the delegate/herd response source) and calls
`idleFeed.append`.

**Transport — long-poll GET (`src/routes/idle.ts`, mounted at `/api`).**
`GET /api/idle?after=<seq>&session=<id?>&wait=<ms>`. Returns
`{ cursor, events, reset? }`. This is the primary decision:

- MECHANISM chosen: hanging GET + cursor over the in-memory ring.
- vs a WebSocket idle channel: WS already exists for rich clients; the goal is
  the SIMPLEST script transport — one `curl`/`Invoke-RestMethod`/`requests.get`
  in a loop, no framing or subscribe handshake, works through any HTTP proxy.
- vs stateless polling: a plain poll (or a fire-and-forget WS) can MISS an idle
  that lands between calls. The cursor+ring lets the server replay everything
  since `after`, closing that race; eviction is surfaced via `reset` rather than
  silently dropped.

**Consumption models (multi-session).** One feed serves many sessions and many
concurrent observers. (a) **Fan-in:** an automation driving many sessions polls
`GET /api/idle?after=$C` with NO filter and receives every session's idle
interleaved, `sessionId`-tagged, in one loop. (b) **Single-session:** the Ralph
loop, pager, and structured-output publisher pass `?session=X` to receive only
X's idles (waiter wake is filtered too, so an unrelated idle never wakes them).
Multiple independent observers each keep their own `after` cursor; a single
`append` wakes all matching parked waiters. **Dispatch↔idle correlation:** because
a session's dispatches are serialized (the busy-guard 409s a concurrent send),
capturing `cursor` immediately BEFORE `POST /api/sessions/:id/messages` and then
polling `?after=<that cursor>&session=X` yields exactly that dispatch's idle — no
correlation id required. The event also carries the dispatch's `correlationId`
when available, for observers that prefer to match explicitly.

**Cursor discipline.** `after` absent ⇒ start at `head` (only future idles; the
first call returns the current cursor and no history). `after=0` ⇒ replay all
retained. Response always carries `cursor` for the next `after`. On `reset` the
client has provably missed some idles (the ring evicted them, or the server
restarted). Recovery is STATUS-ONLY: it reads `GET /api/sessions/:id/state`
(busy/idle/inactive) to learn each session's current disposition, then resumes
the feed from `cursor`. The final-response TEXT of an evicted idle is NOT
recoverable from the feed (the bounded-ring tradeoff) — an observer that must have
it re-drives the session, or reads the session transcript through an existing
history surface. In practice `reset` is rare (ring capacity ≫ the number of
sessions a single automation drives between polls); the feed is sized so a
well-behaved poller never evicts an unseen event.

## Invariants

- **idle-fires-iff-needsObservation.** The external idle notification fires
  exactly for a real idle with `needsObservation === true`. It MUST NOT fire for
  herd children, delegates, or tool-enable reveal-idle. Enforced structurally by
  hooking inside the idle authority's `needsObservation` branch — after the
  `willFire && started` false-idle return — not by a parallel predicate.
- **one classification authority.** No new "is this externally observable"
  predicate may be introduced outside the idle authority (mirrors the
  idle-suppression-central lesson: a forgettable second predicate drifts).
- **layering.** `idle-feed` is injected into the route deps; `idle-authority`
  imports no `idle-feed` and stays pure/unit-testable. `idle-feed` imports no
  route/session-manager internals beyond types.

## Considerations

- **Missed-idle race is the reason for the cursor+ring.** Bounded memory beats
  unbounded correctness: on eviction the client is told (`reset`) and falls back
  to a state read, rather than the server retaining forever.
- **Noisy-neighbor eviction (multi-session).** With one global ring, a busy
  session can evict a quiet session's still-unseen events. The per-session
  `lastSeq` map keeps a `session`-filtered reader from a spurious `reset` when it
  is actually caught up on its own session (see the filter-aware `reset` rule);
  the unfiltered fan-in reader accepts eviction as a genuine `reset`. Size the
  ring (`IDLE_RING_CAP`) generously relative to the expected idle rate so eviction
  is rare for a well-behaved poller.
- **Correlation.** The event carries the dispatch's `correlationId` when the idle
  path has it in scope (thread it through `handleIdle` → the `notifyExternalIdle`
  dep); when absent the field is omitted and the cursor-capture-before-POST
  pattern still gives exact correlation (dispatches per session are serialized).
- **Restart.** The in-memory log resets `head` to 0. A client `after > head`
  (its cursor is from a prior process) → `reset`; the observer re-syncs status via
  `/state` and resumes. Durable log is future work.
- **Response fidelity.** Reuse `getLastAssistantMessage` (last `assistant.message`
  content). Cap size (`IDLE_RESPONSE_CAP`, e.g. 64 KB) with a `truncated` flag so
  a runaway response can't bloat the ring. Sufficient for string-match
  (COMPLETE/BLOCKED) and code-block extraction per the use cases.
- **Read-before-append ordering.** `getLastAssistantMessage` is async; do the
  read BEFORE `append` so the event carries settled text. `append` is the only
  seq assigner and is synchronous, so a concurrent idle cannot interleave a seq.
- **Filter semantics.** `session=` filters BOTH the returned events AND the
  waiter wakeup, so a per-session observer is not woken by unrelated idles.
- **Same-origin.** `requireSameOrigin` allows Origin-absent requests
  (`same-origin.ts:60`), so header-less `curl`/python/powershell reach the feed
  with no config; loopback binding is the network boundary. Scripts must not send
  an `Origin` header (they don't by default).
- **Long-poll hygiene.** Cap `wait` (`IDLE_WAIT_CAP`, e.g. 30 s). Clean up the
  waiter + timer on resolve AND on request `close` (client disconnect). Cap the
  number of concurrently parked waiters (`IDLE_WAITER_CAP`, e.g. 256); over the
  cap, `read` returns immediately (empty + cursor) instead of parking, bounding
  memory against accidental local fan-out.

## Risks and Mitigations

- Missed events after restart/eviction → `reset` flag + documented status-only
  re-sync via `/state`; the final-response text of evicted idles is not
  recoverable from the feed (bounded-ring tradeoff).
- Response read cost per idle → identical to today's per-idle herd/delegate reads;
  size-capped.
- Long-poll socket leaks → hard `wait` cap + timer/waiter cleanup on resolve and
  on `req.on('close')`; a parked-waiter cap bounds memory under local fan-out.
- Misuse as a full token stream → docs state it is idle-only, low-fidelity (final
  response); rich clients use WS.
- Duplicate notifications (idle → observed → idle again) → each real idle appends
  a new seq; correct — the Ralph loop wants every iteration.

## Acceptance

- Observable: a session driven by `POST /api/sessions/:id/messages` has its final
  response appear on `GET /api/idle` shortly after it idles; a herd/delegate/
  auto-continue idle does NOT appear. A bash loop
  (`C=$(curl -s "$BASE/api/idle" | jq .cursor); while :; do r=$(curl -s
  "$BASE/api/idle?after=$C&wait=25000"); C=$(echo "$r" | jq .cursor); echo "$r"
  | jq -c '.events[]'; done`) prints each session's final response as it idles.
  **User signoff** on the demo snippet (user-visible transport).
- Budgets: `append` O(1) amortized; ring bounded by capacity const; `wait ≤ cap`.
- Gates: `npm run typecheck` (×2), `lint:strict`, `knip`, `test`, `build:client`,
  `check:specs` — all green. The new route is documented in API.md (enforced by
  the now-exhaustive `api-docs.test.ts`).
- Oracles:
  - idle-feed: a reference-style unit that runs a scripted sequence of
    appends/reads (including eviction, `session` filter, long-poll wake, and
    `reset` on a stale cursor) and compares the feed's output against an
    independently-computed expected event/cursor sequence.
  - idle-authority: extend `idle-authority.test.ts` — `notifyExternalIdle` is
    called iff `needsObservation` (and never on the `willFire && started`
    false-idle path). Assert BOTH a `needsObservation:false` idle (no call) and a
    `needsObservation:true` idle (call), since the gate is `needsObservation`, not
    `source`.
  - route: `/api/idle` unit — immediate hit, empty-on-timeout, `reset`, `session`
    filter, the noisy-neighbor case (a filtered reader caught up on its own
    session is not `reset` by another session's eviction), and long-poll wake by a
    concurrent append.

## Plan

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 1 | `idle-feed` module: ring + `head` seq + per-session `lastSeq` + `append(sessionId,response,kind,correlationId?)` + `read({after,session,wait})` with filter-aware `reset` + waiter wake/timeout + size cap + waiter cap | `src/idle-feed.ts` | ref-impl: scripted append/read sequence incl. eviction, `session` filter, long-poll wake, unfiltered `reset`, AND noisy-neighbor case (filtered reader caught up on its session is NOT reset despite global eviction) vs independently-computed expected | one-authority, layering |
| 2 | idle-authority: add `notifyExternalIdle` dep; call inside the `needsObservation` branch (after the `willFire && started` return) | `src/idle-authority.ts`, `tests/unit/idle-authority.test.ts` | `notifyExternalIdle` called iff `needsObservation`; not on false idle | idle-fires-iff-needsObservation |
| 3 | Route wiring: thread the dispatch `correlationId` through `handleIdle`; `notifyExternalIdle = async id => idleFeed.append(id, cap(await getLastAssistantMessage(id)), kindOf(id), correlationId)` | `src/routes/session-messages.ts` | wiring unit: a `needsObservation:true` idle appends w/ response + correlationId; a `needsObservation:false` idle does not — asserted on `needsObservation`, not `source` | idle-fires-iff-needsObservation |
| 4 | `GET /api/idle` route (`after`,`session`,`wait`), mount at `/api`, `req.on('close')` cleanup | `src/routes/idle.ts`, `server.ts`, `src/routes/index.ts` | route unit: immediate hit, empty-timeout, reset, session filter, wait wake | layering |
| 5 | Document `GET /api/idle` in API.md ("Idle Notifications" section) with the bash/python/powershell loop | `API.md` | `api-docs.test.ts` covers the new route | - |
| 6 | Full gate + code review | - | all gates green | idle-fires-iff-needsObservation |

## Rationale (optional, skippable)

The feature is the machine-observable analog of the UI's "unobserved" dot: the
unobserved tracker already fires exactly on `needsObservation` real idles and the
UI clears it when the *user* opens the session. The idle feed exposes that same
signal to an out-of-process observer, adding the final response text so a script
can act without a second round-trip. Reusing `needsObservation` (rather than
inventing an "is-external" flag) is what makes the exclusion of herd/delegate/
auto-continue correct by construction and keeps a single classification
authority — the same design lesson as spec-idle-suppression-central.

Long-poll over WS is deliberate: the target caller is a shell loop. The cursor is
the one non-obvious necessity — without it the "did I miss an idle between polls?"
question has no answer; with it the server replays since the client's watermark
and only falls back to a state re-sync when the bounded ring has genuinely
evicted the gap.

### Example: the Ralph loop

Retry a prompt in a FRESH session on a directory until the final response
contains a sentinel (`COMPLETE`) or the attempt budget is exhausted. It captures
the feed cursor BEFORE sending (so it waits for exactly that dispatch's idle) and
re-polls across the server's `wait` cap. This is the reference client the API.md
"Idle Notifications" section reproduces (Plan step 5).

```bash
#!/usr/bin/env bash
set -euo pipefail
BASE="http://127.0.0.1:53000"
CWD="/path/to/repo"
MODEL="claude-sonnet-4.6"
PROMPT="Do the task in TASK.md. When fully done, reply with COMPLETE on its own line."
MAX=10

for ((i = 1; i <= MAX; i++)); do
  # 1. Fresh session in the target directory.
  sid=$(curl -s "$BASE/api/sessions" -H 'Content-Type: application/json' \
    -d "{\"cwd\":\"$CWD\",\"model\":\"$MODEL\"}" | jq -r .sessionId)

  # 2. Capture the cursor BEFORE sending: the next event for this session on the
  #    feed is guaranteed to be THIS dispatch's idle (sends per session serialize).
  cursor=$(curl -s "$BASE/api/idle?session=$sid" | jq .cursor)

  # 3. Send the prompt (response streams over WS; the loop doesn't need it).
  curl -s "$BASE/api/sessions/$sid/messages" -H 'Content-Type: application/json' \
    -d "{\"prompt\":$(jq -Rn --arg p "$PROMPT" '$p')}" >/dev/null

  # 4. Hang until this session idles. One GET returns within the server's wait cap
  #    (~30s); if still busy it returns empty, so re-poll until an event arrives.
  resp=""
  while [ -z "$resp" ]; do
    r=$(curl -s "$BASE/api/idle?session=$sid&after=$cursor&wait=25000")
    cursor=$(echo "$r" | jq .cursor)
    resp=$(echo "$r" | jq -r '.events[-1].response // empty')
  done

  echo "=== attempt $i (session ${sid:0:8}) ==="
  printf '%s\n' "$resp"
  if printf '%s' "$resp" | grep -q '^COMPLETE$'; then
    echo "COMPLETE after $i attempt(s)."; exit 0
  fi
done

echo "Exhausted $MAX attempts without COMPLETE." >&2
exit 1
```

(An errored dispatch never emits idle, so a production loop adds an overall
wall-clock timeout around step 4 to escape a hard failure.)
