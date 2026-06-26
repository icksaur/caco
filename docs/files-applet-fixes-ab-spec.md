# Spec: Files-applet fixes A (source edit) + B (tab flicker)

Status: implemented (gate green); pending visual signoff before commit. Two small,
independent fixes in `applets/files/`. Light.

---

## B. Stop tab flicker on edit bursts

### Problem
`caco.edit` batches many edits in `d.edits[]`. The handler (`script.js:3759-3769`)
does `forEach(openOrUpdateTab)`, and `openOrUpdateTab` calls `setActiveTab(...)` for
EVERY new/edited tab while `followEdits` is on (the async-factory path `script.js:1711`
and the diff follow-edits path `script.js:1768`). A 5-file burst → 5 synchronous
active-tab swaps → visible flicker.

### Fix (behavior-preserving for the FINAL visible state)
Select only on the LAST edit of a batch. Precise preservation contract: today every edit
calls `setActiveTab` (which activates/deactivates panes, scrolls the tab strip, persists,
echoes state — `script.js:1552-1596`) and the diff follow path also schedules
`scrollPaneToFirstDiffRow` (`~1765-1780`); the LAST edit's effects win visually. We
preserve exactly that final state by running the active-tab effects only for the last
edit, while keeping per-edit, non-selection side effects for ALL edits:
- KEEP for every edit: tab creation/append, `lastEditedTabId` update, the
  `schedulePersist()`/factory `echoState()` calls, and the viewer-local
  `if (isNew && dv3) dv3.scrollTop = 0;` (diff scroll INIT, not an active-tab action).
- SUPPRESS for non-last edits: `setActiveTab(container.id)` and the
  `scrollPaneToFirstDiffRow` rAF (active-tab visual actions only).

1. `openOrUpdateTab(edit, options)` already takes `options`. Add
   `options.suppressFollowSelect`. Guard the active-tab actions in BOTH follow paths:
   - `script.js:1711` (async-factory branch) →
     `if (followEdits && !options.suppressFollowSelect) setActiveTab(container.id);`
   - `script.js:1765-1780` (diff `else if (followEdits)` branch): keep the
     `dv3.scrollTop = 0` line; wrap `setActiveTab(container.id)` AND the following
     `scrollPaneToFirstDiffRow` rAF block in `if (!options.suppressFollowSelect) { ... }`.
   The `forceFocus` path (`script.js:1754`, explicit single action) and `updateOnly`/
   reopen callers pass their own `options` (no `suppressFollowSelect`) and are untouched.
2. In the `caco.edit` handler, concatenate `edits` + `cleanedEdits` (order preserved) and
   pass `suppressFollowSelect: i < last` so only the final edit runs the active-tab effects:
   ```js
   var all = [];
   if (Array.isArray(d.edits)) all = all.concat(d.edits);
   if (Array.isArray(d.cleanedEdits)) all = all.concat(d.cleanedEdits);
   all.forEach(function(e, i) {
     openOrUpdateTab(e, { suppressFollowSelect: i < all.length - 1 });
   });
   ```
   A single-edit batch is unchanged (`i < 0` false → it selects + scrolls).

### Acceptance
- Manual/visual: an agent edit touching 3+ files selects exactly one tab (the last),
  no flicker. Single-file edit still auto-focuses as before.
- No oracle test (DOM/event-timing UI behavior); rely on the gate + visual signoff.
  If feasible, a small unit over a pure helper is welcome but not required.

---

## A. Give source files an Edit button

### Problem
The mode-toggle button (`.files-mode-toggle`) shows only when the active viewer's
`getModes()` returns ≥2 modes (`TabContainer.updateModeToggle`, `script.js:615`).
`MarkdownViewer` returns `[view, edit]` and implements `getActiveMode/setMode/isDirty/
save` (`markdown-viewer.js:97-200`). `SourceViewer` (`source-viewer.js`, read-only
`<pre>`) implements NONE of these, so the button never appears for `.ts/.cpp/...`.
The `canEdit` capability (`script.js:3714/3824`) is unrelated — the gate is the mode
interface. `SourceViewer.echoState` also hardcodes `readOnly: true`.

### Fix — source-only edit, sharing just the `save()` URL helper
Scope (per review): add edit mode to `SourceViewer` directly, and extract ONLY the subtle,
genuinely-identical part — the `save()` disk write — into a shared helper. Do NOT migrate
MarkdownViewer to a full shared controller now (that's a separate phase needing
`getChromeButtons`/`echoState`/disk-indicator delegation); markdown keeps its structure and
just calls the shared write helper, a one-line, low-risk change.

1. New `applets/files/editable-text.js` exposing `window.__filesApplet.writeFileText(absPath, text)`
   — lifts the EXACT save URL builder + `PUT /api/files/<encoded-abspath>` from
   `markdown-viewer.js:160-175` (preserve the leading-slash handling for absolute vs
   relative paths verbatim). Returns the fetch result / throws on non-ok (caller maps the
   message). Sibling `*.js` load alphabetically BEFORE `script.js` (`applet-store.ts:235`),
   so `editable-text.js` is available to both viewers.
2. `MarkdownViewer.save()` swaps its inline URL build + `fetch` for
   `window.__filesApplet.writeFileText(this.absPath, pendingText)`. Snapshot/restore-on-
   failure and `_diskText` pinning stay exactly as-is. No other markdown change.
3. `SourceViewer` gains edit mode mirroring markdown's shape, self-contained (its own
   `_readOnly/mode/_diskText/_editorText/_saveInFlight/_diskChangedWhileEditing`):
   - thread `opts` through `SourceViewer.open` (`source-viewer.js:154` drops it) + the
     constructor; set `this._readOnly = !!(opts && opts.readOnly)`.
   - constructor builds the existing `<pre>` (view) PLUS a hidden
     `<textarea class="fe-source-editor">` (edit), with `input` + Ctrl-S handlers like
     markdown (`markdown-viewer.js:78-90`).
   - implement `getModes` (`[view]` if `_readOnly`, else `[view, edit]`), `getActiveMode`,
     `setMode` (swap `<pre>`↔textarea; on view re-run the hljs highlight via the existing
     `load()`/highlight path so saved text re-renders highlighted; prompt on dirty→view
     like markdown), `isDirty`, and `save()` (→ `writeFileText`, snapshot/restore like
     markdown). Add `getChromeButtons()` (Save button gated on `isDirty`/`_saveInFlight`)
     and a disk-changed indicator, mirroring markdown's own (`markdown-viewer.js:264-291`).
   - `echoState` returns `readOnly: this._readOnly` (not hardcoded) + the active mode/dirty,
     so chrome reflects edit state.
4. CSS: add `.fe-source-editor` styling parallel to `.md-editor` (`style.css:724-739`);
   the existing source `<pre>` styling (`~833-858`) is untouched.

### readOnly source of truth
Today nothing passes `opts.readOnly` to source files, so they default editable — which is
the desired fix (code files become editable). `_readOnly` is plumbed now so a future
read-only signal (e.g. external/out-of-cwd files, or a capability) can disable edit without
more changes; absent that signal, source files are editable.

### Deferred (separate phase, not this spec)
Migrating MarkdownViewer onto a shared editable-text CONTROLLER (mode state + textarea +
chrome + disk indicator, not just the write helper). Tracked for later to fully remove the
parallel mode logic; out of scope for this light change.

### Acceptance
- Visual: open a `.ts`/`.cpp` file → "→ Edit" toggle appears; edit + Ctrl-S/Save writes
  to disk; toggling back re-highlights; read-only files show no Edit. Markdown editing
  unchanged.
- Gate green. Mandatory visual signoff (UI change) before commit.
- Oracle (if helper is pure enough): a unit asserting `EditableText.save()` builds the
  correct `/api/files//abs/path` URL for absolute + relative paths (the subtle bit).

---

## Plan
1. **B** first (smallest, de-risks nothing else): add `suppressFollowSelect`, rewrite the
   `caco.edit` handler. Visual-check a multi-file edit.
2. **A**: extract `editable-text.js`; migrate markdown; add edit mode to source; load
   order; `readOnly` plumbing. Visual-check both viewers.
3. `npm run build`; visual signoff; then commit.
