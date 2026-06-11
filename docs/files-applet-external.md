# Files applet — open files outside the session cwd ("external" read-only mode)

## Status

Proposed. Spec for review before implementation.

## Problem

The meta-context footer renders clickable links for context/edited
files (`?applet=files&openPath=<abs>`). Clicking a file **outside the
session cwd** silently fails. The user frequently runs a session whose
cwd is one repo but references documents under
`OneDrive/Desktop/workspace`; those footer links are dead.

### Why it fails (two independent bugs)

1. **Path round-trip mangling.** Footer passes an absolute path. The
   open flow is:
   `_handleOpenPath → _relativizePath → routeOpen(rel) → _pickerAbsPathOf/absPathOf`.
   For an in-cwd path, `_relativizePath` strips the cwd prefix → a true
   relative path → `absPathOf` rejoins it correctly. For an **out-of-cwd**
   path, `_relativizePath` returns the absolute path *unchanged*, then
   `routeOpen` treats it as relative and `absPathOf` joins
   `cwd + absPath` → a garbage path.

2. **Viewer selection is git-only for code.** `defaultViewer` picks the
   **diff** viewer for any non-binary file. The diff viewer calls
   `POST /sessions/:id/file-edits/open`, which **rejects absolute paths**
   and enforces cwd-containment + git. So even with a correct path, a
   `.ts`/`.js`/`.py` file outside cwd has no viewer that can render it.

### What already works (and why)

- `GET /api/file?path=<abs>` serves **any absolute path** (api.ts:395;
  "personal software — allows any filesystem path").
- `POST /sessions/:id/watch` (`shell.api.watchPath`) accepts arbitrary
  paths (watch.ts:54-60).
- The **markdown**, **image**, and **html** viewers fetch by `absPath`
  via `/api/file` and watch by `absPath`. They are **not** cwd-bound;
  only bug #1 (path mangling) stops them opening external files today.

So the diff viewer is the *only* component that is intrinsically
cwd/git-scoped. A working-tree diff for a file outside the repo is
not a meaningful concept — external files are inherently **read-only,
no-diff**.

### Guiding principle (per user direction)

The diff viewer cannot easily resolve a diff root for a file outside
the session cwd, and shouldn't try. For external files we **do not
attempt a diff** — we simply **open the file in its current state**,
read-only. No git, no diff root probing, no `/file-edits/open` call.
This makes the behavior simple and predictable: an external link just
shows the file as it is on disk right now (with live reload on change).

## Decision: external files are read-only

Confirmed with user: external files open **read-only**, consistent with
how clean (no-diff) code files already render in-cwd today (the diff
viewer's full-file grid is itself read-only — only the MarkdownViewer
has an editable textarea, and only `.md` files get it). We will **not**
offer edit-save for external files, even though `PUT /api/files/*path`
accepts absolute paths. This keeps the mental model simple ("external =
look, don't touch") and avoids implying workspace-edit semantics for
files outside the session. Editing external files is explicitly out of
scope (no deferred phase planned unless requested).

External MarkdownViewer instances therefore run **view-only** (edit
toggle suppressed); SourceViewer is read-only by construction.

## Review revisions (R1 — incorporated from background review)

The background review found 4 P0s in the original sketch (path mangling
at secondary entry points + tab keying). These supersede the looser
prose below; the implementation MUST follow this section.

### Container model (resolves P0 #1, #4; P1 #5)

`TabContainer` gains `external: boolean` and a canonical `key`. In-cwd
tabs keep their `relativePath`-derived id. External tabs:
- `TabContainer.id` gets an explicit external branch BEFORE the
  markdown/diff branches (~script.js 299-307): id = `'external:' + abs`.
  Never call `diffTabId(abs)`.
- store `abs` for display + fetch; compare normalized (forward-slashed,
  lowercased on Windows) for dedup only.
- add `findContainerByExternalAbs(abs)` (mirrors
  `findContainerByRelPath`, keyed on `external && container.abs===abs`).
  `findContainerByRelPath` is untouched and never receives an abs path.

### Single routing chokepoint — every entry point goes through it

Add `openAnyPath(input, opts)`:
1. resolve `input` → absolute `abs`,
2. `isExternal(abs)` → `routeOpenExternal(abs, opts)`,
3. else → `routeOpen(_relativize(abs), opts)` (today's path).

Re-point every opener so none can double-root an external path:

| Entry point | Change |
|---|---|
| `_handleOpenPath` (footer/URL/drain) | call `openAnyPath` |
| `onUrlParamsChange` openPath | via `_handleOpenPath` ✓ |
| `pickSelected` (finder) | call `openAnyPath` (P1 #6): a `_pickerRootOverride` outside cwd can yield an external path |
| `applyAgentState` (P0 #2) | **early-return if `targetRelPath` is absolute/external** (mirror the `markdown:` guard ~line 1345); never let it reach `absPathOf`/`/file-edits/open` |
| `initFromPersistence` restore | external tabs not persisted (below) → only in-cwd rel paths ✓ |
| `openOrUpdateTab` (server edits) | always in-cwd ✓ (no change) |

### Persistence: actively skip external tabs (resolves P0 #3)

`buildPersistBody` (~1904-1916) writes `container.relPath` for all tabs.
Add `if (container.external) continue;`. External tabs are ephemeral in
Phase 1 (re-click footer to reopen); this guarantees restore only ever
sees in-cwd rel paths.

### MarkdownViewer view-only contract (resolves P1 #7)

`MarkdownViewer.open(..., opts)` accepts `opts.readOnly`. When true,
`getModes()` returns a single `[{id:'view'}]`. `updateModeToggle`
(~524-532) already hides the toggle when `getModes().length < 2`, so no
toggle and no Save button render. No other change.

### SourceViewer error + binary handling (resolves P1 #9, binary)

`SourceViewer.open` renders an **inline error state** (not console.warn
+ silent destroy) on failure: 404 → "File not found", 403 → "Permission
denied", 413 → "File too large to preview". Guard with
`isBinaryExtension(abs)` BEFORE fetch → "Binary file — cannot preview".

### Watch lifecycle (P1 #10 — verify)

Confirm `TabContainer.destroy()` / viewer `destroy()` releases the watch
lease. Match whatever in-cwd viewers do today; SourceViewer mirrors it.

## Goals

- Footer (and finder) links to files **outside cwd** open and render.
- Markdown / image / html external files use their existing viewers.
- Code / text external files get a **read-only source view** with
  syntax highlighting (no diff, no edit).
- In-cwd behavior is **unchanged** (diff viewer, follow-edits, edit).
- No weakening of the diff/edit routes' cwd containment checks.

## Non-goals

- Diffing files outside the session's git repo.
- Editing external files (Phase 1 is read-only; a future phase could
  allow edit via the existing `PUT /api/files/*path`, which already
  accepts absolute paths — deferred).
- Cross-repo git support.

## Design

### 1. Detect "external" at open time

Add an `isExternal(absPath)` predicate in `script.js`: true when
`absPath` is absolute AND not contained in `cachedCwd` (reuse the
Windows-aware, case-insensitive containment logic just added to
`_relativizePath`). Centralize containment in one helper used by both
`_relativizePath` and `isExternal`.

### 2. Stop mangling external paths

`_handleOpenPath(p)` currently always relativizes. Change:

- Compute `abs` = the incoming path resolved to absolute (it already is
  absolute from the footer).
- If `isExternal(abs)`: call a new `routeOpenExternal(abs)` that keys
  the tab by the **absolute path** and never round-trips through
  `absPathOf`.
- Else (in-cwd): relativize and use the existing `routeOpen(rel)` path
  (unchanged).

`routeOpen`/`routeOpenExternal` can share a core that takes
`{ abs, relOrAbsKey, external }`; the only differences are (a) tab key,
(b) viewer eligibility (external ⇒ never diff), (c) no
`/file-edits/open` call.

### 3. Viewer selection for external files

`defaultViewer(abs, rel)` gains awareness via an `external` flag (or a
separate `defaultExternalViewer(abs)`):

- markdown ext → MarkdownViewer (read-only; see §4)
- image ext → ImageViewer (already read-only)
- html ext → HtmlViewer (already read-only)
- everything else (code/text, non-binary) → **SourceViewer** (new, §5)
- binary/unknown → existing "can't preview" handling

The diff viewer is **excluded** from the external registry.

### 4. MarkdownViewer read-only for external

MarkdownViewer has a view/edit toggle that saves via
`PUT /api/files/*path`. For external files, suppress the edit mode
(hide the toggle / force view-only) in Phase 1 to avoid implying
edit-save semantics for files outside the workspace. (The PUT route
*does* accept absolute paths, so a later phase can enable editing; out
of scope now.)

### 5. New SourceViewer (read-only, syntax-highlighted)

A lightweight ViewerInstance mirroring MarkdownViewer's lifecycle but:

- Fetches raw text via `GET /api/file?path=<abs>`.
- Renders into a `<pre><code>` highlighted by extension (reuse the same
  hljs path as the diff renderer's per-line highlight, but whole-file).
- Watches `absPath` (`scope:'file'`) for live reload.
- No gutters, no selection-envelope/agent-state machinery, no edit.
- `white-space: pre; overflow-x: auto` (consistent with the diff
  no-wrap fix).

This becomes the general read-only code viewer; it is also a natural
home for any future "view a file you don't want to diff" need.

### 6. Tab identity & UI affordance

- External tabs are keyed by absolute path; `findContainerByRelPath`
  gains an external variant (or we store `abs` as the key and tag the
  container `external: true`).
- Tab header shows a small "read-only" / external indicator and the
  basename; hover title = full absolute path.
- Persistence (`/file-edits/cards`): decide whether external tabs
  persist across reload. Proposal: **do not persist** external tabs in
  Phase 1 (they're ad-hoc views); revisit if the user wants them sticky.

## Interactions / risks

- **Containment helper correctness** (Windows drive-letter, UNC,
  case-insensitivity, trailing slash) — reuse the just-landed
  `_relativizePath` logic; add unit coverage.
- **Follow-edits / agent selection**: external tabs are not diff tabs,
  so the agent's diff-selection state machine must skip them (it keys on
  diff viewers already; verify no assumption that every tab has a diff
  viewer).
- **Watch lease pressure**: external files add watch leases like any
  open file; bounded by TAB_CAP eviction.
- **Security**: no route is loosened. `/api/file` and watch already
  permit arbitrary paths by design ("personal software"); we only stop
  mangling the path on the client. The diff/edit cwd checks stay intact.
- **`isBinaryExtension` gate**: SourceViewer should refuse obviously
  binary files (reuse the diff viewer's `isBinaryExtension`).

## Phasing

- **Phase 1a:** containment helper + `isExternal` + stop path mangling;
  make markdown/image/html external files open (no new viewer). This
  alone fixes the dominant OneDrive-docs (markdown) case.
- **Phase 1b:** add SourceViewer for external code/text files.
- **Phase 2 (deferred):** optional persistence of external tabs across
  reload. (Editing external files is out of scope — see "Decision:
  external files are read-only".)

## Acceptance

- Footer link to a markdown file under `OneDrive/Desktop/workspace`
  (cwd elsewhere) opens and renders read-only; live-reloads on change.
- Footer link to an external `.ts`/`.py` opens in SourceViewer with
  highlighting; no diff UI; no 400.
- Footer link to an external image/html opens in the existing viewers.
- In-cwd files are unaffected: still open in the diff viewer with
  follow-edits and edit intact.
- No regression in the `/file-edits/open` route (still rejects absolute
  paths); no security relaxation.
