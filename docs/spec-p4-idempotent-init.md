# P4 — Idempotent app init (duplicate event streams)

## Goals

Make the two app-lifetime initializers — `initMessageStreaming()` /
`registerWsHandlers()` (`public/ts/message-streaming.ts`) and
`initSessionPanel()` (`public/ts/session-panel.ts`) — *idempotent*: calling
either more than once must not register a second copy of any WS subscription,
tracker subscription, or DOM listener. This is **initializer hardening** that
removes one duplication vector; it is **not, by itself, a full fix** for the
duplicate-event-stream symptom (see "What P4 does and does not fix").

## Background / current behaviour

`init()` runs once per `DOMContentLoaded`. Inside it:

- `initMessageStreaming()` → `registerWsHandlers()` calls `onEvent(handleEvent)`,
  `sessionTracker.onChange(<anon>)`, `onReconnect(<anon>)`. Each returns a
  disposer; all are discarded.
- `initSessionPanel()` calls `onGlobalEvent(<anon>)`,
  `sessionTracker.onChange(<anon>)`, and attaches four
  `dragenter/dragover/dragleave/drop` listeners to `#sessionView`. All
  disposers/handles discarded.

These subscribe into module-level `Set<callback>` registries
(`public/ts/websocket.ts`) and the `sessionTracker` observer set.

**Idempotency is NOT uniform across these registrations:**

- `onEvent(handleEvent)` is **already idempotent**: `handleEvent` is a stable
  module-level function reference, and the registry is a `Set`, so re-adding the
  same reference is a no-op. A double-init does NOT double-dispatch live `event`
  frames to `handleEvent`. (The original root-cause claim that it did was
  wrong.)
- The **anonymous** registrations are NOT idempotent: each call creates a fresh
  closure, so a double-init stacks two `sessionTracker.onChange` closures, two
  `onReconnect` closures, two `onGlobalEvent` closures, and a second set of drag
  listeners. The most consequential is **double `onReconnect`**: on the next
  reconnect it fires `chatView.reloadHistory(sessionId)` twice → two overlapping
  `requestHistory` streams of the same stored events into the same DOM, and
  history replay **includes append-based events** (`deltaContent` passes
  `shouldFilter`; see below), so the interleaved streams double-append.

Most keyed events are collapsed idempotently by the render-side global keyed
dedup (commit 1303a6a), but **append-based events are not** — `handleDelta`
concatenates onto the keyed element. Append-based event types include
`assistant.message_delta`, `assistant.reasoning_delta`,
`tool.execution_progress`, and `tool.execution_partial_result`.

There is no current code path that calls these initializers twice. This phase is
**make-unrepresentable hardening** (per `code-quality.md`: prefer making the bad
state impossible over relying on call-site discipline). It removes the
listener-accumulation vector, unblocks any future hot-reload / re-init path
without reintroducing it, and pins the property with a regression test.

## What P4 does and does not fix

- **Fixes (hardening):** stacked anonymous WS/tracker/DOM listeners on any
  repeated init — eliminating double `onReconnect` → double history stream, and
  double-firing drag/global handlers.
- **Does NOT fix (deferred to P7):** the append-based double-append that can
  occur *without* listener accumulation — e.g. a single `onReconnect`-driven
  `reloadHistory` interleaving with a still-live delta stream, or any path where
  the server delivers the same append-based frame twice. That needs per-event
  sequencing / a subscribe generation token, which is P7's WS-protocol work.
  P4 must not claim to resolve the duplicate stream in those reconnect/switch
  scenarios.

## Use cases

1. **Normal boot (unchanged):** `init()` calls each initializer once; all
   handlers wire exactly as today. No behavioural change.
2. **Accidental / future double-init:** a second call to `initMessageStreaming()`
   or `initSessionPanel()` is a no-op for registration — the existing single set
   of handlers stays in place; no duplicate WS dispatch, no duplicate drag
   handling.
3. **Explicit teardown (optional, see below):** a `disposeX()` for tests so the
   double-init regression test can run handlers, assert single dispatch, then
   clean module state between cases.

## Design

### Idempotency guard + stored disposers

Each initializer is guarded by a module-level boolean and stores its disposers so
it owns its own teardown. **Set the guard `true` only after every registration
succeeds**, and unwind on partial failure, so a throw mid-registration cannot
leave the module marked initialized with missing handlers:

`message-streaming.ts`:

```ts
let wsHandlersRegistered = false;
const wsHandlerDisposers: Array<() => void> = [];

function registerWsHandlers(): void {
  if (wsHandlersRegistered) return;
  const disposers: Array<() => void> = [];
  try {
    disposers.push(onEvent(handleEvent));
    disposers.push(sessionTracker.onChange((sessionId, state) => { ... }));
    disposers.push(onReconnect(() => { ... }));
    wsHandlerDisposers.push(...disposers);
    wsHandlersRegistered = true;
  } catch (e) {
    for (const d of disposers.reverse()) { try { d(); } catch { /* ignore */ } }
    throw e;
  }
}
```

`initMessageStreaming()` keeps constructing `chatRegion` but the
`ChatRegion`/click-handler construction must also be guarded so a second call
does not replace the live `chatRegion` instance or double-bind its click
handler. A single `messageStreamingInitialized` boolean covering both the region
and the handlers is acceptable, since they are always wired together; the early
`if (initialized) return;` sits at the top of `initMessageStreaming()`.

`session-panel.ts` follows the same shape: guard boolean,
`onGlobalEvent`/`sessionTracker.onChange` pushed as disposers, and the four drag
listeners captured as **named consts** so the disposer can call
`panel.removeEventListener(type, handler)` with the same reference.

`sessionTracker.onChange` already returns a disposer
(`public/ts/session-state-tracker.ts:128`), so no tracker change is needed.

### Test seam

Export `disposeMessageStreaming()` / `disposeSessionPanel()` that run every
stored disposer, clear the array, and flip the guard back to `false`. This is the
seam the double-init test uses to reset module state between cases and the hook a
future soft-reload path would call. Prefer plainly-named `disposeX()` over a
`__test` suffix; document that production currently has no caller.

**Click-handler caveat:** `ChatRegion.setupClickHandler()` currently adds an
anonymous listener and returns no disposer. The init *guard* already prevents a
double click-binding on a plain double-init (the guard short-circuits before
`setupClickHandler` runs again). But `disposeMessageStreaming()` cannot fully
undo the click handler, so a dispose→re-init cycle would leak it. Since P4 has no
production dispose caller, scope `disposeMessageStreaming()` to undo only the
registrations it owns (the three WS/tracker disposers) and leave `chatRegion`
in place; the regression test does not need ChatRegion reconstruction. Note as
P7/reload follow-up: make `setupClickHandler()` return a disposer (or have
`ChatRegion` guard its own click binding) before any real reload path ships.

### What this does NOT change

- WS connection lifecycle, reconnect, subscribe semantics — untouched.
- `handleEvent`, render pipeline, `ChatRegion.renderEvent` keyed dedup — untouched.
- The `loadPromptTemplates()` disposer pattern in `main.ts` already does the
  right thing (runs prior disposers before re-registering); left as-is.

## Delta sequence dedup — explicitly DEFERRED to P7 (not in P4)

The roadmap line for P4 also floated "dedup deltas by sequence/event id". This is
**deferred to P7** (WS protocol typing + subscribe generation token) and should
NOT be implemented here:

1. **No native id exists.** SDK `assistant.message_delta` events carry only
   `messageId` + `deltaContent` (`public/ts/types.ts`); the same is true of the
   other append-based types (`assistant.reasoning_delta`,
   `tool.execution_progress`, `tool.execution_partial_result`). There is no
   per-delta sequence number. Sound dedup requires a stable per-event id, which
   means inventing a BE event-emission protocol field — large blast radius,
   overlapping the deferred "discriminated-union `SessionEvent`" refactor and
   **P7**.
2. **Append-based replay is real and NOT fully solved by P4.** History replay
   passes `deltaContent` through `shouldFilter` (`src/event-filter.ts:34`,
   `src/routes/websocket.ts:364`) and `readLastTurns` does not collapse deltas
   into final messages — so stored deltas *are* re-streamed on history load.
   P4 removes the listener-accumulation vector (double `onReconnect` → double
   `requestHistory`), but a single history replay interleaving with a live delta
   stream, or any server-side double-delivery of an append frame, can still
   double-append. That residual sequencing problem is P7's, not P4's.
3. Content-based delta dedup is unsound (legitimate repeated tokens).

Record this scoping in `plan.md`: P4 = idempotent-init hardening; the real
append-frame dedup needs P7 sequencing.

## Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Guard flips `true` but a partial failure mid-registration leaves some handlers unwired | Set guard `true` only after all `push`es succeed; registration calls are synchronous and cannot throw in practice, but order guard-last to be safe. |
| `sessionTracker.onChange` has no disposer | Add one; it is a `Set.delete` one-liner. Verify no other caller depends on the void return. |
| Drag disposer removes the wrong handler | Capture each listener as a named const; pass the same ref to `addEventListener`/`removeEventListener`. |
| Hidden second init path exists today and currently "works" by luck | Grep confirms only `main.ts` calls each once. The guard is a no-op for the single-call path. |
| Test seam ships in prod bundle | Acceptable: it is a tiny pure function with no prod caller; documented. Alternative (build-stripping) is not worth the complexity. |

## Acceptance

- `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.frontend.json`,
  `npx eslint . --max-warnings 0`, `npx vitest run` all green.
- New `tests/unit/idempotent-init.test.ts` (or per-module): mock the WS
  registration functions (`onEvent`, `onReconnect`, `onGlobalEvent`) and
  `sessionTracker.onChange`, call the initializer twice, and assert each
  registration function was invoked exactly once (registration count, not live
  dispatch — `handleMessage`/registries are private). For `initSessionPanel`,
  also assert `#sessionView.addEventListener` is called once per drag type across
  two inits. Verified RED by temporarily removing the guard. Use
  `disposeMessageStreaming()`/`disposeSessionPanel()` to reset between cases.
- `plan.md` P4 updated: idempotent-init done; delta-id deferred to P7 with
  rationale.

## Out of scope

- Server-side subscription de-duplication (the server already broadcasts; FE
  filters). If the server can register a browser twice, that is a separate BE
  item — not observed in current FE code.
- Any change to delta rendering.
