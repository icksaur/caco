# R2 — Unify the client session-activate seam

Status: implemented (all 3 slices). Parent: `docs/session-lifecycle-architecture.md` §R2.
Prerequisite landed: R1 (delete cleanup). Scope: client only (`public/ts/`).

## Goal

Collapse the **late** half of a client session switch — currently a hand-coded
direct list inside `showChat` **plus** a separate `notifySessionChange` channel
**plus** two footer owners — onto **one ordered activate phase** registered in the
existing `app-state.ts` lifecycle-events section. Then thread the **client**
staleness guards through one token. Result: adding per-session client state is a
single `onSessionActivate` registration, not an edit to `showChat` + a channel +
a cache + a guard.

**Maintainability refactor of correct code.** P1–P8 made transitions correct
under concurrency; R2 consolidates the seams that implement them. Acceptance bar:
**no observable behavior change.**

### Critical correction vs. the parent roadmap
The roadmap (§R2) proposed a *new* `SessionLifecycle` module with
`onSessionDeactivate`/`onSessionActivate` replacing `onActiveSessionChange`. That
is wrong on three counts the code proves:
1. `app-state.ts` **already is** the canonical lifecycle home — it exports
   `onActiveSessionChange(prev,next)`, `onMessageSent`, `onSessionArchived`, with
   a documented convention (`docs/research/global-leak-audit.md`, `docs/code-quality.md`:
   "any module-level `let`/Map keyed by session id MUST declare its LIFECYCLE and
   subscribe to one of these events"). A second module would fork that
   convention.
2. `onActiveSessionChange` already fills the **early** phase correctly: it fires
   on pointer change for switch (`setActiveSession`), new-chat
   (`releaseActiveSessionForNewChat`), and new-session (`onNewSessionCreated`),
   carries `(prev,next)`, and **does not fire on a failed resume**. Replacing it
   risks regressing all of that.
3. The fragmentation is in the **late** half, not the early half.

So R2 **keeps** `onActiveSessionChange` as the early hook and **adds** a sibling
late hook in the same section. Two ordered phases, one home, minimal churn.

### This is one path, not two APIs (design intent)
The value here is **channeling side-effects into one ordered path** for
readability and future change — **not** a new abstraction and **not** a second
way to do the same thing. Three guarantees keep it from becoming "two APIs for
session-changed":

- **Net-removing a mechanism, not adding one.** Today three parallel mechanisms
  carry transition side-effects: the hand-coded `showChat` direct list,
  `notifySessionChange` (Channel 3), and `onActiveSessionChange`. After R2 there
  are **two phases of one family** (`onActiveSessionChange` + `onSessionActivate`,
  both in `app-state.ts` beside `onMessageSent`/`onSessionArchived`).
  `notifySessionChange` is **retired as a public channel** — it survives only as a
  private call *inside* the applet-notify subscriber. So the API-surface count
  goes **down** (3 → 2), and there is exactly **one** place a new side-effect
  registers.
- **The two phases are disjoint, not interchangeable.** They differ by
  fire-condition *and* timing, so "which do I use?" has a deterministic answer:

  | | `onActiveSessionChange` (early) | `onSessionActivate` (late) |
  |---|---|---|
  | Fires when | the active-session **pointer** changes | a session becomes the **displayed, history-loaded** session |
  | Also fires for | new-chat (next=`null`), new-session | switch + new-session (never new-chat, never failed resume) |
  | Payload | `(prev, next)` | `ActivateCtx` (full `SessionInfo` + `isCurrent()`) |
  | Use it for | teardown/clear keyed on leaving/entering | post-history activation rendering (footer, applet notify, menu, adhoc) |

  Decision rule (to document in-code): *clear/prune on pointer change → early;
  render/restore for the now-active session → late.*
- **`showChat` stays the orchestrator, not a registry.** It still owns the
  ordered sequence (resume → load → activate); the hooks just hold the
  *session-scoped* steps that used to be inline. View-only setup (form bind,
  `setViewState`) stays in `showChat`. No logic is duplicated between the two —
  each side-effect lives in exactly one phase.

## Non-goals
- No new behavior / per-session state / protocol changes.
- No change to P1 mutex, P2 dispatch ownership, P4 idempotent init.
- No change to the applet-facing `onSessionChange` API (only its *caller* moves).
- WS server-stamped replay `generation` is **not** touched (see Slice 2).
- R4 (server load bundle) is separate/downstream.

## Current shape (grounded, file:line verified)

### Early phase — already unified (keep as-is)
`onActiveSessionChange(prev,next)` (`app-state.ts:84-104`), dispatched by
`setActiveSession` (`:79`) and `releaseActiveSessionForNewChat` (`:165-170`).
Three subscribers, all correct:

| Subscriber | File:line | Behavior | Phase note |
|---|---|---|---|
| applet pendingState clear | `applet-runtime.ts:286` | `pendingAppletState = null` | pure early clear |
| staged-image clear | `image-paste.ts:50-52` | clears iff `prev!==null && prev!==next && images.length>0` | needs **both** prev & next; also clears on new-chat (next=null) |
| terminal reveal | `terminal-panel.ts:122-124` | `if (open) setTimeout(()=>revealActive(),0)` | **not a clear** — deferred reveal that must land *after* `subscribeToSession`; also wired to `onReconnect` |

Fires for switch at `resumeAndLoad:285` (after a **successful** resume +
`assertCurrent`), before `historyLoader.load:288`. Never fires on failed resume.

### Late phase — fragmented (the target)
Two parallel late channels:
- **Direct list in `showChat`** (`chat-view-controller.ts:347-357`): form bind
  (347-348), `footerSessionId=` (350), `updateMenuIndicators()` (351),
  `notifySessionChange()` (352), `updateStatus()` (353),
  `restoreContextUsage()` (354), `restoreThroughput()` (355),
  `adHocBar.activateSession()` (356), `setViewState('chatting')` (357).
- **`notifySessionChange(id,info)`** (`applet-runtime.ts:62-66`) → active applet's
  `onSessionChange`.

Transcript/footer clear + WS subscribe live in `historyLoader.load`
(`history-loader.ts:41-46`: `cancel()` → `regions.chat.clear()` →
`clearContextFooter()` → `subscribeToSession()` → `requestHistory()`). This is the
load itself, **not** a registered subscriber; it stays put.

### Four staleness guards
| Guard | Where | Role |
|---|---|---|
| (a) `navGeneration`+`assertCurrent`→`SupersededError` | `chat-view-controller.ts:47,186,221-223`; checked :198,:279 | slower earlier activation overwriting newer intent |
| (b) `historyLoader.lastSessionId`+`lastConnectionId` | `history-loader.ts:32-33,85-88,103-104` | drives `isStale()` for the `isShowingSession` short-circuit (`:158-167`) **and** reconnect staleness — **not just** per-load ordering |
| (c) WS `currentHistoryGen` (`isStaleReplay`) | `websocket.ts:59-60,97,384-386` | discards **server-stamped** replay frames; **not 1:1 with activation** (reconnect reload `message-streaming.ts:188-193` requests history w/o activation; `onNewSessionCreated` activates w/o `requestHistory`) |
| (d) `restoreApplet` microtask re-check | `chat-view-controller.ts:303-310` | late async applet/URL write losing to a synchronously-following activation |

### Two footer owners + caches
- `chatView.footerSessionId` (`:54`; set :133,:286,:350; guards :435,:455,:464,:469).
- `activeFooterSessionId` (`context-footer.ts:19`; set :129,:166; read :81,:111).
- Session-keyed caches in `context-footer.ts`: `usageCache` (restored `showChat:354`), throughput (restored `:355`).

## Design

### The late hook (in `app-state.ts`, beside `onActiveSessionChange`)
```
interface ActivateCtx { sessionId: string; cwd: string; info: SessionInfo;
                        prevId: string | null; isCurrent(): boolean; }
onSessionActivate(fn: (ctx: ActivateCtx) => void): Disposer
notifySessionActivated(ctx: ActivateCtx): void   // dispatch, ordered, try/catch per handler
```
Subscribers run in **registration order**, single dispatch, exceptions isolated
(same tolerance as `notifyActiveSessionChange`/`notifySessionChange` today).
Dispatch is synchronous; a subscriber may schedule async work that **self-guards
via `ctx.isCurrent()`** (this is how `restoreApplet`'s fire-and-forget tail
survives). Registration is once-at-init (P4-idempotent).

`showChat` shrinks to orchestration only — form bind + `setViewState('chatting')`
stay inline (they are view setup, not session-scoped state) — then calls
`notifySessionActivated(ctx)`. The session-scoped late work becomes subscribers:

| Moves to `onSessionActivate` | From |
|---|---|
| applet notify (folds Channel 3; `notifySessionChange` fn kept, now called by this subscriber) | `showChat:352` |
| menu indicators | `:351` |
| adhoc activate | `:356` |
| footer: status render + usage + throughput restore + owner set | `:350,353,354,355` (Slice 3) |

`onNewSessionCreated` (`:364-375`) also fires `notifySessionActivated` so the
new-session path gets identical late wiring (today it re-hand-codes a subset).
`showNewChat` (`:126-139`) transitions to the **newChat** view, not chatting —
it fires the **early** hook only (via `releaseActiveSessionForNewChat`) and **no**
activate phase. Reconnect `reloadHistory` (`:387-395`) changes no active pointer
and fires **neither** phase — it only reloads history (transcript clear via
`load()`); unchanged.

### Generation unification (client guards only)
One monotonic token in `chat-view-controller` (the existing `navGeneration`,
exposed via `ctx.isCurrent()`):
- (a) stays as `assertCurrent` at the two orchestrator seams (`SupersededError`
  semantics preserved).
- (d) `restoreApplet` re-check becomes `ctx.isCurrent()` (an activate subscriber),
  keeping the one-microtask yield.
- (b) `lastSessionId`/`lastConnectionId` **stay** — they power `isStale()` for the
  `isShowingSession` short-circuit and reconnect detection, which the token does
  not replace. The token is **additive** for ordering, not a removal of (b).
- (c) WS replay generation **stays independent** — it is server-echoed and **not**
  1:1 with activation (reconnect reload; new-session). Documented exception; do
  not derive it from the token.

Net collapse: (a) and (d) share one token; (b) and (c) keep their distinct roles.
This is a smaller, honest claim than "4 guards → 1".

### Footer unification (Slice 3)
`context-footer.ts` becomes sole owner: `ownerSessionId` (rename of
`activeFooterSessionId`) + `isFooterOwner(sessionId): boolean`. Delete
`chatView.footerSessionId`; its four update-guards call `isFooterOwner()`. Footer
set/render/restore run in the activate subscriber. `usageCache`/throughput maps
unchanged (already session-keyed; already pruned via `onSessionArchived`).

## Plan (three independently shippable, independently testable slices)

### Slice 1 — Add `onSessionActivate`; fold the late channel
Add the hook to `app-state.ts`. Register applet-notify (folding Channel 3), menu
indicators, and adhoc as subscribers; `showChat` and `onNewSessionCreated` call
`notifySessionActivated`. Delete the direct calls they replace and the direct
`notifySessionChange` call (the `notifySessionChange` *function* and applet API
stay). Footer + form-bind + view-state untouched this slice. **Behavior-neutral:**
same calls, same order (registration order mirrors the old line order), now via
one hook. This is the bulk of the maintainability win.

### Slice 2 — Client-guard token
Thread `ctx.isCurrent()` (from `navGeneration`) into the `restoreApplet` re-check
(d). Keep (a) `assertCurrent`, keep (b) `isStale`, keep (c) WS gen. Regression
anchor: existing P3 stale-overwrite tests. (Smallest slice; can be skipped if it
proves to add no clarity — flag for the implementer.)

### Slice 3 — Footer ownership
`activeFooterSessionId`→`ownerSessionId`+`isFooterOwner`; delete
`chatView.footerSessionId`; repoint its four guards; move footer set/restore into
the activate subscriber.

## Risks & mitigations
| Risk | Mitigation |
|---|---|
| Moving a late call changes order/timing | Slice 1 registers in the exact `showChat:347-357` order; assert via switch test that footer/applet/menu still update once, post-history |
| Early "clear" accidentally fires on failed resume | Early hook is **unchanged**; activate phase is post-history (success only); no new early dispatch added |
| `image-paste` predicate needs prev & next | Early hook (kept) already carries `(prev,next)`; untouched |
| terminal reveal mis-phased | Stays on the early hook + its own `setTimeout(0)`; not migrated to activate |
| Applet `onSessionChange` contract breaks | `notifySessionChange` fn unchanged; only its caller moves into a subscriber |
| WS gen coupling | Left independent; documented non-1:1 with activation |
| `restoreApplet` async tail under sync dispatch | Subscriber schedules its own microtask, self-guards via `ctx.isCurrent()` |
| Double registration (P4) | Register once in existing init; init is idempotent |
| new-session path diverges | `onNewSessionCreated` calls the same `notifySessionActivated` |

## Tests
- **Hook unit**: registration order preserved; handler throw isolated;
  `isCurrent()` false after a newer token.
- **Switch**: footer/applet-notify/menu/adhoc each fire once, after history, for
  the activated session only.
- **Failed resume**: staged image/applet state **preserved** (early hook does not
  fire; activate phase not reached).
- **New-chat**: early hook fires (staged clears), **no** activate phase, view =
  newChat.
- **New-session** (`onNewSessionCreated`): activate phase fires identically to a
  switch.
- **Reconnect reload**: neither phase fires; history reloads; no double late-wiring.
- **Terminal reveal**: still deferred until after `subscribeToSession`.
- **Footer (Slice 3)**: non-owner `updateUsage`/`updateThroughput` dropped; owner
  repoints once.
- Full gate (`npm run build`) green after each slice.

## Acceptance
The late session-activate work flows through one ordered `onSessionActivate` hook
co-located with the existing early hook; `notifySessionChange` is retired as a
caller; footer has one owner; client guards (a)+(d) share one token while (b)+(c)
keep their distinct, still-needed roles. No observable behavior change; adding a
new per-session client subsystem is one registration.
