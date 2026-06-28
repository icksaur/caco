# spec-files-applet

Status: **done** (shipped, on master). Root spec for the Files applet. Consolidates the
V1–V7 / file-edits version history (~60 docs) into a single source of truth describing the
**current** behavior. Two sub-specs carry the deep mechanisms:
- `docs/files-applet-viewers-spec.md` — the viewer contract + per-viewer behavior.
- `docs/files-applet-edits-spec.md` — the git diff-card + selection/edit server system.

## Fit
- Goal it serves: an in-Caco file surface — view source, edit text, view diffs, and render
  images/audio/markdown/html — that the agent and the user share, deep-linkable by URL.
- Invariants in scope:
  - **One applet, one viewer per file type.** The `files` applet owns all rendering; the
    old per-type stub applets (markdown-viewer, image-viewer, …) were retired (V7). A file
    extension maps to exactly one *default* viewer.
  - **In-cwd vs external is a hard routing split.** A path inside the session cwd uses the
    diff/edit path (git-backed); an absolute path outside cwd is **external** —
    read-only, never diffed. The server enforces this: `/file-edits/open` rejects an
    absolute or cwd-escaping `relativePath` with **400**, and `404`s only when an in-repo
    path is in neither HEAD nor the working tree. A non-git cwd reports `isGit:false` from
    the snapshot (not an error), and the client falls back to read-only.
  - **The applet never bypasses the server file API.** All content read/write/browse goes
    through `/api/file`, `/api/files`, `/api/project-files`, and `/api/sessions/:id/
    file-edits/*` — the applet has no direct FS access (it is sandboxed in an iframe).
  - **Persisted tab state is per session and survives switch/reload.** Tabs, active tab,
    per-viewer mode/scroll round-trip through `/file-edits/cards`.
  - **Echo carries a `sourceId`.** UI→agent state echoes are tagged with a per-client id so
    a peer client's echo never steals this client's focus/selection.
- Contradiction check: none. The applet is a pure SDK-applet consumer of existing server
  routes; no new persistence or FS surface.

## Goal
Open `?applet=files` (optionally `&openPath=<abs-or-rel>`) and get a tabbed file workspace.
Each tab is one file path with a switchable set of viewers; a floating toggle button swaps
viewers when more than one applies. `Ctrl+P` opens a fuzzy file picker (recent files,
directory browse, project search). In-cwd files in a git repo show a live diff (working
tree vs HEAD) with line-selection that the agent can read and drive; text files can be
edited in place and saved. External files render read-only. Works **with or without** an
attached session (V7 no-session mode).

## Design

**Packaging.** The applet is concatenated sibling scripts under `applets/files/`:
`script.js` (orchestrator, ~4000 lines) + one `*-viewer.js` per type + `editable-text.js`
(shared PUT encoder) + `content.html` + `style.css` + `meta.json`. No build step; loaded
in an iframe by the applet host. Shared globals it relies on: `window.appletAPI`
(`setAppletState`/`onStateUpdate`/`watchPath`), `window.renderMarkdownElement`,
`window.hljs`.

**Tab model** (`TabContainer`, script.js ~371). `tabs: Map<tabId, TabContainer>` in strip
order; `activeTabId` is the visible one. A `TabContainer` holds `viewers:
Map<viewerType, ViewerInstance>` — viewers are **lazy-constructed** on first switch. Tab id
encodes identity + kind to avoid collisions: `external:<abs>`, `markdown:<abs>` (md
default, V1 schema), bare `<rel>` (diff unstaged, default), `\0diff-staged\0<rel>` (staged).
`TAB_CAP = 50` (past the cap, `evictOldestNonActive` removes the oldest non-active tab of
**any** type). Close picks the left-then-right neighbor; a dirty tab prompts before close.

**Viewer registry + default selection** (script.js ~267, ~2909). Ordered registry:
Markdown → Image → Html → Audio → Diff → Source. `defaultViewer(abs, rel)` returns the
first viewer whose `isDefault(ext)` matches, else the first `canHandle`. Defaults:
`.md/.markdown/.mdx`→markdown; raster+`.svg/.ico`→image; `.html/.htm`→html;
`.wav/.mp3/.ogg/.oga/.m4a/.aac/.opus/.flac`→audio; **every other non-binary**→diff; Source
is never a default (fallback / external). `defaultExternalViewer(abs)` is the same minus
diff (external never diffs). `canHandle`/`isDefault` live on the **orchestrator's viewer
descriptors** (the registry), not on the viewer classes. The floating toggle
(`updateToggle`, ~594) shows when ≥2 viewers `canHandle` the file and switches to the next.
Full viewer contract + per-viewer behavior: **see `docs/files-applet-viewers-spec.md`.**

**Path routing** (script.js ~104–172). `_isAbsolutePath` (POSIX `/`, Windows drive, UNC) +
`cachedCwd` decide in-cwd vs external. `_relativizePath` strips the cwd prefix
(Windows-case-insensitive). `isExternal(abs)` routes to `routeOpenExternal` (read-only,
`external:` tab) vs `routeOpen` (diff/edit). `cwdIsGit` (false after the snapshot 404s)
forces in-cwd opens to the external/read-only path when the cwd is not a git repo.

**File picker** (script.js ~2200–2710). `Ctrl+P` / `+` opens a modal. Empty query →
directory browse via `GET /api/files?path=<dir>` with a clickable breadcrumb. Non-empty →
fuzzy project search via `GET /api/project-files?cwd=<dir>&q=<query>` (`_fuzzyScore`, capped
`PICKER_RESULT_CAP = 50`), with `>img`/`>md`/`>html`/`>diff`/`>any` type filters. Per-type
icons + hover copy-path button (V4). Recent files in `localStorage`
(`caco:files-applet:recentPaths`, cap 20).

**State & persistence** (script.js ~915–972, ~2095–2173, ~3617+). Two outward channels:
- **Echo to agent** — `echoState()` (coalesced one-per-frame via `queueMicrotask`) →
  `appletAPI.setAppletState({ fileEdits, files })`. `fileEdits` = `{ activeTab, selection,
  sourceId }` (legacy shape; `sourceId` is the focus-steal guard); `files` = `{ tabs[],
  activeTabId }` with each tab's `echoState()` viewer fragment.
- **Persisted cards** — debounced (`PERSIST_DEBOUNCE_MS = 500`) `PUT /api/sessions/:id/
  file-edits/cards` (`sendBeacon` on unload); `GET` on rehydrate. `{ schemaVersion: 2,
  cards[], dismissed: [] }` (the client always writes `dismissed: []`). **External tabs are
  never persisted.** Each card is `{ relativePath, defaultViewerType, activeViewerType,
  diffMode?(when staged), active?, scroll?, mode?(when 'edit') }` — additive fields the
  server round-trips untouched (older readers ignore unknowns). On session switch all tabs
  are destroyed and `initFromPersistence` rebuilds them (sync for diff, async for
  image/html/markdown), restoring mode + scroll + active tab. **Dismissed paths** (closed by
  the user) suppress the poller from re-creating a just-closed tab unless the file's content
  changed.

**Selection / edit-diff bridge** (script.js ~976–1390). On a diff tab the user can drag to
select line ranges; `envelopeFromRange` snaps the DOM range to `.fe-row[data-work-line]`
bounds → `{ start, end, text }` (text capped `TEXT_CAP = 4096`), echoed to the agent. The
agent can push a `{ start, end }` envelope back; `applyEnvelopeAsRange` re-materializes it
as a DOM selection (guarded by `_expectedEnvelope` to avoid an echo loop). Full diff-card +
git-poller mechanism: **see `docs/files-applet-edits-spec.md`.**

## Considerations
- **External never diffs.** The in-cwd/external split is load-bearing: the server rejects an
  absolute/escaping path at `/file-edits/open` (400), and a non-git cwd reports
  `isGit:false`; `cwdIsGit` gates the client so in-cwd opens fall back to read-only when the
  cwd is not a git repo.
- **Concatenation contract.** Viewers are separate files merged by the applet store; they
  share globals (`window.__filesApplet.writeFileText`, `shell.renderBody`, `shell.api`),
  not ES imports. A viewer must define the common contract (below) or the orchestrator
  breaks.
- **Echo loops & focus theft.** Coalesced echo + `sourceId` + `_expectedEnvelope` prevent
  (a) flooding the agent, (b) a peer client stealing focus, (c) a programmatic selection
  re-echoing as a user gesture.
- **Lost-on-consolidation:** the per-version specs held proposed-but-unbuilt ideas (range
  diff mode, split panes, some V7 sub-items). Those are intentionally dropped; this spec
  describes only what ships. Recover from git history if ever needed.

## Acceptance (Definition of Done)
- Observable: `?applet=files&openPath=…` opens the right default viewer for the type;
  `Ctrl+P` finds + opens files; an in-cwd git file shows a live diff with selectable lines;
  editing a text file + `Ctrl+S` writes it (verified by re-reading); an external abs path
  renders read-only; tabs + active tab + scroll/mode survive a session switch and reload;
  no-session deep-links render. (Visual signoff — the applet is user-visible UI.)
- Budgets: `TAB_CAP=50`, `PICKER_RESULT_CAP=50`, `RECENT_FILES_CAP=20`, `TEXT_CAP=4096`,
  persist debounce 500ms, picker-fetch debounce 100ms; `/api/file` enforces
  `MAX_FILE_SIZE_BYTES` (413).
- Gates: `npm run build` green.
- Oracles: the applet is browser glue with no isolated unit suite; correctness is pinned by
  **visual acceptance**. On the server, the git diff helpers are unit-tested
  (`parsePorcelain`/`truncateDiff`/`parseHunks` in `tests/unit/git-edit-poller.test.ts`) and
  the card store's V5 migration in `tests/unit/file-edits-store.test.ts` — but the
  `/api/file*` and `/file-edits/*` HTTP routes are **not** route-tested today (`/api/file`
  is a `test.todo` in `tests/api.test.ts`); those, the orchestrator, and the viewers are
  **by-construction / visual**. Pure helpers extracted from `script.js` (path classify,
  fuzzy score, envelope snap) **should** get unit tests when touched — currently a
  documented gap.

## Plan
Shipped across V1–V7 (history in `docs/files-applet-roadmap.md`). Forward work hangs new
steps off this table.

| # | Area | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 1 | Orchestrator: tabs, viewer-switch, path routing, picker, persistence, selection bridge | `applets/files/script.js`, `content.html`, `style.css`, `meta.json` | visual acceptance | one-viewer-per-type; in-cwd/external split; per-session persistence |
| 2 | Viewers + contract | `applets/files/*-viewer.js`, `editable-text.js` | visual acceptance | concatenation contract (see viewers sub-spec) |
| 3 | Server file API | `src/routes/api.ts` (`/file`, `/files`, `/project-files`, `PUT /files/*`) | by-construction (no route test yet; `/api/file` is `test.todo`) | no-FS-bypass; size cap; per-type CSP |
| 4 | Diff-card + selection system | `src/routes/file-edits.ts`, `src/file-edits-store.ts`, `src/git-edit-poller.ts`, `src/file-watcher.ts` | poller helper tests + store-migration test; routes by-construction (see edits sub-spec) | git-backed in-cwd only (see edits sub-spec) |

## Rationale (skippable)
The applet grew over ~60 version/review docs (V1 tabbed diff/markdown → V7 no-session,
one-viewer-per-type). That history is preserved in git and summarized in the roadmap, but
it had diverged badly from the code, making changes risky. This root spec + the two
sub-specs are a deliberate fresh slate: they describe **only the shipped behavior** so the
next change starts from a spec that matches reality. The version docs are archived (see the
roadmap pointer), not maintained.
