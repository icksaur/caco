# Files applet — picker directory navigation

**Status:** spec rev 2, not implemented. Adds breadcrumb + directory
browsing to the `files` applet's open-file picker, so the user
can navigate above/below the session cwd to reach files (e.g.
images in `~/repo/hull/artifacts` from a session rooted
elsewhere).

## 1. Goal

Two capabilities, restoring what the deprecated `file-finder`
applet had:

1. **Breadcrumb** — clickable path segments at the top of the
   picker showing the current browse root; clicking an ancestor
   segment re-roots the picker there (navigate *up*).
2. **Directory rows** — the picker lists directories (not just
   files); clicking a directory re-roots the picker into it
   (navigate *down*).

The "browse root" is the directory the picker is currently
listing. It starts at the session cwd (or `openFinderRoot` for a
sessionless/override picker) and the user moves it up/down
without changing the session cwd.

## 2. Use cases

- Session cwd is `~/repo/hull`. User wants an image in
  `~/repo/hull/artifacts`: opens picker → clicks `artifacts`
  directory row → sees the images → opens one.
- User wants something in a sibling tree `~/repo/other`: clicks
  a breadcrumb segment up to `~/repo` → descends into `other`.
- User is deep in `~/repo/hull/artifacts/renders/2026` and wants
  to pop up two levels: clicks the `artifacts` breadcrumb segment.

## 3. Non-goals

- Changing the **session** cwd (that's `/session-cwd`). This is
  picker-local browsing only.
- A persistent file-tree sidebar (separate, larger feature).
- Multi-select / bulk open.
- Creating / renaming / deleting directories.
- Showing files outside what `/api/files` returns (no recursive
  search across the new browse root — see §5.4 on how search
  interacts with browsing).
- Replacing the recursive fuzzy file search (it stays for
  type-to-search within a root).

## 4. Current architecture

### 4.1 The picker today

`applets/files/script.js`:
- `openPicker(opts)` (~line 2287) — opens the overlay; sets
  `_pickerRootOverride` from `opts.rootOverride` (used by
  sessionless `openFinderRoot` and Ctrl+P). Otherwise the root
  is `cachedCwd` (session cwd).
- `runPickerFetch(q)` (~line 2339) — fetches
  `GET /api/project-files?cwd=<root>&q=<query>`. This endpoint
  does a **recursive** walk returning **files only** (dirs
  excluded, gitignore-respected, capped). Results land in
  `pickerResults` (array of repo-relative file paths).
- `renderPickerList()` (~line 2374) — renders an optional
  type-filter chip, a "Recent" section, then `pickerResults` as
  `.fe-picker-item` rows (icon + path + copy button + "(open)"
  suffix for already-open tabs). Each row pushes
  `{ rel, recent }` into `pickerVisible`; selection + Enter/click
  call `pickSelected(rel)`.
- `pickSelected(rel)` (~line 2491) — resolves to abs via
  `_pickerAbsPathOf` and routes through `openAnyPath`.

So today the picker is a **recursive file search rooted at one
fixed directory**. There is no concept of a current browse
directory or directory entries.

### 4.2 The old file-finder (reference)

The deleted `applets/file-finder/script.js` (recoverable at
commit `70788ff~1`) had:
- A `rootPath` state + `navigateRoot(newRoot)` that re-set the
  root and reloaded.
- `renderBreadcrumb()` — split `rootPath` on `/`, render
  clickable `.bc-item` segments, each `navigateRoot(accPath)`.
- A **non-recursive** `GET /api/files?path=<dir>` fetch
  returning `{ name, type: 'file'|'directory', size }` for one
  directory level. Dirs rendered as clickable rows that
  `navigateRoot(dir)`.

`/api/files` already exists and returns directories — it's the
right data source for browse mode.

### 4.3 Server endpoints available

- `GET /api/files?path=<abs|rel>&dotfiles=0` — one-level listing
  with `type` discriminator (file/directory), dirs-first sort.
  **This is what browse mode uses.**
- `GET /api/project-files?cwd=<root>&q=<query>` — recursive,
  files-only fuzzy search. **Stays for type-to-search.**

No new server endpoint is required.

## 5. Design

### 5.0 Normalized picker entry (the core contract)

The current picker passes bare strings around and relies on
`pickSelected(rel)` re-resolving against `cachedCwd` /
`_pickerRootOverride`. That coupling breaks the moment the
browse root differs from those roots (a searched file under
`artifacts/` would open from the session cwd). V1 fixes this by
making every picker row a **normalized entry that carries its
own absolute path**, so activation never has to guess which root
a relative path came from:

```
PickerEntry = {
  kind: 'dir' | 'file',
  abs: string,        // absolute path — the activation truth
  display: string,    // label shown (basename in browse mode,
                       //   repo-relative in search mode, abs for recents)
  recent?: boolean,
  open?: boolean,      // file already has an open tab (for "(open)")
}
```

`pickerResults` becomes `PickerEntry[]` (not strings).
`pickerVisible` entries are `PickerEntry` too. A single
dispatcher activates any entry:

```
activatePickerEntry(entry):
  if entry.kind === 'dir': navigateBrowse(entry.abs)
  else: closePicker(); openAnyPath(entry.abs)
```

Both the Enter keydown handler and the mousedown row handler
call `activatePickerEntry(entry)` — no duplicated branch logic,
and **`abs` is always the source of truth**. `openAnyPath`
already branches in-cwd vs external on an absolute path (verified:
`isExternal(abs)` false → `_relativizePath` strips cwd →
`routeOpen`; true → `routeOpenExternal`). So a searched file
under the navigated browse root opens from the correct location
whether it's in-cwd or external.

This replaces the `{ rel, recent }` shape and the
`pickSelected(rel)` indirection. `pickSelected` is removed (or
becomes a thin `openAnyPath(entry.abs)` wrapper); callers use the
dispatcher.

### 5.1 Browse root state

Add a picker-local `_browseRoot` (absolute path), distinct from
`cachedCwd` (session cwd) and `_pickerRootOverride`.

- `_pickerRootOverride` is **only the initial seed** (sessionless
  `openFinderRoot` / Ctrl+P). After open, ALL resolution
  (browse, search, copy, open) uses `_browseRoot` or absolute
  paths — never `_pickerRootOverride` again.
- On `openPicker`, `_browseRoot = _pickerRootOverride || cachedCwd || ''`.
- Breadcrumb clicks and directory-row clicks set `_browseRoot`
  and re-fetch.
- Closing the picker resets `_browseRoot` AND
  `_pickerRootOverride` to null. Next open re-seeds from the
  session cwd (or a fresh override). The browse root does not
  persist across opens in V1.

This bounds the search-scope behavior change: a **fresh open
always starts at the session cwd** (acceptance §8.12); only
explicit in-picker navigation moves the root.

### 5.2 Two picker modes

The picker displays in two modes depending on the **raw** input
(not the type-filter-parsed rest — see §5.6 on type filters):

- **Browse mode** (raw input empty): breadcrumb +
  one-level directory and file listing of `_browseRoot` from
  `/api/files`. Directories navigable.
- **Search mode** (raw input non-empty): recursive fuzzy file
  search via `/api/project-files?cwd=_browseRoot&q=`. Files only.
  Breadcrumb still shows. Search is rooted at `_browseRoot`, so
  navigating into `artifacts` then typing searches `artifacts/**`.

Search results from `/api/project-files` are repo-relative to
the `cwd` param (= `_browseRoot`). Each result is normalized to
a `PickerEntry` with `abs = join(_browseRoot, relPath)` and
`display = relPath`. Activation uses `abs` (§5.0), so the
relative-to-which-root ambiguity is eliminated.

### 5.3 Breadcrumb

Rendered between the input and the list. Ported from the old
file-finder, **including its Windows drive handling** (`C:/`
root segment vs POSIX `/`):
- Split `_browseRoot` into segments; render a root segment + each
  path part as a clickable `.fe-picker-bc-item` with `data-path`
  = accumulated absolute path.
- Click → `navigateBrowse(thatPath)`.
- Mouse-only in V1; arrow keys navigate result rows.

Port the segment-splitting logic from
`70788ff~1:applets/file-finder/script.js` `renderBreadcrumb`
rather than hand-rolling POSIX-only splitting.

### 5.4 Directory rows (browse mode)

`/api/files` entries render as `PickerEntry` rows:
- **Directory** (`kind:'dir'`): folder icon + name, class
  `.fe-picker-dir`. Activate → `navigateBrowse(entry.abs)`. No
  copy button, no "(open)" suffix.
- **File** (`kind:'file'`): icon + basename + copy + "(open)"
  suffix. `abs = join(_browseRoot, name)`. Activate →
  `openAnyPath(entry.abs)`.

### 5.5 "(open)" suffix by route identity

The current code checks `tabs.has(p)` where `p` is a
repo-relative path — which won't match browse-mode basenames or
external tabs (keyed `external:ABS`). V1 adds a helper
`isPathOpen(abs)` that checks tab existence using the **same
route identity** the open paths use:
- in-cwd → relativized path key (matches `routeOpen`'s tab id)
- external → `external:` + normalized abs (matches
  `routeOpenExternal`'s `findContainerByExternalAbs`)

`isPathOpen(entry.abs)` sets `entry.open`, and the renderer adds
the "(open)" suffix + disabled state. This makes "(open)" correct
in both browse and search modes, including external files.

### 5.6 Type filters in the two-mode design

The existing `>img`/`>md`/`>html`/`>diff`/`>any` type filters
must keep working as **recursive search** (their current
behavior). The mode branch keys on **raw input non-empty**, so
`>img` (even with empty rest after the prefix) is search mode,
NOT browse mode. The type filter then narrows the recursive
results as today. This preserves the existing shortcut: typing
`>img` searches images repo-wide (now: browse-root-wide).

`runPickerFetch` therefore branches:
- raw `q` empty → browse fetch (`/api/files?path=_browseRoot`).
- raw `q` non-empty (incl. a bare type-filter prefix) → existing
  recursive search path, type-filter parsing unchanged.

### 5.7 Navigation helper + debounce safety

`navigateBrowse(absDir)`:
- Validate non-empty absolute.
- **Cancel any pending `pickerFetchTimer`** before fetching, so a
  stale debounced search input can't land after navigation.
- `_browseRoot = absDir`; `pickerInput.value = ''`;
  `pickerLastQuery = ''`; `pickerSelectedIdx = 0`.
- Increment `pickerFetchToken`; run the browse fetch; only the
  latest token mutates `pickerResults`.
- Re-render.

`runPickerFetch` keeps the token guard for both modes: every
fetch increments the token and only the latest response renders.

### 5.8 Selection dispatch

`renderPickerList` maps each `PickerEntry` into `pickerVisible`.
Both the `pickerInput` Enter keydown and the `pickerList`
mousedown handlers route through `activatePickerEntry(entry)`
(§5.0). `movePickerSelection` is unchanged (reads
`dataset.flatIdx` + selection ids only — additive fields safe).
The copy button continues to read `copyEl.dataset.path` (now set
from `entry.abs`); directory rows have no copy button.

### 5.9 No server changes

Both endpoints exist. `/api/files` returns directories with the
`type` field and dirs-first sorting, works sessionless for
absolute paths, and requires no session. `/api/project-files` is
unchanged. All work is client-side in `applets/files/script.js`
+ CSS.

## 6. Considerations

### 6.1 Search scope follows browse root

A subtle improvement: today search is always rooted at the
session cwd. After V1, search is rooted at `_browseRoot`. So
navigating into `artifacts` then typing `render` searches
`artifacts/**`, not the whole repo. This is the intuitive
behavior and directly serves the user's "too hard to get to
subdirectories" complaint.

### 6.2 Gitignore + dotfiles in browse mode

`/api/files` does NOT respect gitignore (it's a raw directory
listing) and hides dotfiles unless `dotfiles=1`. The recursive
search DOES respect gitignore. This asymmetry is acceptable for
V1 — browse mode is "show me what's actually on disk here",
search mode is "find tracked files". Document it; don't try to
unify.

### 6.3 Recents in browse mode

Recents are stored as absolute paths and may point anywhere.
They are normalized to `PickerEntry` (`kind:'file'`,
`abs = the stored path`, `display = the stored path`,
`recent: true`) and activate through the same
`activatePickerEntry` dispatcher → `openAnyPath(abs)`. Because
recents already carry their absolute path, they were never
subject to the browse-root resolution bug; the normalized shape
just makes them consistent with the rest. V1 keeps recents
visible in browse mode at any root. A V2 could hide them when
`_browseRoot !== cachedCwd`.

### 6.4 Performance

`/api/files` is one-level and fast. No recursive walk in browse
mode. Search mode is unchanged (already cached server-side).
Navigating directories is a cheap single fetch each.

### 6.5 Sessionless mode

V7 sessionless picker uses `openFinderRoot` as `rootOverride`.
`_browseRoot` initializes from it, so breadcrumb + directory
browse work sessionless too (the data endpoints don't require a
session). Navigating up/down sessionless is fine; opening a file
routes external read-only (already the sessionless contract).

### 6.6 Keyboard model

V1: arrow keys move through `pickerVisible` (dirs + files mixed),
Enter activates (navigate into dir, or open file). Breadcrumb is
mouse-only. Backspace-on-empty still closes the picker (existing).
A future rev could add Alt+Up / Left to pop a directory level.

## 7. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Enter on a directory accidentally opens it as a file | medium | `kind` marker routes dirs to navigateBrowse; tested |
| Browse root escapes to `/` and lists huge dirs | low | `/api/files` is one-level; large dirs render as a list, acceptable; no recursion |
| Path join bugs on Windows (`\` vs `/`) | medium | Reuse existing `_isAbsolutePath` + separator logic from absPathOf; breadcrumb ported from finder which handled Windows |
| File row in an out-of-cwd browse dir opens with wrong routing | medium | Browse file rows pass ABSOLUTE path to openAnyPath, which already branches in-cwd vs external (V7) |
| Breadcrumb + recents + dirs + files clutter the overlay | medium | Sections with headers (existing pattern); verify height/scroll |
| Search mode now rooted at browse root surprises users expecting repo-wide search | low | Intuitive per §6.1; breadcrumb shows where you are |
| `pickerVisible` shape change breaks copy-button / (open) logic | medium | Extend shape additively; keep file-row behavior identical; tests for both kinds |

## 8. Acceptance

Browse mode:
1. Opening the picker (empty query) shows a breadcrumb of the
   session cwd + a one-level listing (dirs first, then files).
2. Clicking a directory row re-roots the picker into it; the
   breadcrumb extends; the listing updates to that dir.
3. Clicking a breadcrumb ancestor segment re-roots there; the
   listing updates; deeper segments disappear.
4. Clicking a file row opens that file (in-cwd if under session
   cwd, external read-only if above/outside).
5. Arrow keys move through dirs + files; Enter on a dir
   navigates into it; Enter on a file opens it.
6. Navigating above the session cwd (e.g. to `~/repo`) and into
   a sibling dir works; opening a file there opens read-only.

Search mode:
7. Typing a query searches recursively rooted at the current
   browse root (not always the session cwd); results are files
   only; the breadcrumb still shows.
8. Clearing the query returns to browse mode at the same browse
   root.
8a. **Search-after-navigate opens the correct file**: session
    cwd `/repo/hull`, navigate into `artifacts`, search
    `render`, open the result → opens
    `/repo/hull/artifacts/render.png`, NOT `/repo/hull/render.png`.
    (The browse-root resolution-bug guard.)
8b. A bare type-filter prefix (`>img`) is treated as search mode
    (recursive, image-filtered), not browse mode.

Sessionless:
9. With `openFinderRoot`, the picker browses from that root with
   working breadcrumb + directory navigation.

Regression:
10. The existing recursive search, Recent section, type-filter
    chip, copy button, "(open)" suffix, and Ctrl+P open still
    work.
11. Opening a file under the session cwd still routes in-cwd
    (relativized) exactly as before.
12. **A fresh picker open always starts at the session cwd** —
    navigation does not persist across opens; reopening after
    navigating away resets the browse root to the session cwd.

Edge cases:
13. An empty directory shows an empty-listing state (breadcrumb
    still present, no rows).
14. An unreadable / nonexistent directory shows an error state
    without crashing the picker.
15. Windows drive root (`C:\`) renders a correct breadcrumb root
    segment and navigates correctly.
16. "(open)" suffix appears for an already-open file in browse
    mode, including an external (out-of-cwd) open tab.

## 9. Out of scope (parking lot)

- Persistent file-tree sidebar.
- Breadcrumb keyboard navigation (Alt+Up to pop a level).
- Unifying gitignore behavior between browse + search.
- Hiding recents when browsing away from the session cwd.
- Remembering the last browse root across picker opens.
- Directory creation / file operations.
- A leading `../` row (impl may add; not required).
