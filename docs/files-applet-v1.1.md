# Files applet V1.1 — per-tab viewer toggle

Status: draft.
Predecessor: `docs/files-applet-v1.md` (shipped on branch
`files-applet-v1`, merged into master pending).
Branch target: NEW `files-applet-v1.1` off the V1 branch (or off
master once V1 is merged).

## 1. Goal

Replace the V1 chevron sub-menu next-to-`+` mechanism with a
**per-tab viewer toggle** floating in the top-right corner of the
content pane. The toggle appears only on tabs whose type has more
than one registered viewer for the same file. In V1.1, only
markdown qualifies (markdown-view vs diff-view); the toggle is
invisible on diff tabs of non-markdown files.

The + button's behavior simplifies: it always opens the "default
viewer for this file" — no chevron, no type override at open time.
The user changes viewers AFTER open via the floating toggle.

## 2. Use cases

| # | Story |
|---|---|
| U1 | User picks `README.md` via +. Tab opens as markdown view (rendered). A floating "⇄ Diff" button appears top-right of the content area. |
| U2 | User clicks the toggle. The same tab's content switches to diff view (the file's git diff). Button label flips to "⇄ Markdown". |
| U3 | User clicks again. Back to markdown view. State (scroll, selection, etc.) is preserved per viewer instance to the extent natural for each. |
| U4 | User picks `src/foo.ts` via +. Tab opens as diff view. No toggle button appears (this file type has only one registered viewer). |
| U5 | A `caco.edit` arrives for the open markdown tab. If the user is currently in markdown view, the rendered content re-loads. If in diff view, the diff card updates. Either way the toggle button stays put. |
| U6 | User closes the tab (X or middle-click). Both viewers' resources are released. The dismissed-path snapshot (V1 feature) records whichever viewer was active. |

## 3. Non-goals (V1.1)

- No persistence of viewer-mode across sessions; on session-switch the tab rehydrates in its default viewer.
- No keyboard shortcut for the toggle (could be added in V2).
- No "preview multiple at once" (split view). Strictly one viewer at a time per tab.
- The V1 chevron menu (`#feOpenMenu` + `_pinnedType` + `buildOpenMenu`) **IS removed** in V1.1; the toggle replaces it. (Spec §4.1 + plan Step 5 cover the deletion.)
- No new tab types; just the toggle.

## 4. Design

### 4.0 Architecture changes from V1

The V1 spec §4.0 ownership / lifecycle / invariants stay in force.
The deltas are:

#### 4.0.A Tab-type → viewer-type split

V1 conflated "tab type" with "viewer type": a tab WAS a DiffTab
or a MarkdownTab. V1.1 splits this:

- **Tab** (the thing in the tab strip + pane) is now a thin
  container that holds a path and one **active viewer** at a time.
- **Viewer** is what V1 called "tab type": DiffTab and MarkdownTab
  become DiffViewer and MarkdownViewer, each implementing
  ViewerInstance (formerly TabInstance) over a path.
- **TabContainer** owns the tabEl + per-tab `contentEl`, holds a
  `Map<viewerType, ViewerInstance>` of constructed viewers (lazy:
  only the first activated viewer is constructed; the toggle
  lazy-constructs the second).

The shell tracks `tabs: Map<tabId, TabContainer>`. Each
TabContainer has `activeViewerType: string` and a
`viewers: Map<viewerType, ViewerInstance>`.

Tab id stays `relativePath` for diff-default tabs and
`markdown:absPath` for markdown-default tabs (matches V1 cards
endpoint and avoids invalidating the existing persistence shape).

#### 4.0.B Viewer registry

```ts
// Replaces V1's tabTypes registry.
interface ViewerDescriptor {
  viewerType: 'diff' | 'markdown';
  label: string;                          // shown on toggle button
  canHandle(absPath, relPath): boolean;  // does this viewer apply to this path?
  isDefault(absPath, relPath): boolean;  // is this the default viewer for this path?
  open(shell, container, absPath, relPath): Promise<ViewerInstance>;
}
```

The shell holds `viewers: ViewerDescriptor[]`. Open path:
1. + button picks a file, computes (absPath, relPath).
2. Shell asks each registered viewer `isDefault(abs, rel)`. First
   one wins; if none, falls back to first `canHandle === true`;
   if still none, log and return.
3. The chosen viewer's `open` constructs the ViewerInstance and
   the shell creates a TabContainer wrapping it.

For V1.1's two viewers:
- MarkdownViewer.canHandle: `.md` / `.markdown` / `.mdx`.
- MarkdownViewer.isDefault: same as canHandle.
- DiffViewer.canHandle: every file (it can show a "no diff" state
  for clean files).
- DiffViewer.isDefault: every file that is NOT markdown.

A tab can switch between any viewers whose `canHandle` returns
true for its path. So markdown tabs can flip to diff (both
canHandle), but diff tabs of non-markdown files have nothing to
flip to and the toggle button is hidden.

#### 4.0.C TabContainer

```ts
interface TabContainer {
  readonly id: string;
  readonly absPath: string;
  readonly relPath: string;
  readonly tabEl: HTMLElement;
  readonly contentEl: HTMLElement;     // parent for viewer contentEls
  activeViewerType: string;
  viewers: Map<string, ViewerInstance>;
  // Lifecycle methods are TabContainer's; viewers implement their own.
  activate(): void;
  deactivate(): void;
  destroy(): void;
  switchViewer(viewerType: string): Promise<void>;
  echoState(): unknown;
}
```

TabContainer.activate() calls the active viewer's activate (lazy-
constructing on first activation). TabContainer.destroy() iterates
all constructed viewers and destroys each, then detaches
contentEl + tabEl.

TabContainer.switchViewer:
1. Deactivate current viewer.
2. If the target viewer hasn't been constructed yet, run its
   `open()` factory. On rejection, log and bail — current viewer
   stays active (the deactivate in step 1 means contentEl is
   display:none briefly; restore by re-activating the original).
3. Activate the target viewer.
4. Update `activeViewerType`. Update the toggle button label.
5. shell.echoState() once.

Concurrency: a switch-in-progress flag on TabContainer prevents a
double-click on the toggle from launching two `open()`s in
parallel. If the user clicks toggle while a switch is in flight,
the second click is ignored.

#### 4.0.D ViewerInstance contract

Identical to V1's TabInstance contract (§4.0.4) but renamed for
clarity. The viewer no longer owns its tabEl (TabContainer does);
it owns only its content subtree (a child of TabContainer.contentEl):

```ts
interface ViewerInstance {
  readonly viewerType: string;
  readonly contentEl: HTMLElement;     // child of TabContainer.contentEl
  activate(): void;                    // sets contentEl.style.display = ''
  deactivate(): void;                  // sets contentEl.style.display = 'none'
  destroy(): void;                     // detach contentEl, abort fetches, close watchers
  update?(payload: unknown): void;     // tab-type-specific update method
  echoState?(): unknown;
}
```

The container's contentEl is a positioning root (`position: relative`)
that holds:
- 0..N viewer contentEls (only one visible at a time).
- The floating toggle button (position: absolute, top: 8px, right: 8px).

#### 4.0.E Toggle button DOM and scroll architecture

The toggle is a single `<button class="files-viewer-toggle">` per
TabContainer, created in TabContainer's constructor and appended
to `container.contentEl` (a sibling of the viewer contentEls).
Visibility:

- Hidden by default.
- Made visible if `availableViewers(absPath, relPath).length >= 2`.
- Label is `"→ " + otherViewer.label` where `otherViewer` is the
  one not currently active. With more than 2 viewers (future), the
  button becomes a small menu; V1.1 hard-codes the 2-viewer case.

The button is `position: absolute` inside `container.contentEl`,
anchored top-right.

**Scroll architecture (resolves B3 from review):** The toggle must
stay pinned to the **viewport** of the content area, not scroll
with the content. To make this work:

- `.fe-pane` (the outer pane in `content.html`) **loses** its
  `overflow-y: auto` — it becomes a fixed-height non-scrolling
  flex container that holds N `TabContainer.contentEl` siblings.
- `TabContainer.contentEl` is `position: relative; height: 100%;
  overflow: hidden` — its job is to be the absolute-positioning
  root for the toggle and to clip the viewer's content.
- **Each viewer's `contentEl` (a child of TabContainer's) is the
  vertical scroll container.** It gets `overflow-y: auto;
  height: 100%`.
  - For MarkdownViewer, `.files-md-content` adds `overflow-y: auto`.
  - For DiffViewer, `.fe-diff` gains `overflow-y: auto`.
- The toggle's `right: 8px` accounts for the viewer's scrollbar
  (small reserved gap; if a scrollbar gutter visibly intrudes,
  bump `right` to `16px`). The right-padding on
  `.files-md-content` (~40px) ensures markdown text never crosses
  under the button.

`.fe-pane`'s pre-V1.1 scroll handler that watches for user-driven
scroll (`pendingProgrammaticScroll`, follow-disable) **must move
to listen on the active DiffViewer's `contentEl`**. The plan
covers this in Step 3.5 / Step 6.

#### 4.0.F Ownership table (delta from V1)

| Instance | Lifetime | Owner |
|---|---|---|
| `viewers: ViewerDescriptor[]` (was V1's `tabTypes`) | One per applet load | Shell IIFE |
| `tabs: Map<tabId, TabContainer>` (was `tabs: Map<tabId, TabInstance>`) | One per applet load | Shell IIFE |
| A `TabContainer` instance | From routeOpen completion until closeTab | Shell |
| A `ViewerInstance` (DiffViewer or MarkdownViewer) | From first activation OR switchViewer until TabContainer.destroy | The owning TabContainer |
| TabContainer.contentEl (positioning root) | Same as TabContainer | TabContainer (constructor mounts into shell.paneEl; destroy detaches) |
| The toggle button | Same as TabContainer | TabContainer |
| A viewer's contentEl (child) | Same as the viewer | The viewer class |

#### 4.0.G Lifecycle additions

States (per viewer; per tab is unchanged from V1):

- **not-constructed:** the TabContainer has not yet called
  `descriptor.open` for this viewer type. The Map<viewerType,
  ViewerInstance> has no entry. Allowed transitions: switchViewer
  to this type → triggers `open` → moves to mounted-inactive.
- **mounted-inactive / active / destroyed:** as V1 §4.0.5.

Critical ordering rules added:

- Rule §4.0.5.9: TabContainer.switchViewer MUST deactivate the
  current viewer BEFORE awaiting the new viewer's `open()`. This
  preserves the §4.0.6 single-visible invariant during the switch.
- Rule §4.0.5.10: If `switchViewer`'s `open()` rejects, the
  container re-activates the original viewer (which is still
  constructed and mounted-inactive) before re-throwing.

#### 4.0.H Invariant additions

| Invariant | Why |
|---|---|
| At most one viewer per TabContainer has `contentEl.style.display !== 'none'` at any time. | Same as V1 §4.0.6 single-visible, scoped per-tab. |
| **TabContainer.contentEl has `style.display = 'none'` BEFORE it is attached to `shell.paneEl`.** Set in constructor. | Preserves V1's "no flash" guarantee for the outer-tab level. |
| **Every ViewerInstance.contentEl has `style.display = 'none'` BEFORE it is appended to `container.contentEl`.** Set in the viewer's constructor. | Two-level single-visible invariant. |
| `TabContainer.activeViewerType` is always a key in `viewers`. | `switchViewer` doesn't set activeViewerType until after the target's open() succeeds. |
| TabContainer.contentEl is `position: relative; overflow: hidden`. Its viewer-child contentEl is the scroll container. | Required for the absolutely-positioned toggle to anchor to the viewport (B3 of review). |
| The toggle button is visible iff `count(canHandle(path) for v in viewers) >= 2`. | UX rule §4.0.E. |
| When a viewer is constructed lazily via switchViewer, it does NOT inherit any state from the previously-active viewer. | Each viewer manages its own scroll/selection; sharing across types is incoherent. |
| **`TabContainer.destroy()` is called exactly once.** The container's own `destroyed` flag (set FIRST, before any teardown) is the idempotency guard, paralleling V1's per-viewer `destroyed` flag. | Resource safety. The shell's "delete from `tabs` before destroy" rule §4.0.5.2 is the outer guard; the flag is the inner. |

### 4.1 + button behavior (simplified)

Remove the V1 chevron menu DOM and its JS. The + button:
1. Opens the picker.
2. On selection, computes (absPath, relPath).
3. Shell's `defaultViewer(abs, rel)` picks the first
   `isDefault === true` (else first canHandle). Returns a
   ViewerDescriptor.
4. Shell calls `routeOpen(abs, rel, descriptor)` which constructs
   the TabContainer with `descriptor` as the initial viewer.

The chevron button (`#feOpenMenu`) is removed from content.html.
Its event handlers are removed from script.js. The
`buildOpenMenu` / `openMenuPopup` / `_pinnedType` flow goes away.

### 4.2 Toggle behavior

Wired in TabContainer:
- Click → call `this.switchViewer(otherType)` where `otherType` is
  the non-active member of the 2-viewer set.
- The button label updates to reflect the new "other" viewer
  after the switch completes.
- During the switch (between deactivate-old and activate-new),
  the button is disabled (`button.disabled = true`) to prevent
  re-click. Re-enabled on completion or rejection.

### 4.3 caco.edit dispatch (delta)

V1's handler iterates `tabs.values()` filtered to `t.type ===
'diff'`. V1.1: iterate `tabs.values()`; for each tab, ask the tab
"do you have a DiffViewer constructed and is its relPath this
edit's relPath?" — if yes, call `diffViewer.update(edit)`. This
update can run for the constructed-but-inactive DiffViewer of a
markdown tab — when the user toggles back to diff view, the
already-loaded diff card is current.

**Container lookup by relPath (resolves B2):** A markdown-default
tab for `README.md` has id `markdown:/abs/path/README.md`, but a
poller-driven `caco.edit` for the same file arrives keyed by the
bare relativePath `README.md`. Without dedup, the handler would
not find the existing markdown container and would create a
**second** tab (diff-default) for the same file — two tabs for
one file, violating the V1.1 split.

Resolution: shell adds `findContainerByRelPath(relPath)` that
scans `tabs.values()` for any container whose `container.relPath
=== relPath` (the relPath is canonical regardless of default
viewer). The `caco.edit` handler:
1. `existing = findContainerByRelPath(edit.relativePath)`.
2. If `existing`:
   - If `existing.viewers.has('diff')`: call its DiffViewer's
     `update(edit)` (works whether active or inactive).
   - Else (markdown-default tab, no diff viewer constructed):
     **do nothing**. The MarkdownViewer's own watcher keeps the
     rendered view current. Lazy-constructing a diff viewer just
     to update it would burn a network call and memory the user
     never asked for.
3. Else (no existing tab): proceed with V1's `openOrUpdateTab`
   behavior (creates a diff-default container if `dismissedPaths`
   doesn't suppress).

### 4.3.1 Cards rehydrate

V1's `initFromPersistence` calls `new DiffTab(shell, placeholder)`
for each persisted card. V1.1: create a **diff-default
TabContainer** keyed by `relativePath`; construct its DiffViewer
with the clean placeholder edit; append the container's DOM;
leave the container mounted-inactive. Subsequent `fetchSnapshot`
updates flow into the DiffViewer via the V1.1 caco.edit dispatch.

### 4.3.2 Agent-pushed state (`applyAgentState`)

V1 directly constructs `new DiffTab(shell, data.edit)` when no
tab exists for the agent's target. V1.1:
- **Existing container with DiffViewer:** set DiffViewer's
  `pendingSelection`, ensure container is active, schedule
  finalize.
- **Existing container WITHOUT DiffViewer (markdown-default, no
  prior toggle):** the agent is asking for a diff selection on a
  file currently viewed as markdown. Construct the DiffViewer
  via `MarkdownViewer.canHandle === true && DiffViewer.canHandle
  === true` (always true), set `pendingSelection`, toggle the
  container to diff view, schedule finalize.
- **No existing container:** create a **diff-default**
  TabContainer keyed by `targetTabId`, construct its DiffViewer
  from `data.edit`, set `pendingSelection`, append DOM, activate,
  schedule finalize.

### 4.4 Persistence (unchanged from V1)

`buildPersistBody` still filters to diff-default tabs only. The
viewer-mode flip is in-memory; reopening a tab from cards
rehydrate always starts in diff view (it was a diff-default tab to
begin with). Markdown tabs remain in-memory only.

This is acceptable: viewer-mode is a transient view setting, not
content. A future V1.2 may persist it as a per-tab field in the
cards schema.

### 4.5 setAppletState envelope (additive)

The `files.tabs[]` entries gain an `activeViewer: string` field.
The legacy `fileEdits` envelope is unchanged in shape (still uses
`SOURCE_ID`, still echoes the active diff tab's selection) but
the "active diff tab" now means: the active TabContainer **whose
active viewer is `'diff'`**. So a markdown-default tab toggled
to diff DOES participate in the legacy envelope; a markdown-
default tab in markdown view does not (legacy envelope reports
null selection — matches V1's null-selection-when-active-tab-
isn't-diff behaviour).

### 4.6 V3.5 selection-code adaptation (resolves B1)

V1 selection-code sites read `tab.paneEl`, `tab.selection`,
`tab.edit`, `tab.pendingSelection`, `tab.paintSelection()`,
`tab.scrollTop` directly on the map value. In V1.1 each of these
belongs to a DiffViewer, and the DiffViewer is reached via
`container.viewers.get('diff')`.

Adaptation strategy: shell adds a helper
```js
function activeDiffViewer(container) {
  if (!container) return null;
  if (container.activeViewerType !== 'diff') return null;
  return container.viewers.get('diff') || null;
}
```
Every site that previously did `var tab = activeTabId ? tabs.get
(activeTabId) : null; ... tab.paneEl ...` becomes:
```js
var container = activeTabId ? tabs.get(activeTabId) : null;
var diff = activeDiffViewer(container);
if (!diff) return;       // selection ops are diff-only
// ... use diff.paneEl, diff.selection, etc.
```

Sites affected (script.js — count from V1 implementation):
`renderedWorkLines`, `scrollPaneToLine`, `rangeFromEnvelope`,
`textFromEnvelope`, `handleSelectionChange`, gutter click,
Escape clear, `applyAgentState`, `scrollPaneToFirstDiffRow`,
`buildFileEditsLegacyState`. Each gets the `activeDiffViewer`
indirection. The plan enumerates them in Step 6.

The V1 `tab.paneEl` getter on DiffTab.prototype (which aliased
`contentEl`) MOVES to DiffViewer.prototype (renamed) and serves
the same purpose for code that holds a DiffViewer reference.

### 4.7 Dismissed-path key (resolves I5)

`dismissedPaths.add(...)` and `dismissedSnapshots.set(...)` in
closeTab MUST key by `container.relPath` (and snapshot from
`container.viewers.get('diff')?.edit`, only if that viewer was
constructed). Reasons:
- The poller's `caco.edit` arrives with `edit.relativePath`,
  which matches `container.relPath` (NOT `container.id` for
  markdown-default tabs).
- Markdown-default tabs whose DiffViewer was never constructed
  contribute **no** snapshot — re-opening them on the next poll
  is allowed (the tab was a markdown viewer, not a diff
  dismissal). The dismissedPaths Set still gets the relPath
  entry so the auto-open suppression engages; the absence of a
  snapshot in dismissedSnapshots is interpreted as
  "always-suppress until session-switch or status==='clean'".

### 4.8 Tab-click semantics (resolves I7)

V1 DiffTab's tab-button click handler called `shell.setFollowEdits
(false)`, `shell.badgeCounter.delete(relPath)`, `shell.
updateFollowButton()`, then `shell.setActiveTab(relPath)`. V1
MarkdownTab's click only did `shell.setActiveTab(this.id)`.

V1.1: TabContainer owns the tab button. The click handler:
1. Always: `shell.setActiveTab(container.id)`.
2. **Always:** disable follow-edits and clear the badge for
   `container.relPath`. Even a markdown-default container can
   receive `caco.edit` re-creations (suppressed via
   `dismissedPaths`), so the badge semantics apply uniformly.
   This is a small UX simplification from V1 (markdown tabs
   used to ignore follow-edits because they couldn't receive
   it; in V1.1, follow-edits is global to the strip).

## 5. Backend changes

None.

## 6. Migration / deprecation

V1.1 deletes:
- `applets/file-edits/content.html` line for `feOpenMenu` button.
- `applets/file-edits/script.js` blocks: `_pinnedType` variable,
  `buildOpenMenu` function, `openMenuBtn` click handler.
- CSS for `.fe-menu` / `.fe-menu-item` (still used by nobody else).

V1.1 renames:
- `tabTypes` → `viewers`
- `TabTypeDescriptor` interface mentions → `ViewerDescriptor`
- DiffTab class → DiffViewer (file renamed `diff-tab.js` →
  `diff-viewer.js`)
- MarkdownTab → MarkdownViewer (`markdown-tab.js` →
  `markdown-viewer.js`)
- `tab.type` → `tab.activeViewerType` (with a `type` getter for
  V1 cards-compat: returns `'diff'` for diff-default tabs so the
  existing `buildPersistBody` `t.type === 'diff'` filter keeps
  working without modification)

### Rename complications

Renaming the files changes the alphabetical concatenation order in
`src/applet-store.ts` (V1 ordered diff-tab.js → markdown-tab.js →
script.js). The new order `diff-viewer.js → markdown-viewer.js →
script.js` is identical alphabetically; safe.

Class renames break `window.__filesApplet.DiffTab` consumers. V1
has zero external consumers (the namespace is purely an internal
load-order workaround). Safe to rename within this file.

## 7. Considerations

### 7.1 Why per-tab toggle vs chevron menu

The chevron picks viewer at open time. The toggle picks viewer at
any time. Toggle wins:
- More intuitive (the user sees the file, then decides how).
- Doesn't pollute the picker UX with type questions.
- Scales naturally to N viewers (toggle becomes a menu when N>2).
- The picker just picks files; viewer choice is a property of the
  open tab, not of the open action.

The chevron has 0 of these properties.

### 7.2 Why floating button (vs in the tab strip / in the toolbar)

Three options considered:

- **A (chosen): floats top-right of content pane.** Mirrors VS
  Code's preview/source flip and Marked.app's modes. Immediate
  visual association with "what I'm seeing right now."
- **B: extra row of buttons in the toolbar.** Already crowded
  with Follow, +, repo name. Adds vertical pixels for a
  rarely-used control.
- **C: secondary control on the tab itself (small icon next to
  the X).** Visually noisy — the tab strip already has X +
  type-icon prefix.

A is chosen.

### 7.3 Risks

| Risk | Mitigation |
|---|---|
| The toggle button overlaps markdown content at the top-right (e.g. a heading or image). | Right-padding on `.files-md-content` (~40px) so content never crosses under the button. |
| Lazy viewer construction means switching to diff for the first time blocks on a network fetch — UI flash. | Show a small in-button spinner during the switch. The toggle is disabled during the await. |
| Two viewers of the same tab could double-subscribe to the same WatchHandle on the same path (each acquires its own lease). | Acceptable: V1.1's two viewers have different needs (markdown uses watchPath; diff uses caco.edit), so no double-acquire today. Note in spec; revisit if a future viewer also uses watchPath. |
| caco.edit arrival for a markdown tab in markdown-view mode causes diff view to silently update too — and when the user toggles, the agent's last edit is "already there", no animation. | Acceptable: this is the V1 behavior for the markdown-tab case (no diff viewer to update), now extended. The "already updated" feel is consistent and matches user expectation that the tab tracks the live file. |
| User clicks toggle rapidly during in-flight switch. | switchViewer's `switching` flag drops re-entries. Button is disabled during the await. |
| Constructed-but-inactive viewers consume memory (markdown text + render, diff card DOM). | Acceptable in V1.1. V2 can add an eviction policy ("destroy non-active viewer if memory pressure"). |

### 7.4 Open questions (with answers)

1. **When the user closes a tab, both viewers destroy. Should we
   destroy the inactive viewer eagerly on toggle-away?** No.
   Keeping it constructed avoids the re-construct cost on toggle-
   back. Memory is small (one diff card or one rendered markdown
   subtree).
2. **What about a tab opened via cards rehydrate — does it start
   with diff viewer constructed?** Yes (cards are diff-default).
   The markdown viewer is never constructed unless the user
   toggles toward it.
3. **What if a future viewer canHandle a path but the current
   viewers don't?** Out of scope for V1.1; the registry is fixed
   at 2 entries.
4. **Does the toggle persist `activeViewerType` across applet
   hide/show?** Yes, naturally — the TabContainer lives across
   visibility changes (only session-switch destroys).
5. **Toggle-back to MarkdownViewer after a diff-view interval
   (resolves N3 of review):** The MarkdownViewer keeps its
   `WatchHandle` open the whole time (acquired at open, closed at
   destroy). Watch events keep firing through the diff interval
   and call `load()` regardless of whether the markdown view is
   currently visible. So toggle-back from diff to markdown shows
   the live content. **Trust the watcher; no force-reload on
   `MarkdownViewer.activate()`.** If a future bug shows missed
   events, this becomes the natural place to add a defensive
   reload.

## 8. Acceptance

- [ ] V1 chevron button and its menu are gone from the DOM and from
      script.js.
- [ ] + button opens markdown files as MarkdownViewer (rendered).
- [ ] + button opens non-markdown files as DiffViewer (existing
      behavior, no toggle button visible).
- [ ] On a markdown tab, a toggle button appears top-right of the
      content area, labeled "→ Diff".
- [ ] Clicking it loads the diff view for the same path. Label
      flips to "→ Markdown". Re-click flips back. Switch latency
      is < 1s for typical files.
- [ ] During the switch, the button is disabled. Rapid clicks do
      not produce parallel `open()`s.
- [ ] A failed switch (network error on the lazy viewer's open)
      restores the prior viewer's activate state and logs the
      error.
- [ ] caco.edit for the markdown tab's path updates the (possibly
      inactive) DiffViewer. Toggling to diff view shows current
      content.
- [ ] Closing the tab destroys both viewers' resources (verified
      via watch-lease teardown ≤ 60s).
- [ ] Session switch destroys all tabs and their viewers; rehydrate
      builds diff-default tabs.
- [ ] `npm run build` passes.

## 9. Roll-back

Same as V1: revert the V1.1 commit(s). V1 chevron + open-as menu
are restored from the previous commit. No data migration.

## 10. V2+ stubs (carry-forward from V1)

Unchanged. V2 still adds preview/edit flip for text-editable
viewers (the toggle pattern from V1.1 is the natural home for
view ⇄ edit mode-flipping inside a single viewer type). V3 adds
image, html, finder. V4 renames the slug.

## 11. Test plan

Manual smoke per §8. No new unit tests (consistent with V1; no
DOM tests for applet JS).
