# files-applet V5 — rename + standalone-viewer deprecation

**Status:** spec (not yet implemented)
**Branch:** `files-applet-v5` (to be created)
**Predecessors:** V4 (`docs/files-applet-v4.md`)
**Roadmap:** `docs/files-applet-roadmap.md` — covers V5+ items 9, 10, 15 (rename, deprecate standalone viewers, consolidate icon map).

## 1. Goal

Three coupled changes that retire technical debt accumulated over
V1-V4:

1. **Rename slug** `file-edits` → `files`. The applet has grown past
   its V1 "diff list" identity; "files" matches what users say.
2. **Soft-deprecate the four standalone single-purpose applets**
   `markdown-viewer`, `image-viewer`, `html-viewer`, `file-finder`.
   They are removed from agent prompts and from the default
   applet-browser list, and they redirect to `files` **when an
   active session exists**. Without a session they keep their
   current behavior so deep-linked URLs do not break.
3. **Consolidate** the `_PICKER_FILE_ICONS` map duplicated in V4.
   The standalone `file-finder` keeps its own copy only because
   the conditional-redirect path needs it for the no-session
   fallback; V6 (full removal of stubs) finally deletes it.

Two enabling changes piggyback because the stub design depends
on them:

4. **`files` applet accepts `?openFinderRoot=ABS`** so the
   `file-finder` stub can preserve the existing `root=` param
   instead of dropping it. Without this V5 regresses
   context-footer, git-status, text-editor, html-viewer and
   new-chat Ctrl+P (all of which pass `root=` today; see §5.4).
5. **Persistence rename** `STORE_NAME` from `file-edits-cards` to
   `files-cards`, with an explicit copy + `deleteSessionData`
   migration on first read (the underlying `session-data-store`
   keys on filename; the rename does not happen automatically).

V5 ships small but not trivially so. The five items above are
inseparable. Anything beyond §1.1-§1.5 is out of scope (§3).

## 2. Why now

V4 brought the picker to parity with `file-finder`. The window to
collapse the duplicate applets is open. Doing it now means:

- Agent prompt churn lands once, not three times.
- Persistence migration code is current and reviewable, not a
  speculative future cleanup.
- Documentation references can swap to `files` everywhere in one
  pass.
- The icon-map duplication V4 deliberately accepted has a clear
  resolution path V5 closes.

Postponing means each future V (autosave, dirty-prompt, visual
refresh) has to keep mentioning four standalone applets that
should not exist.

## 3. Non-goals

- **Remove** the standalone viewer directories. They stay on disk
  with full no-session behavior preserved (§4.2). Removal is V6+.
- **Migrate user data** for the standalone viewers (none — they
  have no per-session persistence).
- Cross-applet shared JS modules (still not supported by
  applet-store; consolidation in V5 happens only at the picker
  icon-map duplication V4 introduced).
- Autosave, dirty-prompt, visual refresh — separately bucketed in
  roadmap §13, §14, §12.
- Server-side URL rewriting beyond `SLUG_ALIASES`. The slug-alias
  is server-side resolution only; the visible URL in the
  browser address bar may still read `?applet=file-edits` — see
  §4.4. Power users who want a canonical URL navigate explicitly
  to `?applet=files`.
- Renaming TypeScript source files (`src/routes/file-edits.ts`,
  `src/file-edits-store.ts`). The filenames are independent of
  the user-facing slug; renaming them adds import-fix churn
  with no behavior change. Defer to V6+.
- Renaming historical spec files (`docs/file-edits*.md`). Spec
  history is locked.
- Touching every doc-comment in `src/` and `applets/` that
  mentions `file-edits`. The spec touches code paths that
  affect behavior; comments stay readable.

## 4. Ownership and relationships

The `files` applet (formerly `file-edits`) becomes the primary
owner of all per-file viewing in active sessions. The four
deprecated applets remain fully functional standalone applets
**when there is no active session**, and become **conditional
redirect stubs** when a session is present.

### 4.1 The `files` applet

- Owns the unified tabbed shell, viewer registry (DiffViewer,
  MarkdownViewer, ImageViewer, HtmlViewer), the Ctrl+P picker
  (V3.y.2), recent-files store, and the V4 icon-map + copy-button
  pair.
- Lives at `applets/files/` after V5; its meta.json `slug` reads
  `files`. The directory is renamed on disk via `git mv`
  (single commit; see §5.2).
- Continues to receive `?applet=file-edits&...` URLs via the
  alias mechanism (§4.4). Existing chat history with V4-era
  links does not break.
- Gains `?openFinderRoot=ABS` support so the `file-finder`
  stub can preserve its `root=` param (§4.3). Implementation:
  one new branch in the existing `onUrlParamsChange` handler
  that, if present, calls `openPicker({ source: 'shortcut',
  rootOverride: ABS })`. `openPicker` learns a one-shot
  `rootOverride` parameter that biases `runPickerFetch` to use
  it in place of `cachedCwd` for the duration of that picker
  open. Cleared in `closePicker`.

### 4.2 The four deprecated applets — conditional redirect stubs

Each of `markdown-viewer`, `image-viewer`, `html-viewer`,
`file-finder` keeps its existing `script.js` + `content.html`
behavior **mostly intact**. Only the entry point changes: at
the very top of `script.js`, the applet calls a shared "should
I redirect?" check. If yes, it builds a `?applet=files&...`
URL from its own URL params and SPA-navigates. If no, it falls
through to its existing rendering.

The "should I redirect?" condition is:

- `window.appletAPI.getSession()` (or the equivalent that
  exposes the current session id — verify exact name during
  implementation) returns a non-null session id.

This means:

- A user opening `?applet=image-viewer&path=/abs/file.png` from
  a chat (session-bound) gets a redirect to
  `?applet=files&openPath=/abs/file.png` and sees the unified
  tab shell. (Brief "Redirecting…" flash; see §6.6.)
- A user typing the same URL in a fresh browser tab with no
  active session gets the standalone viewer — same as today.
- An agent that still generates `markdown-viewer` URLs in chat
  is silently upgraded.

Each `meta.json` adds two informational fields used only by
the agent-facing and applet-browser filtering paths (§4.5):

- `"deprecated": true`
- `"replacedBy": "files"`

No other changes to standalone `script.js` content beyond the
top-of-file redirect check. `style.css` and `content.html` are
untouched.

### 4.3 Stub redirect URL translation

| Old slug + param | Translates to (when session exists) |
|---|---|
| `?applet=markdown-viewer&path=ABS` | `?applet=files&openPath=ABS` |
| `?applet=image-viewer&path=ABS` | `?applet=files&openPath=ABS` |
| `?applet=html-viewer&path=ABS` | `?applet=files&openPath=ABS` |
| `?applet=file-finder&root=ABS` | `?applet=files&openFinder=1&openFinderRoot=ABS` |
| `?applet=file-finder` (no root) | `?applet=files&openFinder=1` |

The stub uses `window.navigation.navigate(url)` with a
`window.location.href` fallback, mirroring the pattern in
`public/ts/input-router.ts:79-92`. **Not** `navigateAppletUrlParam`
— that primitive only changes query params on the **current**
applet and cannot change the slug (review §IMPORTANT-3).

Any URL params the stub does not know about are passed through
unchanged. Future params (e.g. `openLine=42`) reach `files`
without the stubs needing updates.

### 4.4 Slug alias migration — server-side only

`SLUG_ALIASES` in `src/applet-store.ts:101-103` already exists
(currently `{ 'roadmap': 'session-context' }`). V5 adds:

```
'file-edits': 'files',
```

`SLUG_ALIASES` is resolved server-side in `resolveAppletDir()`
and `resolveAppletAsset()`. The client (`public/ts/router.ts`,
`public/ts/applet-loader.ts`) does **not** canonicalize the
slug. Consequence:

- `?applet=file-edits` POSTs `/api/applets/file-edits/load`,
  the server resolves the alias and returns the `files`
  applet's bundle.
- The browser address bar continues to show
  `?applet=file-edits`.
- `currentApplet.slug` inside the runtime reads `file-edits`
  (the URL slug, not the resolved one).

This is intentional. V5 does not introduce a client-side
canonicalizer; it accepts that some URLs surface the legacy
slug while behaving as `files`. UC1 below verifies the
behavior, not the surface URL string.

### 4.5 Agent-facing surface and applet-browser filtering

The current code paths that surface applets:

- `src/applet-store.ts:listApplets()` returns all `AppletMeta`
  records.
- `src/routes/api.ts: GET /api/applets` calls `listApplets()`
  and serializes the response. **It currently strips unknown
  meta fields**; V5 explicitly adds `deprecated` and
  `replacedBy` to the response schema.
- `src/prompts.ts:buildAppletSection()` lists slugs in the
  system prompt at server startup
  (`src/server.ts:176` — `buildSystemMessage()` is built once,
  not per turn; see §6.9).
- `src/applet-tools.ts:formatAppletUsage()` and the
  `caco_applet_usage` tool format usage for the agent on
  demand at tool-call time.
- `applets/applet-browser/script.js` consumes
  `window.appletAPI.listApplets()` to render the user-facing
  list.

V5 changes:

- `AppletMeta` in `src/applet-store.ts` gains optional
  `deprecated?: boolean` and `replacedBy?: string` fields.
- `src/prompts.ts:buildAppletSection()` filters out entries
  with `deprecated === true`.
- `src/applet-tools.ts:formatAppletUsage()` filters out
  entries with `deprecated === true` (so `caco_applet_usage`
  returns "Applet not found" for deprecated slugs even though
  they still resolve via the alias mechanism for URL
  loading — this is the right behavior because the agent
  should be guided away).
- `src/routes/api.ts` includes the new fields in
  `GET /api/applets`.
- `applets/applet-browser/script.js` filters
  `deprecated === true` out of the default render and gains a
  single "Show deprecated" checkbox in the header. When
  enabled, deprecated entries render with a "deprecated →
  $replacedBy" badge.

The filter responsibility lives at each call site — `listApplets()`
itself is **not** changed to filter, so the applet-browser can
opt-in to seeing the full list without a separate API call.

### 4.6 Persistence key migration — explicit copy + delete

`src/file-edits-store.ts:23` declares `STORE_NAME =
'file-edits-cards'`. The underlying `src/session-data-store.ts`
keys the disk file on `<STORE_NAME>.json`. Renaming `STORE_NAME`
alone does **not** rename or delete the old file (review §BLOCKER-4).

V5 changes:

- `STORE_NAME` becomes `'files-cards'`.
- The store's read path (`getPersistedCards(sessionId)`,
  approximately) is wrapped with a one-time migration check:
  if the read for `'files-cards'` returns null AND the read
  for `'file-edits-cards'` returns non-null, copy the old
  value to the new key via `setSessionData(sessionId,
  'files-cards', migrated)`, then call
  `deleteSessionData(sessionId, 'file-edits-cards')`.
- Migration is idempotent: after one successful migration the
  old key is gone, subsequent reads see the new key directly.
- A unit test in `tests/unit/file-edits-store.test.ts` (or
  whichever file owns the store's tests; create one if absent)
  verifies the migration path: seed a `file-edits-cards.json`,
  call the read function, assert the returned value matches
  the seed AND `file-edits-cards.json` is gone AND
  `files-cards.json` exists with the same content.

### 4.7 Prompt and doc updates

Items that are agent-facing or user-visible and **must** move
to `files` in V5:

- `src/prompts.ts:74` example link.
- `src/browser-tools.ts` (currently tells agents to wrap
  screenshots in `image-viewer`; switch to `files&openPath=`).
- `public/ts/input-router.ts:73` (Ctrl+P in new-chat — points
  to `file-finder&root=`, V5 changes to
  `files&openFinder=1&openFinderRoot=` because the stub
  redirect would otherwise add a flash on every Ctrl+P press).
- `public/ts/input-router.ts:82,90` (Ctrl+P in active session,
  already targets `file-edits`; switch to `files`).
- `public/ts/context-footer.ts:123` footer `files` link.

Items that **may** stay as old URLs because they go through
the stub redirect transparently:

- `applets/text-editor/script.js:164` (links to standalone
  viewers based on file extension).
- `applets/html-viewer/script.js:25` (links to file-finder).
- `applets/git-status/script.js:659,707` (links to file-finder).
- `applets/image-gallery/script.js` (links to image-viewer).
- `applets/session-context/script.js` (returns standalone
  viewer slugs).

The stubs handle these; V5 does **not** update them. V6 (full
stub removal) will. This keeps the V5 diff focused on the
items that materially affect agent behavior (prompts, tools)
or user-perceived snappiness (footer + Ctrl+P, which would
otherwise stub-flash on every interaction).

### 4.8 Per-stub "should redirect?" implementation

Each of the four stubs gets a 6-line check at the very top
of its existing `script.js`:

```javascript
(function() {
  var api = window.appletAPI;
  if (!api || typeof api.getSession !== 'function') return;
  var sid = api.getSession();  // exact name verified during impl
  if (!sid) return;
  // Build target URL from current URL params and navigate.
  var p = new URLSearchParams(window.location.search);
  var target = '?applet=files';
  // ...per-applet param translation per §4.3...
  if (window.navigation && typeof window.navigation.navigate === 'function') {
    try { window.navigation.navigate(target); return; } catch (_e) {}
  }
  window.location.href = '/' + target;
})();
```

The stub returns early before its original IIFE runs the
standalone applet's render code. If the session API is not
exposed, the stub falls through to standalone behavior (safe
default — the SSE/session wiring evolved over time and the
deprecated applets predate some of it).

## 5. Code analysis

### 5.1 Slug usages outside `applets/file-edits/`

`grep -rn 'file-edits' src/ public/ts/ applets/ | grep -v 'file-edits/'`
returns ~20 hits. Categorized:

- **3 hits**: route file names (`src/routes/file-edits.ts`,
  `src/routes/index.ts` export). Keep filename — see §3
  non-goals. The HTTP path `/api/sessions/:sid/file-edits/...`
  stays the same.
- **2 hits**: `public/ts/input-router.ts:82,90` — Ctrl+P in
  active session navigates to
  `?applet=file-edits&openFinder=1`. Update to `files`.
- **1 hit**: `public/ts/input-router.ts:73` — Ctrl+P in new-chat
  navigates to `?applet=file-finder&root=`. Update to
  `?applet=files&openFinder=1&openFinderRoot=` (see §5.4 and
  §4.7 for why new-chat must skip the stub flash).
- **1 hit**: `public/ts/context-footer.ts:123` footer `files`
  link. Update.
- **1 hit**: `src/prompts.ts:74` example link. Update.
- **3 hits**: `applets/file-finder/script.js` link templates
  + `meta.json` agentUsage prose. The stub redirect handles
  in-page navigation; meta.json gains `deprecated: true`.
- **9 hits**: doc/spec comments. Not touched.
- **1 hit**: `src/file-edits-store.ts:23` `STORE_NAME`. Change
  per §4.6.

Separately, `grep -rn 'markdown-viewer\|image-viewer\|html-viewer\|file-finder' applets/ src/ public/ts/`
surfaces the call sites listed in §4.7 that V5 does **not**
update (stubs handle them transparently).

### 5.2 Directory rename mechanics

`git mv applets/file-edits applets/files` preserves history at
single-commit boundary. `meta.json` slug updates in the same
commit. The bundled-applet path lookup
(`buildPaths(BUNDLED_APPLET_DIR, slug)` in
`src/applet-store.ts:79-87`) resolves to `applets/files` after
the rename; the alias from §4.4 covers `file-edits` → `files`.

### 5.3 Existing stub-like patterns

There are none. `SLUG_ALIASES` is used for **directory**
redirects (same UI, different slug); a stub is needed when the
**URL params** differ. V5 introduces the conditional-stub
pattern; future deprecations can copy it.

### 5.4 `file-finder?root=X` is widely used — preserve via openFinderRoot

The review identified 5+ active call sites for
`?applet=file-finder&root=`:

- `public/ts/context-footer.ts:123`
- `public/ts/input-router.ts:73` (Ctrl+P in new-chat)
- `applets/text-editor/script.js:164`
- `applets/html-viewer/script.js:25`
- `applets/git-status/script.js:659,707`

Dropping `root` is therefore **not** an acceptable regression.
V5 adds `?openFinderRoot=ABS` to `files` (§4.1) and the
`file-finder` stub translates `root=` → `openFinderRoot=` per
§4.3. The `files` applet's `openPicker` learns a one-shot
`rootOverride` knob that biases `runPickerFetch` for the
duration of that picker open (cleared in `closePicker`).

`openPicker` currently early-returns when `!sessionId`. For the
new-chat case (no session, no cwd), the stub redirect does not
fire, so the standalone `file-finder` continues to work. The
direct `?applet=files&openFinder=1&openFinderRoot=ABS` URL in
`input-router.ts:73` (new-chat Ctrl+P) needs the picker to
function with `rootOverride` even when `sessionId` is null:
two small relaxations in `openPicker` / `runPickerFetch` so they
proceed when a `rootOverride` is set even without a session.
This is the smallest viable change to keep new-chat Ctrl+P
snappy without a stub flash.

Acceptance §8.16 covers these flows explicitly.

### 5.5 No-session deep links to standalone viewers

`markdown-viewer`, `image-viewer`, `html-viewer` work today
without an active session — a user can hand-craft
`?applet=image-viewer&path=/abs/file.png` in a fresh browser
tab and see the file. The `files` applet, by contrast,
requires `sessionId` for `routeOpen` to function (the viewer
factories call `shell.api.watchPath` which is session-scoped).

V5 preserves the no-session capability by making the stub
redirect **conditional** (§4.2): it only fires when a session
exists. A no-session URL falls through to the standalone
applet's existing render code, unchanged.

This means the `files` applet does **not** need to gain no-session
support in V5. The two paths (session ⇒ unified `files`,
no-session ⇒ legacy standalone) coexist. V6 (stub removal) is
when `files` would have to grow no-session capability — and is
the appropriate scope for that change.

### 5.6 Agent-facing code paths (the real names)

The review caught that the original spec named `src/agent-applet.ts`,
which does not exist. The actual code paths are:

- `src/applet-store.ts` — `AppletMeta` type + `listApplets()`.
  V5 adds `deprecated` and `replacedBy` to the type.
- `src/prompts.ts:buildAppletSection()` — assembled at server
  startup in `src/server.ts:176`. V5 filters
  `deprecated === true` here.
- `src/applet-tools.ts:formatAppletUsage()` — runtime tool call.
  V5 filters here. Returns "Applet not found" or equivalent for
  deprecated slugs.
- `src/routes/api.ts:GET /api/applets` — applet list for the
  applet-browser. V5 includes the new fields in the response.
- `applets/applet-browser/script.js` — V5 adds default-off
  filtering + a "Show deprecated" checkbox.

### 5.7 Persistence migration test seam

`SLUG_ALIASES` resolution is private to `resolveAppletDir`
(not exported). Test via the public surface:

- `loadApplet('file-edits')` returns a bundle whose `slug`
  reads `files` (or whose script content matches the renamed
  applet) — confirming the alias.
- For persistence migration: seed
  `~/.caco/sessions/<sid>/file-edits-cards.json` in a test
  fixture, call the read function, assert the data round-trips
  AND the old file is gone AND the new file exists.

## 6. Considerations

### 6.1 Slug name choice

- `files` — chosen. Clean, broad, matches user vocabulary.
- `file` — rejected; singular feels wrong when the UI shows many.
- `editor` — rejected; UI is also a viewer.
- `workbench` / `workspace` — rejected; over-broad.
- `viewer` — rejected; UI also edits.

If the user prefers a different slug, the rename is one
search-replace + the `SLUG_ALIASES` entry; everything else is
isolated.

### 6.2 `SLUG_ALIASES` is one level deep

`resolveAppletDir` looks up `slug` in `SLUG_ALIASES` exactly
once; the resolved value is treated as a real directory name.
V5 adds one mapping (`file-edits` → `files`). Standalone slugs
are **not** aliased because their URL **param shapes** differ
(would route `?applet=markdown-viewer&path=X` into `files`
which doesn't know `path`). Stubs handle them instead.

### 6.3 Deprecated-applet visibility

The applet browser hides deprecated applets by default but shows
them under a toggle. This matters because:

- Power users may have deep-linked bookmarks to standalone
  viewers and want to confirm they still resolve.
- Anyone hand-typing `?applet=image-viewer&path=X` still gets a
  working redirect.
- The agent never sees them, which is the main goal — no more
  prompt suggestions for outdated entry points.

### 6.4 No live tests for the standalone viewers

The four deprecated viewers have no targeted unit tests in
`tests/`. V5 adds **no** new tests for the stubs — they are
~10 lines each, behavior is trivial (read param → build URL →
navigate). Manual smoke covers them (§8).

### 6.5 Persistence migration is best-effort

If `setSessionData('files-cards', ...)` is called before the
first read of the same session, the migration trigger never
fires and the old `file-edits-cards` file is orphaned (still
sitting on disk in `~/.caco/sessions/<sid>/`). This is harmless
— it consumes a few KB per session and never reloads. A future
janitor pass can sweep them. Not a blocker.

### 6.6 Redirect-chain timing

`?applet=file-finder&root=/x` → stub renders for a few frames →
SPA navigates to `?applet=files&openFinder=1` → picker opens.
Users will perceive a brief flash of the deprecated applet's
content-html ("Redirecting…"). Acceptable; the alternative
(server-side redirect) requires a new route and breaks the
client-only applet-store model.

### 6.7 Test gap for the alias

`SLUG_ALIASES` has no unit test covering the alias-resolution
path. V5 adds **one** test in `tests/unit/applet-store.test.ts`
(create if missing) that asserts `resolveAppletDir('file-edits')`
returns the path under `applets/files/`. This is the smallest
testable seam that protects the rename across future refactors.

### 6.8 `STORE_NAME` migration triggers exactly once per session

Migration runs in the read path. If a session has never had the
files applet opened, no migration happens — there's nothing to
migrate. If a session was opened in V4 and reopened in V5, the
first read triggers the copy. If a session is opened only in
V5, the new key is used directly.

### 6.9 Agent prompt cache — real behavior

`buildAppletSection()` is called from `buildSystemMessage()`
which runs at server startup in `src/server.ts:176`, NOT every
turn. The system message is then passed into
`createSessionState()` and held for the life of the session.
Resumed sessions only get memory appended; they do not get a
rebuilt applet list (see `src/session-manager.ts`).

Consequences for V5:

- After deploy/restart: **new** sessions get the filtered
  applet list (no deprecated entries). Existing live sessions
  do NOT see the filter until the server restarts and the
  session is recreated.
- Live tool calls (e.g. `caco_applet_usage`) call into
  `formatAppletUsage()` per invocation, so the filter applies
  immediately to those.
- Resumed sessions inherit whatever applet list was assembled
  at the resume time's server boot — which after a V5 deploy
  is the filtered one. Pre-V5 chat history visible in the
  model context may still mention deprecated slugs (cannot be
  retroactively scrubbed); the filter only governs new system
  messages.

V5 does not introduce a per-session prompt rebuild mechanism;
that would be a separate Caco-level change.

V5 does NOT blank `agentUsage.purpose` on deprecated stubs
(review §MINOR-3). Filtering at call sites is the correct
mechanism; blanking creates data that must be kept in sync
and does nothing for already-cached model context.

## 7. Use cases

**UC1.** User has a chat link from yesterday:
`[the diff](/?applet=file-edits&openPath=src/foo.ts)`. Clicks it
on V5. URL resolves via alias to `applets/files/script.js`. Tab
opens. No "applet not found" error.

**UC2.** Agent reads `prompts.ts` example, generates a new chat
link with `?applet=files&openPath=...`. Works.

**UC3.** User has a bookmark for `?applet=image-viewer&path=
/home/me/x.png`. Stub loads, reads the path, navigates to
`?applet=files&openPath=/home/me/x.png`. Files applet opens the
image viewer. Brief "Redirecting…" flash.

**UC4.** Agent (V5) lists applets. Sees `files`, `git-status`,
`themes`, etc. Does **not** see `markdown-viewer`, `image-viewer`,
`html-viewer`, `file-finder`. Cannot suggest the deprecated
applets.

**UC5.** User opens the applet browser, default view. Same
filtering as UC4. Toggles "Show deprecated"; sees the four
stubs with a "deprecated → files" badge.

**UC6.** Session has `file-edits-cards.json` on disk from a V4
session. User reopens the session in V5. First read migrates to
`files-cards`. Tab list reappears intact.

## 8. Acceptance

1. `applets/file-edits/` no longer exists; `applets/files/` does;
   `meta.json` slug reads `"files"`.
2. `SLUG_ALIASES` includes `'file-edits': 'files'`. New unit test
   covers the alias by calling `loadApplet('file-edits')` and
   confirming the resolved bundle matches the renamed directory.
3. `?applet=file-edits&openPath=X` opens the files applet and
   routes to X. The browser address bar may continue to show
   `file-edits` (no client-side canonicalizer; §4.4); behavior
   matches `?applet=files&openPath=X`.
4. Each of the four deprecated applets has:
   - `deprecated: true` and `replacedBy: "files"` in `meta.json`.
   - A 6-line "should I redirect?" check at the top of
     `script.js` that only redirects when an active session
     exists.
5. With an active session: `?applet=markdown-viewer&path=ABS`
   redirects to `?applet=files&openPath=ABS` and opens the file.
6. With an active session: `?applet=image-viewer&path=ABS`
   likewise.
7. With an active session: `?applet=html-viewer&path=ABS`
   likewise.
8. With an active session: `?applet=file-finder&root=X`
   redirects to `?applet=files&openFinder=1&openFinderRoot=X`
   and the picker opens with results rooted at X. `root=` is
   preserved, not dropped.
9. Without an active session: each of `markdown-viewer`,
   `image-viewer`, `html-viewer`, `file-finder` keeps its
   existing standalone behavior. Hand-typed
   `?applet=image-viewer&path=/abs/file.png` in a fresh tab
   still works.
10. The `files` applet accepts `?openFinderRoot=ABS` and opens
    the picker rooted at ABS even when there is no active
    session (used by new-chat Ctrl+P; see §5.4).
11. `src/prompts.ts:buildAppletSection()` filters
    `deprecated === true`. The four standalone applets are
    absent from the system message of a new session.
12. `src/applet-tools.ts:formatAppletUsage()` returns
    "Applet not found" (or equivalent) for deprecated slugs.
13. `GET /api/applets` includes `deprecated` and `replacedBy`
    fields on responses.
14. `applets/applet-browser/script.js` default view excludes
    deprecated applets; a "Show deprecated" checkbox reveals
    them with a "deprecated → files" badge.
15. `STORE_NAME` is `'files-cards'`. First read for a V4
    session migrates `file-edits-cards.json` content into
    `files-cards.json` AND deletes the old file. A unit test
    in `tests/unit/file-edits-store.test.ts` (or whichever
    file owns the store's tests) covers this.
16. Updated callers — these are exercised by manual smoke and
    must not stub-flash:
    - `public/ts/input-router.ts:73,82,90` Ctrl+P (new-chat AND
      active-session) goes directly to `files`.
    - `public/ts/context-footer.ts:123` footer link goes
      directly to `files`.
    - `src/prompts.ts:74` example uses `files`.
    - `src/browser-tools.ts` screenshot wrap uses `files`.
17. `_PICKER_FILE_ICONS` is unchanged in V5. The standalone
    `file-finder/script.js` retains its `fileIcons` map for
    the no-session fallback path; V6 (stub removal) is when
    the duplication finally collapses.
18. `npm run build` passes (typecheck + lint + tests + pii +
    vendor).
19. Manual smoke (covers all branches):
    - Active session, in-app: open `caco.png`, `README.md`,
      `applets/files/script.js`, `tests/artifacts/demo.html`
      via the four picker links — each opens in `files`.
    - Active session, deep link: paste
      `?applet=markdown-viewer&path=$(pwd)/README.md` in the
      address bar — instant redirect, file opens in `files`.
      Repeat for image-viewer, html-viewer, file-finder.
    - Active session, footer click + Ctrl+P in active session
      + Ctrl+P in new-chat — none show a stub flash.
    - No active session (fresh browser tab):
      `?applet=image-viewer&path=$(pwd)/caco.png` — opens
      standalone image-viewer (no redirect).
    - V4 session reopen: confirm the tab list (from
      `file-edits-cards.json`) reappears intact and the file
      on disk is now `files-cards.json`.

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Stale URLs with `?applet=file-edits` break | `SLUG_ALIASES` covers them server-side (§4.4); address bar may still show `file-edits`, behavior matches `files`. Acceptance §8.3. |
| Stubs flash old content briefly on redirect | Accepted (§6.6). Minimal "Redirecting…" placeholder. The frequent callers (footer, Ctrl+P) are updated to point directly at `files` so they never stub-flash (§4.7). |
| No-session deep links to standalone viewers break | Conditional redirect: stub only fires when session exists (§4.2, §5.5). Acceptance §8.9. |
| `file-finder?root=X` regression for explicit alternate roots | `openFinderRoot` preserves the param (§4.1, §4.3, §5.4). Acceptance §8.8, §8.10. |
| Persistence migration leaves orphaned `file-edits-cards.json` | Explicit `deleteSessionData('file-edits-cards')` after successful copy (§4.6). Unit-tested per §8.15. |
| Slug-alias misuse for standalone slugs | Documented (§6.2). Stubs are required when param shapes differ. |
| `agentUsage.purpose` filtering doesn't retroactively scrub model context | Acknowledged (§6.9). V5 only governs new system messages; pre-V5 conversation history is read-only. |
| TypeScript filenames don't rename | Intentional (§3 non-goals). Filename ≠ slug. |
| `applet-browser` toggle UX wrong | Single checkbox; smallest change (§4.5). |
| `loadApplet('file-edits')` test depends on private `resolveAppletDir` | Test the public `loadApplet` surface (§5.7); no test-only export. |
| `formatAppletUsage('markdown-viewer')` returning "not found" surprises agents who still emit those slugs | Intentional — the prompts no longer suggest them, so this only fires if the agent ignored the prompt update. The stub redirect still works for end users. |
| Adding `?openFinderRoot=` to `files` introduces a no-session code path | Two-line relaxation in `openPicker`/`runPickerFetch` (§5.4). Smoke covers (§8.10, §8.19). |

## 10. Out of scope (V6+ candidates)

- Delete the deprecated stub directories outright. V6+ — after
  enough turns for old chat links to age out.
- Grow the `files` applet to support no-session mode (so the
  conditional redirect can become unconditional and the
  standalone viewers can finally be deleted). V6+.
- Consolidate `_PICKER_FILE_ICONS` (depends on standalone
  removal). V6+.
- Rename TS routes / files (`src/routes/file-edits.ts` →
  `files.ts`, `src/file-edits-store.ts` → `files-store.ts`).
  One-shot rename + import fix; no behavior change. Defer.
- Rename `docs/file-edits*.md` historical spec files. Locked
  spec history convention.
- Update the long-tail of in-applet links
  (`text-editor`, `image-gallery`, `session-context`,
  `git-status`, `html-viewer`) to point at `files` directly
  instead of relying on the stub redirect. V6.
- Visual refresh (roadmap §12).
- Autosave / dirty-prompt (roadmap §13-14).
