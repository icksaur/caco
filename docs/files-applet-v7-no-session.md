# Files applet — V7 no-session mode

**Status:** spec rev 3, not implemented. Combines roadmap items
V7 #10 (delete deprecated stub applets), #11 (no-session mode in
`files`), and #13 (update in-applet links). Rev 2 incorporates
spec-review findings in `docs/files-applet-v7-no-session-review.md`.

## 1. Goal

Make `?applet=files&openPath=/abs/path.ext` render a working
file viewer with **no Caco session attached**. Today the V5 stub
applets (`markdown-viewer`, `image-viewer`, `html-viewer`,
`file-finder`, `git-diff`) exist solely to serve sessionless deep-
links: they redirect to `files` when a session exists and fall
through to their own standalone code otherwise. V7 lifts the
session requirement from `files`, replaces the conditional
redirect with an unconditional HTTP redirect at the server, and
deletes the stub applets — one viewer per file type, owned by
`files`.

## 2. Use cases

These deep-link surfaces today depend on the stub fallthrough
because there is no session:

- Bookmarked applet URL pasted into a fresh browser tab.
- File-manager / OS-level "open with Caco" handler.
- `session-context` footer link viewed outside a chat surface.
- `image-gallery` per-image links.
- Session-archive viewer opening a checkpointed file path.
- Any `text-editor` / `html-viewer` direct link with no active
  session.
- `file-finder?root=/abs/dir` bookmarks that open the standalone
  finder rooted at a known directory.

All of them want either "show me this file" or "let me pick a
file under this directory."

## 3. Non-goals

- Persistence. A sessionless surface has no per-session card
  store. The single open tab lives only as long as the page.
- DiffViewer. Diffs require a git repo at a known cwd.
  Sessionless mode hides the diff entry from `viewerRegistry`
  (it never appears in `updateToggle()`'s menu).
- MarkdownViewer Edit mode and Save. Sessionless markdown is
  read-only.
- `caco.edit` polling and live `watchPath`. There is no session
  to subscribe to and `watchPath` requires a session-scoped
  lease.
- The file-tree sidebar (V3 backlog).
- `src/routes/file-edits.ts` → `files.ts` rename (V7 #12, ships
  separately).

## 4. Design

### 4.1 Boot mode boundary

`applets/files/script.js` resolves `getSessionId()` once at the
bottom of its IIFE. V7 splits that decision into two named flat
functions in the same file:

- **`bootSession(existingId)`** — current behaviour: wire
  `onSessionEvent`, `onSessionChange`, call `initFromPersistence`,
  set `capabilities` to all-true, render full chrome.
- **`bootSessionless(params)`** — read `openPath` / `openFinder`
  / `openFinderRoot` from URL params. Set `capabilities` to a
  read-only descriptor (§4.2). Either open one tab via
  `routeOpenExternal(openPath, { watch: false })` or open the
  finder via `openPicker({ rootOverride: openFinderRoot })`. Do
  not subscribe to any session events.

Boot selection is at the bottom of the IIFE: missing session
selects sessionless. **No `if (!sessionId)` checks are sprinkled
through the rest of the code.** The boot mode is the invariant
that the rest of the file relies on.

Sessionless boot is terminal: a session activating later does
**not** upgrade the page to session mode (the user can reload).
This is intentional — upgrading mid-page would require tearing
down the sessionless tab, rebuilding chrome, and reconciling
state; that complexity has no compelling use case in V7.

### 4.2 Capabilities

A `capabilities` object created at boot:

```
{
  canPersist:       boolean,  // controls #feOpen, persistence calls,
                              // beforeunload beacon, finder shortcut
  canDiff:          boolean,  // filters DiffViewer out of viewerRegistry
                              // when false (so updateToggle never
                              // surfaces it, and TabContainer never
                              // constructs one)
  canEdit:          boolean,  // forwarded into MarkdownViewer opts;
                              // when false, MarkdownViewer is constructed
                              // with readOnly: true (existing flag)
  canFollowEdits:   boolean,  // controls #feFollow visibility AND
                              // makes updateFollowButton() return early
                              // (so future calls can't re-show the chip)
  canWatch:         boolean,  // forwarded into viewer open() calls as
                              // opts.watch=false; viewers skip
                              // shell.api.watchPath entirely (§4.3)
}
```

`bootSession` sets all true. `bootSessionless` sets all false.

The descriptor is plumbed in three ways:

1. **DOM-level**: `applyCapabilities(capabilities)` toggles
   `hidden` on `#feFollow`, `#feOpen`, and `#feNotGit` (the last
   is always hidden sessionless — it's a session-mode signal).
2. **Registry-level**: `viewerRegistry` is constructed inside the
   boot function, not at module top-level, and conditionally
   excludes the DiffViewer descriptor when `!canDiff`. This
   makes `TabContainer.updateToggle()` and `_pickDefaultViewer`
   naturally exclude it without per-call checks.

   **Sequencing caveat (IMPORTANT-1):** `shell.viewers` is
   currently assigned to the original `viewerRegistry` array
   (~`script.js:335`). The implementation must construct the
   filtered registry *before* the shell object is created, OR
   reassign `shell.viewers` to the new array after construction.
   Either is fine; mutating `viewerRegistry` in place after
   `shell.viewers` is captured is NOT — the array reference is
   what `TabContainer.updateToggle()` reads.

3. **Per-viewer-opts**: `routeOpenExternal` forwards
   `{ readOnly: true, watch: canWatch }` into each viewer's
   `open()`. External opens are read-only in **all** modes
   (matches today's session-mode behaviour — out-of-cwd files
   have never been editable); only `watch` is capability-
   derived (`false` sessionless, `true` session-mode).
   `TabContainer.switchViewer()` reads `shell.capabilities` on
   each lazy open so subsequent viewer constructions stay
   consistent (§4.3).

   For session-mode in-cwd opens (the routeOpen path), markdown
   editability is unaffected — that path is owned by `routeOpen`,
   not `routeOpenExternal`, and only runs in session mode.

### 4.3 No-watch viewer opens (BLOCKER-1 fix)

Every external viewer factory currently calls
`shell.api.watchPath(absPath, { scope: 'file' })`, which throws
`No active session for watchPath` in sessionless mode and
silently destroys the tab. V7 adds a single `opts.watch` flag
honoured by every viewer AND threaded through every
construction path:

**Static `open()` signatures.** All four viewers gain (or
already have) an `opts` argument and wrap their `watchPath` call:

- `applets/files/markdown-viewer.js` — `open(shell, container,
  abs, rel, opts)` already exists; wrap `watchPath` in
  `if (opts && opts.watch !== false)`.
- `applets/files/source-viewer.js` — `open(shell, container,
  abs, rel, opts)` already exists; same wrap.
- `applets/files/image-viewer.js` — add `opts` argument (today:
  `open(shell, container, abs, rel)`); same wrap.
- `applets/files/html-viewer.js` — add `opts` argument (today:
  `open(shell, container, abs, rel)`); same wrap.

**Registry-wrapper opts forwarding.** The image and HTML
registry wrappers in `script.js` (~lines 2675, 2684) currently
drop the fifth argument:

```
open: function(s, c, a, r) { return ImageViewer.open(s, c, a, r); }
```

Both wrappers gain the `opts` parameter and forward it:

```
open: function(s, c, a, r, opts) { return ImageViewer.open(s, c, a, r, opts); }
```

(The markdown and source wrappers already forward opts.)

**Lazy viewer switching (NEW-BLOCKER-1).**
`TabContainer.switchViewer()` (~`script.js:826`) calls
`desc.open(this.shell, this, this.absPath, this.relPath)` with
no opts. A sessionless markdown or HTML tab can be toggled to
SourceViewer via the per-tab viewer toggle; without forwarded
opts the lazy open reproduces the `watchPath` crash.

V7 requires `TabContainer` to remember the opts it was
constructed with (or, equivalently, snapshot the capability-
derived `{ readOnly, watch }` at construction time) and forward
them on every `switchViewer()`. The shell's `capabilities`
descriptor is the canonical source; `TabContainer` can read
`shell.capabilities` on each `switchViewer()` to keep the
contract one-way.

The initial `/api/file?path=` fetch still happens. The tab
renders normally; the file just doesn't auto-refresh on disk
change. Session-mode behaviour is unchanged (`watch` defaults to
true).

### 4.4 Sessionless picker (BLOCKER-2 fix)

`openPicker` already accepts `{ rootOverride }` without a session
(line 2272: `if ((!sessionId && !opts.rootOverride) || pickerOpen)
return;`). V7's `bootSessionless` honours `?openFinder=1`
combined with `?openFinderRoot=/abs/dir`:

1. Validate `openFinderRoot` is a non-empty absolute path
   (POSIX `/...`, Windows `X:\...`, or UNC `\\...`). Today
   `/api/project-files` resolves relative `cwd` against
   `programCwd`, which would silently work for `openFinderRoot=src`
   but break the sessionless contract. Reject relative roots in
   `bootSessionless` before calling `openPicker`.
2. On valid absolute root: call
   `openPicker({ source: 'url', rootOverride })`.
3. On invalid root (relative, empty, or missing when
   `openFinder=1` is set): render an empty-pane error message
   ("Sessionless finder requires `openFinderRoot=ABSOLUTE_PATH`").

Selecting a file in the picker re-routes via `openAnyPath`,
which sessionless mode treats as external (§4.5).

This preserves `file-finder?root=/abs/dir` semantics under the
new redirect.

### 4.5 External-only routing

`openAnyPath` today dispatches to `routeOpenExternal` (abs path
outside cwd) or `routeOpen` (in-cwd rel). In sessionless mode
`cachedCwd` stays `''`. V7 adds one check at the top of
`openAnyPath`: when sessionless (no `sessionId`), always
`routeOpenExternal(path, opts)` regardless of `isExternal`. This
is one branch, not a redefinition of `isExternal`.

Relative `openPath` in sessionless mode is rejected; the empty
pane shows the same usage hint as `?openFinder=1` with no root.

**Session-mode regression note (NEW-IMPORTANT-3).** The lexical
containment check in `_isContainedIn` is unchanged by V7 — a
path that lexically appears inside `cachedCwd` but is a symlink
to outside cwd continues to be classified as in-cwd. This is
existing behaviour. V7 must not change it; the routing-boundary
edits are restricted to the no-session branch.

### 4.5.1 Sessionless error-rendering ownership (NEW-IMPORTANT-2)

Sessionless visible-error guarantees (acceptance 10-12, 15)
require an explicit owner. The current `routeOpenExternal()`
logs and destroys the container on failure, leaving only the
generic empty pane. V7 adds two complementary mechanisms:

1. **Pre-validation in `bootSessionless`.** Bad URL inputs
   (relative `openPath`, missing-everything, invalid
   `openFinderRoot`) are caught before any viewer construction
   and rendered as an inline message into `#fePaneEmpty` with
   `.fe-pane-error` class. No tab is created. The empty-pane
   element already exists; V7 adds a `setEmptyPaneError(message)`
   helper.
2. **Factory-failure rendering in `routeOpenExternal`.** When
   `desc.open()` throws (file unreadable, no matching viewer),
   `routeOpenExternal` writes an inline error into the tab's
   container instead of silently destroying it. The error
   surface is the tab's content area; the tab stays in the strip
   so the user can close it.

Both helpers are session-mode-safe (no-op when session-mode
shows a tab elsewhere) — they only render when their
preconditions are met.

### 4.6 Markdown Save guard (IMPORTANT-2 fix)

`MarkdownViewer` already has `_readOnly` and hides the Edit mode
when it's true. V7 strengthens the read-only contract so hidden
UI is not the only barrier:

- `getChromeButtons()` returns `[]` when `_readOnly`.
- The Ctrl+S keydown handler checks `_readOnly` before calling
  `save()`.
- `setMode('edit')` is a no-op when `_readOnly`.
- `save()` starts with `if (this._readOnly) throw new Error('read-only')`.

This is the "make the wrong thing unrepresentable" application
of code-quality.md — the Save path is unreachable in sessionless
mode regardless of how its UI is wired.

### 4.7 Server-side redirect (BLOCKER-3 fix)

The unconditional redirect lives in `server.ts`'s existing
`app.get('/')` handler (lines 98-106), before `cachedIndexHtml` is
served. The OAuth callback check already lives there; the
legacy-applet rewrite goes next to it.

Owner of the rewrite logic: a pure helper
`legacyAppletRedirectTarget(slug, params)` in a new
`src/legacy-applet-redirects.ts` file. Returns
`URLSearchParams | null`. Unit-tested in isolation. The handler
calls it and either `res.redirect(302, '/?' + target)` or falls
through to serve the index HTML.

Rules:
- `?applet=markdown-viewer&path=X` → `?applet=files&openPath=X`
- `?applet=image-viewer&path=X` → `?applet=files&openPath=X`
- `?applet=html-viewer&path=X` → `?applet=files&openPath=X`
- `?applet=file-finder&root=X` →
  `?applet=files&openFinder=1&openFinderRoot=X`
- `?applet=file-finder` (no root) → `?applet=files`
  (sessionless empty-pane usage hint)
- `?applet=git-diff&file=X&staged=1` →
  `?applet=files&openPath=X&diffMode=staged`
- `?applet=git-diff&file=X` →
  `?applet=files&openPath=X&diffMode=unstaged`
- `?applet=git-diff` (no file, with `ref=`) → `?applet=git-status`
  (preserves V6.1 stub behaviour; ref-bearing URLs land on
  status, not files)
- **All other query params are preserved** (e.g., `&line=42`,
  future UI flags). Only `applet` and explicitly-translated
  params (`path`, `file`, `staged`, `ref`, `root`) are mutated.

Returns null when slug isn't a known legacy slug → handler
serves index normally.

### 4.8 Removed code

Files deleted (once the redirect lands):
- `applets/markdown-viewer/`
- `applets/image-viewer/`
- `applets/html-viewer/`
- `applets/file-finder/`
- `applets/git-diff/`
- The duplicated `fileIcons` map (currently in the file-finder
  applet + the `files` applet) — collapses to one in `files`.
- `SLUG_ALIASES` and `deprecated` entries in `applet-store.ts`
  that exist purely for the stubs (`files-cards` alias for the
  V5 storage rename stays — it's unrelated to this work).

`applet-browser` no longer lists the deprecated stubs (they don't
exist on disk).

### 4.9 In-applet link callsites (V7 #13)

Updated to point at `files` directly:
- `public/ts/context-footer.ts` (already done for recent-files;
  audit for other paths).
- `applets/text-editor/script.js` — recent files / file-open links.
- `applets/image-gallery/script.js` — per-image "open" links.
- `applets/session-context/script.js` — file refs.
- `applets/html-viewer/script.js` — if its internal navigation
  escapes the sandboxed iframe, point at `files`; if it stays
  inside the iframe, leave alone.
- `applets/git-status/script.js` — already uses `files` (V6).

These updates avoid relying on the redirect for new links. The
redirect handles long-tail chat-message URLs and stale bookmarks.

### 4.10 Guard retention (IMPORTANT-3 fix)

The ~18 `if (!sessionId) return` guards in `script.js` fall into
three groups:

1. **Wiring-only paths** (`onSessionEvent`, `onSessionChange`,
   `initFromPersistence` subscribers): these become unreachable
   in sessionless mode because the wiring lives inside
   `bootSession`. Guards can be removed here.
2. **Async boundary calls** (`schedulePersist`, `flushPersist`,
   `flushPersistBeacon`, `fetchSnapshot`, `applyAgentState`):
   these are called from generic paths (`beforeunload`, picker
   handlers, tab-state updates) where a future change could
   re-introduce a sessionless caller. Guards stay as cheap belt-
   and-suspenders.
3. **`openPicker`/`runPickerFetch`**: intentionally allow
   `rootOverride` without a session (already correct). No
   change.

The spec rule: remove a guard only when its caller is provably
session-only after the boot split. When in doubt, keep the
guard.

## 5. Code analysis

### 5.1 `applets/files/script.js`

- ~lines 3452-3589 (bottom-of-IIFE wiring) is the boot
  boundary. Split into `bootSession(existingId)` and
  `bootSessionless(params)`. ~80 lines added, ~30 removed.
- `viewerRegistry` (currently top-level near line 2696) becomes
  built inside the boot function via `buildViewerRegistry(caps)`
  so `canDiff` can exclude DiffViewer. Must run before `shell`
  is constructed, or `shell.viewers` must be reassigned to the
  new array (§4.2 sequencing caveat). ~15 lines refactor.
- `applyCapabilities(capabilities)` helper near the boot
  boundary. ~15 lines.
- `setEmptyPaneError(message)` helper that renders an inline
  error into `#fePaneEmpty`. ~5 lines.
- `openAnyPath` gets one early return: when sessionless, route
  external unconditionally. ~3 lines.
- `updateFollowButton`: early-return when `!canFollowEdits`. ~3
  lines.
- `routeOpenExternal`: forward `{ readOnly: true, watch:
  capabilities.canWatch }` into the viewer's `open()`. External
  opens are read-only in both modes (unchanged from today); only
  `watch` is mode-dependent. On factory failure, render an
  inline error into the tab content instead of silently
  destroying. ~10 lines.
- Image and HTML registry-wrapper signatures (~lines 2675,
  2684): add `opts` parameter and forward. ~4 lines.
- `TabContainer.switchViewer()` (~line 826): on call, forward
  `{ readOnly, watch }` derived from `this.shell.capabilities`.
  ~5 lines.
- Remove guards per §4.10 group 1. ~10 lines removed.

### 5.2 `applets/files/{markdown,image,html,source}-viewer.js`

- Each gains an `opts.watch !== false` check around its
  `watchPath` call. ~3 lines per file.
- `image-viewer.js` and `html-viewer.js` `open()` signatures
  gain an `opts` argument (today they have none). ~1 line
  signature change each.

### 5.3 `applets/files/markdown-viewer.js`

- `getChromeButtons()` returns `[]` when `_readOnly`. ~3 lines.
- Ctrl+S handler short-circuits when `_readOnly`. ~3 lines.
- `setMode('edit')` no-op when `_readOnly`. ~3 lines.
- `save()` throws when `_readOnly`. ~2 lines.

### 5.4 `applets/files/content.html`

No new elements. Existing buttons get `hidden` toggled by
`applyCapabilities`.

### 5.5 `server.ts`

- Import `legacyAppletRedirectTarget`.
- In `app.get('/')` after the OAuth check, call the helper; if
  it returns a `URLSearchParams`, redirect. ~8 lines.

### 5.6 `src/legacy-applet-redirects.ts` (new)

- Pure function `legacyAppletRedirectTarget(slug, params:
  URLSearchParams): URLSearchParams | null`.
- Implements the rules in §4.7. ~60 lines.
- Unit-tested in `tests/unit/legacy-applet-redirects.test.ts`.

### 5.7 `tests/unit/legacy-applet-redirects.test.ts` (new)

One test per rule in §4.7, plus:
- Unknown param preservation (`&line=42`).
- Non-legacy slug returns null.
- `applet=files` itself returns null (no redirect loop).
- Empty params returns null for slugs that need params
  (markdown-viewer with no path → null, falls through to serve
  index with no openPath).

### 5.8 Deleted directories

`applets/markdown-viewer/`, `applets/image-viewer/`,
`applets/html-viewer/`, `applets/file-finder/`, `applets/git-diff/`.
Audit `applet-store.ts` for any registry entries that reference
these slugs as `deprecated: true` and remove them.

### 5.9 Link callsites (§4.9)

Audit and update — likely ~10-20 lines total across files.

## 6. Considerations

### 6.1 One PR vs phased ship

#10 (delete stubs) + #11 (no-session mode) + #13 (link
cleanup) ship in one PR. Splitting them creates a regressed
intermediate state: shipping #11 first leaves stubs as dead-but-
live code; shipping #10 first regresses sessionless URLs.

**The redirect helper + tests land in the same commit as the
stub-directory deletion.** Reviewer should verify this commit is
self-contained: tests pass, no broken URLs left in the
codebase.

If atomic deploy isn't guaranteed, ship the redirect helper +
the `files`-side capability changes first (still no behaviour
change because stubs still exist and still take precedence),
then a second commit deletes the stubs once the redirect is
confirmed live. The spec leaves this to impl discretion based on
deploy guarantees.

### 6.2 Why no shared base class

The two boot functions share fewer than 20 lines of distinct
wiring after `applyCapabilities` and existing helpers (placeholder
DOM appending, follow-button init, `updateEmptyState()`). A base
class would be one method that calls four helpers — the classic
over-abstraction smell. Keep them as two flat functions; share
plain helpers (`applyCapabilities`, `buildViewerRegistry`).

(Spec-review MINOR-1 noted "under 10 lines" was optimistic. The
actual shared core after the split is small but nonzero. The
guidance stands: two flat functions, shared helpers, no base
class.)

### 6.3 Boot terminality

Sessionless boot does not auto-upgrade when a session activates
later. This avoids cross-cutting reconciliation logic and matches
how the V5 stubs behave today (a stub-page load doesn't morph
into a session-aware page if a session later attaches).
Documented as an explicit invariant (§4.1).

### 6.4 URL contract ownership

Today the legacy URL contract is implicit across five stub
scripts, four link callsites, and the `files` applet. V7
centralises:

- **Legacy slugs** → `src/legacy-applet-redirects.ts` (server-
  side, tested).
- **New links** → continue to construct
  `?applet=files&openPath=…` inline. A shared client-side URL
  builder would be nice but is over-investment for the small
  number of callsites; flagged as a follow-up.

### 6.5 No tests for applet JS

Consistent with V1+ baseline, V7 adds no tests inside
`applets/files/*.js`. The redirect helper IS unit-tested (it's
TypeScript, server-side). Manual smoke checks in §8 cover the
applet boot paths.

## 7. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| `watchPath` throws and silently destroys sessionless tabs | high if §4.3 missed | Acceptance items 1-4 explicitly cover all four viewer types sessionless |
| Old `file-finder?root=` URLs regress (no finder in sessionless) | medium if §4.4 missed | Acceptance item 14 covers; redirect rule is explicit |
| Stale `if (!sessionId)` guard removed but boot boundary misses a sessionless caller | medium | §4.10 guard-retention rule + impl-time grep audit |
| Server redirect routes legacy URLs to a path `files` can't handle (e.g., malformed `path=` param) | low | Acceptance item 16 covers param-preservation; tests cover edge cases |
| Sessionless boot accidentally subscribes to `onSessionChange`, then activates session mid-page in inconsistent state | low | §4.1 invariant: `bootSessionless` makes no `onSessionChange` / `onSessionEvent` subscriptions; impl audit |
| Markdown Save reachable via some non-UI path even when read-only | low | §4.6 hardens four code paths (chrome buttons, keydown, setMode, save itself) |
| DiffViewer accidentally appears in sessionless `updateToggle` menu | low | §4.2 registry-level exclusion; if a file would default to DiffViewer, the registry has no DiffViewer entry to pick |
| Deleting stubs breaks a long-tail link the redirect doesn't cover | medium | §4.7 covers all five legacy slugs with unknown-param preservation; smoke test one of each pre-merge |
| `git-diff?ref=` URL routes somewhere unexpected | low | §4.7 explicitly says ref-bearing → `git-status`, matching V6.1 stub |

## 8. Acceptance

### Sessionless file viewing
1. `?applet=files&openPath=/abs/dir/file.md` opens a single
   read-only markdown tab. Toolbar shows `dir` as label.
2. `?applet=files&openPath=/abs/dir/img.png` opens image viewer.
3. `?applet=files&openPath=/abs/dir/page.html` opens sandboxed
   HTML viewer.
4. `?applet=files&openPath=/abs/dir/source.cpp` opens
   SourceViewer (highlighted read-only text).
5. None of the above cause `No active session for watchPath`
   errors in console; tabs render successfully.
6. Hidden in sessionless: `#feOpen` (`+`), `#feFollow`, `#feNotGit`.
7. Per-tab viewer toggle: DiffViewer is NOT listed in the menu
   for any sessionless tab.
8. Markdown tab: only "View" mode shown; no Save button; Ctrl+S
   does nothing.
9. Closing the only tab leaves empty-pane usage hint.
10. Relative `openPath` (no leading `/` or drive letter) shows
    inline error in empty pane (not a silent failure).
11. Path the server can't read: viewer surfaces error visibly
    in pane (not console-only).
12. `?applet=files` (no `openPath`, no `openFinder`) shows
    empty-pane usage hint.

### Sessionless finder
13. `?applet=files&openFinder=1&openFinderRoot=/abs/dir` opens
    the finder rooted at `/abs/dir` with no session.
14. Selecting a file in the sessionless finder opens it via
    `routeOpenExternal` (no watch, read-only) — same behaviour
    as items 1-4.
15. `?applet=files&openFinder=1` with no root → empty-pane
    visible error message.
15a. `?applet=files&openFinder=1&openFinderRoot=src` (relative)
     → empty-pane visible error message (no silent fall-through
     to programCwd-relative resolve).

### Lazy viewer switching (sessionless)
15b. Sessionless markdown tab toggled to SourceViewer via the
     per-tab viewer toggle renders without `No active session
     for watchPath` errors.
15c. Same for sessionless HTML tab toggled to SourceViewer.

### Session-mode regression
16. With a live session, every existing affordance works
    unchanged: finder, persistence, follow-edits, diff toggle,
    markdown Edit/Save, `caco.edit` polling, `onSessionChange`
    tear-down/re-init.
17. Out-of-cwd absolute path from chat still routes via
    `routeOpenExternal` (unchanged).
18. Session-switch tears down tabs and re-inits from new
    session's persistence (unchanged).
18a. An absolute path that lexically lies under `cachedCwd` but
     is a symlink to outside cwd continues to be classified as
     in-cwd (V7 does not change `_isContainedIn`).

### Sessionless → session transition
19. If a session activates after a sessionless boot, the page
    stays in sessionless mode (no auto-upgrade). User can
    reload to enter session mode.

### Legacy redirects (HTTP-level)
20. `?applet=markdown-viewer&path=/abs/x.md` → 302 →
    `?applet=files&openPath=%2Fabs%2Fx.md`. (URL encoding
    preserved.)
21. Same for `image-viewer`, `html-viewer` (with `path=`).
22. `?applet=file-finder&root=/abs/dir` → 302 →
    `?applet=files&openFinder=1&openFinderRoot=%2Fabs%2Fdir`.
23. `?applet=file-finder` (no root) → 302 → `?applet=files`.
24. `?applet=git-diff&file=/abs/x&staged=1` → 302 →
    `?applet=files&openPath=%2Fabs%2Fx&diffMode=staged`.
25. `?applet=git-diff&file=/abs/x` (no staged) → 302 →
    `?applet=files&openPath=%2Fabs%2Fx&diffMode=unstaged`.
26. `?applet=git-diff&ref=HEAD~1` → 302 → `?applet=git-status…`
    (preserves V6.1 stub behaviour).
27. Unknown params preserved across all redirects:
    `?applet=markdown-viewer&path=/x.md&line=42&foo=bar` →
    `?applet=files&openPath=%2Fx.md&line=42&foo=bar`.
28. `?applet=files&openPath=/x.md` (already files) → no redirect.
29. `?applet=calculator` (unrelated applet) → no redirect.

### Stub removal
30. Directories `applets/{markdown-viewer,image-viewer,html-viewer,file-finder,git-diff}/`
    no longer exist on disk.
31. `applet-browser` lists no entry for the deleted slugs.
32. `fileIcons` map exists in exactly one location (inside
    `applets/files/`).

### Link callsites
33. `text-editor` recent-file links open in `files`.
34. `image-gallery` per-image links open in `files`.
35. `session-context` footer links open in `files`.
36. `git-status` per-file diff links open in `files` (already
    true as of V6 — regression check).

### Unit tests
37. `legacyAppletRedirectTarget` has tests for every rule in
    §4.7 plus the param-preservation, no-loop, and unknown-slug
    cases. All pass.

## 9. Out of scope (parking lot)

- Sessionless mode upgrading to session mode on later
  attachment (§6.3).
- Shared client-side URL builder for `files&openPath=…` links
  (§6.4).
- File-tree sidebar in any mode.
- File-write in sessionless mode (would need a permission
  model).
- `src/routes/file-edits.ts` → `files.ts` rename (V7 #12, ships
  separately).
- Per-commit detail view in git-status (V7 #14).
- Live event hook for staged tabs (V7 #15).
- Global keyboard shortcuts beyond Ctrl+P (V7 #16).
- Visual refresh (V7 #17).
- Autosave (V7 #18).
