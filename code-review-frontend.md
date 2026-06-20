# Frontend code review

## Summary

- Biggest reliability risk: session activation/send flows are not transactions; stale async completions can overwrite newer user intent.
- Duplicate event streams are plausible from non-idempotent app init/listener registration and non-idempotent delta handling.
- Applet runtime relies on global mutable `currentApplet`/`pendingAppletState`; async applet work can attach cleanup or state to the wrong lifetime.
- Protocol contracts are stringly typed and mostly enforced by comments, DOM classes, URL params, and backend message shapes.
- Comment cleanup removed low-value narration; no logic/name/refactor changes were made.

## Findings table

| file:line | severity | category | problem | why it matters per code-quality.md | recommended fix |
|---|---|---|---|---|---|
| `public/ts/chat-view-controller.ts:164` | High | reliability | `activateSession()` has no activation generation/abort. A slower earlier `resumeAndLoad()` can later call `showChat()` and restore the old session over a newer click. | Global mutable session state + side effects; correctness depends on async completion order. | **Make-unrepresentable:** activation transaction with monotonic token + `AbortController`; only latest token may mutate active session/DOM. |
| `public/ts/message-streaming.ts:221` | High | reliability | New-chat send captures no launch token. If user switches sessions while `/api/sessions` or `/messages` is in flight, lines 255-261 can select the new session; catch lines 290-295 restores prompt/busy state on whatever session is active then. | Side effects leak across sessions; stale async result silently corrupts active UI. | **Make-unrepresentable:** dispatch object owns target session/view token; all success/failure paths use that token and abort if superseded. |
| `public/ts/message-streaming.ts:176` / `public/ts/session-panel.ts:36` | High | reliability | Init functions register WS/global/tracker listeners every call and do not retain/unsubscribe/guard. If boot/HMR/reload calls them twice, each event renders twice. | Complexity from hidden side effects; duplicate event streams match the reported symptom. | **Encapsulate:** one app-lifetime initializer with `initialized` guard and stored disposers; test double-init. |
| `public/ts/streaming-markdown.ts:119` / `public/ts/dom-regions.ts:737` | High | correctness | DOM keyed dedup reuses the same message element, but `handleDelta()` blindly appends each delta. Duplicate delivery of the same `assistant.message_delta` doubles content. | Duplicate stream is not idempotent; correctness depends on “events arrive exactly once”. | **Make-unrepresentable:** include sequence/event ids and ignore duplicates; or have backend send full content snapshots instead of append-only deltas. |
| `applets/session-surface/script.js:31` | High | correctness | `mutateChange()` queues work, but `putItem()` reads current `sessionId()` and global `doc` when the queued task runs. A session switch before the queue drains can PUT old edits to the new session/doc token. | Mutable global state + async queue; code must be kept in sync with session lifetime. | **Make-unrepresentable:** capture `{sessionId,dataToken,itemId,item}` at enqueue; per-session queue; abort on session/doc mismatch. |
| `public/ts/extension-loader.ts:36` | Medium | reliability | If an extension registers slots/listeners/commands then throws before returning, `autoDispose()` is never called and `disposeFns` is never set. Partial extension side effects leak. | Side-effectful initialization without rollback; hidden global state accumulates. | **Encapsulate:** load transaction that always rolls back tracked registrations in `catch`. |
| `public/ts/applet-runtime.ts:633` | Medium | reliability | `watchPath()` pushes cleanup to `currentApplet` after async acquire. If the applet was destroyed/replaced during the await, cleanup attaches to the wrong applet or leaks. | Global state lifetime is coupled to async completion order. | **Make-unrepresentable:** bind API methods to an `AppletInstance` object; reject/close when instance token is stale. |
| `public/ts/websocket.ts:266` | Medium | coupling | Session filtering depends on every session-scoped server message carrying `sessionId`; callbacks receive only payload data, not the checked session id. | Implicit coupling: smallest backend omission of `sessionId` silently bypasses client isolation. | **Make-unrepresentable:** discriminated WS protocol types; pass `{sessionId,event}` to callbacks; assert missing `sessionId` for session messages. |
| `public/ts/history-loader.ts:72` / `public/ts/history-loader.ts:96` | Medium | reliability | `historyComplete` callbacks do not include the completed session id; `finish()` applies busy/usage to `getActiveSessionId()` instead of the pending id. | State update target is implicit global state, not the request being completed. | **Encapsulate:** pending load owns session id and ignores completions for other ids; callback includes `sessionId`. |
| `applets/git-status/script.js:509` | Medium | reliability | `refresh()` has no epoch/abort. URL param, session change, idle, and tool-complete refreshes can overlap; stale results overwrite the current repo UI. | Correctness relies on network response order. | **Assert/test-seam:** refresh epoch or `AbortController`; apply results only if `repoPath` and epoch still match. |
| `applets/text-editor/script.js:183` | Medium | reliability | `loadFile()` has no epoch/abort. A slower previous file load can replace editor contents after `currentFilePath` changed; Save then writes stale content to the current path. | Wrong session/path state becomes representable via shared globals. | **Make-unrepresentable:** per-load token; store loaded path with editor state; Save requires `editorPath === currentFilePath`. |
| `public/ts/extension-api.ts:154` | Medium | maintainability | Extension commands are registered with `source: 'built-in'`; disposer deletes by name without ownership token. Duplicate command names can delete/label the wrong command. | Wrong abstraction: registry lacks ownership, so code must coordinate names manually. | **Make-unrepresentable:** command key `{source,owner,name}` or owner-token disposal. |
| `applets/files/script.js:260` | Medium | coupling | Files applet depends on sibling viewer files mutating `window.__filesApplet` before `script.js`; backend alphabetical concatenation is the hidden loader contract. | Implicit coupling: renaming or adding a file silently changes runtime behavior. | **Make-unrepresentable:** explicit applet manifest/import order or build bundle; assert required viewers at boot. |
| `public/ts/applet-runtime.ts:813` | Low | wrong-abstraction | CSS scoping mutates `document.head` to parse CSS and silently returns unscoped CSS if `temp.sheet` is null. | Side effects and silent fallback create cross-applet style leakage. | **Encapsulate/assert:** constructible stylesheet/parser; log/fail closed instead of returning unscoped CSS. |
| `applets/image-gallery/script.js:16` | Low | reliability | `loadGallery()` has no stale-response guard; slower old directory responses can overwrite a newer directory after URL changes. | Same async-order bug pattern in smaller applet. | **Test-seam:** epoch/abort and current-dir check before DOM write. |
| `applets/mcp-servers/script.js:94` | Low | maintainability | `renderClientIdForm()` is dead/unreferenced; the auth path always renders “Authenticate”. | Dead code is liability and hides the real behavior. | **Delete:** remove dead function or wire it through one owner. |

## Reliability focus: duplicate streams and flaky session resume/switch/start

- `public/ts/message-streaming.ts:176-193`: `registerWsHandlers()` adds `onEvent`, `sessionTracker.onChange`, and `onReconnect` without an idempotence guard. Duplicate registration means every WS `event` calls `handleEvent()` N times.
- `public/ts/session-panel.ts:36-62`: `initSessionPanel()` has the same app-lifetime listener accumulation hazard for global events and tracker updates.
- `public/ts/main.ts:191-201`: boot order is enforced by comments only. Reordering `initMessageStreaming()`, form attach, or `connectWs()` silently drops/duplicates first-event side effects.
- `public/ts/streaming-markdown.ts:119`: duplicate `assistant.message_delta` delivery appends the same delta again; `public/ts/dom-regions.ts:737-756` dedups elements, not delta payloads.
- `public/ts/chat-view-controller.ts:164-190`: rapid session clicks race. No latest-activation token prevents older `resumeAndLoad()` from calling `showChat()` after a newer activation.
- `public/ts/chat-view-controller.ts:256-260`: `resumeAndLoad()` mutates active session before history completes; no rollback if superseded.
- `public/ts/message-streaming.ts:240-261`: starting a new session races with user navigation; success unconditionally calls `onNewSessionCreated()`.
- `public/ts/message-streaming.ts:287-296`: send failure uses `getActiveSessionId()` at catch time, not dispatch target.
- `public/ts/history-loader.ts:72-77`: `onHistoryComplete` is not correlated to a request id/session id at callback boundary.
- `public/ts/history-loader.ts:96-117`: completed history data applies to active id, not the load’s `sessionId`.
- `public/ts/websocket.ts:266-310`: active-session filter is centralized but silent; callback APIs drop session id, forcing downstream code to trust global active state.
- `public/ts/applet-runtime.ts:633-704`: applet watcher leases can outlive/rebind to the wrong applet because cleanup registration happens after awaits.

## Implicit contracts / coupling

| contract owner | invisible dependency | smallest silent breaker |
|---|---|---|
| `public/ts/main.ts:191-201` | Boot must be `initMessageStreaming()` → form attach → `connectWs()`. | Moving `connectWs()` earlier makes first WS event arrive before handlers/form state pump. |
| `public/ts/websocket.ts:266` + backend WS | Every session-scoped message must include `sessionId`. | Backend adds a new `stateUpdate`/`historyComplete` without `sessionId`; client accepts it for active session. |
| `public/ts/types.ts:9` | `SessionEvent.type` magic strings drive all rendering/tracker behavior. | Backend renames/adds event type; frontend silently ignores or renders wrong bucket. |
| `public/ts/history-loader.ts:72` | `historyComplete` means “current pending active session completed”. | Two loads/reconnects overlap; completion has no request/session id at callback site. |
| `public/ts/applet-runtime.ts:40` | `pendingAppletState` belongs to current applet + current session. | Applet state set, user switches session/applet before send; clear/send behavior depends on timing. |
| `public/ts/applet-runtime.ts:703` | `currentApplet` at async completion is the same applet that started work. | Applet starts `watchPath()`, user switches applet before lease acquire returns. |
| `applets/files/script.js:260` + `src/applet-store.ts:236-255` | Sibling applet JS files share one scope and load alphabetically before `script.js`. | Rename `source-viewer.js` or add a new file that depends on `script.js`; load order changes silently. |
| `public/ts/applet-runtime.ts:813` + applet CSS | All selectors can be prefixed with `.applet-instance[data-slug=...]`. | Applet CSS uses selectors where prefixing changes semantics; fallback returns unscoped CSS. |
| `public/ts/extension-api.ts:101` | `.header-bar`, `.context-links`, `.session-item[data-session-id]` are stable extension API. | HTML/CSS rename makes extension API no-op with no assertion. |
| `applets/git-status/script.js:598` | URL params, session cwd, and repo refresh target are the same repo during async refresh. | User switches path/session while refresh is in flight; old response paints new view. |

## Deferred code changes (renames / refactors not performed)

| file | old → recommended | rationale |
|---|---|---|
| `public/ts/message-streaming.ts` | `initMessageStreaming` → `initMessageStreamingOnce` | Current name hides app-lifetime side effects and duplicate-listener risk. |
| `public/ts/message-streaming.ts` | `registerWsHandlers` → `registerApplicationWsHandlersOnce` | Makes singleton contract visible. |
| `public/ts/chat-view-controller.ts` | `activateSession` → `activateLatestSession` or refactor to `SessionActivation` transaction | Name hides supersession/abort requirement. |
| `public/ts/message-streaming.ts` | `streamResponse` → `dispatchPromptToTargetSession` | Current name hides REST send + WS lifecycle + session creation side effects. |
| `public/ts/applet-runtime.ts` | `pendingAppletState` → `pendingAppletStateForActiveAppletSession` | Existing short name hides applet/session ownership. Better as typed owner object. |
| `public/ts/extension-api.ts` | `registerCommand` command source `'built-in'` → `'extension'` | Not just rename: registry needs owner tokens to dispose safely. |
| `applets/files/script.js` | `viewerRegistry` → `registeredViewerDescriptors` | Existing name hides external global registration/load-order contract. |
| `applets/session-surface/script.js` | `pendingPuts` → `surfaceMutationQueueForSession` | Current name hides queue/session affinity. |

## Comment cleanup log

- Files touched: 9 in-scope files.
- Comment lines removed: 199.
- Comment lines rewritten: 0.
- Notable removals:
  - `applets/git-status/script.js`: phase banners and function-name narration.
  - `applets/jobs/script.js`: DOM/rendering narration comments.
  - `public/ts/app-state.ts`: getter/setter comments that repeated function names.
  - `public/ts/router.ts`: stale orphan footer-status comment and click-handler narration.
  - `public/ts/applet-runtime.ts` / `public/ts/websocket.ts`: line-by-line narration around obvious DOM/WS operations.
- Kept comments that encode non-local constraints, lifecycle invariants, units, and bug-prevention rationale.
