# Transcript MRU cache (event-array re-render)

Status: Slice A in progress (branch `transcript-mru-cache`). Scope: client
`public/ts/` + one server `/resume` field. Related: distinct from C2 (applet DOM,
R3-gated); this is the **core-owned chat transcript**, needs no R3. Builds on R4
(the `/resume` payload carries the freshness token).

> **Design note (post-review).** A spec review found a naive seq counter unsafe —
> this repo **front-truncates `events.jsonl` on history rotation** (plus
> repair/fork/import) outside any broadcast, and the server has **no persist
> chokepoint** (the SDK writes the file; `broadcastEvent` is a gated live relay).
> Resolution: the freshness token is the **file's `{size, mtimeMs}` read fresh at
> `/resume`** — faithful by construction, rotation-aware with no epoch, no counter,
> no live-frame stamping. And we cache the **event array + re-render locally** rather
> than detaching live DOM, so the normal load side-effects all still run. This keeps
> a sharp-edged idea small and provably correct; given the hot switch is already
> <100ms, we ship the light version and **measure** before anything heavier.

## Goal

Make switching **back** to a recently-visited session reuse its existing transcript
DOM instead of clearing `#chat` and re-streaming history over the WebSocket — but
**only when a freshness token proves the cached DOM is byte-identical to the
server's current state**. When it can't be proven fresh, fall back to today's exact
re-stream path. Net: a hot switch-back goes from a ~100ms clear+restream to a
near-instant DOM re-attach, with **zero** added cost when not switching and **zero**
staleness risk by construction.

This is **polish on an already-good number** (<100ms hot switch). It is a pure
optimization with a guaranteed-correct fallback, not a behavior change.

## Non-goals
- No multi-subscription / live background rendering (rejected: continuous
  main-thread cost that lands worst when background agents are busy — see the
  session's analysis). The client stays single-subscription.
- No applet DOM retention (that is C2, R3-gated, separate).
- No persistence across server restart (a restart changes the WS connection id,
  which invalidates every cache entry — see the connection guard).
- No change to how live events render or to the SDK event shape beyond an optional
  stamped token on the broadcast frame.

## Current shape (grounded, file:line)

- **Transcript DOM:** one `#chat` container (`dom-regions.ts:79`), children are
  message boxes; cleared by `clear: () => { el.innerHTML = ''; }` (`:47`).
- **The switch/load seam:** `chat-view-controller.ts:286`
  `await historyLoader.load(data.sessionId)` — the single branch point. `load()`
  (`history-loader.ts:40-79`) does: `cancel()` → `setLoadingHistory(true)` →
  `regions.chat.clear()` → `clearContextFooter()` → `subscribeToSession()` →
  `requestHistory()` → await `historyComplete`; `finish()` calls `scrollToBottom()`
  (`:108`) and sets busy/usage/form state.
- **Client event model:** `handleEvent` → `chatRegion.renderEvent(event)`
  (`message-streaming.ts:67-171`, `dom-regions.ts:651-700`). The client `SessionEvent`
  is bare — `{ type, data?, agentId? }` (`types.ts:9-15`): **no seq, id, or
  timestamp**. Keyed dedup (`messageId`/`toolCallId`/`reasoningId`/`turnId`) is
  identity, not ordering. **There is no monotonic ordering signal on the client
  today** — the core gap this spec must fill.
- **Server events:** `broadcastEvent(sessionId, event)` (`websocket.ts:458-485`)
  sends to subscribed viewers only; no seq added. Replay via `streamHistory`
  (`:370-448`) reads `readLastTurnsResult()` which already returns `totalLines`
  (`sdk-session-store.ts:150-165`, counted by `countFileLines`, mtime-cached) —
  **but `totalLines` is not sent to the client today.**
- **`/resume`:** `sessions.ts:241-286`, already returns `throughput` (R4 Slice A).
  A new freshness field slots in beside it.
- **Staleness today:** `historyLoader.isStale` = `lastSessionId !== sessionId ||
  connectionId changed` (`history-loader.ts:85-88`). **No scroll persistence** —
  every load resets to bottom (`scrollToBottom`, `ui-utils.ts:8-13`).
- **WS frame:** already carries an optional `generation` on replay frames
  (`websocket.ts:66-67`) — the precedent for stamping a per-frame number.

## Design

### The freshness token (revised — file-stat version)
**Post-investigation simplification.** The server does **not** own a persist
chokepoint — the SDK writes `events.jsonl` itself and `broadcastEvent`
(`event-bus.ts`/`websocket.ts:458`) is only a live relay, also fired for
non-persisted signals (terminal/watch/surface). So an in-memory broadcast counter
can't faithfully track persisted history. Instead, read the token **directly from
the file** at `/resume`:

**Token = `{ size, mtimeMs }` of `events.jsonl`** (one `statSync`,
`sdk-session-store.ts` owns the path via `sessionPath(sessionId,'events.jsonl')`).
This is faithful by construction because it reflects the real file:
- Append (new events) → `size` grows, `mtimeMs` changes → token differs.
- **History rotation** front-truncates (`session-history-rotation.ts:280`,
  `renameSync`) → `size` shrinks + `mtimeMs` changes → token differs. **No epoch
  needed** — reading the file catches what a counter (which rotation bypasses)
  would miss.
- **Repair** rewrites (`session-auto-repair.ts:84`, `writeFileSync`) → `mtimeMs`
  changes → token differs. Fork/import → new session id or new file.

A false hit needs `size` **and** `mtimeMs` identical while content differs —
impossible in practice (rotation always shrinks; any rewrite bumps mtime; same-ms
appends differ in size). No `events.jsonl` yet → token `null` (never caches/hits).

**This removes three of the four review must-fixes:** no chokepoint counter, no
rotation epoch, no live-frame `eventSeq` stamp, no client event-callback metadata
change. The token is read once, server-side, in the `/resume` handler.

**One exposure point:** `/resume` gains `eventVersion: { size: number;
mtimeMs: number } | null` (`sessions.ts` resume handler), from a new
`getEventVersion(sessionId)` helper in `sdk-session-store.ts`.

### Consequence: interacted-session pessimism (accepted for v1)
Because the token is captured at **load time** and re-read at switch-in, a session
you **sent to** (its `events.jsonl` grew) re-reads a different token → **miss →
re-stream**. Only **idle, untouched** sessions hit. This is the common
click-through-to-read navigation pattern, so it still wins; sessions you actively
worked in re-stream (fast). Live-frame stamping to also hit interacted sessions is a
**possible v2** — deferred until measurement shows the pessimism matters.

### Client cache of the rendered event array
The client already receives every history event during a load. Accumulate them into
an array during `historyLoader.load`, and on `historyComplete` store a cache entry
keyed by sessionId. This is the **re-render** design (the reviewer's lighter option),
chosen over detaching live DOM: on a fresh switch-back the client **re-renders the
cached event array locally** through the existing `renderEvent` path instead of
`requestHistory`-ing over the WebSocket. The normal `finish()` / `caco.context` /
scroll path still runs because re-rendering replays the same events — so there is no
side-effect replication and no detached-DOM lifecycle.

### The cache
`Map<sessionId, CacheEntry>` (module-level, in a new `transcript-cache.ts`), MRU,
capped at **N = 3** (config constant). `CacheEntry`:
```
{ events: SessionEvent[];        // the rendered history event array
  version: { size: number; mtimeMs: number };  // events.jsonl stat at load
  connectionId: number;          // WS identity at load
  isBusy: boolean; }             // session busy state at cache time
```

### Capture (at historyComplete)
When a load completes via the slow path, the client has the full event array and the
`/resume` `eventVersion` for that session. Store
`{ events, version: data.eventVersion, connectionId: getConnectionId(),
isBusy }` keyed by sessionId, evicting LRU beyond N. (No switch-away DOM detach, no
"fully loaded" race — we only cache a transcript we fully received.) A session loaded
**busy** (mid-stream) is **not** cached (its array is incomplete); cache only on a
clean idle `historyComplete`.

### Fast path (switch-in)
At the load seam (`chat-view-controller.ts:286`), before calling
`historyLoader.load`, consult the cache for the incoming session. **Re-render from
cache iff all hold:**
- entry exists, AND
- `entry.version` deep-equals `data.eventVersion` from `/resume` (same `size` AND
  `mtimeMs` — events.jsonl unchanged since cache; catches appends, rotation, repair),
  AND
- `entry.connectionId === getConnectionId()` (no reconnect since cache), AND
- `data.isBusy === false` (the session isn't mid-stream now).

On a hit: `regions.chat.clear()` then **replay `entry.events` through the existing
`renderEvent` path** (the same code the WS stream drives), `subscribeToSession`, and
run the normal post-load finish (busy/usage/form/scroll/`caco.context` all happen
naturally because the events flow through the standard path). **Skip only**
`requestHistory` and the WS round trip. The entry stays cached (re-render doesn't
consume it).

Otherwise: drop any stale entry for this session and call `historyLoader.load` —
**today's exact path, unchanged**. Any drift (appends, rotation, reconnect, busy)
falls back to a correct re-stream.

### Invalidation
- Append / send activity: `events.jsonl` grew → `version.size`/`mtimeMs` differ →
  miss → re-stream (the accepted interacted-session pessimism).
- **Rotation / repair / fork / import:** the file is rewritten → `version` differs →
  miss. The file-stat token catches this with no epoch.
- Reconnect: `connectionId` mismatch → miss.
- Session archived/deleted: subscribe to `onSessionArchived` (`app-state.ts`) and
  drop the entry (frees the array; avoids reusing a gone session).

### Memory
N = 3 cached event arrays (plain data, not DOM) — far lighter than detached DOM
trees. The `isShowingSession` short-circuit (re-click current session) is unaffected.

## Plan (two slices)

### Slice A — server `eventVersion` (no caching yet)
Add `getEventVersion(sessionId): { size, mtimeMs } | null` (one `statSync` of
`events.jsonl`) to `sdk-session-store.ts`, and return it as `eventVersion` from the
`/resume` handler (`sessions.ts`, beside `throughput`). No client change, no behavior
change — pure plumbing. Server-test: a fresh session returns a version; an append
changes it; a rotation changes it; a missing file returns null.

### Slice B — client re-render cache + fast path
`transcript-cache.ts` (MRU Map). Accumulate the event array during load; cache on
clean `historyComplete` with the `/resume` version + connectionId. At the load seam,
take the fast path (clear + local re-render, skip `requestHistory`) when version +
connectionId match and not busy; else `load()`. LRU eviction, archive-invalidation.
Then **measure** the switch-back delta vs the re-stream to decide if a v2 (live-frame
stamping to also hit interacted sessions, or live-DOM detach to skip re-render) is
worth it.

A ships independently. B is the payoff.

## Risks & mitigations
| Risk | Mitigation |
|---|---|
| Reusing a stale transcript (appends/background activity) | `events.jsonl` grew → `version` (size/mtime) differs → miss → re-stream. Correct by construction (token read from the real file). |
| Busy/streaming session re-rendered from a partial array | `isBusy === false` precondition at switch-in; busy sessions are never cached. |
| Reconnect dropped frames | `connectionId` mismatch → miss. |
| **Rotation/repair/fork/import rewrites events.jsonl → stale hit** | Token is the file's `{size, mtimeMs}`, read fresh at `/resume`; any rewrite shrinks/touches the file → `version` differs → miss. No counter/epoch needed. Test: rotate a cached session → switch back → re-streams. |
| False hit (same size+mtime, different content) | Requires identical `size` AND `mtimeMs` with different content — impossible in practice (rotation shrinks; any write bumps mtime). |
| Re-render duplicates/misses messages | Replay the cached array through the same `renderEvent` path the WS stream uses, after `regions.chat.clear()`. Test a cache round-trip renders an identical transcript. |
| Cached array leaks | LRU cap N=3 (plain data, light); `onSessionArchived` eviction. |
| Interacted sessions never hit | Accepted v1 pessimism (documented); a re-render miss is still today's correct re-stream. v2 (live stamping) only if measured value justifies it. |

## Tests
- **Slice A:** `getEventVersion` returns `{size, mtimeMs}` for an existing
  `events.jsonl` and `null` when missing; an append changes the version; a rotation
  changes it; `/resume` response includes `eventVersion`.
- **Slice B:** fast path taken iff `version` deep-equals + same connectionId + not
  busy → re-renders from the cached array and skips `requestHistory`. Miss paths:
  version mismatch (append/rotation) → `load()`; reconnect (connection mismatch) →
  `load()`; busy → `load()`; no cache entry → `load()`. A cache-then-hit round trip
  renders an identical transcript (no dup/missing). LRU evicts beyond N=3. Archived
  session drops its entry. Busy-at-load session is not cached.
- Full gate (`npm run build`) green per slice.

## Acceptance
Switching back to an idle, unchanged, recently-visited session re-renders its
transcript from a cached event array with **no `requestHistory` / no WS round trip** —
fast (local render only). Every not-provably-fresh case (appends, rotation/rewrite,
reconnect, busy, evicted, archived, uncached) falls back to today's exact re-stream.
Zero added cost when not switching; no staleness possible. Measure the switch-back
delta before considering a v2 (live-frame stamping for interacted sessions, or
live-DOM detach to skip the local re-render).
