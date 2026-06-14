# Session throughput metrics — token I/O + 429 count

**Status:** spec rev 2, not implemented. Adds per-request token-usage
and rate-limit (429) visibility for a running session, so a
"stuck" background review can be diagnosed at a glance.

## 1. Goal

Surface two live signals for the active session:

1. **Request token consumption** — running input/output token
   totals for the current turn (and/or session), updated as the
   SDK streams `assistant.usage` events.
2. **429 count** — how many model calls have been rate-limited,
   from `model.call_failure` events with `statusCode === 429`.

Display both compactly in the meta-context footer (bottom-left,
next to the existing budget/"Unlimited" + context-% readouts).

## 2. Answering the prerequisite question

**Do we get streaming events with per-call token I/O to update
the UI live?**

Yes. The SDK emits an `assistant.usage` event **after every
model API call** (`session-events.d.ts` `AssistantUsageData`)
carrying:

- `inputTokens`, `outputTokens` (per-call)
- `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`
- `model`, `initiator` (`"sub-agent"`/`"mcp-sampling"`/absent
  for main agent)
- `duration`, `timeToFirstTokenMs`, `interTokenLatencyMs`
- `cost`, `reasoningEffort`

So we accumulate from the stream; no polling of
`usage.getMetrics()` needed for V1. (`usage.getMetrics()` stays
a future option for a full on-demand snapshot incl.
code-changes; out of scope.)

For **429s**, the SDK emits `model.call_failure`
(`ModelCallFailureData`) with `statusCode`, `initiator`,
`model`, `errorMessage`, `durationMs`. `statusCode === 429` is
the throttle signal; `initiator: "sub-agent"` distinguishes a
throttled background subagent from the main agent.

**Important correction about quota (rev 2).** In SDK 1.0+,
`assistant.usage` **no longer carries `quotaSnapshots`** — quota
moved to the `account.getQuota` RPC, polled by
`src/quota-poller.ts`. Caco's existing `assistant.usage` handler
in `dispatch-events.ts` still reads `eventData.quotaSnapshots`,
but that field is now always `undefined` — the read is
**vestigial** (a no-op kept from the pre-1.0 path). The account
"Unlimited"/% budget the user sees comes from the quota poller,
not from `assistant.usage`.

This matters for the design: V1 does **not** "add token reads
alongside existing quota handling" on the same event data —
because the quota handling there is dead. V1 adds an
independent token-accumulation path on `assistant.usage`. The
two concerns (account quota vs per-session token throughput) are
fully separate and must not be conflated.

Net: the token fields V1 needs (`inputTokens`/`outputTokens`)
**are** present on the current `assistant.usage` event; the
quota fields are **not**. V1 is valid as a stream-accumulator.

## 3. Non-goals

- On-demand `usage.getMetrics()` snapshot (code-changes,
  per-model breakdown). Future.
- Per-model or per-subagent breakdown in the UI. V1 aggregates.
- Cost/credit display (the model-billing work covers price
  tiers separately).
- Persisting throughput across restarts (it's per-run
  diagnostics; resets are fine).
- Latency/TTFT display. Captured server-side optionally but not
  shown in V1.
- A dedicated diagnostics applet (could be V2; V1 is footer-only).
- Replacing the existing budget ("Unlimited"/"% remaining") or
  context-% readouts — V1 adds alongside them.

## 4. Current architecture

### 4.1 Event flow

- SDK session events → `src/dispatch-events.ts`
  `handleSessionEvent(sessionId, event, deps)`.
- That function already special-cases `assistant.usage`
  (extracts `quotaSnapshots` → `updateUsage` → broadcasts
  `caco.usage` global event).
- Broadcasts: `broadcastGlobalEvent` (all clients) and
  `broadcastEvent(sessionId, ...)` (session-scoped; client
  filters by sessionId). Defined in `src/routes/websocket.ts`;
  WS messages carry an optional `sessionId` (line 63: "client
  filters by this").
- Client: `public/ts/message-streaming.ts` `handleEvent` +
  `public/ts/websocket.ts` `onEvent`/`onGlobalEvent`. The client
  associates events with the active session via
  `getActiveSessionId()`.

### 4.2 Footer

- `public/ts/context-footer.ts` renders the meta-context footer.
  `.context-usage` shows a context-window pie glyph + %
  (`renderUsage`, line 229). Per-session cached in `usageCache`,
  restored on session switch (`restoreContextUsage`).
- `public/ts/usage-display.ts` renders quota into
  `.usage-display` elements (the "Unlimited" / "% remaining"
  text), driven by the `caco.usage` global event.

### 4.3 Server usage state

- `src/usage-state.ts` holds the global quota snapshot
  (remainingPercentage / isUnlimited), persisted to
  `~/.caco/usage.json`. This is **account-wide**, not per-session
  — distinct from what V1 adds.

## 5. Design

### 5.1 Server: per-session throughput accumulator

New module `src/session-throughput.ts` owns an in-memory,
per-session running tally. Not persisted (per-run diagnostics).

```
interface SessionThroughput {
  // Current turn (reset on each user.message / turn_start).
  turnInputTokens: number;
  turnOutputTokens: number;
  // Session lifetime (since server saw the session).
  totalInputTokens: number;
  totalOutputTokens: number;
  rateLimitCount: number;        // 429s this session
  lastRateLimitAt?: string;      // ISO, for tooltip
  updatedAt: string;
}
```

Exports:
- `recordUsage(sessionId, { inputTokens, outputTokens })` —
  adds to turn + total.
- `recordRateLimit(sessionId)` — increments 429 count.
- `resetTurn(sessionId)` — zeroes turn counters (called on
  turn start).
- `getThroughput(sessionId): SessionThroughput | undefined`.
- `snapshot(sessionId): SessionThroughput` — canonical wire
  shape for BOTH the REST route and the broadcast payload, so the
  `caco.throughput` contract has one owner (zeroed default for an
  unknown session).
- `clearSession(sessionId)` — on session delete/evict.

In-memory `Map<sessionId, SessionThroughput>`. Bounded by
session count; cleared on session removal.

### 5.2 Server: wire into dispatch-events

In `handleSessionEvent` (`src/dispatch-events.ts`):

**Event-shape robustness (rev 2, BLOCKER).** `dispatch-events.ts`
currently reads `event.data || {}`. Live SDK events may place
properties at the **root** while history events wrap them in
`data` (documented in `src/sdk-normalizer.ts`). If
`assistant.usage` / `model.call_failure` ever arrive root-shaped,
a naive `event.data` read silently records **zero tokens** or
**misses 429s** — the exact implicit-coupling failure mode in
`code-quality.md`. V1 therefore extracts via the existing
`extractProperty(event, 'inputTokens')` helper (or a tiny local
equivalent in `session-throughput.ts`) that checks `data` then
root. Tested against both shapes.

- On `assistant.usage`: read `inputTokens`/`outputTokens` via
  `extractProperty`, call `recordUsage(sessionId, …)`, then
  broadcast a **session-scoped** `caco.throughput` event with the
  updated snapshot. (This is a NEW handler branch, independent of
  the vestigial quota read described in §2.)
- On `model.call_failure`: read `statusCode` via
  `extractProperty`; if `=== 429`, call `recordRateLimit(sessionId)`
  and broadcast `caco.throughput`.
- On `assistant.turn_start`: call `resetTurn(sessionId)` and
  broadcast, so turn counters reflect the in-flight request.

**Why `model.call_failure` works here even though it's filtered
client-side (rev 2, corrected).** `model.call_failure` does NOT
carry a whitelisted content property, so when the raw event is
forwarded to the client it is dropped by the event filter
(`event-filter.ts`). That's fine. In `session-messages.ts` the
per-event handler forwards the raw event first
(`onEvent(event)`), THEN runs `applyDispatchEventEffects(...)`.
The throughput effect, inside `applyDispatchEventEffects`, emits
a **new** synthetic `caco.throughput` event through the same
`onEvent` callback — and `caco.*` events are passthrough in the
filter. So even though the raw `model.call_failure` never reaches
the client, the derived `caco.throughput` does. Raw client
delivery of `model.call_failure` is **not** required; only the
synthetic event matters. (Note the ordering: raw forward happens
before effects, but the effect's own emission is independently
broadcast — order doesn't affect correctness here.)

Broadcast uses the `deps.onEvent({ type: 'caco.throughput',
data })` callback (in `session-messages.ts` this is
`(evt) => broadcastEvent(sessionId, evt)`, so it's session-keyed
— the same path `caco.reload` already uses). The client filters
session-scoped events by active session (same mechanism as
`caco.edit`). Per the user: "session-keyed events that push to
FE." The throughput effect must NOT call `broadcastGlobalEvent`
(that's the account-quota path for `caco.usage`); throughput is
per-session.

### 5.3 Turn boundary

"Current request's token usage" maps to a **turn**. The reset
boundary is **`assistant.turn_start`** specifically — Caco
already sees it (it's an SDK type, passthrough in
`event-filter.ts`, handled in `message-streaming.ts`). The turn
accumulates every `assistant.usage` within it, **including
subagent calls** (their `assistant.usage` events carry
`initiator: "sub-agent"` but the same `sessionId`). A stuck
review burning tokens in a subagent shows growing turn output.

`user.message` is **not** used as the reset boundary — steer
mode broadcasts a synthetic `user.message` outside the
dispatch-effects path and normal sends rely on the SDK echo, so
it's unreliable. It is a measured fallback only if impl proves
`assistant.turn_start` is absent (it should not be).

V1 counts **all** `assistant.usage` toward the turn total
regardless of `initiator` (the user wants the request's total
consumption, subagents included). A future rev can split.

### 5.4 New REST endpoint (restore-on-load)

`GET /api/sessions/:sessionId/throughput` → the result of
`snapshot(sessionId)` (the current tally, or a zeroed default).
Owned by `src/routes/sessions.ts` (same router as the other
`/api/sessions/:sessionId/*` routes). Reads the in-memory
accumulator; no SDK call, session-independent.

An unknown session intentionally returns the zeroed default
(not 404) so a just-started session reads cleanly. To avoid
masking typoed session IDs as "real zero usage", the response
includes a `known: boolean` flag (`false` when the session has
no accumulator entry yet) that the client can use to distinguish
"no data yet" from "genuinely zero". A route test covers both.

### 5.5 Client: footer display

Add a `.context-throughput` element next to `.context-usage` in
the footer. Rendered by `context-footer.ts`:

- Compact form: `↑12.3k ↓4.1k` (input/output, k-abbreviated).
- 429 indicator appended only when count > 0:
  `⚠3` (or similar), in a warning color, with a tooltip
  `3 rate-limited calls (last 12:04:51)`.
- Tooltip on the token part: full turn + session totals
  (`turn ↑/↓ · session ↑/↓`).

Driven by:
- Session-scoped `caco.throughput` WS event (live updates).
- `GET …/throughput` on session activation / reload (restore).
- Per-session cache (mirror `usageCache` pattern) so switching
  away and back restores instantly.

For V1 the user said the FE "can ignore them" if wiring is hard
— but since the footer already has the session-event plumbing,
V1 renders them. The minimal fallback (if rendering proves
fiddly) is to still emit the events + endpoint and render only
the 429 count + a single `↑in ↓out` pair.

### 5.6 Footer location + "Unlimited"

The user sees "Unlimited" (account quota, from
`usage-display.ts`/quota-poller) and wants in/out + 429 summary
nearby. V1 adds `.context-throughput` to the footer cluster
alongside `.context-usage` (context-window %) — bottom-left.

**CSS/layout ownership (rev 2).** The footer markup lives in
`public/index.html` with `.context-links`, `.context-usage`
(currently `flex: 1`, centered), and `.context-status`. Adding
`.context-throughput` requires an explicit small layout update
in the footer CSS so it doesn't inherit ambiguous flex behavior
or crowd `.context-status`. V1 gives `.context-throughput` its
own non-flex width (content-sized) and places it between
`.context-usage` and `.context-status`. The footer markup owner
is `index.html`; the new element is added there, not injected
ad-hoc from JS.

It does not replace the "Unlimited" budget text; it sits
alongside. Ordering:
`[context-% pie] [↑in ↓out] [⚠429?] … [budget text]`.

### 5.7 Reset semantics

- Turn counters reset at each turn start → "current request"
  reflects the active turn.
- Session totals + 429 count accumulate for the session's
  server lifetime; cleared when the session is deleted or the
  accumulator is evicted. Not persisted across server restart
  (acceptable — it's live diagnostics).

## 6. Considerations

### 6.1 Why stream-accumulate vs poll getMetrics

`assistant.usage` is already flowing and fires per-call, giving
real-time updates with no polling. `usage.getMetrics()` would
require a timer and gives a heavier snapshot. For "watch a turn's
tokens climb", the stream is strictly better. `getMetrics()` is
logged as a future on-demand "full diagnostics" source.

### 6.2 Single owner

`src/session-throughput.ts` is the sole owner of the per-session
tally + the `caco.throughput` shape. `dispatch-events.ts` calls
into it; the route reads from it; the client renders its
broadcast. Avoids the scattered-accumulation smell.

### 6.3 Event field robustness

`assistant.usage` fields are all optional in the SDK type
(`inputTokens?`, etc.). `recordUsage` guards: missing → treated
as 0, no NaN. `model.call_failure.statusCode` is optional;
guard `=== 429` explicitly.

### 6.4 Subagent attribution

V1 lumps subagent usage into the session/turn totals (correct
for "this request's consumption"). The `initiator` field is
**not** captured in the V1 accumulator interface — it's read
only to confirm the event is a usage event, then discarded. A
V2 could add a private `lastInitiator`/per-initiator split to
show `↑in ↓out (incl. subagent)`; V1 does not store it.

### 6.5 Multi-client / global vs session-scoped

`caco.throughput` is **session-scoped** (`broadcastEvent`), so
only clients viewing that session update — matches the footer's
per-session model and the user's "session-keyed events"
request. The existing `caco.usage` (account quota) stays global.

### 6.6 Turn-start event

The reset hook attaches to `assistant.turn_start`, which Caco's
`dispatch-events` sees today (it's an SDK type, passthrough in
`event-filter.ts`, handled in `message-streaming.ts`). Impl
confirms it arrives in `handleSessionEvent`; `user.message` is a
documented fallback only (see §5.3 for why it's less reliable).

## 7. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| `assistant.usage` lacks token fields in some SDK builds | low | All fields optional; guard to 0; 429 path independent |
| Turn-reset event name mismatch | medium | §6.6: confirm in impl; fall back to `user.message` |
| Footer clutter at narrow width | medium | Compact `↑k ↓k`; 429 only shows when >0; verify mobile |
| Accumulator leak (sessions never cleared) | low | `clearSession` on delete/evict; Map bounded by live sessions |
| Session-scoped broadcast not reaching client | low | Reuse existing `broadcastEvent` + client filter (proven by `caco.edit`) |
| Double-count if both turn_start and user.message reset | low | Reset on exactly one boundary; pick turn_start, fall back only if absent |

## 8. Acceptance

Server:
1. `assistant.usage` with `inputTokens`/`outputTokens` updates
   the session's turn + total counters and broadcasts a
   session-scoped `caco.throughput` event.
2. `model.call_failure` with `statusCode: 429` increments
   `rateLimitCount` and broadcasts.
3. A non-429 `model.call_failure` does not increment the count.
4. Turn start resets turn counters (totals untouched).
5. `GET /api/sessions/:id/throughput` returns the current tally
   (or zeroed default for an unknown session) with a `known`
   flag; route test covers known + unknown session.
6. `clearSession` removes a session's tally; a deleted session
   returns the zeroed default with `known: false`.
7. Missing token fields don't produce NaN (counters stay
   integers).
8. **Event-shape seam**: dispatching `assistant.usage` with token
   fields in `data` AND root-shaped (no `data` wrapper) both
   record correctly via `extractProperty`. Same for
   `model.call_failure` `statusCode`.
9. `model.call_failure` 429 increments; non-429 does not; raw
   `model.call_failure` need NOT pass the client `shouldFilter`
   (only derived `caco.throughput` reaches the client).
10. `caco.throughput` is broadcast session-scoped (reaches only
    the subscribed/active session).
11. `session-throughput.ts` unit tests: recordUsage accumulation,
    recordRateLimit, resetTurn (totals preserved), missing-field
    guards, clearSession, snapshot default shape.

Client:
9. Footer shows `↑<in> ↓<out>` for the active session, updating
   live as `caco.throughput` arrives.
10. When `rateLimitCount > 0`, a warning `⚠<n>` appears with a
    tooltip; absent when 0.
11. Switching sessions restores that session's throughput
    (from cache or the REST endpoint); switching away clears it.
12. Page reload mid-run restores via the REST endpoint.
13. The existing budget ("Unlimited"/"% remaining") and
    context-% readouts are unchanged.

Regression:
14. Existing `caco.usage` quota flow unchanged.
15. All existing tests pass.

## 9. Out of scope (parking lot)

- On-demand `usage.getMetrics()` full snapshot (code-changes,
  per-model, premium cost).
- Per-subagent / per-model throughput breakdown.
- Latency / TTFT / inter-token-latency display.
- A dedicated session-diagnostics applet.
- Persisting throughput across restarts.
- Surfacing `subagent.started/failed` model names in the
  timeline (related but separate).
- Cost/credit accumulation (ties into model-billing token
  prices).
