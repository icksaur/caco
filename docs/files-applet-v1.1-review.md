# Files applet V1.1 spec/plan review

## BLOCKER

### B1 — Selection/agent APIs still assume `tabs.get(id)` is a DiffTab

V1.1 changes `tabs` to `Map<tabId, TabContainer>`, but the plan does not define a complete compatibility layer or rewrite for the V3.5 selection path. Current `script.js` has many sites that read/write `tab.paneEl`, `tab.selection`, `tab.pendingSelection`, `tab.paintSelection()`, `tab.scrollTop`, `tab.edit`, and `tab.type === 'diff'` directly on the map value.

Examples include `buildFileEditsLegacyState`, `renderedWorkLines`, `scrollPaneToLine`, `rangeFromEnvelope`, `textFromEnvelope`, `handleSelectionChange`, gutter click handling, Escape clearing, `applyAgentState`, and `scrollPaneToFirstDiffRow`.

The plan's `TabContainer.type` getter is explicitly the default viewer type for persistence, not the active viewer type. That is not sufficient for interactive diff behavior. A markdown-default tab toggled to diff would still have default type `markdown`, so legacy selection echo would report null even while the active viewer is diff.

Recommendation: add an explicit `activeDiffViewer(container)` helper and rewrite selection/agent code to operate on the active DiffViewer only, or add TabContainer delegating getters/methods whose semantics are active-diff-only. Keep persistence on `defaultViewerType`, not `type` overloads.

### B2 — `caco.edit` handling can create a second tab for an already-open markdown file

Spec U5 says a `caco.edit` for an open markdown tab updates that tab's current/available viewers. Plan §6.1 only says to update an already-constructed DiffViewer. It does not say what happens when a markdown-default TabContainer exists for the same `relPath` but its DiffViewer has never been constructed.

If the existing `openOrUpdateTab(edit)` shape remains, a poll/editor edit for `README.md` will not find the bare `relPath` diff tab id, then will create a new diff-default tab beside the existing `markdown:absPath` tab. That violates the V1.1 tab/viewer split and the user's goal that diff/view mode toggles inside one tab.

Recommendation: define a `findContainerByRelPath(relPath)` path before auto-creating diff tabs. If a container exists and no DiffViewer is constructed, do not construct one solely for the edit; let MarkdownViewer's watcher refresh the markdown view. If the DiffViewer is constructed, update it in place.

### B3 — Floating toggle is not guaranteed to stay pinned to the content viewport

The spec says the toggle is absolute inside `TabContainer.contentEl` and viewer content is the scroll container. The plan adds `.files-tab-pane { position: relative; height: 100%; }`, but it does not move vertical scrolling from the existing `.fe-pane` to the viewer subtrees. Today `.fe-pane` has `overflow-y: auto`; diff content (`.fe-diff`) only has `overflow-x: auto`.

With that CSS, long diff content can still scroll the outer pane, so the absolute-positioned toggle scrolls away with the container instead of staying pinned top-right over the visible content area.

Recommendation: either make `TabContainer.contentEl` a fixed-height non-scrolling viewport and make each viewer contentEl handle vertical scrolling (`.fe-diff` included), updating scroll helpers accordingly, or change the toggle positioning strategy to one that is anchored to the pane viewport.

## IMPORTANT

### I1 — Spec contradicts itself on chevron removal

Spec §3 says: "No removal of the V1 chevron immediately" and "V1.1 hides it, V1.2 deletes the DOM and JS." But §4.1, §6, and acceptance all require deleting `#feOpenMenu`, `_pinnedType`, `buildOpenMenu`, and menu CSS in V1.1. The plan follows deletion.

Recommendation: update §3 to match the chosen V1.1 deletion behavior.

### I2 — Initial `display:none` invariants are incomplete for the new two-level model

V1 §4.0.6 requires every newly-constructed tab contentEl to be `display:none` before attachment. V1.1 says V1 lifecycle invariants stay in force, but the plan's `TabContainer.contentEl` field omits `style.display = 'none'`. The viewer contract also does not explicitly require initial viewer contentEls to start hidden before appending to `container.contentEl`.

Recommendation: state both invariants explicitly:

- `TabContainer.contentEl.style.display = 'none'` before it is appended to `shell.paneEl`.
- Every ViewerInstance `contentEl.style.display = 'none'` before it is appended to `container.contentEl`.

### I3 — Card rehydrate construction path is underspecified

Current `initFromPersistence` creates `new DiffTab(shell, placeholder)` directly, appends `tabEl/contentEl`, then `fetchSnapshot()` updates it. Plan §2.5 broadly says to replace `tabs.set` sites, but does not spell out this special placeholder path.

Recommendation: add a step for cards rehydrate: create a diff-default TabContainer keyed by `relativePath`, construct/insert its DiffViewer with the clean placeholder edit, append the container DOM, keep it mounted-inactive, then let `fetchSnapshot()` update the DiffViewer.

### I4 — Agent-state construction path is underspecified

Plan §2.6 says to operate on `TabContainer.viewers.get('diff')`, but current `applyAgentState` also has a no-existing-tab construction case that directly creates `new DiffTab(shell, data.edit)`. That must become a diff-default TabContainer creation path.

Recommendation: specify both cases:

- Existing container: resolve its DiffViewer, constructing it only if the agent state explicitly targets a diff tab id/selection path and this is desired.
- Missing container: create a diff-default TabContainer keyed by `targetTabId`, construct its DiffViewer from `data.edit`, set `pendingSelection` on the DiffViewer, activate the container, then finalize against the DiffViewer.

### I5 — Dismissed snapshot key must be `relPath`, not `container.id`

Plan §6.2 says to record from `container.viewers.get('diff')?.edit`, but does not state the key. For markdown-default tabs, `container.id` is `markdown:absPath`, while `dismissedPaths` is checked against incoming `edit.relativePath`. Using `container.id` would fail suppression and allow a closed markdown-file tab to re-open as a diff tab on the next poll.

Recommendation: explicitly use `container.relPath` / `diffViewer.edit.relativePath` for `dismissedPaths` and `dismissedSnapshots`. Also align spec U6 with the plan: markdown-only tabs with no constructed DiffViewer should not record a diff dismissal snapshot.

### I6 — TabContainer destroy needs an explicit exactly-once guard

Plan §2.2 says `destroy()` iterates viewers and catches errors, but does not include a `destroyed` flag. V1's invariant is that each instance is destroyed exactly once, with idempotency as a second layer after map-delete-before-destroy.

Recommendation: give TabContainer its own `destroyed` flag and have `destroy()` set it first, then destroy each constructed viewer once, then detach/null DOM references.

### I7 — Tab click behavior must preserve diff-specific follow/badge semantics

V1 DiffTab tab clicks call `shell.setFollowEdits(false)`, `badgeCounter.delete(relPath)`, `updateFollowButton()`, then activate. V1 MarkdownTab tab clicks only activate. Plan §2.1 says to copy/move tabEl construction into `buildContainerTabEl`, but does not define how these diff-specific behaviors survive.

Recommendation: TabContainer tab-click wiring should deliberately handle follow/badge behavior. At minimum, diff-default tabs must preserve the V1 behavior. If markdown-default tabs can receive diff updates under `relPath`, clicking the tab should clear `badgeCounter` for `container.relPath` if present.

### I8 — `code-quality.md` path is wrong in the plan/prompt

The requested path `docs/code-quality.md` does not exist. The file is `code-quality.md`. Plan §9.2 references the missing docs path, so the review step will fail as written.

Recommendation: update plan §9.2 to reference `code-quality.md`.

## NICE-TO-HAVE

### N1 — Button label text is inconsistent

Use cases mention `⇄ Diff` / `⇄ Markdown`, while design, plan, and acceptance use `→ Diff` / `→ Markdown`. Pick one. The plan's `→` matches the detailed design.

### N2 — Toggle edge cases deserve short notes

The path-based `canHandle` behavior is acceptable when a markdown file is deleted: MarkdownViewer can show its load error and DiffViewer can show the delete/clean diff state. It would be useful to record that this is intentional. Likewise, clicking the toggle while the picker is open is probably prevented by picker modality, but the spec can note that picker UI owns focus and no special toggle handling is required.

### N3 — Toggle-back to MarkdownViewer may not visibly reload immediately

If a user opens markdown, toggles to diff, an edit occurs, and then toggles back, the MarkdownViewer's watcher should already have refreshed while inactive. If the watcher missed an event or the file changed without a watch event, toggle-back will not force a reload. Consider specifying whether `MarkdownViewer.activate()` should call `load()` or whether the watch subscription is trusted.

## Confirmed OK

- The file rename order remains safe for applet-store alphabetical concatenation: `diff-viewer.js`, `markdown-viewer.js`, then `script.js`.
- Grep found no implementation consumers of `window.__filesApplet.DiffTab` outside the applet's own JS; docs references are historical.
- Lazy update of constructed-but-inactive DiffViewer is correct, and plan §6.1 avoids constructing DiffViewer merely to process `caco.edit`.
- Failed switch recovery is conceptually right: deactivate old, attempt open, reactivate old on rejection, disable the button during the switch.
- Positioning the toggle as a sibling of viewer contentEls is the right ownership model; the remaining issue is scroll ownership/CSS, not DOM ownership.
