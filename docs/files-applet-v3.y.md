# Files applet V3.y — open-from-chat + Ctrl+P finder

Status: draft.
Predecessors: V3.x (shipped, `docs/files-applet-v3.x.md`).
Roadmap: `docs/files-applet-roadmap.md` §V3.y.
Branch target: NEW `files-applet-v3.y` off master.

## 1. Goal

Two cross-module features that bring the files applet into the
broader Caco UX:

- **V3.y.1 Open-from-chat routing** — when chat output contains
  a link to a file, route to a TabContainer in the files applet
  instead of opening the standalone `markdown-viewer` /
  `image-viewer` / `html-viewer` / `text-editor`. Touches:
  - Chat-rendered markdown link generation (server-side prompts
    + client-side fallback).
  - `applets/file-finder/script.js` link generation.
  - `applets/file-edits/script.js` — accept `openPath` URL param
    and route into routeOpen.
  - The four standalone applets keep working — V3.y.1 just
    changes the default link target, not the standalone applets'
    behavior. V4 deprecates them.

- **V3.y.2 Enhanced finder (Ctrl+P overlay)** — the picker
  becomes a first-class "finder" surface inside the files
  applet, opened by Ctrl+P from anywhere in Caco. Adds:
  - Fuzzy match (the V1 picker already has substring search;
    V3.y.2 adds fuzzy ranking similar to `applets/file-finder`'s
    `fuzzyScore`).
  - Recent files history (last N opens, persisted in localStorage).
  - Type-specific filtering (typing `>img` filters to image
    extensions, `>md` to markdown, etc. — the same UX as VS
    Code's `>` command palette).
  - Preview-on-hover (DEFERRED to V3.y.3 — see §3 non-goals;
    requires too much extra surface).

The two parts ship sequentially: V3.y.1 first (smaller, lower
risk), V3.y.2 second.

## 2. Use cases

| # | Story | V3.y part |
|---|---|---|
| U1 | Agent writes a chat message containing `[View file](/?applet=text-editor&path=/repo/src/foo.ts)`. User clicks. Today: opens standalone text-editor. V3.y.1: opens files-applet with src/foo.ts as a diff tab. | V3.y.1 |
| U2 | Same as U1 but the path is `README.md`. V3.y.1: opens files-applet with a MarkdownViewer tab (default for .md). | V3.y.1 |
| U3 | User clicks a file in the file-finder applet. V3.y.1: routes to files-applet (not standalone) when the file is a supported type. | V3.y.1 |
| U4 | User presses Ctrl+P anywhere in Caco. The files applet opens (creating the panel if not visible) with the finder overlay focused. | V3.y.2 |
| U5 | User types in the finder. Fuzzy match ranks results; recent-files appear at top when query is empty. | V3.y.2 |
| U6 | User types `>img` then `app`. Finder filters to image files matching "app". | V3.y.2 |
| U7 | Selecting a result opens it in a new TabContainer via the existing routeOpen flow. The finder closes. | V3.y.2 |

## 3. Non-goals (V3.y)

- No removal of the standalone applets — V4 deprecates them with
  redirect stubs.
- **No preview-on-hover** in V3.y.2's finder. Would require
  rendering a viewer in a side pane, with its own layout +
  destroy semantics — out of scope; defer to V3.y.3 or later.
- No replacement of the V1 picker. The V1 picker (`feOpen` button
  + popup) stays for the in-applet "+" workflow; V3.y.2 just
  adds a SECOND surface (Ctrl+P overlay) that uses the same
  finder logic.
- No global keyboard shortcuts beyond Ctrl+P (other shortcuts
  are V4).
- No autocomplete suggestions / command palette / agent-actions
  in the finder — file-finding only.
- No multi-select / batch-open.

## 4. Design

### 4.1 V3.y.1 Open-from-chat routing

#### 4.1.A New URL contract: `?applet=file-edits&openPath=<abs>`

The files-applet accepts a new URL param `openPath` (absolute
path). On parse, the applet:

1. Strips the leading slash if present.
2. Computes `relPath = path relative to session cwd` if possible,
   else uses the full path as relPath.
3. Calls `routeOpen(relPath)` (existing) which picks the
   default viewer.

The `openPath` param is consumed on each parse: after route, the
URL is updated via `navigateAppletUrlParam('openPath', null)`
(existing API) so a back-button traversal doesn't re-open.

Why a new param instead of repurposing the existing `path`?
- Existing applets (`text-editor`, `markdown-viewer`,
  `image-viewer`, `html-viewer`) all use `path` to mean "the
  single file I'm currently showing". For file-edits, `path`
  would mean… the whole repo? Reusing `path` would conflate
  semantics. `openPath` is unambiguous: "open this file as a
  new tab if not already open; activate it."
- Naming consistency: `openPath` matches the existing internal
  `routeOpen(relativePath)` function.

#### 4.1.B Wiring inside file-edits applet

V3.y.1 ADDS a new `appletAPI.onUrlParamsChange` handler in
`applets/file-edits/script.js` (resolves review B3: file-edits
does not currently wire this callback; the V3.y.1 wiring is
brand-new). Registration site: alongside the existing
`onSessionChange` / `onSessionEvent` / `onStateUpdate`
registrations near the bottom of the file (around line 2704).

```js
// Queue param changes until cwd is known. Cold-load fires
// onUrlParamsChange BEFORE onSessionChange populates cachedCwd
// (resolves review I1). The queue drains as soon as cachedCwd
// is set; subsequent param changes process synchronously.
var _pendingOpenPath = null;
appletAPI.onUrlParamsChange(function(params) {
  if (params && params.openPath) {
    if (cachedCwd) {
      handleOpenPath(params.openPath);
    } else {
      _pendingOpenPath = params.openPath;
    }
    if (typeof appletAPI.navigateAppletUrlParam === 'function') {
      // Consume: empty string deletes per existing applet-runtime
      // signature (resolves review I3 — use '' not null).
      appletAPI.navigateAppletUrlParam('openPath', '');
    }
  }
  if (params && params.openFinder) {
    // V3.y.2: open the picker. Same consume-on-parse pattern.
    if (typeof openPicker === 'function') openPicker({ source: 'shortcut' });
    if (typeof appletAPI.navigateAppletUrlParam === 'function') {
      appletAPI.navigateAppletUrlParam('openFinder', '');
    }
  }
});

function handleOpenPath(p) {
  var relPath = relativizePath(p);
  void routeOpen(relPath);
}

// Drain the queue once cachedCwd is set. Hook into the existing
// session-meta load and onSessionChange paths.
function _drainPendingOpenPath() {
  if (_pendingOpenPath && cachedCwd) {
    var p = _pendingOpenPath;
    _pendingOpenPath = null;
    handleOpenPath(p);
  }
}
```

`relativizePath(absOrRel)`:
- If `absOrRel` starts with `/` AND `cachedCwd` is set AND
  `absOrRel` starts with `cachedCwd + '/'`: return the suffix.
- If `absOrRel` starts with `/` and is exactly `cachedCwd`:
  return `''`.
- Else: return `absOrRel` (treated by `routeOpen → absPathOf`
  as a path that's either already relative or an absolute
  outside the cwd — both handled by existing code).

`_drainPendingOpenPath` is called at the end of:
- The session-meta load promise (after `cachedCwd = info.cwd`
  near line 2776).
- The `onSessionChange` handler (after `cachedCwd = info.cwd`
  near line 2768).

**Signature note (resolves I3):** `navigateAppletUrlParam` in
`public/ts/applet-runtime.ts:346` is typed `(key: string,
value: string)` and treats a falsy `value` as "delete". V3.y.1
passes `''` instead of `null` to match the typed contract.
Applet-runtime spec may widen to `string | null` in a future
release; the spec uses the documented `string` form.

#### 4.1.C Chat-rendered links

Server-side: `src/prompts.ts` line 74 currently advertises
`?applet=text-editor&path=/file` as the link shape. V3.y.1
updates this to `?applet=file-edits&openPath=/file` as the
recommended form for code/markdown/image/html files.

Client-side: nothing produces these links automatically today;
the agent writes them in chat. Updating the prompt example
above is sufficient — the agent picks it up.

#### 4.1.D File-finder integration

`applets/file-finder/script.js:179, 211` constructs links like
`?applet=${getApplet(name)}&path=${absPath}`. V3.y.1 routes all
file types through file-edits via `openPath`. Since every arm
of the old `getApplet` now returns the same constant, the
helper collapses entirely (resolves review I4): the link
construction becomes a single inline template:

```js
// At lines 179 and 211, replace:
//   '?applet=' + applet + '&path=' + encodeURIComponent(absPath)
// with:
'?applet=file-edits&openPath=' + encodeURIComponent(absPath)
```

The `getApplet(name)` function is deleted; both call sites
also drop the `var applet = getApplet(...)` line.

This is a behavior change in the file-finder applet — V3.y.1
release notes call it out. Users with bookmarked file-finder
results will see file-edits open instead of the standalone
viewers.

#### 4.1.E What happens when file-edits is already loaded?

The router's existing flow (router.ts:153) handles same-slug
URL-param changes by firing `popstate`; the
`onUrlParamsChange` handler runs and the applet opens the new
file as a tab. No applet reload. New tab joins the existing
strip.

#### 4.1.F Backward compat for legacy links

Existing `?applet=markdown-viewer&path=X` URLs the user might
have bookmarked: still work. V4 deprecates with redirect.
V3.y.1 doesn't touch the standalone applets.

### 4.2 V3.y.2 Enhanced finder

#### 4.2.A Ctrl+P binding — REPLACE existing handler

Caco's `public/ts/input-router.ts:63-71` ALREADY binds Ctrl+P
(and Cmd+P on macOS); today it does a full-page navigation to
the standalone `file-finder` applet:

```ts
// EXISTING input-router.ts:63-71
if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
  e.preventDefault();
  const cwd = getViewState() === 'newChat'
    ? (getNewChatCwd() || getCurrentCwd() || '~')
    : (getCurrentCwd() || '~');
  window.location.href = '/?applet=file-finder&root=' + encodeURIComponent(cwd);
  return;
}
```

V3.y.2 **replaces** this branch (resolves review B1). The
existing bubble-phase keydown listener is sufficient —
`preventDefault()` on bubble already suppresses the browser's
Print dialog in production (resolves review I5). No
capture-phase shim needed.

New branch:

```ts
if ((e.ctrlKey || e.metaKey) && e.key === 'p' && !e.altKey && !e.shiftKey) {
  e.preventDefault();
  // V3.y.2 newChat handling (resolves review I2): no session
  // yet means file-edits can't run its picker (it fetches
  // /api/project-files?cwd= which requires a session). Fall
  // back to the legacy standalone file-finder for the newChat
  // case, which already accepts ?root=cwd.
  if (getViewState() === 'newChat') {
    const cwd = getNewChatCwd() || getCurrentCwd() || '~';
    window.location.href = '/?applet=file-finder&root=' + encodeURIComponent(cwd);
    return;
  }
  // Active session: route to files-applet finder via SPA navigation
  // so the panel + applet state survive.
  getPanelState().set({ applet: true }, 'deep-link');
  void nav.navigate('?applet=file-edits&openFinder=1');
  return;
}
```

`Ctrl+Shift+F` session-search and other shortcuts are
unchanged.

**Panel-state Reason** (resolves review B2): the existing
`Reason` union in `public/ts/panel-state.ts` is closed:
`'init' | 'user-toggle-session' | 'user-toggle-applet' |
'user-session-pick' | 'deep-link'`. V3.y.2 reuses `'deep-link'`
because the mechanism IS a deep-link navigation. (If finer
debug-signal granularity is wanted later, add a dedicated
reason in V4.)

#### 4.2.B Finder UX (in-applet)

The existing picker (V1, opened via `feOpen` button) becomes
the basis. Enhancements:

- **Fuzzy match.** Port `applets/file-finder/script.js`'s
  `fuzzyScore` function. Returns a numeric score; results sort
  by score descending.
- **Recent files.** Persist last 20 opened paths in
  localStorage `caco:files-applet:recentPaths`. Sorted by
  most-recent. Shown when query is empty, above the live
  search results.
- **Type filters.** Typing `>img ` (with space) at the start of
  query enables a type filter: subsequent matches are scored
  against the post-filter substring AND restricted to the type's
  canHandle. Filter prefixes: `>img`, `>md`, `>html`, `>diff`,
  `>any` (default).
- **Keyboard nav.** Already in V1 picker (arrow keys, Enter,
  Esc); preserved.

#### 4.2.C Finder DOM lifecycle

The existing picker is opened by the `feOpen` button (in-applet
"+" workflow). V3.y.2 keeps that path. Ctrl+P opens the SAME
picker DOM via a different entry point:
- `openPicker({ source: 'shortcut' })` — sets a flag so
  closePicker also restores focus to the previously-focused
  element.

When opened via Ctrl+P:
- If the applet is hidden, the panel-state change makes it
  visible first (the URL navigation handles this).
- Once the applet is rendered, the `onUrlParamsChange`
  handler reads `openFinder=1`, calls `openPicker({ source:
  'shortcut' })`, and clears the param.
- Esc closes the picker but does NOT hide the applet panel
  (user may want to see what's open).

#### 4.2.D Recent-files persistence

```js
// localStorage key: 'caco:files-applet:recentPaths'
// Shape: JSON Array<string> of abs paths, most-recent-first,
//        capped at 20 entries.
```

Updated on:
- Successful routeOpen (push the absPath to the head, dedup,
  cap at 20).

Read on:
- Finder open with empty query (rendered above the live-search
  result list with a "Recent" header).

Cleared on:
- Never automatically. The list ages out naturally; the cap
  bounds memory.

#### 4.2.E Type-filter parsing

In the picker's `runPickerFetch(q)`:
```js
var typeFilter = null;
var match = q.match(/^>(img|md|html|diff|any)\s+(.*)$/);
if (match) {
  typeFilter = match[1] === 'any' ? null : match[1];
  q = match[2];
}
// ... existing fetch logic with q ...
// post-fetch: if typeFilter, drop results whose extension
//             doesn't match the filter.
```

A "filter chip" pill renders at the top of the picker showing
the active filter; clicking the chip clears it.

#### 4.2.F Fuzzy scoring

Port `applets/file-finder/script.js:40-74` `fuzzyScore`:
- Substring match: high score weighted by query/target ratio.
- Char-by-char match with bonus for consecutive matches.
- Bonus for matches at the start of path segments (`/` or basename).

Sorted descending; cap at 50 results.

### 4.3 Integration with V3.x.1 chrome buttons

The finder is NOT a viewer; it doesn't fit the ViewerInstance
contract. It's a transient overlay rendered ABOVE the active
TabContainer. No interaction with chrome buttons.

(Future V4: maybe the finder becomes a viewer type for the
"Recent files" pane. Out of scope.)

### 4.4 Acceptance shape

V3.y.1 ships when:
- Chat link `?applet=file-edits&openPath=/repo/README.md` opens
  the files applet with a markdown tab.
- File-finder's result clicks route through file-edits.
- The standalone applets still work for direct URLs.

V3.y.2 ships when:
- Ctrl+P from anywhere opens the files applet's finder overlay.
- Fuzzy match ranks results.
- Recent files appear on empty query.
- `>img` filter works.
- Selecting a result opens via routeOpen and closes the finder.

## 5. Backend changes

### V3.y.1
- `src/prompts.ts` line 74: update the link example from
  `?applet=text-editor&path=/file` to
  `?applet=file-edits&openPath=/file`.

### V3.y.2
- None. Existing `/api/project-files` already serves the file
  list with optional query.

## 6. Migration / deprecation

V3.y does NOT touch the standalone applets. Both URL forms work
during the transition window:
- `?applet=markdown-viewer&path=X` — opens standalone (legacy).
- `?applet=file-edits&openPath=X` — opens files-applet tab (V3.y).

V4 picks up the cleanup: standalone applet stubs redirect to
`?applet=file-edits&openPath=X`. Saved-applet URLs gracefully
redirect.

## 7. Considerations

### 7.1 Why two URL params (`openPath` vs `path`)?

§4.1.A covered this. `path` is overloaded in the existing
applets; `openPath` is unambiguous and matches the internal
`routeOpen` name.

### 7.2 Why Ctrl+P specifically?

It's the VS Code / IntelliJ / Sublime convention. Users will
expect it. Cmd+P on macOS handled by the same handler (e.metaKey
OR e.ctrlKey).

### 7.3 Risks

| Risk | Mitigation |
|---|---|
| Recent-files localStorage grows / collides across cwds (same path in two different sessions). | Cap at 20 entries; key is just the abs path (no cwd prefix). Cross-session relevance is fine — abs paths are unique. |
| User on iframe-isolated applet — Ctrl+P inside the applet's iframe might not bubble to Caco's input-router. | The applet IS in the main DOM (Caco applets are not iframed; they're injected into the page). Verified via existing `appletAPI` having direct DOM access. The HtmlViewer's content IS in an iframe, but `<iframe sandbox="allow-scripts">` doesn't propagate keydown to the parent — Ctrl+P inside the iframe will hit the browser default. Acceptable (edge case; user can click outside the iframe to refocus). |
| File-finder behavior change surprises users. | Release notes; one paragraph in the file-finder applet meta.json `agentUsage.purpose`. |
| `openPath` URL param leaks into the URL bar visible to the user and looks ugly. | Consumed immediately on parse via `navigateAppletUrlParam(...,'')` so it's only visible for one frame. |
| Type filter syntax (`>img`) conflicts with files that have `>` in the path. | Real-world Unix paths don't have `>` (filename character but rare). Acceptable corner-case. |

### 7.4 Open questions (with answers)

1. **Should the finder remember its query across opens?** No.
   Each open starts fresh; recent-files surfaces past selections.
2. **Should the finder support a global "recent files across
   sessions"?** localStorage per-machine; agnostic to session.
   A session-switch doesn't clear recent-files (intentional).
3. **What about non-file targets like "session-search"?** Out
   of scope; the finder is files-only. A future V4+ command-
   palette could share the overlay shell.
4. **Does routeOpen update recent-files always, or only when
   triggered by the finder?** Always. Recent-files tracks user
   intent across all open paths (picker, finder, openPath URL,
   caco.edit auto-open). Acceptable.
5. **Should `openPath` accept multiple paths
   (`openPath=a&openPath=b`)?** No. Single path per nav. Multi-
   open is V4+.

## 8. Acceptance

### V3.y.1
- [ ] Visiting `?applet=file-edits&openPath=/abs/README.md`
      opens the applet with a MarkdownViewer tab. URL settles to
      `?applet=file-edits` (param consumed).
- [ ] When file-edits is already loaded, the same URL navigation
      opens the file as a NEW tab (or activates an existing
      tab if same id).
- [ ] File-finder applet's result clicks navigate to file-edits.
- [ ] `src/prompts.ts` updated.
- [ ] `npm run build` passes.

### V3.y.2
- [ ] Ctrl+P from anywhere in Caco shows the files applet's
      finder. macOS Cmd+P equivalent.
- [ ] Browser's default "Print" dialog is suppressed.
- [ ] Empty query shows "Recent" section (or "No recent files"
      placeholder).
- [ ] Typing fuzzy-matches; results re-rank live.
- [ ] `>md ` prefix restricts to markdown.
- [ ] Esc closes the finder; applet panel remains visible;
      previously-focused element regains focus.
- [ ] Selecting a result calls routeOpen and adds to recent-files.
- [ ] `npm run build` passes.

## 9. Roll-back

Each V3.y part is its own commit on the branch. Revert V3.y.1:
chat / file-finder links go back to the standalone applets;
file-edits applet ignores `openPath`. Revert V3.y.2: Ctrl+P
becomes the browser default; finder loses the enhanced
features but the V1 picker still works.

## 10. V4+ stubs (carry-forward)

Unchanged: rename to `files`, deprecate standalone applets,
visual refresh, autosave, dirty-on-session-switch (likely
superseded by autosave). V4 also deprecates the standalone
text-editor applet (V3.y.1 makes its routing optional).

Preview-on-hover in the finder defers to V3.y.3 or later.

## 11. Test plan

Manual acceptance per §8. No unit tests.
