# Files applet — roadmap

Living tracker of versioned work. Each shipped version is locked in
its own spec (`docs/files-applet-v<N>.md`). This doc moves items
between version buckets as scope shifts; it never owns design
detail — only intent + status.

## Status (last updated 2026-06-09)

| Version | Status | Tag/commit | Spec |
|---|---|---|---|
| V1 | shipped | 2211b71 (merged into master @ 439210e) | `docs/files-applet-v1.md` |
| V1.1 | shipped | 385cf9a (merged into master @ 6b1e0f2) | `docs/files-applet-v1.1.md` |
| V2.a | shipped | merged into master @ 66e0f17 | `docs/files-applet-v2.md` §4.1 |
| V2.b | shipped | merged into master @ ee40db7 | `docs/files-applet-v2.md` §4.2 |
| V2.c | shipped | merged into master @ b1b4cae | `docs/files-applet-v2.md` §4.3 |
| V2.d | shipped | merged into master @ 0e85d5a | `docs/files-applet-v2.md` §4.4 |
| V3.x | not started | — | `docs/files-applet-v3.x.md` (to be written) |
| V3.y | not started | — | `docs/files-applet-v3.y.md` (to be written) |
| V4 | not started | — | `docs/files-applet-v4.md` (to be written) |

## V1 — shipped

Tabbed file viewer with two tab types (diff, markdown). Multi-file
applet support (sibling `*.js` concat in applet-store). Class-level
contract for TabInstance. Dismissed-path snapshot to suppress
poller re-creation of closed tabs.

## V1.1 — shipped

Tab/viewer split: each tab is a `TabContainer` holding a
`Map<viewerType, ViewerInstance>`. Floating top-right toggle
button switches viewers (markdown ↔ diff) on tabs whose file has
multiple applicable viewers. Chevron-at-open-time removed. Scroll
architecture migrated to per-viewer. Selection-code adapted via
`activeDiffViewer` indirection. `findContainerByRelPath`
deduplicates `caco.edit` polls so a markdown-default tab doesn't
spawn a parallel diff tab.

## V2 — proposed scope

Four pieces, roughly in dependency order. Bucket may be split
further during spec.

1. **ImageViewer** — port `applets/image-viewer/script.js` into a
   `ViewerInstance` over file path. Default for `.png/.jpg/.gif/
   .webp/.svg`. Trivial application of the V1.1 contract (binary
   content). DiffViewer.canHandle may need a binary check so the
   toggle doesn't offer "Diff" for binaries.

2. **HtmlViewer** — port `applets/html-viewer/script.js`.
   Sandboxed iframe stays sandboxed. Default for `.html`. Same
   shape as ImageViewer.

3. **Card schema bump (persistence of viewer mode)** — current
   cards endpoint persists only `relativePath`. V2 adds
   `defaultViewerType` and `activeViewerType` so a reopened
   markdown-default tab comes back as markdown (not diff), and a
   tab the user toggled to a non-default viewer reopens in that
   viewer. Server-side migration: default missing fields to
   `'diff'`. Markdown / image / html tabs become first-class
   persisted entities.

4. **MarkdownViewer view↔edit mode** — the most user-visible win.
   The V1.1 viewer-toggle pattern is the natural home for
   intra-viewer mode flips. MarkdownViewer keeps two child
   elements (rendered, raw-text editor) and toggles which is
   visible. Adds a save endpoint (PUT `/api/file?path=`) or
   reuses an existing one if available. Toggle row likely
   becomes "Mode: View | Edit" alongside the viewer-type toggle.

## V3 — split into V3.x (polish) and V3.y (chat-integration + finder)

**V3.x** (small, coherent contract polish — spec'd in
`docs/files-applet-v3.x.md`):

5. **Eviction policy for inactive viewers** — TabContainer
   destroys non-active viewers after N seconds idle. Memory
   optimization with no user-visible behavior change beyond
   reload-cost on toggle-back. The trigger to ship this is
   memory data, not feature pressure — V3.x lays the design and
   makes the policy opt-in / configurable, but ships with the
   default disabled if data doesn't yet justify it.

8. **Per-viewer chrome decoration** — Generalize V2.d's Save
   button into "viewer may declare extra chrome buttons" hook.
   Anchored next to the mode toggle. Lets a future viewer add
   e.g. "Format" / "Lint" / "Reset zoom" without shell
   changes. Refactor of V2.d's save-button code, not new code.

**V3.y** (large, cross-module — spec'd in `docs/files-applet-v3.y.md`):

6. **Open-from-chat routing** — when chat output contains a link
   to a known file (markdown link, file: URL, etc.), route to a
   TabContainer in the files applet instead of opening the
   standalone applet (markdown-viewer/image-viewer/html-viewer).
   Requires chat-side intent dispatch + a documented contract
   for which slug+param shape the chat link generator should use.

7. **Enhanced file finder** — the picker becomes a first-class
   tab type / surface. Ctrl+P opens it as an overlay. Recent
   files, fuzzy match, preview-on-hover (renders the file's
   would-be tab type in a side pane). Type-specific filtering
   ("only show images").

## V4 — proposed scope (deferred from earlier + V3 deferrals)

9. **Rename slug `file-edits` → `files`.** Old slug kept as a
   redirect for one release. Updates `agentUsage.purpose` and any
   doc references.

10. **Deprecate standalone applets.** `markdown-viewer`,
    `image-viewer`, `html-viewer` marked deprecated; their
    entries in `applets/` keep a stub that redirects to the
    files applet (`?applet=files&openType=markdown&path=...`).

11. **Global keyboard shortcuts.** Ctrl+P opens the files
    applet's finder (after V3.y §7). Other shortcuts: next/prev
    tab, close tab.

12. **Visual refresh.** Tab-type icon glyphs (V1 used ◇ and ¶
    as placeholders), toggle button styling, picker UX get a
    consistent treatment with Caco's broader visual style.

13. **Autosave for write-capable viewers** (deferred from V2).
    Debounced 1s after last keystroke; in-memory "last failed
    save" buffer + small indicator so silent save failures
    surface to the user.

14. **Dirty-prompt on session-switch** (deferred from V2 §7.5;
    superseded by V4 §13 autosave). When autosave makes "unsaved
    changes" rare, this becomes belt-and-suspenders. May ship as
    a small Caco-side `onBeforeSessionChange` hook or be dropped
    if autosave proves sufficient.

## Out of scope (parking lot)

- Tab reordering by drag.
- Split view (two viewers visible at once).
- Per-line annotations / inline comments.
- Diff conflict resolution UI.
- Git operations from the applet (stage / unstage / commit).

These are intentionally deferred to future major versions or
separate applets. They are NOT in any current bucket.

## Process notes

- Each version ships behind its own spec doc. Spec docs are
  locked at ship time (no edits after merge except typo /
  clarification, never design changes — design changes ship in
  the NEXT version with a delta section).
- Plan.md is the in-flight execution log; it is overwritten per
  version and points back at the current spec.
- Spec reviews land as `docs/files-applet-v<N>-review.md`;
  impl reviews as `docs/files-applet-v<N>-impl-review.md`.
- Roadmap (this file) is the only doc that crosses version
  boundaries.
