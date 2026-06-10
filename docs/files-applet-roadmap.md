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
| V3.x | shipped | merged into master @ 1a68f18 | `docs/files-applet-v3.x.md` |
| V3.y | shipped | merged into master | `docs/files-applet-v3.y.md` |
| V4 | shipped | merged into master | `docs/files-applet-v4.md` |
| V5 | shipped | merged into master | `docs/files-applet-v5.md` |
| V6 | shipped | merged into master | `docs/files-applet-v6.md` |
| V7 | not started | — | (to be spec'd) |

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

## V4 — proposed scope (file-finder fidelity)

V4 is intentionally small: bring the Ctrl+P picker in the file-edits
applet to parity with the standalone `file-finder` applet on the two
affordances users notice as missing — per-type icons on each row, and
a hover copy-path button. See `docs/files-applet-v4.md`.

The previously-listed V4 bucket items (slug rename, deprecating
standalone viewers, global shortcuts, visual refresh, autosave,
dirty-prompt) move to V5+ below. They are NOT abandoned, only
re-bucketed so V4 ships small.

## V5 — shipped (rename + standalone deprecation)

Renamed slug `file-edits` → `files` (with `SLUG_ALIASES`
back-compat). Soft-deprecated `markdown-viewer`, `image-viewer`,
`html-viewer`, `file-finder` via `deprecated: true` meta flag +
conditional redirect stub (redirects to `files` when a session
exists; falls through to the standalone applet without one).
Added `?openFinderRoot=ABS` to the picker so `file-finder?root=X`
flows kept working. Persistence `STORE_NAME` renamed
`file-edits-cards` → `files-cards` with one-time on-read
migration. Agent prompt + `caco_applet_usage` + applet-browser
all filter `deprecated`; applet-browser has a "Show deprecated"
toggle. See `docs/files-applet-v5.md`.

## V6 — shipped (git-diff deprecation)

Extended the `files` applet's DiffViewer to handle three diff
modes (unstaged, staged, range) — one file per tab; no new tab
type. `git-diff` became a V5-style conditional redirect stub
(redirects to `files` when a session exists). `git-status`'s
per-file diff links switched to `files` directly; the
multi-file last-commit "View diff" link was removed (single
regression, mitigated by deferred per-commit file list).
Added `?diffMode=` and `?diffRef=` URL params, additive
`diffMode`/`diffRef` on persisted cards (schemaVersion 2 stays
intact). DiffViewer gained a chrome refresh button for
staged/range snapshots. See `docs/files-applet-v6.md`.

## V7+ — proposed buckets (formerly V6+ scope)

10. **Delete the deprecated stub directories outright.** V5
    kept `markdown-viewer`, `image-viewer`, `html-viewer`,
    `file-finder` on disk for back-compat; V6 added `git-diff`
    to that list. Whenever enough turns have passed that old
    chat-link URLs have aged out, remove them. This is the
    change that finally collapses the duplicated `fileIcons`
    map (V5 §10).

11. **Grow the `files` applet to support no-session mode** so
    the conditional redirect can become unconditional and the
    standalone viewers can finally be deleted.

12. **Rename TS routes / files** (`src/routes/file-edits.ts` →
    `files.ts`, `src/file-edits-store.ts` → `files-store.ts`).
    One-shot rename + import fix; no behavior change.

13. **Update the long-tail of in-applet links**
    (`text-editor`, `image-gallery`, `session-context`,
    `html-viewer`) to point at `files` directly instead of
    relying on the stub redirect. (`git-status` already
    targets `files` directly as of V6.)

14. **Multi-file ref-range view** in git-status. Per-commit
    detail row with a file list, each row linking to `files`
    with `diffMode=range&diffRef=<commit>~..commit`.
    Replaces the V6-removed "View diff" link with something
    more useful (per-file clickable).

15. **Live event hook for staged tabs.** Currently V6 staged
    tabs only refresh via the chrome button. A hook into
    `git stage` / `git reset` would let the tab auto-update.

16. **Expand `diffRef` grammar** (V6 §5.3 documents a narrow
    subset). Add reflog `@{...}`, peeling `^{...}`, etc. once
    use cases emerge.

17. **Global keyboard shortcuts.** Ctrl+P already opens the
    files applet's finder as of V3.y.2; remaining shortcuts:
    next/prev tab, close tab.

18. **Visual refresh.** Tab-type icon glyphs (V1 used ◇ and ¶
    as placeholders), toggle button styling, broader picker UX
    get a consistent treatment with Caco's broader visual style.

19. **Autosave for write-capable viewers** (deferred from V2).
    Debounced 1s after last keystroke; in-memory "last failed
    save" buffer + small indicator so silent save failures
    surface to the user.

20. **Dirty-prompt on session-switch** (deferred from V2 §7.5;
    superseded by §19 autosave).

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
