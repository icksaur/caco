# spec-replay

Document of record for Caco's **chat streaming + history replay** pipeline: how a session's transcript is rendered — both the live event stream during a dispatch and the on-demand replay of persisted history — and the fence that keeps the two from colliding. Describes existing behavior so a rendering symptom maps to a theory and location. Basic overview; a specific fix (live/replay double-render) is layered on top in §Plan.

## Goals

A viewer sees a session's transcript render correctly in two situations: (1) **live**, as an in-flight dispatch streams reasoning/assistant/tool events; (2) **replayed**, when a session is opened, switched to, or re-synced after a WebSocket reconnect. The same DOM render path serves both, and a replay must never duplicate or interleave with a concurrent live stream.

## Design

**Two event sources, one render path.**

- **Live stream (no generation).** A user send runs through `dispatchMessage` (`src/routes/session-messages.ts`), which subscribes to the SDK session (`session.on(handleEvent)`) and forwards each SDK event to the client via `onEvent → broadcastEvent(sessionId, evt)` (`src/routes/websocket.ts`). Live frames are `{ type: 'event', sessionId, event }` with **no `generation`**. The SDK also persists these events to `~/.caco/sessions/<id>/events.jsonl`.
- **History replay (generation-stamped).** On demand the client calls `requestHistory(sessionId)`; the server `streamHistory(ws, sessionId, generation)` reads the recent turns from disk (`readLastTurnsResult`, capped) and sends each as a `{ type: 'event', generation }` frame, terminated by `{ type: 'historyComplete', generation }`. Every replay frame carries the request's `generation`.

**Client routing + the staleness fence** (`public/ts/websocket.ts`). `handleMessage` routes `type: 'event'` frames to the shared `eventCallbacks` set, but first drops **superseded replays**: `isStaleReplay(generation)` returns true when a frame carries a `generation` that isn't the current `currentHistoryGen`. The same discard applies to both replay `event` frames and the terminating `historyComplete` frame (`websocket.ts:311-314, 358-360`). `currentHistoryGen` is bumped by `advanceHistoryGeneration()` on each load, so a replay from a just-superseded load (rapid switch) is discarded. **Live frames carry no `generation`, so `isStaleReplay` never drops them** (by construction — see Invariants/Risks).

**History loading** (`public/ts/history-loader.ts`). `load(sessionId, version?, isBusy)` is the single owner of the request→stream→complete lifecycle: it clears the chat, `subscribeToSession`, `requestHistory`, and resolves on the matching `historyComplete`. During a slow-path load it also registers a **second** `onEvent` subscriber that *collects* the streamed events into an array (for the MRU cache) — separate from, and in addition to, the render subscriber registered once by `initMessageStreaming`. Two paths:
- **Slow path**: streams from the server (the generation-stamped replay above).
- **Fast path** (`reuseFromCache`): when a fresh cached transcript exists (MRU cache, `spec-transcript-mru-cache.md`), it re-renders the cached event array locally and **skips `requestHistory`** — but still calls `subscribeToSession(sessionId)` and `advanceHistoryGeneration()`; it is not purely local.

**Render** (`public/ts/message-streaming.ts`). A single `handleEvent` (registered once) renders events — live or replay — through `chatRegion.renderEvent(event)`, which finds-or-creates the message/reasoning element by id and appends delta content. `isLoadingHistory()` gates *scrolling*, *terminal side-effects* (busy clear, observe, form enable), and a few **ephemeral events** — `assistant.turn_start` is render-suppressed during a load (`message-streaming.ts:158-164`) and a stale `session.error` is conditionally dropped (`107-113`) — but it does **not** gate the core `renderEvent` call for reasoning/assistant/tool deltas, so replay frames paint the transcript while `isLoadingHistory` is true.

**Reconnect re-sync** (`public/ts/message-streaming.ts` `onReconnect`). On a WS reconnect while viewing a chat, the client re-subscribes and calls `reloadHistory(sessionId)` to re-fetch the transcript (it may have missed events during the disconnect).

**Related generations.** Distinct from `currentHistoryGen` (history-load fence) is the *navigation* `navGeneration` in `ChatViewController` (`spec-p3-fe-transaction.md`) that supersedes a slower session-activation. The MRU freshness token (`spec-transcript-mru-cache.md`) is the events.jsonl `{size, mtimeMs}` read at `/resume`, deliberately **not** a live-frame stamp.

## Invariants

- **Single render registration** (invariant): the *rendering* `handleEvent` is registered on `eventCallbacks` exactly once (`initMessageStreaming`); `eventCallbacks` is a `Set`, so re-subscription is idempotent. (A slow-path load adds a second, non-rendering `onEvent` subscriber that only collects events for the MRU cache and is unsubscribed on completion — it never renders, so it can't double-paint.) A duplicate *rendering* subscription would double-render.
- **Superseded replays are discarded** (invariant): a replay frame whose `generation !== currentHistoryGen` is dropped, so a stale load's frames can't interleave into the current transcript.
- **Live and replay must not both render the same event** (invariant, currently HELD ONLY when they don't overlap in time): the transcript for a message must reflect each delta once. The generation fence covers stale *replays* but not a live stream overlapping a *current* replay — the gap addressed in §Plan.
- **Server forwards each live event once** (fact): the dispatch is the only live forwarder (`onEvent → broadcastEvent`); there is no second SDK→broadcast path.

## Considerations

- The replay reads a **disk snapshot** taken at request time; the live dispatch keeps writing to the same `events.jsonl` and broadcasting concurrently. On a **busy** session these two sources describe overlapping time ranges.
- `renderEvent` accumulates deltas by appending to an element keyed by event/message id; the same delta delivered by both replay and live is appended twice.
- Cold/slow sessions are the practical trigger: their responses are slow, so a mid-response WS hiccup → reconnect → `reloadHistory` overlapping the still-live stream is far more likely.
- The fast path (`reuseFromCache`) renders from a cached array with `isLoadingHistory` set; live frames arriving during that window are also rendered by `handleEvent`.

## Risks and Mitigations

- **Doubled deltas** (the reported bug): the dominant cause is **dual-writer contamination of `events.jsonl`** — a cold-session retry does not abort the original generation (`dropStaleSession` skips `disconnect`, `src/session-manager.ts:1114-1125`), so two generations persist and every render doubles (§Plan A). Secondary: live frames are unfenced against a same-epoch replay (§Plan B). Mitigation: abort-before-retry (primary) + a live stream epoch + a reconnect-overlap guard (§Plan).
- **Wasted tokens**: even with the render fixed, an un-aborted original generation burns tokens to completion — the abort-before-retry prong stops this at the source, not just the display.
- Over-fencing could **drop legitimate live events**; the epoch discards only *superseded* dispatches, and the reconnect guard must preserve the current dispatch's message tail.
- The abort must be applied to **both** retry triggers (watchdog `no-first-event` and async `isSessionLost`) or contamination persists on one path.
- Fast-path/observe and other `isLoadingHistory`-gated behaviors must not regress when the fence changes.

## Acceptance

- Observable: opening, switching, live-streaming, and reconnect-during-stream all render the transcript with each reasoning/assistant delta shown exactly once.
- Gates: `npm test` (coverage thresholds), typecheck ×2, build:client.
- Oracles: `tests/unit/history-loader.test.ts` (load/replay/fast-path lifecycle), `tests/unit/websocket*.test.ts` (`isStaleReplay` / generation discard). The live/replay overlap is not yet covered — its oracle is added with the fix (§Plan).

## Plan

Overview spec (§Design/§Invariants above) captures existing behavior. The concrete fix for the doubled-delta bug is specced here.

**Root cause — dual-writer disk contamination (primary), with two render-level gaps.** The symptom is doubled text in reasoning/assistant divs on **cold** sessions. The dominant cause is at the persistence layer, not just rendering:

- **(A) Dual-writer contamination of `events.jsonl` (primary).** A cold/slow session whose first SDK event exceeds the 45s watchdog triggers `retryWithFreshClient` (`src/routes/session-messages.ts` watchdog `no-first-event`; also the async `isSessionLost` path). The retry `unsubscribe()`s and `dropStaleSession()`s — but `dropStaleSession` **deliberately does not `session.disconnect()`/abort** the original (`src/session-manager.ts:1114-1125`). If the original prompt was already accepted by the SDK (merely slow, not lost), that original generation **keeps running and writing to `events.jsonl`** while the retry resumes and re-sends a **second** generation. Both persist to the same file, so the transcript itself is doubled — and **every later replay/load renders it doubled** (persistent, not transient). The `unsubscribe()` before the retry means the original's *live* frames don't reach the client, so this is a **disk** double, not a concurrent-live-paint double — which is why it survives reconnects and re-opens.
- **(B) Live/replay overlap (secondary, same-epoch).** Live broadcast frames carry no `generation`, so `isStaleReplay` never fences them (`public/ts/websocket.ts:396-398`). A reconnect `reloadHistory` (`public/ts/message-streaming.ts:189-195`) can overlap a same-epoch live stream + replay. Lower-frequency than (A) but a real render-level hole.

**Fix mechanism — abort-before-retry, plus a live stream epoch.** Three prongs, in priority order:
1. **Abort the original generation before retrying (the primary fix).** Before `dropStaleSession` + resume + resend, the retry must abort/disconnect the original SDK session so it stops writing to `events.jsonl` — exactly one generation persists, killing the disk double at the source. Applied **symmetrically** to both retry triggers (watchdog `no-first-event` and async `isSessionLost`).
2. **Per-dispatch live stream epoch (render fence).** A monotonic token bumped on dispatch start and on retry re-send; live broadcast frames are stamped with it and the client discards superseded-epoch frames (the live analogue of `isStaleReplay`). Defends against any concurrent-live double that abort-before-retry doesn't cover.
3. **Same-epoch reconnect-overlap guard.** During a history load, gate/suppress same-epoch live frames from double-painting the replayed region, without dropping the current dispatch's ongoing frames (§Considerations: preserve the message tail). Closes gap (B).

The rejected alternative — epoch fence *alone* — does not fix (A): the two generations are already on disk, so a stale-epoch discard of live frames leaves the contaminated file to re-double on the next load.

| # | Step | Files | Oracle |
|---|------|-------|--------|
| 1 | Confirm dual-writer contamination: log generation/epoch on every persisted event; force a slow first event (cold sim) and assert `events.jsonl` gains a SECOND generation across a retry | `src/routes/session-messages.ts`, `src/dispatch-retry.ts` | repro: file shows two generations for one send |
| 2 | Abort/disconnect the original SDK session before drop+resume+resend, in the shared retry helper (both triggers) | `src/dispatch-retry.ts`, `src/session-manager.ts` | test: retry calls abort on the stale session before resend; only one generation persists |
| 3 | Add a per-session live stream epoch; bump on dispatch start + retry; stamp live frames; client drops superseded epochs | `src/routes/session-messages.ts`, `src/routes/websocket.ts`, `public/ts/websocket.ts` | test: stale-epoch live frame dropped, current renders |
| 4 | Same-epoch reconnect-overlap guard for the load window (no dropped tail) | `public/ts/websocket.ts`, `public/ts/message-streaming.ts`, `public/ts/history-loader.ts` | test: reconnect during an active stream → no duplicated `*_delta` text |
| 5 | Regression oracle: retry mid-stream AND reconnect-during-stream both yield a single copy of each delta on disk and in the DOM | `tests/unit/*` (dispatch + websocket harnesses) | test RED before, GREEN after |

## Rationale

The replay/streaming pipeline predates the spec corpus and was never written up; its behavior was split implicitly across `spec-p3-fe-transaction` (navigation generation), `spec-transcript-mru-cache` (freshness token, which explicitly chose no live-frame stamping), and `spec-chat-render-cap` (render cap). This document consolidates the streaming/replay contract as the document of record so the double-render fix — and future streaming work — has a home.
