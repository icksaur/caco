# P7 — Mutation boundaries + protocol typing

Phase P7 of the brutal code-review remediation. Three largely independent
changes, each its own commit-sized slice with its own oracle. Rubric:
`doc/code-quality.md` (make-illegal-states-unrepresentable > encapsulate >
assert > test-seam > comment).

## Goals

Close three correctness gaps the review flagged:

1. **MCP auth lost-update.** Every MCP-auth writer does read-modify-write as
   `read snapshot → await network → write {...snapshot, changes}`. A concurrent
   write (token refresh vs. clientId edit, or two refreshes) during the await is
   silently clobbered. Make the read-modify-write atomic so the merge base is
   always the freshest persisted state.
2. **Extension handler accumulation.** `clientMessageHandlers` is a
   module-global `Map` never cleared; a reload stacks/overwrites handlers and
   duplicate registration only `warn`s. Give extensions an owned lifecycle
   (`load`/`reload`/`unload`) and make duplicate registration an error.
3. **WS stale history streams.** A *superseded* `requestHistory` (rapid session
   switch A→B→A, a cancelled load whose events are still arriving) keeps
   streaming its replay into the DOM, and append-based deltas double-append. Tag
   history-replay frames with a generation token so the FE discards a stale
   stream. Also type the `{ sessionId, event }` envelope and assert `sessionId`
   on session-scoped frames instead of silently dropping.

   **Scope boundary (important).** This slice fixes the *stale/superseded
   overlapping-replay* vector only — matching plan.md's commitment ("discard
   stale history completions"). It does **not** fix the *single-load
   live-vs-replay* interleaving (reconnect mid-turn): because the FE subscribes
   to live broadcasts *before* requesting history (`public/ts/history-loader.ts:46`
   then `:56`), a delta the SDK persists-and-broadcasts in the race window
   between subscribe and the server's disk read is delivered twice — once live
   (untagged) and once in the *current* replay (current generation) — and both
   append to the same keyed element (`public/ts/dom-regions.ts:508-515`). A
   generation token cannot distinguish these (neither is stale). That bug needs
   per-frame sequence semantics or, cleaner, **history replay that excludes the
   in-flight turn the live stream owns**; it is explicitly deferred to its own
   phase (P9 candidate) and called out here, not silently implied as fixed.

## Slice 1 — atomic `updateMcpServerAuth`

### Design

Add to `src/mcp-auth-store.ts`:

```ts
export function updateMcpServerAuth(
  serverId: string,
  fn: (prev: MCPAuthState | undefined) => MCPAuthState,
): MCPAuthState {
  const store = getMcpAuth();           // fresh read
  const next = fn(store.servers[serverId]);
  store.servers[serverId] = next;
  setMcpAuth(store);                    // synchronous write
  return next;
}
```

Critical property: **no `await` between the read and the write**. The closure
runs synchronously; all network/async work stays *outside*, and the closure only
merges its result onto `prev` (the just-read value), never onto a pre-await
snapshot. Node is single-threaded, so a synchronous read-modify-write of the
JSON file is atomic with respect to other JS callers.

Migrate **every** read-before-await-write site (each captures a snapshot, does
async work, then writes `{...snapshot, ...}` — clobbering any concurrent write
that landed during the await). Full enumeration (verified):

- `src/mcp-auth-service.ts` `refreshAccessToken` — all four `setMcpServerAuth`
  writes (success ~40, `!res.ok` ~29, no-token ~35, catch ~53). The initial
  guard read (`refreshToken`/`tokenEndpoint`/`clientId`) stays as a
  `getMcpServerAuth` precheck; the merge base inside each closure is re-read fresh.
- `src/routes/mcp-auth.ts` `/start` discovery (~97-115) — reads `serverAuth`,
  `await discoverOAuthMetadata`, writes merged stale; merge onto `prev`.
- `src/routes/mcp-auth.ts` main `/callback` (~220-240) — reads before
  `await exchangeCodeForToken`, writes after; both success and catch.
- `src/routes/mcp-auth.ts` temp-server `/callback` (~364-378) — captures
  `serverAuth` far above (~183) before the async token exchange; both branches.
- `src/routes/mcp-auth.ts` clientId-config route (~257-273) — pure RMW, no await,
  convert for consistency and to drop the explicit get+set pair.
- `src/mcp-auth-tools.ts` (~38-102) — the `getMcpAuth → mutate → setMcpAuth`
  blocks that bracket awaits. Where the mutation spans the whole store (not one
  server), either re-read inside the write or add a sibling
  `updateMcpAuth(fn: (store) => store)` boundary; prefer the per-server boundary
  where the change is server-scoped.

`src/mcp-config-loader.ts` is **read-only** for this store (reads at ~43/56 to
build SDK config; the only write is the `refreshAccessToken` call it delegates
to) — no mutation-boundary change needed there.

Keep `setMcpServerAuth`/`getMcpServerAuth` (still used for pure reads and
non-RMW writes); only the read-await-write callers move.

### Oracle

Invariant/property test (independent of the code under test): a concurrent
"clientId edit" interleaved between an in-flight refresh's read and write must
survive. Drive two `updateMcpServerAuth` calls around a controlled async gap and
assert the final persisted state contains **both** mutations (token from refresh
AND clientId from the edit) — impossible under the old snapshot-clobber path.
Red check: a reference test reproducing the old `read→await→write {...snapshot}`
loses one mutation; the new boundary keeps both.

## Slice 2 — `ExtensionRuntime` lifecycle

### Design

Wrap the module-global maps (`clientMessageHandlers`, `extensionMetadata`) in an
`ExtensionRuntime` class instance owning that state, with:

- `load(app)` — current `loadServerExtensions` behavior.
- `unload()` — clear `clientMessageHandlers` + `extensionMetadata` (releases
  stale handler closures; the accumulation vector).
- `reload(app)` — `unload()` then `load(app)`.
- `onClientMessage(type, handler)` — **duplicate registration throws** (was
  `console.warn` + silent overwrite). Two extensions claiming the same client
  message type is a programming error, not a recoverable warning.

Preserve the existing module-level exports (`loadServerExtensions`,
`getClientMessageHandler`, `getExtensionMetadata`) as thin delegates to a
singleton `extensionRuntime` so callers (server.ts, routes/websocket.ts) don't
change. This keeps the public surface stable while making the bad state (stale
handlers, duplicate registration) unrepresentable.

Note: per-extension router `app.use('/ext/:slug', extRouter)` (`extension-runtime.ts:141`)
stacks a new router on every load and Express has no public un-route. `unload`
therefore clears **handler/metadata state only** — it does NOT remove routes.
Consequence: `reload` is safe for the handler-accumulation vector (the actual
bug) but is **not route-safe**, so it must not be wired to a live reload path
until a stable per-slug delegating router (mounted once, body swapped on reload)
is added. That delegating-router design is out of scope here — no reload caller
exists today (`server.ts:198` is the only `loadServerExtensions` call); this
slice is make-unrepresentable hardening like P4. Do not claim routes are
"re-registered idempotently" — they are not.

### Oracle

- Duplicate `onClientMessage(type, ...)` across two extensions **throws** (hand
  case: register twice, expect throw; the second handler must NOT silently win).
- `unload()` clears handlers: after `unload`, `getClientMessageHandler(type)` is
  `undefined` (was retained). Red: prior code leaves the handler resident.

## Slice 3 — WS history generation token + typed envelope

### Design

**Generation token (stale-replay discard).** Only *history-replay* frames are
taggable; live broadcast frames are not — this is what lets the FE distinguish
and discard a *superseded* replay.

- FE `public/ts/websocket.ts`: module-level `historyGeneration` counter.
  `requestHistory(sessionId)` pre-increments it, records `currentHistoryGen`,
  and sends `{ type:'requestHistory', sessionId, generation }`.
- BE `src/routes/websocket.ts`: `streamHistory(ws, sessionId, generation)` stamps
  `generation` on every `event` frame it sends and on the terminal
  `historyComplete`. Live `broadcastEvent` frames carry no `generation`.
- FE `handleMessage`: an `event`/`historyComplete` frame that carries a
  `generation` is a history-stream frame — **discard if
  `generation !== currentHistoryGen`**. Frames with no `generation` (live) are
  never discarded by this rule. This drops a superseded stream's replay
  (including its append-based deltas) so it cannot interleave into the DOM.

This fixes the *superseded overlapping-replay* vector: a rapid switch A→B→A or a
`historyLoader.cancel()`'d load whose already-queued replay frames keep arriving
after a new load started. Those carry the old generation and are dropped.

**Explicitly NOT fixed by this slice (deferred):** the *single-load
live-vs-replay* double-append. The FE subscribes to live frames before
requesting history (`history-loader.ts:46` precedes `:56`), so a delta the SDK
persists-and-broadcasts during the race window between subscribe and the
server's disk read is delivered both live (untagged) and in the current replay
(current generation); the generation check cannot separate them because neither
is stale. Resolving it requires either per-frame sequence numbers shared across
the history and live paths, or — cleaner — making `streamHistory` exclude the
in-flight turn that the live stream owns (replay completed turns only; let live
own the active turn). That is a distinct design with real turn-boundary
detection and gets its own phase. This slice must not claim to resolve it.

**Typed envelope + assertion.** Today `event`/`historyComplete` smuggle the
payload via `msg as unknown as { event?: SessionEvent }`. Make `ServerMessage` a
real **discriminated union** keyed on `type` (so an `event` frame structurally
requires `{ event: SessionEvent; sessionId: string; generation?: number }` and a
`historyComplete` requires its `data` shape), and replace the `as unknown` casts
on both BE and FE. On the FE, assert/log when a session-scoped frame arrives
without `sessionId` rather than letting the `if (msgSessionId && …)` filter
silently pass it through.

### Oracle

- Generation discard (invariant): given two `requestHistory` calls (gen N then
  N+1), `event` frames tagged gen N are dropped by `handleMessage` while gen N+1
  frames and untagged (live) frames are delivered to `eventCallbacks`. Drive
  `handleMessage` directly with crafted frames; assert callback receipt set.
  Red: without the generation check, the stale gen-N frames are delivered.
- `historyComplete` for a stale generation does not resolve the current load:
  assert the historyComplete callback is invoked only for the current gen.
- BE: `streamHistory` stamps the passed generation on emitted frames (spy on
  `send`; assert every `event`/`historyComplete` carries it). FE round-trips the
  generation it sent.
- (Negative/boundary) An untagged live `event` frame is **never** dropped while a
  history load is in flight — pins that the discard rule keys strictly on
  presence of a mismatched `generation`, protecting the live path.

## Considerations

- **Back-compat of the generation field.** Old FE ⇄ new BE or vice-versa: the
  field is additive and optional. A BE that receives `requestHistory` without a
  `generation` streams with `generation` undefined; the FE rule only discards
  when a frame *has* a generation that mismatches, so missing-generation behavior
  is exactly today's behavior. No protocol break.
- **Reconnect generation.** FE already has a *connection* generation
  (`getConnectionGeneration`) for reconnect bookkeeping — distinct concept; the
  history generation is per history-load. Do not conflate; name it clearly
  (`historyGeneration`).
- **MCP file lock.** The atomic boundary protects against *in-process* JS
  interleaving (the actual bug: async gaps). It does not add cross-process file
  locking; Caco is single-process for this store, so that is sufficient and in
  scope. Note the boundary, not a lock.
- **Slices are independent.** 1/2/3 touch disjoint files and can land in any
  order; each ships green on its own.

## Risks & mitigations

- *Throwing on duplicate extension registration could crash load* — mitigate:
  the throw is caught by the existing per-extension `try/catch` in the load loop
  (logs `[EXT:slug] Failed to load`), so one bad extension fails in isolation,
  not the whole server. Verify the throw is inside that try.
- *Generation discard could drop live frames* — mitigate: only frames that
  *carry* a generation are subject to the check; live frames are emitted by a
  different code path that never stamps one. Oracle pins this.
- *Migrating MCP writers could change observable persisted shape* — mitigate:
  the closure produces the identical object literal as today; only the merge base
  (fresh vs. stale) changes. Existing mcp-auth tests are the snapshot guard.

## Acceptance

- All gates: `npm run typecheck` (×2), `npm run lint:strict`, `npm run knip`,
  `npx vitest run` — green after each slice.
- New oracle tests per slice (above), each verified red→green.
- No change to the public module surface of extension-runtime or mcp-auth-store
  (additive only).
- Slice 3 acceptance is bounded to **stale/superseded replay discard**; the
  single-load live-vs-replay double-append is explicitly out of scope and
  recorded as deferred (below), not asserted fixed.

## Deferred (own phase)

- **Live-vs-replay single-load double-append.** Recommended direction:
  `streamHistory` excludes the in-flight turn (replay completed turns; live owns
  the active turn), or per-frame sequence numbers shared across history+live so
  the FE drops `seq <= lastApplied`. Needs turn-boundary detection; design
  separately.
- **Extension reload route-safety.** A per-slug delegating router (mounted once,
  body swapped on reload) so `reload` becomes route-safe. Only needed when a live
  reload caller is introduced.

## Plan

- [ ] Slice 1: `updateMcpServerAuth` (+ optional `updateMcpAuth`) and migrate ALL
      enumerated RMW sites (refreshAccessToken ×4, /start, main /callback, temp
      /callback, clientId route, mcp-auth-tools) + interleave oracle.
- [ ] Slice 2: `ExtensionRuntime` (load/unload/reload), duplicate=throw, delegating
      exports + oracles (route-safety bounded out).
- [ ] Slice 3: history generation token (FE+BE), discriminated `ServerMessage`,
      sessionId assert + oracles (stale-replay discard only; live-vs-replay deferred).
- [ ] Background code-review (gpt-5.5, ref code-quality.md); apply warranted.
