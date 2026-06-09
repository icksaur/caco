# Global-leak audit

Audit of `public/ts/` for state-leak bugs in the same class as the
recently fixed `ChatFormController.handleSubmit` /
`image-paste.ts:imageData` issues: long-lived state that is logically
scoped to a session/view/form/transient action but whose write path
and clear path live in different modules, so one of the consume paths
forgets to clear it.

## Summary

10 findings: **3 likely bugs**, **5 suspicious patterns**, **2
verified safe** (documented because they match the anti-pattern shape).

The three actionable bugs all match a specific shape: state is written
on a per-action basis but only cleared on a different event that is
not guaranteed to follow. The clearest one is `pendingAppletState` —
identical structurally to the just-fixed draft-cache bug.

---

## BUG: `pendingAppletState` leaks across applet/session switches

**File:** `public/ts/applet-runtime.ts:40` (write), `:748-752` (only clear path)

**Pattern:** #7 (setter with no matching clearer) + #8 (write on A,
clear on B where A and B aren't paired).

**Repro:**
1. Open applet X (e.g. a custom editor); applet JS calls
   `window.appletAPI.setAppletState({ foo: 'X' })` to register state
   for the agent to read on the next prompt.
2. Without sending a chat message, navigate to applet Y, OR switch
   to a different session entirely.
3. In session/applet Y, send any chat message.
4. The POST body to `/api/sessions/{id}/messages` carries
   `appletState: { foo: 'X' }` — applet X's state, leaking into a
   session/applet that has nothing to do with X.

**Root cause:** `setAppletState` writes to the module-level
`pendingAppletState`. The only clear path is
`getAndClearPendingAppletState()`, called once inside
`streamResponse()` at message send time
(`message-streaming.ts:225`). `destroyInstance()` (called when an
applet is swapped) does NOT clear it; neither does
`onActiveSessionChange`. So any path that destroys an applet or
switches the active session without an intervening send carries the
prior applet's state forward.

This is structurally identical to the chat-draft bug just fixed:
write path and "consume" path are bound, but every other lifecycle
boundary (applet swap, session switch) is ignored.

**Fix sketch:** Clear `pendingAppletState` in `destroyInstance()`,
and additionally clear it in `onActiveSessionChange` (registered in
`initAppletRuntime`). Alternatively, scope `pendingAppletState` to
the current applet instance (store it on `AppletInstance`) so the
existing `destroyInstance()` naturally wipes it.

---

## BUG: `ChatFormController.restoreFailedInput` writes failed-steer text into a possibly-rebound form

**File:** `public/ts/chat-form-controller.ts:293-298` (`restoreFailedInput`),
called from `:243-249` and `:249-251`.

**Pattern:** #9 (state captured at action-A time leaked into action-B
context) + cross-session bleed.

**Repro:**
1. In session A's chat (busy), type `do something risky` and click
   "Steer" (sends a steer to a busy session).
2. Immediately switch to session B (the chatting-form's `binding` is
   rebound to B inside `ChatFormController.bind`).
3. The steer POST to session A fails (e.g. 4xx, network error). The
   async catch block runs `this.restoreFailedInput(message)`.
4. `restoreFailedInput` writes `this.textarea.value = "do something
   risky"` and dispatches an `input` event. The input listener reads
   `this.binding.key` — now session **B**'s key — and persists "do
   something risky" as session B's draft (both in `sessionDrafts`
   cache and to disk via the debounced PUT).
5. User now sees ghost text in session B's input that they never
   typed there; switching back to A also re-hydrates A from disk to
   nothing (it was never saved against A).

**Root cause:** `restoreFailedInput` doesn't snapshot the binding at
dispatch time. It assumes the form's binding is still what it was
when the steer was launched. By contrast,
`chatView.restoreFailedPrompt(sessionId)` *does* compare against
`getActiveSessionId()` and routes the restore to the right cache
entry — only the form-controller path is unguarded.

**Fix sketch:** Capture `const launchBinding = this.binding;` at the
top of the steer branch in `handleSubmit`. In `restoreFailedInput`,
if `this.binding !== launchBinding` (or `binding.key` differs), do
NOT touch the textarea — instead enqueue the prompt directly into
the right session's cache via the shared `DraftCache`:
`this.cache.setDraftCache(launchBinding.key, message)` and
`putDraft(launchBinding.sessionId, message)`.

The same fix should be considered for the regular-send error path
(`streamResponse`'s catch in `message-streaming.ts:280-284`), which
calls `chatView.restoreFailedPrompt` — that path already checks
active-session, but the fact that two restoration paths exist with
different guarantees is itself a smell.

---

## BUG: Extension `registerCommand` returns a no-op dispose, so hot-reload leaves stale commands registered

**File:** `public/ts/extension-api.ts:138-147` (returns `() => {}`).

**Pattern:** #7 (setter without matching clearer) — masked because
the local registry *does* have a real unregister, but the extension
API wrapper throws it away.

**Repro:**
1. An extension `foo` registers a command via
   `api.registerCommand('foo-cmd', { handler: handlerV1 })`.
2. `extension-loader.ts:reloadExtension('foo')` is invoked (e.g.
   server emits `extension.reload` on file change, see
   `main.ts:221`).
3. `reloadExtension` calls the stored dispose fn — which is the
   no-op returned above — then reloads `client.js`, which probably
   re-registers `foo-cmd` with `handlerV2`. The Map.set replaces the
   command entry, so this specific case works.
4. But: if the new version of the extension *removes* a command
   (`foo-cmd` no longer registered on reload), the old `foo-cmd`
   stays in the registry forever, with `handlerV1` retained as a
   closure (potentially over destroyed extension state). Slash-popup
   keeps showing `/foo-cmd`; selecting it runs orphaned code.

A parallel case exists in `main.ts:174` where prompt-template
commands are `registerCommand({...})`'d on boot without retaining
the unregister fn. There is no path to remove a template that the
server later deletes — the agent would still see it in the slash
menu until full page reload.

**Root cause:** `extension-api.ts:registerCommand` calls the real
`registerCommand(cmd)` but discards the returned unregister fn and
returns `() => {}` to the extension. The local registry is fully
capable of supporting removal — the wrapper just doesn't wire it.

**Fix sketch:** Return the real unregister fn from `registerCommand`
in `extension-api.ts`. Track commands registered by each extension
in `extension-loader.ts` (alongside `disposeFns`) and call them all
inside `reloadExtension` before reloading. Apply the same pattern to
prompt-template registrations in `main.ts`.

---

## SUSPICIOUS: `streaming-markdown.ts` `sessions` Map leaks on stream cancellation

**File:** `public/ts/streaming-markdown.ts:31` (Map),
`:144` (only delete path is `finalize`).

**Pattern:** #8 — entries created on every delta, cleared only on
finalize. If the stream never reaches finalize (cancellation, session
error, page-internal navigation that destroys the rendering
element), the Map entry stays AND its scheduled `setTimeout` will
fire `render(state)` against a possibly-detached element.

**Repro is plausible but not confirmed:** start a long assistant
turn, hit Stop while a partial delta has a 200ms render timer
pending. The timer fires, tries to render markdown into a stale DOM
node. Visible artifact (transient broken render or a console warning
from `renderMarkdownElement`) is likely but not reproduced in this
audit.

**Fix sketch:** On `session.cancelled` / `session.error` /
`regions.chat.clear()`, iterate the Map and run cleanup (clearTimeout,
delete). Or: scope state to messageId and have `regions.chat.clear`
emit a "clear streaming for these messageIds" hook.

---

## SUSPICIOUS: `swarm-progress.ts:activeSwarms` not cleared on session archive/idle

**File:** `public/ts/swarm-progress.ts:17` (Map),
`:46-49` (only clear path: `completed >= total`).

**Pattern:** #3 — Map keyed by session id, removal only on swarm
completion. Session archival, swarm cancellation, or session.idle
(which calls `adHocBar.clearSession`, killing the widget but NOT the
Map entry) all leave dangling entries holding stale `AdHocWidgetHandle`
references.

Next swarm progress event for the same session id would hit the
"existing" branch and call `.handle.update()` on a stale handle.
`adhoc-bar.ts:50-52` makes `update()` a no-op when not the active
session, so no crash, but the progress display silently fails to
appear.

**Fix sketch:** Subscribe to `session.listChanged` (or a more
specific session-archived event) and prune entries for sessions
that no longer exist. Also handle the "swarm reset / restart"
case: a `total` decrease should reset the entry.

---

## SUSPICIOUS: `chatView.sessionPrompts` / `sessionDrafts` never pruned on session archive

**File:** `public/ts/chat-view-controller.ts:37-38`.

**Pattern:** #3 — `Map<sessionId, …>` with no removal path on
session deletion. Both maps grow monotonically for the page's
lifetime. With heavy use (hundreds of sessions created in a single
page-load) memory and lookup cost grow without bound, but no
user-visible bug because the maps are queried by current
sessionId.

Mild correctness wart: `streamResponse` (`message-streaming.ts:214`)
calls `chatView.savePrompt(prompt, currentId || '')` — writing under
the empty-string key when sending a brand-new chat. This entry never
maps to any real session and is unreachable forever.

**Fix sketch:** Subscribe in `chatView` to `session.listChanged` /
`SessionStateTracker`'s removal events (the tracker already prunes
in `syncFromList`), and drop matching entries. Guard the empty-key
write in `streamResponse` (`if (currentId) chatView.savePrompt(...)`).

---

## SUSPICIOUS: `context-footer.ts:usageCache` never pruned

**File:** `public/ts/context-footer.ts:191`.

**Pattern:** #3. Same shape as above. Token-usage cache entries
accumulate per-session and are never deleted. No correctness impact
visible to the user; just unbounded growth.

**Fix sketch:** Hook into the same session-removal signal as above
and prune.

---

## SUSPICIOUS: `applet-runtime.ts:onUrlParamsChange` registers `popstate` handler when there is no `currentApplet`

**File:** `public/ts/applet-runtime.ts:359-381`.

**Pattern:** #6 — `window.addEventListener('popstate', handler)`
inside a function. The handler is normally tracked on
`currentApplet.popstateHandler` for cleanup in `destroyInstance`,
but `:375 if (currentApplet)` is best-effort — if `onUrlParamsChange`
is somehow called with no current applet (race: applet script runs
after the instance is destroyed; future timer-based callers; tests),
the listener is added to `window` with no path to removal. Each such
call adds another leaked listener that captures the user-supplied
callback closure.

Likely unreachable in practice (the API is only documented for
applet `customScript` which runs while `currentApplet !== null`),
but the defensive check should be inverted: refuse to install if
there is no instance to anchor it to.

**Fix sketch:** Early-return when `!currentApplet`, log a warning
once.

---

## SUSPICIOUS: `chat-form-popups.ts` module-level file cache crosses cwds incorrectly on the first request

**File:** `public/ts/chat-form-popups.ts:22-39`.

The cache invalidation key is `cwd === cacheCwd && fresh`. But
on a cache miss when the fetch fails (`return cachedFiles` on the
catch path at `:32` and `:37`), the *stale* file list from the
prior cwd is returned. So switching to a session in a different
cwd, opening a pound popup while the network is flaky, would show
files from the previous project.

Not a bleed across forms (the cache is correctly cross-form by
design) — but a leak across `cwd` lifecycle. Low impact; the popup
contents are advisory.

**Fix sketch:** On cache miss for a different cwd, return `[]`
rather than the stale list; or invalidate the cache the moment
`cwd !== cacheCwd` (before the fetch starts).

---

## VERIFIED SAFE: `message-streaming.ts:34` `let chatRegion: ChatRegion`

Module-level uninitialized `let`. Reads happen only from `handleEvent`,
which is bound to the WS via `onEvent(handleEvent)` inside
`initMessageStreaming()`, which sets `chatRegion` first. Boot order
in `main.ts:161` guarantees `initMessageStreaming()` runs before
`connectWs()`. No path can call `handleEvent` before init.

## VERIFIED SAFE: `input-router.ts:chatKeyHandler` and `escapeTime`

Module-level state, both written and read from the same single
`document.addEventListener('keydown', …)` installed once in
`initInputRouter`. `chatKeyHandler` is set via `registerChatKeyHandler`
— a single setter with no "unset" path, but it's effectively a
singleton: only one chat key handler exists per page, set at boot,
and the only consumer is the same router. No cross-context leak
possible.

---

## Out-of-scope notes

- `dom-regions.ts`, `panel-state.ts`, `websocket.ts`: module-level
  singletons by design (DOM regions, panel store, WS connection).
  No session/form scoping concern.
- `markdown-renderer.ts:_mermaid` / `_mermaidLoading`: load-once
  global; correct.
- `notifications.ts:permissionGranted`: page-global permission
  state; correct.
- `session-panel.ts:isImporting`, `movingSessionIds`,
  `sessionDragActive`: all cleared in matching `finally` blocks or
  symmetric event-pair handlers.
- `chat-form-controller.ts:hydrated Set`: page-load-scoped by
  design — restore-from-disk is a once-per-key operation; growth is
  bounded by number of distinct sessions ever visited in this
  page-load. Memory leak is acceptable here for the same reason
  `sessionDrafts` is.
