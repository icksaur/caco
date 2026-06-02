# File Edits V3.1 — Fuzzy-open arbitrary files

Builds on V2.1 (`docs/file-edits-v2.1.md`, shipped on `file-edits-v2`).
First V3 increment; smallest useful slice of the V3 "file navigability"
theme.

## Goal

The user can add any file in the repo to the stacked viewer without
needing to edit it first. Pick from a fuzzy-filtered list keyed to the
session's `cwd`. Picked files behave exactly like cards the agent
created — persisted, dismissible, syntax-highlighted, diff-aware if
the file later changes.

> "It's almost a decent read-only text editor. It's unable to open
> files without edits occurring though." — operator, 2026-06-01

## Scope (locked)

- New "+" button in the applet toolbar.
- Click → text input with a fuzzy-filtered file list below it.
- Up/down + Enter to pick; Esc to dismiss; click outside to dismiss.
- Picked path → new card prepended-at-bottom (existing append rule).
- The picked card persists like any other (V2.1 mechanism).

## Non-goals (V3.1)

- Multi-select. One file per pick.
- Gitignored files. The list comes from `/api/project-files` which
  honors `.gitignore` by default.
- **Dotfiles**. `/api/project-files` defaults to excluding any file
  whose name starts with `.` (e.g. `.env`, `.eslintrc.json`,
  `.github/workflows/*.yml`). V3.1 inherits that behavior; the picker
  does not surface a dotfile toggle. A future revision can add a
  checkbox that re-fetches with `dotfiles=1`.
- Binary files. Filtered out server-side already (`BINARY_EXTENSIONS`
  set in `routes/api.ts`).
- Files outside the session's `cwd`.
- Files beyond the 10,000-file cap (`FILE_LIST_CAP` in
  `routes/api.ts`). On very large repos some files may be unreachable
  via the picker.
- Files created in the last 30s. `/api/project-files` has a 30s LRU
  cache; freshly-created files may not appear immediately. fsmonitor
  (V3 backlog) would close this gap.
- Tree view / browser. Separate V3 item.
- Recent files / pin / star / bookmarks. Separate V3 items.
- Drag-to-reorder. V3 backlog.

## Preserved V2/V2.1 invariants

- Cards are never reordered after creation.
- New cards always `appendChild` to the stream.
- Persisted card list and dismissed set unchanged in shape.
- The 50-card cap still applies; the user can pick a file that triggers
  cap eviction of the oldest clean card.

---

## UX

### "+" button

- Placed in `.fe-toolbar` between `.fe-counts` (which has
  `margin-right: auto`) and the `Refresh` button.
- Icon-only (`+`) at the same visual weight as Refresh.
- Hover label: "Open file in viewer."
- Disabled when no session is active (sessionId null) or when the cwd
  is not a git repo (snapshot endpoint returns the not-a-git-repo
  signal — we already gate on this).

### Popup

Click "+" → a popup anchored below the toolbar opens with:

- a text input on top (autofocus, placeholder "Search files…")
- a scrollable list of paths below it
- the topmost match selected by default; selection styled with the
  Caco accent background

- Input is autofocused.
- Empty query → top 50 alphabetically.
- Typing → live filter via `GET /api/project-files?cwd=<sessionCwd>&q=<query>`
  (server already does fuzzy scoring + ranking).
- The server returns up to its 10,000-file cap with no rank limit; the
  client slices `response.files.slice(0, 50)` for rendering.
- Highlight the selected row with the Caco accent.
- Already-open paths show a subtle `(open)` suffix and select-disabled
  styling (clicking does nothing).
- Already-dismissed paths show a subtle `(dismissed)` suffix and act as
  "re-open" — selecting un-dismisses and creates the card.

### Keyboard

- Up / Down: change selection. Scrolls into view if necessary.
- Enter: pick.
- Esc: close popup without picking.
- Backspace from empty input: close.
- Tab: pick (Enter alias).
- Click outside: close.

### Pick result

1. Remove the path from `dismissed` if present (re-open semantics).
2. If a card already exists for that path: no-op (popup pre-empts via
   `(open)` suffix, but be defensive).
3. Otherwise: create a clean card at the bottom of the stream with the
   full file content visible by default.
4. Schedule persist (250ms debounce).
5. Close the popup. The new card scrolls into view via the existing
   Autoscroll path (if applicable) — but this is a USER gesture, so
   the existing user-gesture-enters-Sticky rule applies: do NOT
   autoscroll. The user picked it, they see it appear at the bottom;
   they scroll if they want.

---

## Server

### Reuse `/api/project-files`

Already exists in `src/routes/api.ts:539`:

- `cwd` query param (we'll pass the session's cwd).
- `q` query param for fuzzy filter.
- 30s file-list cache per `(rootDir, dotfiles, ignore)` triple.
- 10,000-file cap with binary-extension and excluded-dir filtering.
- Respects `.gitignore` by default.

No changes needed. The existing cache is shared across all features
that use this endpoint, which is fine.

### Build the card payload

We need to materialize a card for an arbitrary path. Three cases:

1. **Path is in the current dirty set.** Build a normal dirty
   `EditEntry` via the existing `buildEntry(repoRoot, path, info)`
   path.
2. **Path is tracked + clean** (in HEAD, not dirty). Build via
   `buildCleanEntry(repoRoot, relPath)` — V2.1 logic. Returns an
   `EditEntry` with `status: 'clean'` and a `fullFile` payload
   (workLines = headLines, hunks = []).
3. **Path is untracked.** Need a new `buildUntrackedEntry(repoRoot,
   relPath)`. **It must NOT use `hunks: []`** — the client's
   `buildRows(null, workLines, [])` returns an empty row list (since
   `headLines=null` skips the tail emit and there are no hunks to
   walk), and the card body would render "(no visible changes)".

   Instead the helper synthesizes the same shape that V2.1's
   `computeFullFile` produces for untracked status:

   ```ts
   async function buildUntrackedEntry(repoRoot, relPath): Promise<EditEntry | null> {
     const absPath = join(repoRoot, relPath);
     let workText;
     try { workText = await readFile(absPath, 'utf-8'); } catch { return null; }
     const workLines = toLines(workText);
     if (workLines.length > FULLFILE_LINE_CAP) {
       return { path: absPath, relativePath: relPath, status: 'untracked',
                timestamp: new Date().toISOString() };  // header-only fallback
     }
     return {
       path: absPath,
       relativePath: relPath,
       status: 'untracked',
       timestamp: new Date().toISOString(),
       fullFile: {
         headLines: null,
         workLines,
         hunks: [{ headStart: 0, headLen: 0,
                   workStart: 1, workLen: workLines.length }],
       },
     };
   }
   ```

   That single synthetic hunk is what triggers the all-add rendering
   in `buildRows`.

### `GitEditPoller` interface extension

The new helpers (`buildUntrackedEntry`) and the existing private ones
(`buildEntry`, `buildCleanEntry`, plus access to the per-session
`repoRoot`) live in `createGitEditPoller()`'s closure. The route
handler holds only a `GitEditPoller` interface reference; it cannot
reach them.

Add one method to the interface:

```ts
export interface GitEditPoller {
  // ...existing methods...
  /** V3.1: materialize an EditEntry for an arbitrary path in the
   *  session's repo. Returns null if the session is unknown, the
   *  repo isn't a git repo, or the path doesn't exist in HEAD or
   *  the working tree. */
  openFile(sessionId: string, relPath: string): Promise<EditEntry | null>;
}
```

Implement inside the closure: look up `state = sessions.get(sessionId)`,
return null if missing, then run the case-branch (dirty / clean /
untracked) using existing private helpers. All git logic stays inside
the poller — the route handler is a thin wrapper.

### New route

`POST /api/sessions/:sessionId/file-edits/open`

Body:
```json
{ "relativePath": "src/foo.ts" }
```

Response:
- `200 { edit: EditEntry }` — the materialized entry for the picked
  path. The client uses this to populate the card body immediately.
- `404` — session unknown, repo not a git repo, or path doesn't exist
  in HEAD or working tree.
- `400` — relativePath missing, empty, contains `..` segment, absolute
  path, contains a NUL byte, resolves outside the repo root, or
  resolves to a directory rather than a file.

Validation (server-side, before calling `poller.openFile`):

1. `typeof relativePath === 'string'` and non-empty.
2. `!relativePath.includes('\0')` (NUL would be treated as the
   porcelain path separator).
3. `!relativePath.startsWith('/')` (no absolute).
4. `!relativePath.split(/[/\\]/).includes('..')` (no parent-dir
   segments).
5. Post-`resolve(join(repoRoot, relPath))`: assert the resolved
   absolute path starts with `repoRoot + path.sep` (defends against
   symlinks pointing outside the repo).
6. `(await stat(abs)).isFile()` — directories are rejected. Skip step
   6 if the path doesn't exist on disk (might be a tracked-but-
   deleted file; the poller handles that case).

Behavior inside `openFile(sessionId, relPath)`:

1. `state = sessions.get(sessionId)`; if missing, return null.
2. Run `git status --porcelain=v1 -z -u -- <relPath>` (NOT
   `--no-renames`; matches the existing poller — the per-path filter
   limits the output to one or two entries so handling is trivial).
3. Parse the single-entry porcelain output. If non-empty:
   - status `??` → `buildUntrackedEntry`
   - status `M`/`A`/`D` → `buildEntry`
   - status `R`/`C` (a rename) → `buildEntry`, which already handles
     the second NUL field for the rename source. For the per-path
     query this case is rare but possible.
4. If porcelain output is empty (path is clean), check `git show
   HEAD:<relPath>` returns 0 → `buildCleanEntry`. Else return null.

The endpoint does NOT modify the persisted card list. The client owns
that; it PUTs after creating the card (existing V2.1 flow).

### Why not just have the client build the card from `buildCleanEntry`'s output?

Two reasons. First, the client doesn't know whether a path is dirty,
untracked, or clean without asking the server. Second, the server
already owns the `git show` + `git diff` calls; replicating in the
client wastes a roundtrip and forks the logic.

---

## Client

### Toolbar button

Add to `applets/file-edits/content.html` between counts and Refresh:

```html
<button class="fe-btn" id="feOpen" title="Open file in viewer">+</button>
```

### Popup component

Implement locally in `applets/file-edits/script.js`. The popup is a
single absolute-positioned `<div>` attached to `.fe-root`. Structure:

```html
<div class="fe-picker" hidden>
  <input class="fe-picker-input" type="text" placeholder="Search files…" />
  <ul class="fe-picker-list"></ul>
</div>
```

Behavior closely mirrors `InputPopup` (the existing main-bundle
component, which we can't import directly). 100-line implementation;
no dependency on the rest of the applet's state machine.

State:
- `pickerOpen: boolean`
- `pickerResults: string[]` (relative paths)
- `pickerSelectedIdx: number`
- `pickerLastQuery: string`
- `pickerFetchToken: number` (later-query-wins for the fuzzy fetch)
- `pickerOpenAbort: AbortController | null` (for cancelling the
  per-pick `/file-edits/open` call on session change)
- `cachedCwd: string` — set from `info.cwd` in `onSessionChange` and
  from `meta.cwd` (`appletAPI.getSessionMeta`) in the initial
  `getSessionId` path. Cleared on session change before the next
  session's meta arrives.

### Fuzzy fetch

Debounce 100ms. Build `/api/project-files?cwd=<cwd>&q=<query>` and
fetch. Discard if `pickerFetchToken` has changed (later query in
flight). Update list on success.

### Pick → create card

```js
async function pickFile(relativePath) {
  closePicker();
  // De-dupe with existing cards (popup pre-empts but be defensive)
  if (cards.has(relativePath)) return;
  // Cancel any prior open call (session change may have fired)
  if (pickerOpenAbort) pickerOpenAbort.abort();
  pickerOpenAbort = new AbortController();
  const sid = sessionId;  // capture: session may change while fetching
  let edit;
  try {
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(sid)}/file-edits/open`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relativePath }),
        signal: pickerOpenAbort.signal,
      }
    );
    if (!res.ok) {
      showToast('Could not open ' + relativePath);
      return;
    }
    ({ edit } = await res.json());
  } catch (err) {
    if (err.name === 'AbortError') return;
    showToast('Could not open ' + relativePath);
    return;
  }
  // Race guard: if session changed mid-fetch, drop the result.
  if (sid !== sessionId) return;
  // Now safe to mutate state: clear dismiss for re-open semantics,
  // then dispatch via applyEdits with suppressScroll so the new card
  // doesn't yank the viewport (this is a UI gesture, not an edit
  // arriving from the agent).
  dismissed.delete(relativePath);
  applyEdits([edit], [], [], { suppressScroll: true });
}
```

Notes on the changes from the V2.1 behavior:

- **Dismissed cleared AFTER successful open.** A failed `/open` (404,
  validation error, network) leaves the path dismissed. Re-pick
  attempts re-fire `/open`. Once `/open` returns 200, we know the
  card is about to be created, so clearing dismissed is safe.
- **`AbortController`** cancels the in-flight `/open` when the user
  switches sessions (see §"Session change" below).
- **`sid !== sessionId` race guard** is the belt-and-braces check in
  case the abort race somehow loses (the abort signal fires after the
  response has already been read, etc.). Cheap.
- **`applyEdits([edit], [], [], { suppressScroll: true })`** —
  requires a small extension to `applyEdits`: add an optional fourth
  argument `{ suppressScroll?: boolean }`. When truthy, skip the
  `scrollToCard(topmostChangedCard)` call in the autoscroll branch.
  Sticky-mode behavior is unchanged (sticky already preserves scroll
  position).

### `applyEdits` signature extension

```ts
function applyEdits(edits, cleared, cleanedEdits, options) {
  options = options || {};
  // ...existing code, except the autoscroll branch:
  } else {
    applyAll();
    if (topmostChangedCard && !options.suppressScroll) {
      scrollToCard(topmostChangedCard);
    }
  }
}
```

All other callers (`fetchSnapshot`, the `caco.edit` WS handler) pass
no fourth argument and get unchanged behavior.

### Session change cleanup

In `onSessionChange` (script.js, after the flushPersist call):

```js
closePicker();
if (pickerOpenAbort) {
  pickerOpenAbort.abort();
  pickerOpenAbort = null;
}
cachedCwd = '';
```

`cachedCwd` is repopulated by `info.cwd` immediately after, when
that's provided.


### CSS

Drop into `applets/file-edits/style.css`. Themed off Caco tokens:

```css
.fe-picker {
  position: absolute;
  top: 36px;  /* below toolbar */
  left: var(--space-md);
  right: var(--space-md);
  max-height: 60%;
  background: var(--bg-raised);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  z-index: 20;
  display: flex;
  flex-direction: column;
}
.fe-picker-input {
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--color-border);
  color: var(--color-text-bright);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  padding: var(--space-sm) var(--space-md);
  outline: none;
}
.fe-picker-list {
  list-style: none;
  margin: 0; padding: 0;
  overflow-y: auto;
  max-height: 400px;
}
.fe-picker-item {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  padding: 4px var(--space-md);
  color: var(--color-text);
  cursor: pointer;
}
.fe-picker-item.selected {
  background: var(--color-accent);
  color: white;
}
.fe-picker-item.disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.fe-picker-suffix {
  color: var(--color-text-muted);
  margin-left: var(--space-sm);
  font-size: var(--text-xs);
}
```

---

## Edge cases

- **Path picked is currently dirty.** Server returns dirty `EditEntry`
  with full diff. Card displays diff body. Subsequent polls update
  normally.
- **Path picked goes dirty after open.** Normal poll path: the card
  exists; `applyEdits` finds it and re-renders via `_renderDiff`.
- **Path picked is later deleted from working tree AND HEAD.** Card
  becomes a stale persisted entry. Same handling as any other stale
  persisted card (V3 backlog has a stale-cleanup item).
- **Path picked is `.gitignore`d.** Doesn't appear in `/project-files`
  results. The user must un-ignore or use a future "ignore-aware
  toggle" V3 item. Acceptable for V3.1.
- **Path picked is over `FULLFILE_LINE_CAP` lines (5000).** `buildCleanEntry`
  already returns a header-only entry (no `fullFile`). Card shows the
  header with no body. Future work could add a "view in text-editor"
  link.
- **Session change with picker open.** Close the picker.
- **Network failure on `/open`.** Show a toast; do nothing else. No
  partial card is created. (The dismissed-clear above the fetch is
  potentially a small leak — fix: only clear dismissed AFTER successful
  open.)

---

## Acceptance

1. Click "+" → popup opens with input focused.
2. Type "git-edit-poller" → top result is `src/git-edit-poller.ts`.
3. Enter → popup closes, card appears at bottom showing full file body
   with hljs highlighting (it's a tracked clean .ts file).
4. Click "+", type "README", Enter → README.md card appears.
5. Close applet, reopen → both cards still there in pick order.
6. Pick a file that's already open → popup shows `(open)` and Enter
   does nothing.
7. Pick a file that was X-dismissed earlier → popup shows `(dismissed)`,
   Enter re-creates the card.
8. Pick a file that is currently dirty (modified) → card shows diff
   body, not full content. Subsequent edits update normally.
9. Esc closes picker. Click outside closes picker.
10. Picking 51 distinct files triggers cap eviction (oldest clean
    first); the new card is visible at bottom.
11. Pick a file that is new/untracked (not yet `git add`-ed) → card
    shows full file content with all-add (green) highlighting. The
    gutter HEAD column is blank for every line.
12. With the user scrolled to the top of the stream (Autoscroll mode):
    pick a file → card appears at the bottom but the viewport does
    NOT scroll (suppressScroll honored).
13. Open the picker, type a query, switch to a different session
    before the `/open` response arrives → no card created in either
    session (race guard).
14. POST `/file-edits/open` with `relativePath: "../outside"`, `"/abs"`,
    `"src\u0000foo"`, or `"src/"` (a directory) → 400.

---

## Risks

- **Picker UX divergence from main-bundle InputPopup.** Two
  implementations of the same pattern. Acceptable: applets can't
  import bundle components today; the picker is small enough.
- **`/project-files` 30s cache staleness.** If the user creates a new
  file just before opening the picker, it may not appear for up to
  30s. Mitigation: V3 has fsmonitor planned which would invalidate
  the cache.
- **Card persistence for picked files is the same as agent-touched
  files.** The persistence JSON doesn't distinguish "picked by user"
  vs "agent-modified", so on next reopen there's no way to tell. This
  matters only if we want different cap-eviction priority later
  (e.g. pinned > picked > clean). Defer to the pin V3 item.

## Open questions

1. **Should the picker show only files NOT in the dirty set?** The
   user can already see dirty files in their card stack; showing them
   in the picker is redundant. Recommend: show all, with `(open)`
   suffix on dirty paths (which are always already open).
2. **Glob support in the picker.** `src/*.ts` style. Skip for V3.1
   unless trivial — fuzzy is good enough for most cases.
3. **Recent picks history.** Per session, top 5? Skip for V3.1; pin
   is a separate item.
4. **Should picked-but-clean cards start collapsed or expanded?**
   V2/V2.1 default is expanded. Recommend: expanded (consistency).
   Operator override possible later.

## Document layout

- `docs/file-edits.md` — V1 + V3 backlog (file-navigability section).
- `docs/file-edits-v2.md` — V2 spec.
- `docs/file-edits-v2.1.md` — V2.1 spec.
- `docs/file-edits-v3.1.md` — this doc.
- `docs/file-edits-v3.1-review.md` — review log (after review).
