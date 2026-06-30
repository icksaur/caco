# Chat Render Cap

## Goals

Reduce client-side history-render cost by capping the number of events Caco shows on session resume. The current behavior loads the last 10 turns (subject to a 2000-event hard cap) — for talkative sessions that's 700+ events to paint at once. Most users only look at the last few exchanges; the rest is scroll cost they never use.

We want the operator's "open a session" tap to land on the chat in <50ms client-side after the WebSocket data arrives, instead of ~100ms.

## Non-Goals

- **Not** a true virtualized scroller (mount/unmount on scroll). That's much bigger code and we can't justify the complexity for the use case.
- **Not** server-side change. `readLastTurns` already does the heavy lifting; we just want the client to render less.
- **Not** changing what the SDK reads. The agent's *context* is whatever the SDK rebuilt internally — capping client render does NOT affect what the agent remembers.
- **Not** "load older messages" UI in v1. We log the truncation in chat so the user knows; explicit reveal is a follow-up.

## Design

### Cap by turns, not events

Capping at "last N events" is fragile because a single agent turn can produce 50+ events (tool calls, deltas, etc.). The operator's mental model is **turns**: "show me my last 3 questions and their answers."

Cap: **render the last 5 turns**, where a turn boundary is a `user.message` event.

### Two implementation paths

Two places where we could enforce the cap:

1. **Server-side (`readLastTurns`)** — change the default `maxTurns` arg in `streamHistory` from 10 → 5. One-line change, lowest blast radius. But callers of `readLastTurns` from other code paths (e.g. session-history-tool) would not be affected, which is correct.

2. **Client-side (`history-loader.ts` or message-streaming dispatch)** — count user.message events from the end of the stream, drop everything earlier. More flexible (operator could tune at runtime via a setting); also lets the truncation banner be a client concern.

**Choice:** server-side. Three reasons:

- It's a one-line change. The client-side variant requires buffering and re-scanning the stream.
- The server already emits a `caco.truncated` event when it skips lines; we get the "we cut off the older stuff" UX for free.
- Per-session and per-user customization isn't needed yet. If it ever is, we can add a query param to `streamHistory` later.

### Truncation banner

When `skipped > 0`, the server already sends:

```ts
{ type: 'caco.truncated', data: { skipped, total } }
```

The client already renders this. We need to verify it's prominent enough — currently it's a quiet text node at the top of chat. A simple visual nudge ("View earlier" / "Load older messages" link) would be nice but is **out of scope for v1** — log it as a follow-up.

### What gets capped

Both initial resume AND any explicit reload. The cap lives in `streamHistory` so it applies uniformly. Live streaming during an active turn is unaffected — events sent post-historyComplete come through `dispatchMessage` and bypass the cap.

### What does NOT get capped

- The SDK's own conversation memory (the agent still sees full context up to its compaction threshold).
- Tool history (`caco_session_history` tool reads via a different path; bounded by its own params).
- `events.jsonl` on disk (untouched).

## Code Analysis

### Files touched (single hot spot)

- `src/routes/websocket.ts:319` — change `readLastTurns(sessionId, 10, 2000)` to `readLastTurns(sessionId, 5, 2000)`.

### Files we'd touch if doing more

If we wanted client-side cap or a settings knob: `public/ts/history-loader.ts` + `public/ts/main.ts` + a config field. Out of scope.

### Test impact

No existing test asserts the magic "10". `readLastTurns` has unit tests on its own logic (counting user.message backwards), all of which take maxTurns as an arg and still pass. We add one new test that exercises the streamHistory path with a session containing >5 turns and verifies the client sees a `caco.truncated` event plus 5 user.message events.

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Operator scrolls up expecting older messages, sees nothing. | High the first time per session; low after that. | Truncation banner is already there. Future "Load older" UI follow-up. |
| 5 turns is too few for some user flows (e.g. reading a code review thread). | Medium. | Make the cap configurable later. v1 picks a safe default. |
| Sessions with very long single turns (one user.message followed by 200 tool calls) still render slow. | Low (rare). | maxEvents cap stays at 2000 as a safety. |
| Newcomers to Caco think it's broken (where are my messages?). | Low (3 users). | Documented behavior in the truncation banner; not in v1 scope to redesign the banner. |
| Server-side cache invalidation. | Low. | `readLastTurns` cache key includes `maxTurns`, so changing the value invalidates cleanly. |

## Acceptance

1. Open a session with >10 turns. The chat shows the last 5 user.message + assistant.message pairs and nothing older.
2. Server logs `[HISTORY] Truncated: skipped N of M lines` for any session where `M > 5 user.messages`.
3. The truncation banner appears at the top of chat ("…N earlier messages skipped").
4. `[PERF] history <id>: ttfe=<small>ms stream=<smaller>ms events=<smaller>` — events count drops sharply for long sessions, stream time drops proportionally.
5. Existing perf for short sessions (≤5 turns) unchanged.
6. Live messaging during an active turn shows new events normally; the cap does not apply.

## Follow-ups

- Better truncation banner with "Load older" action that re-requests with a higher `maxTurns`.
- Per-session render preference (some flows want full history visible).
- True virtualization if/when DOM cost dominates even at 5 turns.
- Make the constant a config field in `src/config.ts`.

## Estimated effort

- Code change: **1 line** in `src/routes/websocket.ts`.
- Tests: 1 new unit test (~30 lines).
- Documentation: this spec.

Total: maybe an hour including the test and a smoke-run.

## Plan

| # | Step | Files | Oracle |
|---|------|-------|--------|
| 1 | Change default maxTurns 10 → 5 in streamHistory | `src/routes/websocket.ts` | test: >5-turn session returns `caco.truncated` + ≤5 user.message events |
| 2 | Verify truncation banner renders | `public/ts/history-loader.ts` | visual: banner at top of chat for capped sessions |
