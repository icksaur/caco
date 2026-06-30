# P3 — Frontend activation/send transactions

## Goals

Make the three frontend async flows that currently leak across sessions behave
as **transactions bound to a target session**, so a slower earlier completion
can never overwrite newer user intent. This is the largest remaining FE
reliability risk identified in `code-review-frontend.md` (the "stale async
overwrite" family behind flaky session switch/start).

Three independent fixes, shippable together:

| # | File | Bug today |
|---|------|-----------|
| 3a | `public/ts/chat-view-controller.ts` | `activateSession()` has no supersession guard: a slower earlier `resumeAndLoad()` can call `setActiveSession`/`showChat` after a newer activation, restoring the old session over a newer click. |
| 3b | `public/ts/message-streaming.ts` | `streamResponse()` new-chat path captures no launch baseline. If the user switches sessions while `/api/sessions` or `/messages` is in flight, the catch restores prompt/busy on whatever session is active *then*, and the new-chat path can yank the view to the just-created session after the user already navigated away. |
| 3c | `public/ts/history-loader.ts` + `public/ts/websocket.ts` | `historyComplete` callbacks carry no session id; `finish()` applies busy/usage/form-enable to `getActiveSessionId()` instead of the request's session id. A completion for a non-active load mutates the wrong session's UI. |

## Non-goals

- No protocol/event-shape changes beyond forwarding the `sessionId` the server
  **already** includes on `historyComplete` (`src/routes/websocket.ts:313,432,438`).
- The applet-level stale-response bugs (git-status, text-editor, image-gallery,
  session-surface) are separate roadmap items, not P3.
- No change to the per-client server-side transition mutex (that was P1).

## Current behavior (analysis)

### 3a — activation

`activateSession(sessionId)` (`chat-view-controller.ts:164`):
1. fast-path `isShowingSession` early return,
2. `setSessionLoading(sessionId, true)`,
3. `await resumeAndLoad(sessionId)` — which itself, after its awaits, runs
   `setActiveSession(data.sessionId, …)`, `this.footerSessionId = …`, and
   `await historyLoader.load(data.sessionId)` (`:256-259`),
4. `showChat(...)`, `setResponseOptions`, `setActiveContextBudget`,
   `restoreApplet(...)`,
5. `finally`: `setSessionLoading(sessionId, false)`.

Two concurrent activations (rapid clicks A then B) race: whichever resolves
*last* wins, regardless of which the user clicked last. `historyLoader.load`
already cancels a prior in-flight load, but `setActiveSession`/`footerSessionId`
/`showChat` from the stale activation still fire.

### 3b — send

`streamResponse(prompt, model, imageData, newChat, cwd)` (`message-streaming.ts:221`):
- `currentId = getActiveSessionId()` captured up front; busy/savePrompt applied
  to it.
- new-chat branch: `regions.chat.clear()`, `await POST /api/sessions`, then
  `onNewSessionCreated(newId)` (switches view to chatting), `setBusy(newId)`.
- `await POST /api/sessions/:id/messages`.
- `catch`: reads `getActiveSessionId()` **at catch time** and calls
  `setBusy(thatId,false)` + `restoreFailedPrompt(thatId)`.

If the user navigates away during either await, the catch mutates the wrong
session, and the new-chat success path drags the view back to the created
session. `restoreFailedPrompt` is itself already session-correct (it routes to
the draft cache when the id is not active) — the bug is purely that the **wrong
id** is passed.

### 3c — history completion

Server sends `{ type:'historyComplete', sessionId, data:{ isBusy, usage } }`.
The WS handler (`websocket.ts:301`) ignores `msg.sessionId`, forwards only
`data` to callbacks, and uses `getActiveSessionId()` for `markSessionObserved`.
`HistoryLoader.finish()` applies `setBusy`/`updateContextUsage`/`setFormEnabled`
to `getActiveSessionId()`. A `historyComplete` for session A arriving while B is
active toggles B's form/busy.

## Design

The unifying principle (`code-quality.md`: make-unrepresentable): **every async
flow captures its target identity at launch and refuses to mutate shared UI
state unless it is still the current/target session at completion time.**

### 3a — shared navigation generation token

The token must capture **any** intent that claims the chat surface, not just
other `activateSession` calls. Otherwise an in-flight `activateSession(A)` can
still win over a newer new-chat send (it would hold the only/highest activation
token and overwrite the view back to A after the new session was shown). So the
generation is a *navigation* generation owned by `ChatViewController` and bumped
by every surface-claiming entry point.

- Add `private navGeneration = 0;` to `ChatViewController`.
- Bump it on every chat-surface claim:
  - `activateSession`: `const token = ++this.navGeneration;` (after the
    `isShowingSession` fast path).
  - `showNewChat()`: `this.navGeneration++;` (entering the new-chat view is a
    surface claim — it invalidates any in-flight activation).
  - `onNewSessionCreated()`: `this.navGeneration++;` (committing a freshly
    created session claims the surface).
- Introduce a module-local `class SupersededError extends Error {}` and a guard
  `private assertCurrent(token: number): void { if (token !== this.navGeneration) throw new SupersededError(); }`.
- Pass `token` into `resumeAndLoad(sessionId, token, flight)`. Inside
  `resumeAndLoad`, call `this.assertCurrent(token)` **before** any user-visible
  side effect, i.e. before the `cwdFallback` toast (`:252-254`) **and** before
  the three state mutations `setActiveSession` / `this.footerSessionId =` /
  `historyLoader.load` (`:256-259`). The resume `fetch` is allowed to complete;
  only the side effects are gated.
- Back in `activateSession`, `this.assertCurrent(token)` again **before**
  `showChat(...)` / `setResponseOptions` / `setActiveContextBudget` /
  `setActiveReasoningEffort` / `restoreApplet`.
- In the `catch`, treat `SupersededError` as a silent no-op:
  `if (error instanceof SupersededError) return;` before the existing error
  handling. `finally` keeps `setSessionLoading(sessionId, false)` (per-session,
  only clears the stale activation's own indicator) and `flight.done()`.

Result: a superseded activation performs **zero** shared-state mutation and
produces no error UI/toast. The newest surface claim always wins because it
holds the highest generation; an older activation completing later fails its
guard.

Rejected alternative (AbortController on the resume fetch): the generation guard
already makes the overwrite unrepresentable. Aborting the in-flight resume POST
is a pure optimization (saves a redundant server resume) but widens
`fetchWithTimeout`'s contract. Deferred.

### 3b — send target capture + new-chat supersession guard

- At entry capture `const launchActiveId = getActiveSessionId();` (baseline —
  `null` when sending from new-chat) and `let targetSessionId: string | null = launchActiveId;`.
- New-chat branch, after the create response: set `targetSessionId = data.sessionId`.
  Session-keyed state is **always** applied (it is correct regardless of where
  the user navigated, and is required for failure recovery): `savePrompt(prompt,newId)`,
  `notifyMessageSent(newId)`, `setBusy(newId,true)`. **Only** the view-switching
  call `onNewSessionCreated(newId,…)` is gated on
  `const superseded = getActiveSessionId() !== launchActiveId;` → call it only
  when `!superseded`. If superseded, the session was created, the prompt is
  saved under `newId`, the message still POSTs, and the session dispatches in
  the background (busy in the session list); the view stays where the user went.
  > Fixes review finding #2: `savePrompt` is recovery state, not a UI hijack —
  > skipping it would lose the prompt for a superseded new-chat send that later
  > fails. Only `onNewSessionCreated` (which calls `setViewState('chatting')` +
  > `setActiveSession`) actually claims the view, so only it is gated.
- The message **always POSTs** to `targetSessionId` (the created or pre-existing
  session).
- `catch` rework:
  - `const failedSessionId = targetSessionId;`
  - If `failedSessionId` is set (existing-session send, or new-chat that failed
    *after* create): `setBusy(failedSessionId,false)` +
    `restoreFailedPrompt(failedSessionId)` (already session-correct internally —
    routes to the draft cache when `failedSessionId` is not the active one).
  - If `failedSessionId == null` (new-chat that failed *before* create produced
    an id): the prompt has no session to key on and the form/draft was cleared
    on send. Restore it via a new `chatView.restoreNewChatPrompt(prompt)` (see
    3b-aux) so the user does not lose their text.
    > Fixes review finding #3.
  - `setFormEnabled(true)` only when `failedSessionId == null || failedSessionId === getActiveSessionId()`
    (don't re-enable a form the user has since pointed at another, possibly busy,
    session).

#### 3b-aux — `restoreNewChatPrompt`

Add to `ChatViewController`:
```
restoreNewChatPrompt(prompt: string): void {
  if (getActiveSessionId() !== null) return;       // user navigated to a session
  if (vcGetViewState() !== 'newChat') return;      // not on the new-chat surface
  const ta = this.getActiveForm()?.textarea;
  if (ta) { ta.value = prompt; ta.dispatchEvent(new Event('input', { bubbles: true })); }
}
```
Restores the prompt into the new-chat textarea only when the user is still on
the new-chat surface (mirrors `restoreFailedPrompt`'s active-session check).

### 3c — correlate history completions to their request session

The session-scope broadcast filter (`websocket.ts:269-271`) drops any message
whose `sessionId !== getActiveSessionId()` **before** the `historyComplete`
case runs. So history correlation cannot rely on a guard inside the callback —
the message must be routed to callbacks regardless of the active session.

- **Handle `historyComplete` before the session-scope filter.** Add an early
  branch in the WS message handler (above `:266`): if `msg.type === 'historyComplete'`,
  forward `msg.sessionId` to callbacks and `markSessionObserved(msg.sessionId)`
  using that id (not `getActiveSessionId()`), then `return`. This removes the
  reliance on active-session identity for history correlation entirely.
  > Fixes review finding #1.
- Widen the callback type:
  `type HistoryCompleteCallback = (sessionId: string | undefined, data?: { isBusy?: boolean; usage?: { tokenLimit: number; currentTokens: number } }) => void;`
- In `HistoryLoader`:
  - `onHistoryComplete((completedId, data) => { if (this.pending && completedId && completedId !== this.pending.sessionId) return; this.finish(wrappedResolve, data); })`
    — ignore completions for a different session than the in-flight load.
    Completions without a usable id fall through (preserves the timeout/no-session
    paths). The no-session server frame (`src/routes/websocket.ts:313`) carries
    the URL `sessionId`, which matches the pending load, so it is **not** dropped.
  - `finish()` applies `setBusy`/`updateContextUsage` to **`this.pending.sessionId`**
    (the request target) instead of `getActiveSessionId()`. `setFormEnabled` and
    the thinking-indicator cleanup are gated on
    `this.pending.sessionId === getActiveSessionId()` so a background load's
    completion never toggles the visible form. The happy path is unaffected:
    `setActiveSession(sessionId)` runs inside `resumeAndLoad` (`:256`) **before**
    `historyLoader.load` (`:259`), so by completion the active id already equals
    `pending.sessionId`.

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| `SupersededError` leaks as an unhandled rejection if a path forgets to catch it. | Only `resumeAndLoad` throws it and only `activateSession` calls `resumeAndLoad`; the single `catch` in `activateSession` swallows it. Covered by a unit test. |
| New-chat supersession skips `onNewSessionCreated`, leaving the created session without a FE subscription. | The session-panel list refreshes from the server (busy badge) and `subscribeToSession` happens when the user later opens it. The message still dispatches and the prompt is saved under `newId`; no data lost. Acceptable — matches "user navigated away" intent. |
| Gating `setFormEnabled` on active-session match could leave a form disabled. | Only gated for the **non-active** session; the active session's own load/tracker drives its form. The active path is unchanged. |
| Forwarding `msg.sessionId` could be `undefined` on older server frames. | Callback param is `string | undefined`; the loader falls through to `finish` when the id is absent (today's behavior). |
| Moving `historyComplete` ahead of the session-scope filter changes broadcast routing. | `historyComplete` is the only history frame and is now self-correlating via `msg.sessionId`; it must bypass the active-session filter precisely because completions for a just-superseded load must still resolve their pending promise. Other message types keep the filter. |
| New `navGeneration` bumped in `showNewChat`/`onNewSessionCreated` could over-invalidate a legitimately concurrent activation. | That is the intended semantics: the latest surface claim wins. An activation superseded by a new-chat (or vice-versa) is exactly the bug being fixed. |

## Acceptance

- Observable: rapid session switch shows only the latest activation; a new-chat send that races a navigation dispatches to the created session without hijacking the current view; `historyComplete` for a non-active session applies busy/usage to that session only.
- Budgets: n/a.
- Gates: `npx tsc --noEmit -p tsconfig.frontend.json`, `npx tsc --noEmit`, `npx eslint . --max-warnings 0`, `npx vitest run`
- Oracles (Vitest, DOM-light unit tests with module mocks):
  - 3a: `tests/unit/chat-view-controller.test.ts` — two overlapping `activateSession` calls where first resolves last: only second session's `setActiveSession`/`showChat` fire; `showNewChat` generation bump suppresses in-flight activation. Verified RED without the generation guard.
  - 3b: `tests/unit/message-streaming-send.test.ts` — new-chat send with mid-flight active-id change: `onNewSessionCreated` not called; catch targets created session id. Pre-create `/api/sessions` rejection: `restoreNewChatPrompt` used (no `setBusy(null)`).
  - 3c: `tests/unit/history-loader.test.ts` — `historyComplete` for session A while B is active reaches callbacks; `finish` applies busy to A; `setFormEnabled` not called (A ≠ active B).

## Plan

| # | Step | Files | Oracle |
|---|------|-------|--------|
| 1 | 3c: forward `msg.sessionId` before session-scope filter; correlate `HistoryLoader.finish` to request session | `src/routes/websocket.ts`, `public/ts/websocket.ts`, `public/ts/history-loader.ts` | `tests/unit/history-loader.test.ts` (3c cases) |
| 2 | 3a: add `navGeneration` + `SupersededError` + `assertCurrent` to `ChatViewController`; bump on `showNewChat`/`onNewSessionCreated` | `public/ts/chat-view-controller.ts` | `tests/unit/chat-view-controller.test.ts` (3a cases) |
| 3 | 3b: capture `launchActiveId`/`targetSessionId` at send entry; gate `onNewSessionCreated`; rework catch; add `restoreNewChatPrompt` | `public/ts/message-streaming.ts`, `public/ts/chat-view-controller.ts` | `tests/unit/message-streaming-send.test.ts` (3b cases) |
