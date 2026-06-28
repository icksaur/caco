# spec-files-applet-viewers

Status: **done** (shipped). Sub-spec of `docs/files-applet-spec.md`. The viewer contract
all `applets/files/*-viewer.js` modules implement, and each viewer's as-built behavior.

## Fit
- Goal it serves: a uniform, lazy viewer surface so the Files orchestrator can host any
  file type behind one interface.
- Invariants in scope:
  - **Every viewer implements the common CORE** (ctor + static `open` + `activate`/
    `deactivate` + `echoState` + `destroy` + `viewerType`). Text viewers (source, markdown)
    additionally implement the editor surface (modes, scroll save/restore, dirty/save);
    media viewers (image, audio, html) implement only the core. The orchestrator calls the
    extended methods only on viewers that declare them.
  - **Routing predicates live in the orchestrator, not the viewer.** `canHandle`/`isDefault`
    are properties of the orchestrator's viewer **descriptors** (the registry in
    `script.js`), not methods on the viewer classes.
  - **Latent construct, deferred I/O.** The constructor is synchronous and creates a hidden
    `contentEl` (display:none); all expensive work (fetch, watcher acquire, render) happens
    in the async `open()` factory / `load()`, so the tab strip paints instantly.
- Contradiction check: none.

## Goal
Each file type renders in its own viewer with consistent lifecycle (activate/deactivate,
scroll save/restore, mode toggle, dirty/save, destroy) and consistent agent-state echo, so
viewers are interchangeable within a tab and switchable via the floating toggle.

## Design

### Common viewer contract
Each `*-viewer.js` exposes a constructor + static async `open` factory and instances expose
the lifecycle methods the orchestrator calls.

| Member | Shape | Role |
|---|---|---|
| `Viewer(shell, container, absPath, opts)` | sync ctor | create hidden `contentEl`; no I/O |
| `static async Viewer.open(shell, container, absPath, relPath, opts)` | factory | await `shell.api.watchPath` (unless `opts.watch===false`), first `load()`, append `contentEl` |
| `viewerType` | string | `'diff' \| 'markdown' \| 'image' \| 'html' \| 'audio' \| 'source'` |
| `activate()` / `deactivate()` | void | show/hide `contentEl`; restore/save scroll |
| `echoState()` | `{kind, path, …}` | per-viewer agent-state fragment |
| `destroy()` | void, idempotent | close watcher, detach DOM, null handlers |
| `getScrollState()` / `setScrollState(n)` | number | **text viewers** — persist scroll across reopen |
| `getModes()` / `getActiveMode()` / `setMode(id)` | `[{id,label}]` | **text viewers** — view/edit toggle |
| `getChromeButtons()` | `[{id,label,visible,disabled,onClick}]` | **text viewers** — Save etc. |
| `isDirty()` | bool | **text viewers** — unsaved-changes guard |

Routing (`canHandle(abs,rel)` / `isDefault(ext)`) is **not** on the viewer — it lives on the
orchestrator's viewer descriptors (the ordered registry in `script.js`).

**Watch reload:** the factory acquires `shell.api.watchPath(absPath, {scope:'file'})` and
on change calls `inst.load()` (re-fetch + re-render); the reload **does** call
`shell.echoState()` (so the agent sees the refreshed content/size). DiffViewer is the
exception — it has **no** watcher; the orchestrator updates it via `update(newEdit)` after
polling the diff snapshot.

**Shared helpers (globals, not imports):** `window.__filesApplet.writeFileText(abs, text)`
(`editable-text.js`) PUTs to `/api/files/<path>` as `text/plain` (absolute paths keep the
double slash `/api/files//home/...`); `window.renderMarkdownElement(el)` renders markdown;
`window.hljs.highlightElement(el)` highlights; `shell.renderBody(contentEl, edit)`
(orchestrator) renders the diff body.

### Per-viewer behavior

| Viewer | Types | Source | Render | Edit | Watch | Echo `kind` |
|---|---|---|---|---|---|---|
| **source** | code/text (non-binary, `BINARY_RE`) | `GET /api/file?path=` (text) | hljs over `<pre><code class=language-…>`; `EXT_TO_LANG` map | textarea overlay on highlighted backdrop, `Ctrl+S`; `opts.readOnly` blocks | yes; in edit mode flags `⚠ disk changed since edit started` | `source` `{path,readOnly,loaded,size,mode}` |
| **markdown** | `.md/.markdown/.mdx` | `GET /api/file?path=` (text) | `renderMarkdownElement` + hljs on code blocks | textarea edit, Save chrome button when dirty, `Ctrl+S` | yes; disk-changed flag in edit mode | `markdown` `{path,loaded,size,mode}` |
| **diff** | non-binary text, **in-cwd only** | `POST /api/sessions/:id/file-edits/open` `{relativePath,diffMode?}` | `shell.renderBody`: full-file `hunks[]` with per-line Myers word-marks, fold >20 ctx rows | read-only (line-selection, not text edit) | none — `update(newEdit)` from poll | `diff` `{path,selection}` |
| **image** | raster + `.svg/.ico` | `GET /api/file?path=&t=` (img.src) | native `<img>`, zoom/pan | no | yes (cache-busted) | `image` `{path,loaded,zoom}` |
| **audio** | `.wav/.mp3/.ogg/.oga/.m4a/.aac/.opus/.flac` | `GET /api/file?path=&t=` (audio.src) | native `<audio controls>` | no | yes (cache-busted) | `audio` `{path,loaded}` |
| **html** | `.html/.htm` | `/api/file?path=&t=` in a **sandboxed iframe** (server sets a restrictive CSP, `connect-src 'none'`) | iframe | no | yes | `html` `{path,loaded}` |

`editable-text.js` (39 lines) is not a viewer — it is the shared write encoder used by the
source + markdown editors.

## Considerations
- **Concatenation, not modules.** Viewers are merged sibling files sharing window globals;
  adding a viewer means defining the full contract + registering it in the orchestrator's
  registry (ordered: markdown, image, html, audio, diff, source).
- **DiffViewer asymmetry** (no watcher, `update()` instead) is deliberate: diffs come from
  the git poll, not a raw file read, so it reuses the poll cycle rather than a file watch.
- **Disk-changed-while-editing** is surfaced, not auto-merged: the editor warns and leaves
  the user's buffer intact.

## Acceptance (Definition of Done)
- Observable: each type opens in its viewer; the floating toggle switches among applicable
  viewers; a text edit + `Ctrl+S` persists; an image/audio/html updates on external file
  change; a diff updates from the poll; scroll + mode survive tab reopen. (Visual signoff.)
- Budgets: n/a beyond the root spec's caps.
- Gates: `npm run build` green.
- Oracles: visual acceptance is the pin; viewer JS has no isolated unit suite and the
  `/api/file*` routes are not route-tested today (`/api/file` is a `test.todo`). Pure
  helpers (`EXT_TO_LANG`, language detection, word-mark diff) **should** get tests if
  extracted — a documented gap, not a claimed test.

## Plan
Shipped (V2–V6 viewers; V7 made them the sole renderers). Forward work adds a viewer by:

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 1 | Define the viewer (ctor + `open` + lifecycle + `echoState` + `destroy`) | `applets/files/<type>-viewer.js` | visual acceptance | common contract; latent-construct |
| 2 | Register in the orchestrator registry (default/canHandle) | `applets/files/script.js` | visual acceptance | one-viewer-per-type default |
| 3 | If editable, reuse `writeFileText`; if served raw, confirm `/api/file` MIME + CSP | `applets/files/editable-text.js`, `src/routes/api.ts` | by-construction (no `/api/file` route test yet) | no-FS-bypass |
