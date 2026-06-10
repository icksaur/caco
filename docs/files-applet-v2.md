# Files applet V2 — image + html + persistence + markdown edit

Status: draft.
Predecessors: V1 (shipped, `docs/files-applet-v1.md`), V1.1 (shipped,
`docs/files-applet-v1.1.md`).
Roadmap: `docs/files-applet-roadmap.md` §V2.
Branch target: NEW `files-applet-v2` off master.

## 1. Goal

Make the files applet a complete replacement for three standalone
applets (image-viewer, html-viewer, markdown-viewer) and add the
first WRITE surface (markdown raw-text editor). Persistence is
extended so non-diff tabs survive reloads / session-switches and
viewer-mode survives reload too.

V2 ships **four** features behind one umbrella spec, implemented
serially as V2.a → V2.b → V2.c → V2.d:

- **V2.a ImageViewer** — port `applets/image-viewer/script.js`
  into a ViewerInstance.
- **V2.b HtmlViewer** — port `applets/html-viewer/script.js` into
  a ViewerInstance.
- **V2.c Card-schema bump** — persist `defaultViewerType` and
  `activeViewerType` so non-diff tabs survive reload and the
  user's toggled viewer mode survives reload.
- **V2.d MarkdownViewer view↔edit mode** — first write-capable
  viewer. Toggle between rendered view and raw-text editor;
  Save commits to disk via the existing `PUT /api/files/*path`
  endpoint.

The four parts are scope-independent in terms of design but
share the V1.1 class-level contract. Each part has its own plan
phase + commit; the spec covers all four to lock the contract
extensions before any code lands.

## 2. Use cases

| # | Story | V2 part |
|---|---|---|
| U1 | User picks `screenshot.png` via +. Tab opens as ImageViewer with zoom/pan controls. No viewer toggle button (only image viewer applies). | V2.a |
| U2 | User picks `report.html` via +. Tab opens as HtmlViewer (sandboxed iframe). The toggle button offers "→ Diff" (diff also handles HTML files). | V2.b |
| U3 | User picks `large.png` (binary). The diff viewer is not offered (`canHandle === false` for binaries) so toggle is hidden. | V2.a |
| U4 | User opens 3 tabs: README.md (markdown), src/foo.ts (diff), screenshot.png (image). Closes the browser tab, reopens. All 3 tabs reappear in the correct viewer mode. | V2.c |
| U5 | User toggles README.md from markdown view to diff view. Closes the applet, reopens. README.md tab is in diff view (not its default markdown view). | V2.c |
| U6 | User clicks "Edit" on a markdown tab. The rendered view swaps for a `<textarea>` containing the raw markdown. User edits, clicks "Save". File is written; toggle returns to view mode showing re-rendered content. | V2.d |
| U7 | User has unsaved edits in markdown editor. Clicks "View" mode-toggle. Confirm dialog: "Discard unsaved changes?". | V2.d |
| U8 | User has unsaved markdown edits. Closes the tab via X. Confirm dialog. | V2.d |
| U9 | Agent saves the markdown file externally while the user is in Edit mode. The watcher fires but DOES NOT overwrite the editor's textarea (would clobber unsaved input). A small "(file changed on disk)" indicator appears. | V2.d |

## 3. Non-goals (V2)

- No HtmlViewer write mode. HTML files are read-only in V2; the
  diff viewer remains the way to see HTML changes.
- No ImageViewer crop / annotation / paint. Read-only.
- No file picker for binary files separate from text files. The
  + button picker filters nothing; the picker is path-only.
- No multi-file save batch. Save is per-tab.
- No persistence of zoom/pan state on ImageViewer or of editor
  scroll position. Those are session-memory only.
- No conflict resolution when external edit happens during user
  edit. V2 ships a warning indicator only.
- No new keyboard shortcuts (Ctrl+S inside the editor is V2.d's
  only shortcut). Ctrl+P opens-finder defers to V3.

## 4. Design

### 4.0 V1.1 contract extensions

The V1.1 ViewerInstance contract (`docs/files-applet-v1.1.md`
§4.0.D) needs these additions:

#### 4.0.A `canHandle` may be content-type aware

V1.1's `canHandle(absPath, relPath)` decides by extension. V2
keeps the same signature but adds an extension-based binary
check inside DiffViewer:

```js
DiffViewer.canHandle = function(_abs, rel) {
  return !isBinaryExtension(rel);
};
function isBinaryExtension(rel) {
  return /\.(png|jpg|jpeg|gif|webp|svg|ico|pdf|zip|gz|tar|bin|exe|class|jar)$/i.test(rel || '');
}
```

Effect: opening a `.png` shows the image viewer with no toggle
(diff doesn't accept). HTML and markdown remain toggleable to
diff.

#### 4.0.B Viewer dirty-state hook (new)

To support unsaved-edit warnings (U7, U8), the ViewerInstance
contract gains an optional method:

```ts
interface ViewerInstance {
  // ... V1.1 methods unchanged
  /** Returns true if the viewer has unsaved changes that would
   *  be lost on destroy or switchViewer. Returning false (default
   *  for non-editor viewers) is fine. */
  isDirty?(): boolean;
}
```

`TabContainer.switchViewer` and `closeTab` consult `isDirty()`:

- `switchViewer(targetType)`: queries the OUTGOING (currently-
  active) viewer's `isDirty()`. If true, prompts; on cancel
  abort the switch.
- `closeTab(id)`: iterates EVERY constructed viewer in the
  container (not just the active one — a markdown viewer
  toggled-away-from could still be dirty) and prompts if ANY
  returns true. The user dismisses one prompt that covers all
  viewers of the closing tab.

V2 uses `window.confirm()` for the prompt — a blocking modal,
acceptable for now; replaced by a styled modal in V3.

**Unsaved markdown edits on:**
- **Session-switch** — V2.d does NOT prompt; the spec §7.5
  defers to V3 (acceptable because session-switch is user-
  initiated and the model is "edit is a convenience").
- **Browser tab close / reload** — V2.d installs a
  `beforeunload` handler that queries every container for
  `isDirty()` and triggers the native browser confirm if any
  returns true. The 5-line addition prevents silent loss on
  Ctrl+R / browser-close.

#### 4.0.C Viewer mode (intra-viewer state, new)

A viewer may declare an internal **mode**, exposed via:

```ts
interface ViewerInstance {
  // ...
  /** Optional. Lists modes this viewer supports for the floating
   *  mode-toggle row. Returns null/undefined if the viewer has no
   *  modes (the default). The shell renders a separate mode
   *  toggle BUTTON beside the viewer-type toggle. */
  getModes?(): { id: string; label: string }[] | null;
  /** Optional. Currently-active mode id from getModes(). */
  getActiveMode?(): string | null;
  /** Optional. Switch internal mode. Synchronous. Implementation
   *  may set isDirty pre-state; the shell does NOT prompt for
   *  mode changes (the viewer's own logic owns that — e.g.
   *  MarkdownViewer's Edit→View prompts internally if dirty). */
  setMode?(modeId: string): void;
}
```

Default behavior: viewers without these methods have no mode
toggle. MarkdownViewer in V2.d will declare two modes:
`{ id: 'view', label: 'View' }`, `{ id: 'edit', label: 'Edit' }`.

The shell renders a mode-toggle DOM scoped to the active
viewer's modes:

- **One mode-toggle button per TabContainer.** Created lazily
  on the first activate of a viewer whose `getModes()` returns
  ≥2 entries. The shell calls `updateModeToggle()` after every
  `switchViewer` to (a) hide if the new viewer has no modes
  and (b) re-label if it does.
- **Save button** stacked BELOW the mode toggle (not between
  it and the viewer-type toggle). Position: `top: 72px` when
  visible, hidden via `[hidden]` attribute when
  `isDirty() === false`. The position math in §4.4.3 reflects
  this BELOW layout authoritatively (resolves review I4
  ambiguity).
- Class hooks on `contentEl`: `.has-modes` (mode toggle
  visible), `.is-dirty` (save button visible). The CSS in
  §4.4.3 reserves the top:72px slot only when `.has-modes` is
  set; for tabs without modes (diff, image, html) the
  viewer-type toggle stays at top:8px with no gap injected.

#### 4.0.D Save action hook (new)

For viewers with an editable mode:

```ts
interface ViewerInstance {
  // ...
  /** Optional. If declared, the shell renders a "Save" button
   *  adjacent to the mode toggle when isDirty() is true. Returns
   *  a Promise that resolves on success or rejects with an
   *  `Error` instance whose `.message` is the surface text. */
  save?(): Promise<void>;
}
```

The Save button:
- Hidden when `isDirty()` returns false.
- Disabled (with spinner) during the save Promise.
- On reject: rendered inline in `contentEl` via the per-tab
  error surface (§7.3 option B).

### 4.1 ImageViewer (V2.a)

```ts
class ImageViewer implements ViewerInstance {
  readonly viewerType = 'image';
  readonly contentEl: HTMLElement;
  // ... watcher, zoom/pan state
}

ImageViewer.canHandle = (_a, rel) =>
  /\.(png|jpg|jpeg|gif|webp|svg|ico)$/i.test(rel || '');
ImageViewer.isDefault = ImageViewer.canHandle;  // same
```

Implementation follows the existing `applets/image-viewer/
script.js` (zoom levels [1..6], pan via mousedown drag, reset on
new image). The class:

- Constructor builds detached `contentEl` with `display:none`.
  Contains an `<img>` element + minimal zoom-label HUD.
- `load()`: sets `img.src = '/api/file?path=' + encodeURIComponent
  (this.absPath) + '&t=' + Date.now()` (cache-bust for live re-render).
  AbortController-guarded.
- `MarkdownViewer.open`-style factory: acquire watcher first
  (so a write during initial fetch isn't lost), wire onChange to
  `load()`, then load and attach. **On watcher acquire failure
  the factory rejects** (per spec §4.0 contract): the picker
  surfaces a toast; cards rehydrate skips the failed card.
- `destroy()`: idempotent, sets `destroyed=true`, abort fetch,
  close watcher, detach DOM, null fields.
- `echoState()` returns `{ kind: 'image', path, loaded, zoom }`.

**Required shell change: `openOrUpdateTab` refactor** (resolves
review B2). V1.1's `openOrUpdateTab` hard-codes a diff-default
container at `script.js:1102-1118`. V2.a rewrites it to:

1. Look up `desc = defaultViewer(absPath, relPath)` instead of
   hard-coding diff.
2. For diff-default paths the synchronous V1.1 path is preserved
   (`DiffViewer.fromEdit(shell, container, edit)`) — the `edit`
   payload is fresh from the poller and avoids a redundant
   fetch.
3. For non-diff defaults (image, html, markdown), call the
   descriptor's `open()` factory (async). The `edit` payload is
   discarded — only the path matters. The new tab opens with
   the file's content fetched fresh by the factory.
4. Dismissed-snapshot recording at `script.js:1177-1188`
   widens: image/html closes record a path-only entry (no diff
   to snapshot), same as today's markdown-default branch.

Without this refactor V2.a would regress: every `caco.edit`
for a `.png` would still build a diff-default container whose
`DiffViewer.canHandle` is now false, leaving the toggle hidden
and showing a binary-diff card with no escape.

### 4.2 HtmlViewer (V2.b)

```ts
class HtmlViewer implements ViewerInstance {
  readonly viewerType = 'html';
  readonly contentEl: HTMLElement;
  // ... iframe ref, watcher
}

HtmlViewer.canHandle = (_a, rel) => /\.html?$/i.test(rel || '');
HtmlViewer.isDefault = HtmlViewer.canHandle;
```

Implementation follows the existing `applets/html-viewer/
script.js`:

- Constructor builds detached `contentEl` containing a
  `<iframe class="files-html-frame" sandbox="allow-scripts">`.
- `load()` does `iframe.src = '/api/file?path=' + encodeURIComponent
  (this.absPath) + '&t=' + Date.now()`. The cache-bust query
  string forces the iframe to re-fetch on watcher events. No
  body fetch; the iframe handles the GET itself with CSP from
  the existing `/api/file` handler (api.ts:414-417 already sets
  CSP for `.html`).
- Watcher acquired first, then load(), per V1.1 pattern.
  On watcher acquire failure the factory rejects (same as §4.1).
- `destroy()`: idempotent, close watcher, detach DOM.
- `echoState()` returns `{ kind: 'html', path, loaded }`.

HtmlViewer applies to `.html` and `.htm`. `DiffViewer.canHandle`
returns true for both (HTML is not in §4.0.A's binary list), so
the toggle button is available on html tabs.

V2.b inherits the `openOrUpdateTab` refactor from V2.a (the
refactor is part of V2.a; V2.b just registers an additional
descriptor).

### 4.3 Persistence schema bump (V2.c)

#### 4.3.0 Today's wire shape (V1 / V1.1)

`buildPersistBody` in V1/V1.1:
```js
{ schemaVersion: 1, cards: [{ relativePath, collapsed: false }, ...], dismissed: [] }
```

The endpoint stores this as-is. V1.1 filters to diff-default
tabs so only diff cards persist.

#### 4.3.1 New shape (V2)

```js
{
  schemaVersion: 2,
  cards: [
    {
      relativePath,
      defaultViewerType: 'diff'|'markdown'|'image'|'html',
      activeViewerType: 'diff'|'markdown'|'image'|'html', // optional; defaults to defaultViewerType
      collapsed: false,
    },
    ...
  ],
  dismissed: [],
}
```

`schemaVersion: 2` is the trigger. Server-side: `src/routes/
file-edits.ts` accepts both v1 and v2 schemas (PUT is opaque
storage). Client-side: when loading, if `schemaVersion === 1`,
treat every card as `defaultViewerType: 'diff', activeViewerType:
'diff'`. When loading v2, honor the fields directly.

`buildPersistBody` in V2 emits v2 schema for ALL tabs (not just
diff). Every TabContainer is persisted with its
`defaultViewerType` and `activeViewerType`. The previous
"only persist diff-default" filter is removed.

#### 4.3.2 Cards rehydrate (V2)

`initFromPersistence` builds a TabContainer for each card:
1. Look up descriptor by `defaultViewerType`.
2. Construct TabContainer with that descriptor.
3. **INSERT the container into `tabs` synchronously**, set
   `container.rehydrating = true`, attach `tabEl` and
   `contentEl` to the DOM. The tab button is rendered
   immediately but its content pane shows a small "Loading…"
   placeholder until the factory resolves.
4. Spawn the per-card factory: for diff this uses
   `DiffViewer.fromEdit(placeholder)` synchronously; for
   markdown/image/html it uses each viewer's full `open()`
   factory (which needs to fetch the file).
5. If `activeViewerType !== defaultViewerType`: **await** the
   default factory first, THEN call `container.switchViewer
   (activeViewerType)` (which lazy-constructs the secondary
   viewer). The two factories MUST sequence (resolves review
   I1's second paragraph); they cannot race.
6. On factory resolution: clear `rehydrating`; if the user
   was clicking the loading tab, `activate()` is called
   defensively at that point.
7. **Failed rehydrate**: log + drop the container. Specifically:
   `tabs.delete(container.id); container.destroy();`. The next
   `schedulePersist` fires and the failed card is naturally
   absent from the new persisted snapshot. The user gets back
   the tab only by manually re-opening (or by a `caco.edit`
   for that path if it ever returns to the dirty list). This
   matches V1 behavior — "persist whatever's currently in
   `tabs`" (resolves review I5).

Cards rehydrate is now asynchronous per-card. The user sees tabs
appear progressively. The `rehydrating` flag also gates the
caco.edit race covered in §7.4.

**User-clicks-rehydrating-tab race** (resolves I1): when the
user clicks a rehydrating tab, `setActiveTab(id)` runs and
`container.activate()` looks up `viewers.get(activeViewerType)`
which returns undefined. The activate is a no-op; the user
sees the "Loading…" placeholder. On factory resolution, the
viewer's `activate()` is called only if `activeTabId ===
container.id`, otherwise the viewer stays mounted-inactive (its
contentEl was set to display:none in the constructor; the
"Loading…" placeholder remains visible until factory resolves
AND the tab is the active one).

#### 4.3.3 Server-side migration

`src/routes/file-edits.ts` does not need a code change. The
PUT handler stores opaque JSON; the GET handler returns opaque
JSON. Schema is a client-side concept. The endpoint's stored
`schemaVersion` will increment as users save new state.

`src/file-edits-store.ts` (if it validates) needs to accept
both v1 and v2. If it has type definitions for the body, those
must be extended. Reviewed during implementation.

### 4.4 MarkdownViewer view↔edit mode (V2.d)

MarkdownViewer gains two modes:
- `view` (default): the existing rendered markdown.
- `edit`: a `<textarea>` containing the raw file content.

```ts
class MarkdownViewer implements ViewerInstance {
  // V1.1 fields
  // V2 additions:
  private mode: 'view' | 'edit' = 'view';
  private _viewEl: HTMLElement;  // .md-rendered (V1.1)
  private _editEl: HTMLTextAreaElement;
  private _diskText: string;        // last loaded-from-disk content
  private _editorText: string;      // current textarea value (mirror)
  private _diskChangedWhileEditing = false;

  getModes() { return [
    { id: 'view', label: 'View' },
    { id: 'edit', label: 'Edit' },
  ]; }
  getActiveMode() { return this.mode; }
  setMode(m) { ... }
  isDirty() { return this.mode === 'edit' && this._editorText !== this._diskText; }
  save() { ... }
}
```

#### 4.4.1 Edit mode mechanics

- `setMode('edit')` swaps the visible child: `_viewEl.style.
  display = 'none'; _editEl.style.display = ''; _editEl.value =
  _diskText; _editorText = _diskText; _editEl.focus();`
  The shell renders a Save button (per §4.0.D) when isDirty.
- `setMode('view')` from edit:
  - If `isDirty() && !confirm('Discard unsaved changes?')`: bail.
  - Else: swap visible child back; `_editorText = _diskText`;
    `_editEl.value = _diskText` (reset).
- `save()` (resolves review I2 — order matters):
  - Snapshot `pendingText = _editorText` (the user's current
    content) BEFORE the PUT. Snapshot `priorDisk = _diskText` in
    case we need to revert on failure.
  - `PUT /api/files/<absPath>` with `pendingText` as body,
    `Content-Type: text/plain`.
  - On success: `_diskText = pendingText` (the value WE just
    wrote — NOT the live `_editorText`, which may have moved on
    during the PUT). Clear `_diskChangedWhileEditing` ONLY IF
    no concurrent watcher event has set it for a DIFFERENT
    content since save started (track via a `_saveInFlight`
    flag — see below). `shell.echoState()`.
  - On failure: `_diskText = priorDisk` (restore the exact
    prior value). The Promise rejects with `new Error(message)`;
    the shell renders the message in the per-tab error surface
    (§7.3 option B). `isDirty()` stays true so the user can
    retry.
  - `_saveInFlight = true` is set at the top of save() and
    cleared in finally. The watcher's edit-mode branch in
    §4.4.2 checks this flag: when an event arrives during a
    save in flight, it suppresses `_diskChangedWhileEditing`
    until the save resolves (the watcher event is likely our
    own write).

#### 4.4.2 External-edit-during-edit (U9)

The MarkdownViewer's watcher fires on every disk change. The
load() pipeline is split into two stages (resolves review N7):

- `_fetchDisk()`: async, returns the file text. Used in both
  modes.
- `_renderToDom(text)`: synchronous, mutates the rendered DOM.
  Used only in view mode.

In **view mode**: load() = await fetch; if destroyed bail;
_renderToDom(text); _diskText = text; echoState.

In **edit mode**: load() = await fetch; if destroyed bail;
- If `_saveInFlight === true`: suppress (this is likely our own
  write completing); do NOT update `_diskChangedWhileEditing`.
- If `text === _diskText`: no-op (no actual change).
- Else: `_diskChangedWhileEditing = true`. Surface via the
  small "⚠ disk changed since edit started" indicator inside
  the contentEl, near the Save button.

**Escape hatches when "(disk changed)" appears** (resolves I8):

1. **Save** — overwrites disk with editor content. User's
   in-progress edits win.
2. **Discard via View toggle** — confirm dialog; on accept,
   re-fetch and discard editor content.
3. **Preserve both** — manually copy editor content to an
   external editor / clipboard, THEN toggle to View. The user
   can then merge externally. Document this in the V2.d
   release note so users know the workaround.

V2 does NOT auto-merge or 3-way diff. The indicator + escape
hatches are the entire conflict-handling UX.

#### 4.4.3 Mode-toggle DOM and CSS

A second floating button row, below the viewer-type toggle:
- Mode toggle: `<button class="files-mode-toggle">` with label
  `"→ View"` or `"→ Edit"`.
- Save button: `<button class="files-save-btn" hidden>Save</button>`.
- Both anchored top-right, stacked vertically. The Save button
  appears between the viewer-type toggle and the mode toggle
  when isDirty.

Position math: viewer-type toggle at `top: 8px`. Mode toggle at
`top: 40px` (8 + 24 button height + 8 gap). Save at `top: 72px`
when visible. Right-aligned to 16px (clears scrollbar).

#### 4.4.4 Textarea CSS

```css
.files-md-content textarea.md-editor {
  width: 100%;
  height: 100%;
  border: none;
  background: var(--color-bg);
  color: var(--color-text);
  font-family: var(--font-mono);
  font-size: 14px;
  line-height: 1.5;
  padding: 16px 56px 16px 20px;
  resize: none;
  outline: none;
  box-sizing: border-box;
}
```

The textarea replaces (display-swap, not destroy) the rendered
view. Both subtrees live in `contentEl`.

#### 4.4.5 Ctrl+S keyboard shortcut

Edit-mode-only: textarea keydown handler intercepts Ctrl+S /
Cmd+S, preventDefault, calls `save()` if isDirty.

### 4.5 setAppletState envelope (additive)

The `files.tabs[]` entries gain `activeMode: string | null` and
`isDirty: boolean` fields populated from the viewer's
`getActiveMode()` (null if undefined) and `isDirty()` (false if
undefined). `isDirty` is always a boolean — never null — so
consumers can use it as a plain predicate (resolves review N6).
The legacy `fileEdits` envelope is unchanged.

## 5. Backend changes

### V2.a / V2.b — none

ImageViewer + HtmlViewer use existing `GET /api/file`. No new
endpoints.

### V2.c — one constant + two validator widenings

(Resolves review B1.) The current `PUT /api/sessions/:sid/file-edits/cards`
handler at `src/routes/file-edits.ts:144` rejects any body whose
`schemaVersion !== SCHEMA_VERSION` (`= 1` in
`src/file-edits-store.ts:26`). The route's `isCardPersist`
validator at `src/routes/file-edits.ts:166-170` also REQUIRES
`collapsed: boolean` per card. V2.c needs:

1. In `src/routes/file-edits.ts:144`, change the strict equality
   to a set check: `if (body.schemaVersion !== 1 && body.schemaVersion !== 2)`.
   This keeps the server version-tolerant during the rollout
   (a V1 client mid-deploy still writes v1; the server stores
   both shapes; rehydrate handles both).
2. In `src/routes/file-edits.ts:166-170` AND
   `src/file-edits-store.ts:66`, loosen `isCardPersist` to make
   `collapsed` optional AND accept new optional fields
   `defaultViewerType` and `activeViewerType`:
   ```ts
   function isCardPersist(v: unknown): v is CardPersist {
     if (!v || typeof v !== 'object') return false;
     const o = v as Record<string, unknown>;
     if (typeof o.relativePath !== 'string') return false;
     if (o.collapsed !== undefined && typeof o.collapsed !== 'boolean') return false;
     if (o.defaultViewerType !== undefined && typeof o.defaultViewerType !== 'string') return false;
     if (o.activeViewerType !== undefined && typeof o.activeViewerType !== 'string') return false;
     return true;
   }
   ```
3. Update `CardPersist` type in `src/file-edits-store.ts:28-31`
   to add the optional fields.

Storage shape on disk does not change beyond what the new fields
add; `setCardList` writes opaque JSON. No data migration.

### V2.d — uses existing `PUT /api/files/*path`

No new endpoint. Verify the PUT handles the markdown file paths
(both relative and absolute). It does — see `src/routes/api.ts:438`.

## 6. Migration / deprecation

The standalone `markdown-viewer`, `image-viewer`, `html-viewer`
applets stay in place through V2. V4 deprecates them with
redirect stubs.

`schemaVersion: 1` cards: handled by V2.c rehydrate as
"defaultViewerType: 'diff', activeViewerType: 'diff'". No
server-side migration. The first save after V2.c lands writes
schemaVersion: 2; rolling back to V1 client would see v2 cards
and… actually, V1's `loadPersistedCards` would still parse
the JSON and iterate `cards[]`, treating each as a diff
relativePath (the extra fields are ignored). Backward-compat
is therefore graceful **with one caveat**: v2 cards for binary
file types (image-default) would be treated by a V1 reader as
diff cards. The diff endpoint's `openFile` returns an `edit`
whose `isBinary: true` and `diff` is the synthetic "Binary
files differ" placeholder. The V1 client renders that. Not
elegant but no crash, no data loss. Document in V2.a / V2.c
release note.

**Inter-part ordering** (resolves review N8): the four V2 parts
are NOT fully scope-independent. V2.c (persistence schema bump)
hard-depends on V2.a + V2.b having registered their viewer
descriptors — rehydrating a card with
`defaultViewerType: 'image'` looks up the ImageViewer descriptor
which only exists once V2.a has shipped. Required ship order is
**V2.a → V2.b → V2.c → V2.d** (V2.d is independent and could
ship first, but the spec sequences it last so all features
benefit from the schema bump). Rolling back V2.a while keeping
V2.c WOULD crash on rehydrate of any image card.

## 7. Considerations

### 7.1 Why all four in V2 vs four point releases?

The four features share contract extensions (§4.0.A-D) that are
easier to land coherently. Splitting persistence (V2.c) from
the viewers that need it (V2.a, V2.b) would mean shipping two
viewers that DON'T persist, then bumping the schema and
re-shipping. The umbrella approach keeps the contract
extensions in one spec doc.

That said, **implementation IS serial**: V2.a → V2.b → V2.c → V2.d
with a commit per part. Each part can roll back independently.

### 7.2 ImageViewer + DiffViewer toggle: should diff handle binaries?

No. `DiffViewer.canHandle` now returns false for binary
extensions. The diff endpoint can technically return a "binary
file changed" placeholder, but users don't want to TOGGLE to
that — they want the image. Hiding the toggle prevents the
useless flip.

Side-effect: a `.png` that's tracked in git no longer auto-opens
as a diff tab on `caco.edit`. The poller emits the edit, but
`openOrUpdateTab` calls `defaultViewer(abs, rel)` which now
returns ImageViewer for `.png`. The tab opens as an image. This
is correct behavior (user wants to see the new image), but it
means binary file changes get a tab where they didn't before in
V1.

Mitigation: that's the desired UX. The follow-edits jump still
works to image tabs (same lastEditedTabId mechanism). Document
in V2.a release note.

### 7.3 Save errors — where do they surface?

Two options:
- A: throw via `appletAPI.toast` (existing Caco mechanism).
- B: inline error message in the TabContainer's content pane.

V2 picks B for save errors specifically because the error
context (which file, what message) belongs near the affected
tab, not floating across the app. Implementation: a small
`<div class="files-save-error" hidden>` element inside
`contentEl`, populated by the shell when `save()` rejects.
Auto-dismissed on next successful save or mode-change.

`appletAPI.toast` remains the mechanism for non-tab-specific
errors (e.g. failed cards persist, watcher acquire failure).

### 7.4 Cards rehydrate is now async — race hazards

V1.1 rehydrate was synchronous (placeholder DiffViewers). V2.c
rehydrate is async (each card's full viewer factory runs). New
hazards:
- User opens applet, immediately switches sessions before
  rehydrate finishes. The pending per-card factories see
  `shell.sessionId !== openSessionId` and bail.
- Two simultaneous loads of the same applet instance: prevented
  by Caco runtime (one applet instance per session at a time).
- `caco.edit` arrives during rehydrate. The `openOrUpdateTab`
  flow finds the container if it exists (no-op or update),
  else creates a diff-default. The async-rehydrate-then-caco-
  edit race could create a duplicate. Mitigation: rehydrate
  registers the container in `tabs` SYNCHRONOUSLY before
  starting the factory; the factory then awaits and on success
  finishes attaching contentEl. Until then, `openOrUpdateTab`
  finds the container, sees `activeDiffViewer === null`, and
  bails (correct: there's no diff to update, the rehydrate
  factory will catch up).

Specifically: during rehydrate, INSERT into `tabs` synchronously
with the container; mark container `rehydrating = true`; the
async factory completes by clearing the flag. `closeTab`
during rehydrate gracefully cancels (sets `destroyed = true`
on container; factory bails on next await).

### 7.5 Markdown edit mode unsaved-state on session-switch

V1.1 session-switch: capture-clear-destroy. Now any markdown
container in edit mode with isDirty() would lose changes
without prompt. Acceptable in V2 (a) because session-switch is
user-initiated and (b) because the V2 model is "edit is a
convenience for quick tweaks" — anything long-form belongs in
a real editor. Optional V2.d enhancement: prompt before
session-switch destroy if any container is dirty. Defer to V3.

### 7.6 Risks

| Risk | Mitigation |
|---|---|
| Schema bump corrupts existing user state | V1 cards still parse correctly under V2 reader; V2 cards have extra fields V1 reader ignores. Tested in V2.c implementation. |
| Image hot-reload thrashes on rapid saves | Watcher already coalesces at 150ms server-side. Cache-bust query string doesn't suppress the browser's natural request batching. |
| Iframe sandbox + cache-bust on every watcher event: iframe full reload steals user focus / scroll | Existing html-viewer applet has the same behavior; users tolerate it. Mitigation deferred. |
| Markdown editor accidentally saved during session-switch tearing down the tab | Save Promise resolves/rejects regardless of destroy. If destroy runs mid-save, the file is written but the UI state is gone — acceptable (the file IS the result). |
| isDirty prompt for switchViewer creates user-hostile interruption | The prompt happens only on user-initiated viewer toggle (clicking the floating button), not on programmatic switches (cards rehydrate). |
| Binary-file toggle change breaks user expectation | Documented in V2.a release notes. Diff-of-binary-file is rare; for the few users who need it, V3 may add a config toggle. |

### 7.7 Open questions (with answers)

1. **Should images persist their zoom across reload?** No, V2.
   Zoom is session-scoped.
2. **What does the picker show for binary files?** Same as
   today (path listing). Filtering is V3 (finder).
3. **Edit-mode save: per-keystroke autosave or explicit Save?**
   Explicit. V2 ships Ctrl+S + Save button. Autosave is a
   separate feature (V3+).
4. **Mode-toggle position vs viewer-type-toggle position:**
   Stacked vertically, viewer-type on top. Both top-right.
5. **What about the diff-of-an-image case (someone added a
   PNG)?** The poller still emits `caco.edit` for it; the
   `openOrUpdateTab` flow now routes through `defaultViewer`
   which picks ImageViewer. The user sees the new image. The
   git status (added/modified) is visible on the tab strip
   only via the tab icon (◇ vs ¶ — could add a small status
   dot in V3).
6. **Tab label dirty indicator?** No. V2 does NOT add a `*` or
   `●` prefix to the tab label on dirty. The Save button + the
   `isDirty: true` field in setAppletState are sufficient
   surfaces. Deferred to V3 if user feedback wants it.
7. **SVG treated as binary?** Yes. SVG is XML but its diff is
   line-by-line noise. ImageViewer renders SVG fine; users who
   want the diff of SVG sources can use a real editor. Pinned
   in §4.0.A.
8. **`collapsed` vestigial field?** Kept in the V2 writer for
   zero churn (resolves review N1 option: "keep it"). The new
   `isCardPersist` validator makes it optional so future writers
   can drop it without breaking older servers.

## 8. Acceptance

V2 ships when ALL of these hold (per-part subsets gate per-part
commits):

### V2.a
- [ ] Open a `.png` via +: ImageViewer tab opens, zoom/pan work.
- [ ] No viewer toggle button visible on the image tab (only
      image canHandles).
- [ ] Saving the image externally re-renders within 1s.
- [ ] Close → reopen the same applet (no V2.c yet): markdown +
      diff tabs persist as before; image tab does NOT persist
      (V2.a alone keeps the V1.1 persistence behavior).
- [ ] `npm run build` passes.

### V2.b
- [ ] Open a `.html` via +: HtmlViewer tab opens, iframe loads.
- [ ] Toggle button visible: "→ Diff" (diff canHandles HTML).
      Clicking toggles to diff card.
- [ ] External edit triggers iframe reload.
- [ ] `npm run build` passes.

### V2.c
- [ ] Open 4 tabs: README.md, src/foo.ts, screenshot.png, report.html.
- [ ] Close the applet (or browser tab), reopen. All 4 tabs
      reappear in their respective viewers.
- [ ] Toggle README.md to diff. Close, reopen. README.md is in
      diff view.
- [ ] V1 cards JSON (schemaVersion 1) on disk: parsed
      correctly, all tabs come up as diff.
- [ ] `npm run build` passes.

### V2.d
- [ ] Open README.md. Mode toggle "→ Edit" visible top-right
      (below viewer-type toggle).
- [ ] Click → textarea appears with raw markdown. Save button
      hidden (not dirty).
- [ ] Type → Save button appears. Click → file written, button
      hides, mode-toggle still in Edit.
- [ ] Ctrl+S from inside the textarea saves.
- [ ] Click View mode toggle while dirty → confirm dialog.
      Cancel → stay in edit. Confirm → discard → view mode shows
      original.
- [ ] Edit mode + external write to same file → small "(disk
      changed)" indicator near Save button.
- [ ] Close tab while dirty → confirm dialog.
- [ ] `npm run build` passes.

## 9. Roll-back

Each V2 part is its own commit on the V2 branch. Rolling back
a single part: `git revert <commit>` for that part. V2.c
rollback would leave V2.a + V2.b orphans (image / html tabs
that don't persist) — acceptable transient state but signals
to ship V2.c-fix or roll back further.

V2 → V1.1 full roll-back: revert the merge commit. No data
migration; client falls back to v1 schema reader naturally.

## 10. V3+ stubs (carry-forward)

Unchanged from roadmap §V3-V4: eviction policy,
open-from-chat routing, enhanced file finder, per-viewer
chrome decoration, rename to `files`, deprecate standalone
applets, global keyboard shortcuts, visual refresh.

V3 may also add: dirty-state prompt on session-switch (deferred
from V2.d per §7.5), autosave (deferred from §7.7 Q3).

## 11. Test plan

Manual acceptance per §8. No new unit tests (consistent with
V1, V1.1; no DOM tests for applet JS).
