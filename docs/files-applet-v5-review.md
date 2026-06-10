# files-applet V5 spec review

Review target: `docs/files-applet-v5.md`
Quality bar: `code-quality.md` — correctness, maintainability, simple design, avoid side-effect reliance, prefer tests.

## BLOCKER

### BLOCKER: Deprecated meta plumbing is aimed at the wrong code

The spec names `src/agent-applet.ts`, but that file does not exist. Agent-facing applet discovery is currently split across:

- `src/prompts.ts` (`buildAppletSection()` lists slugs in the system message)
- `src/applet-tools.ts` (`formatAppletUsage()` and `caco_applet_usage` expose URL patterns)
- `src/applet-store.ts` (`AppletMeta`, `listApplets()`)
- `src/routes/api.ts` (`GET /api/applets`, used by `applets/applet-browser/script.js`)

There is no existing `deprecated: true` convention. `AppletMeta` has no `deprecated` or `replacedBy` fields, and `/api/applets` currently drops unknown meta fields from its response. The applet browser therefore cannot implement a meta-driven deprecated toggle from the current API response.

Fix-up suggestion: replace §4.5/§5.5 with the actual ownership. Add `deprecated?: boolean` and `replacedBy?: string` to `AppletMeta`; decide whether `listApplets()` returns all applets and callers filter, or whether it accepts an `includeDeprecated` option. For maintainability, prefer caller-side filtering so the applet browser can request/show deprecated entries while prompts and tools hide them. Update `/api/applets` to include `deprecated` and `replacedBy`.

### BLOCKER: `file-finder?root=X` is not rare and redirecting it to `files&openFinder=1` breaks current flows

The spec accepts dropping `root` as a rare regression, but current code creates `file-finder&root=` links in several normal paths:

- `public/ts/context-footer.ts:123` footer `files` link
- `public/ts/input-router.ts:73` Ctrl+P in new-chat
- `applets/text-editor/script.js:164`
- `applets/html-viewer/script.js:25`
- `applets/git-status/script.js:659` and `:707`

Also, `applets/file-edits/script.js` cannot open the picker without an active session: `openPicker()` returns when `!sessionId`, and `runPickerFetch()` also returns when `!sessionId`. So `?applet=files&openFinder=1` is not an equivalent replacement for new-chat or explicit-root browsing.

Fix-up suggestion: V5 needs either `?applet=files&openFinder=1&root=ABS` / `openFinderRoot=ABS` support, or it must keep `file-finder` functional instead of making it a root-dropping stub. Update the Ctrl+P/new-chat story explicitly. Add acceptance for `context-footer`, `git-status`, `html-viewer`, and `text-editor` links.

### BLOCKER: Standalone viewer redirects can break no-session absolute-path links

Existing `markdown-viewer`, `image-viewer`, and `html-viewer` can display an absolute `path` without an active session. The proposed stub redirects to `?applet=files&openPath=ABS`, but `file-edits` currently queues `openPath` until `cachedCwd` is set. With no active session, `cachedCwd` may never arrive, so the file never opens.

Fix-up suggestion: specify the required `files` applet change: absolute `openPath` must be handled immediately when there is no active session/cwd, or the redirect must provide enough root/cwd context to drain the pending open. Add no-session smoke acceptance for all three viewer stubs.

### BLOCKER: Persistence migration claims automatic file removal that `session-data-store` does not perform

`src/session-data-store.ts` uses the data name as the on-disk filename: `~/.caco/sessions/<sid>/<name>.json`. `setSessionData(sessionId, 'files-cards', ...)` writes `files-cards.json`; it does not rename or delete `file-edits-cards.json`. The spec says the old file is removed automatically on first write, which is false.

Fix-up suggestion: migration must explicitly call `getSessionData(sessionId, 'file-edits-cards')`, `setSessionData(sessionId, 'files-cards', migrated)`, then `deleteSessionData(sessionId, 'file-edits-cards')` after a successful write. Specify this in §4.6 and add a unit test that verifies the old filename is deleted. Also note `STORE_NAME` is both logical key and filename.

## IMPORTANT

### IMPORTANT: Applet-browser filtering is more than a small UI toggle

`applets/applet-browser/script.js` currently renders whatever `window.appletAPI.listApplets()` returns. That calls `/api/applets`, whose response omits `deprecated` and `replacedBy`. There is no existing meta-driven filter mechanism.

Fix-up suggestion: scope the browser work as API + runtime + UI work, not just a checkbox. The spec should define whether `appletAPI.listApplets()` includes deprecated applets by default. A simple design is: backend returns all metadata including deprecation flags; applet-browser filters locally with a default-off checkbox; agent prompt/tool code filters separately.

### IMPORTANT: Agent prompt cache claim is inaccurate

`buildSystemMessage()` is called at server startup in `server.ts:176`, then passed into `createSessionState()`. It is not reassembled every turn. Resumed sessions do not get a rebuilt applet list; `session-manager.ts` only appends memory on resume. Filtering `agentUsage.purpose` does not remove old text already in a model's context.

Fix-up suggestion: replace §6.9 with the real behavior: after deploy/restart, newly created sessions get the filtered applet list; live tool calls such as `caco_applet_usage` can filter immediately; already-running/resumed model contexts may still contain old prompt text until a new session/compaction/restart path replaces it.

### IMPORTANT: Redirect API choice should be explicit

`window.appletAPI.navigateAppletUrlParam()` is available before applet script execution, because `initAppletRuntime()` installs `window.appletAPI` and `pushApplet()` sets `currentApplet` before rendering. However, `navigateAppletUrlParam()` only changes query parameters on the current URL; it cannot change the `applet` slug, so it is the wrong primitive for stubs that must navigate from `markdown-viewer` to `files`.

Fix-up suggestion: explicitly require `window.navigation.navigate('?applet=files&...')` with `window.location.href` fallback, and explicitly say not to use `navigateAppletUrlParam()` for slug-changing redirects.

### IMPORTANT: Alias test seam is private

The spec acceptance asks for a test asserting `resolveAppletDir('file-edits')` returns `applets/files/`, but `resolveAppletDir` is not exported from `src/applet-store.ts`.

Fix-up suggestion: either test the public `loadApplet('file-edits')` / `resolveAppletAsset('file-edits', ...)` behavior, or explicitly add a small exported test seam. Prefer public behavior to avoid adding API surface just for tests.

### IMPORTANT: Client/server alias behavior should be described precisely

The server-side alias path works: `public/ts/router.ts` passes the URL slug to `public/ts/applet-loader.ts`, which POSTs `/api/applets/:slug/load`; `src/routes/api.ts` calls `loadApplet(slug)`; `src/applet-store.ts` resolves `SLUG_ALIASES` in `resolveAppletDir()`. The client does not canonicalize the slug. A `?applet=file-edits` URL loads the renamed files directory, but `currentApplet.slug`, session metadata, and the URL can remain `file-edits`.

Fix-up suggestion: update §4.4/UC1 to avoid implying client-side canonicalization. Add acceptance that old URLs load successfully even though the visible URL may remain `file-edits`.

### IMPORTANT: Existing references to deprecated applets exceed prompt and browser entries

The spec mentions prompt and Ctrl+P updates, but code still contains active links/slug mappings to standalone viewers and file-finder:

- `applets/text-editor/script.js` maps extensions to `markdown-viewer`, `image-viewer`, etc.
- `applets/image-gallery/script.js` links to `image-viewer`
- `applets/session-context/script.js` returns standalone viewer slugs
- `src/browser-tools.ts` tells agents to wrap screenshots in `image-viewer`
- `applets/git-status` and `applets/html-viewer` link to `file-finder`

Fix-up suggestion: add these to §5.1 and decide which are in V5. If they remain as old links relying on stubs, acceptance should cover them; if prompts must stop suggesting deprecated applets, `src/browser-tools.ts` should change.

### IMPORTANT: Test strategy is too light for the amount of routing behavior

The spec says no new tests for stubs because they are trivial. They are not trivial in this codebase: session/no-session state, root preservation, Navigation API fallback, and alias restore behavior all affect correctness.

Fix-up suggestion: add targeted unit or browser-level tests where existing infrastructure allows. At minimum, add manual smoke cases for no-session viewer links, new-chat Ctrl+P, footer files link, old `file-edits` link, and each stub redirect.

## MINOR

### MINOR: No ASCII diagrams found

The spec uses prose and tables. I did not find ASCII diagrams to flag.

### MINOR: §6.2 calls `file-edits -> files` a two-step chain

`SLUG_ALIASES` resolves one level, and this migration is one alias mapping, not a two-step chain.

Fix-up suggestion: reword to "one-level alias" and keep the warning not to alias standalone viewer slugs.

### MINOR: `agentUsage.purpose` blanking is unnecessary if deprecated applets are filtered

Blanking fields in the stub metadata creates data that must be kept in sync and does not solve existing model context. Filtering deprecated applets at prompt/tool call sites is simpler and more maintainable.

Fix-up suggestion: keep useful `agentUsage` text only if it helps humans inspecting deprecated applets; otherwise omit it from stub meta. Do not rely on blanking as a cache invalidation mechanism.
