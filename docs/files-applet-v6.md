# files-applet V6 — git-diff deprecation

**Status:** spec (not yet implemented)
**Branch:** `files-applet-v6` (to be created)
**Predecessors:** V5 (`docs/files-applet-v5.md`)
**Roadmap:** `docs/files-applet-roadmap.md`

## 1. Goal

Retire `git-diff` as a distinct applet. The `files` applet already
shows working-tree (unstaged) diffs per file. V6 extends the same
DiffViewer to cover the two modes git-diff added on top:

1. **Staged diff** — `git diff --cached -- <file>`.
2. **Ref-range diff for a single file** — `git diff <ref> -- <file>`.

Both modes render in the same per-file diff tab. No new tab type.
Multi-file ref-range view (the "show me the whole commit") is
explicitly **out of scope** (§3).

`git-diff` then becomes a V5-style conditional redirect stub:
when a session exists, redirect to the equivalent `files` URL;
otherwise fall through. `git-status`'s two link sites switch to
`files` directly.

## 2. Why now

The user pointed out that the V5 review's "git-diff has staged
+ ref-range capabilities" framing was misleading: git-diff has
no staging *controls* (git-status owns those); it's a read-only
diff view. The remaining distinction — "shows the staged version
of a diff" — is a one-line shell argument away from the
existing DiffViewer. Keeping a separate applet for it is a UX
split (click file → leave to a different applet → click back)
that has no functional payoff.

V5 already established the conditional-stub pattern and the
`SLUG_ALIASES` plumbing. V6 reuses both. The marginal cost of
shipping V6 now is low; the cost of NOT shipping is that every
future V has to keep saying "and don't forget git-diff."

## 3. Non-goals

- **Multi-file ref-range view** (`git diff HEAD~1..HEAD` as one
  surface). That requires a different tab model than per-file
  files-applet tabs. If/when we want it, the right home is
  probably git-status — a per-commit detail row with a file
  list and per-file open-in-files links. Not V6.
- **Cross-commit blame, three-way conflict view, or
  interactive rebase**. Out of scope.
- **Removing the `git-diff` stub directory**. Same rule as the
  V5 stubs: it stays on disk for back-compat (chat history,
  bookmarks). V7+ may sweep.
- **Per-line stage/unstage controls in the diff viewer**.
  git-status owns staging. The diff viewer is read-only. (A
  future "interactive staging in the diff viewer" is a real
  feature worth speccing separately.)
- **Renaming TS files** (`src/routes/file-edits.ts` etc.).
  Same defer as V5 §3.
- A new tab type or alternative diff layout.

## 4. Ownership and relationships

### 4.1 The `files` applet — extended DiffViewer

The existing DiffViewer (`applets/files/diff-viewer.js`)
currently fetches its `edit` payload via
`POST /api/sessions/:sid/file-edits/open` with body
`{ relativePath }`. The endpoint runs the git-edit poller's
`openFile(sid, relPath)`, which produces an `EditEntry` for the
working-tree (unstaged-vs-HEAD) diff.

V6 extends both the API endpoint and the poller's `openFile` to
accept an optional `diffMode` field:

- `'unstaged'` (default — current behavior, working-tree vs.
  index for tracked files; working-tree vs. /dev/null for
  untracked; HEAD-only diff for files clean in worktree).
- `'staged'` — index vs. HEAD (`git diff --cached -- <relPath>`).
- `'range'` — `git diff <ref> -- <relPath>`. Requires an
  additional `ref` field (e.g. `'HEAD~1..HEAD'` or any valid
  git revision range).

The DiffViewer remains otherwise unchanged. It renders the diff
text it receives; it does not know or care which mode produced
the text. The mode is reflected only in the tab label (§4.4).

### 4.2 URL params for the `files` applet

V6 adds three new URL params to `files`:

- `?diffMode=unstaged|staged|range` — chosen explicitly. Default
  is `unstaged` when omitted, matching current behavior.
- `?diffRef=<ref>` — required when `diffMode=range`. Ignored
  otherwise.
- `?openPath=ABS` (existing, no change) — the file to open.

Example links:

- `?applet=files&openPath=ABS&diffMode=staged`
- `?applet=files&openPath=ABS&diffMode=range&diffRef=HEAD~1..HEAD`
- `?applet=files&openPath=ABS` (unchanged; defaults to unstaged)

### 4.3 Tab identity — collision-safe

The current TabContainer constructor hard-codes
`this.id = descriptor.viewerType === 'markdown' ? 'markdown:' + absPath : relPath`
(`applets/files/script.js:215-223`). V6 needs an explicit
diff-mode-aware id source. Two requirements:

1. The id MUST NOT collide with any user-supplied relPath, even
   one that happens to start with `diff-staged:` or `diff-range:`.
2. The id MUST NOT be ambiguous between different
   `(diffRef, relPath)` pairs.

V6 introduces a `diffTabId({ mode, ref, relPath })` helper that
returns:

- `mode === 'unstaged'` (default): `relPath` — V1 schema, no
  change. Backward-compatible with persisted cards.
- `mode === 'staged'`: `'\u0000diff-staged\u0000' + relPath`.
  The `\u0000` (NUL) sentinel is rejected from real file paths
  by the API (`src/routes/file-edits.ts:72` already rejects
  `relPath.includes('\0')`), so it cannot collide with any
  valid file's id.
- `mode === 'range'`: `'\u0000diff-range\u0000' + len(ref) + '\u0000' + ref + relPath`.
  The length-prefix on the ref disambiguates any
  `(ref, relPath)` pair (otherwise `ref="foo"+relPath="bar"` and
  `ref="fooba"+relPath="r"` collide).

The TabContainer constructor reads the descriptor (extended in
§4.x) to learn the mode/ref instead of hard-coding the
markdown/diff switch:

```javascript
this.diffMode = descriptor.diffMode || 'unstaged';
this.diffRef = descriptor.diffRef || null;
if (descriptor.viewerType === 'markdown') {
  this.id = 'markdown:' + absPath;
} else {
  this.id = diffTabId({
    mode: this.diffMode,
    ref: this.diffRef,
    relPath: relPath,
  });
}
```

`diffTabId` lives near the top of script.js with the other
pure helpers.

### 4.3.1 `findContainerByRelPath` becomes mode-aware

`findContainerByRelPath` (`applets/files/script.js:159-165`)
currently returns the first container with `c.relPath === relPath`
regardless of mode. It is used by **more than the poller**:

- `routeOpen` activates an existing tab before opening anything
  (`script.js:2262-2271`). Today, a deep link to
  `?openPath=ABS&diffMode=staged` would find an existing
  unstaged tab and focus it — silently dropping the requested
  mode.
- `routeOpen` race re-check (`script.js:2294-2301`).
- `openOrUpdateTab` for `caco.edit` updates
  (`script.js:1417-1424`).
- (Search for additional `findContainerByRelPath` call sites
  during implementation to confirm.)

V6 makes the helper mode-aware:

```javascript
function findContainerByRelPath(relPath, opts) {
  opts = opts || {};
  var wantMode = opts.mode || null;       // null = any
  var wantRef = opts.ref || null;
  var found = null;
  tabs.forEach(function(c) {
    if (found) return;
    if (c.relPath !== relPath) return;
    if (wantMode && c.diffMode !== wantMode) return;
    if (wantRef !== null && c.diffRef !== wantRef) return;
    found = c;
  });
  return found;
}
```

Call sites change:

- `routeOpen`: passes `{ mode, ref }` from the URL params, so a
  staged-mode deep link does not find an unstaged tab.
- `openOrUpdateTab` (poller): passes `{ mode: 'unstaged' }` so
  `caco.edit` never finds a staged/range tab.
- All other callers: audit. Default behavior (no `opts`) keeps
  current "find any tab for this path" semantics for callers
  that legitimately want it (e.g. existing markdown/diff
  dedup) — but document those call sites.

### 4.4 Tab labels and titles

V6 distinguishes modes visually:

| diffMode | Tab label | Title attr |
|---|---|---|
| `unstaged` | `<basename>` | `<relPath>` (current) |
| `staged` | `<basename> · staged` | `<relPath> (staged)` |
| `range` | `<basename> · <ref>` | `<relPath> at <ref>` |

The `· staged` and `· <ref>` suffixes use a small dim span so
the basename stays the dominant glyph.

### 4.5 The `git-diff` deprecation stub

Identical pattern to V5 standalone stubs. Wrap the existing
`applets/git-diff/script.js` body in a conditional-redirect
IIFE that fires only when `appletAPI.getSessionId()` is truthy.

URL translations:

| Old git-diff URL | Translates to |
|---|---|
| `?applet=git-diff&path=REPO&file=REL` | `?applet=files&openPath=ABS` |
| `?applet=git-diff&path=REPO&file=REL&staged=1` | `?applet=files&openPath=ABS&diffMode=staged` |
| `?applet=git-diff&path=REPO&file=REL&ref=R` | `?applet=files&openPath=ABS&diffMode=range&diffRef=R` |
| `?applet=git-diff&path=REPO&ref=R` (no file) | `?applet=git-status&path=REPO` (§5.5) |

`ABS` is computed via the join helper in §4.6.1.

`meta.json` gains `deprecated: true` and `replacedBy: "files"`.

**No `SLUG_ALIASES` entry for `git-diff`.** Aliases assume the
same URL param shape; git-diff's params (`path`, `file`,
`staged`, `ref`) differ from `files`' (`openPath`, `diffMode`,
`diffRef`). The conditional stub owns URL translation.

### 4.6 git-status caller updates

`applets/git-status/script.js` has two call sites:

- Line ~158 (`viewDiff(filePath, staged)`): builds the diff URL.
  git-status already knows the absolute repo path from URL `path`
  or `info.cwd` (`script.js:648-707`), and parsed git status
  paths are repo-relative (`script.js:77-121`). V6 changes the
  output to `?applet=files&openPath=<joinPath(repoPath, filePath)>&diffMode=<staged?'staged':'unstaged'>`.
- Line ~518 (last-commit "View diff" link): see §6.5 — the
  link is removed in V6 (no multi-file view exists yet).

#### 4.6.1 Path join helper

V6 adds a small helper inside git-status's script.js:

```javascript
function joinPath(base, rel) {
  if (!base) return rel;
  if (!rel) return base;
  var trimmedBase = base.replace(/[\/\\]+$/, '');
  var trimmedRel = rel.replace(/^[\/\\]+/, '');
  // Pick separator from base (Windows backslash-only path keeps
  // backslashes; everything else POSIX-joins).
  var sep = trimmedBase.indexOf('\\') >= 0 && trimmedBase.indexOf('/') < 0
    ? '\\' : '/';
  return trimmedBase + sep + trimmedRel;
}
```

URL construction uses `URLSearchParams` to avoid manual
escaping bugs:

```javascript
var url = new URL('/', window.location.origin);
var sp = url.searchParams;
sp.set('applet', 'files');
sp.set('openPath', joinPath(repoPath, filePath));
if (staged) sp.set('diffMode', 'staged');
window.location.href = url.toString();
```

### 4.7 Caller of git-status's `viewDiff`

`viewDiff` is the only caller of git-diff URLs from git-status.
After V6's update it produces `files` URLs. The files applet
handles them in the same code path as any other `openPath`
(V3.y.1), with the new `diffMode` / `diffRef` params consumed
by the DiffViewer construction (§4.x).

### 4.x DiffViewer.open vs DiffViewer.fromEdit

`DiffViewer.open` (`applets/files/diff-viewer.js:142-161`)
currently POSTs `/api/sessions/:sid/file-edits/open` with body
`{ relativePath }`. V6 extends the signature:

```javascript
DiffViewer.open = async function(shell, container, absPath, relativePath, opts) {
  opts = opts || {};
  var body = { relativePath: relativePath };
  if (opts.diffMode && opts.diffMode !== 'unstaged') {
    body.diffMode = opts.diffMode;
    if (opts.diffMode === 'range') {
      body.ref = opts.ref || '';
    }
  }
  var res = await fetch(
    '/api/sessions/' + encodeURIComponent(shell.sessionId) + '/file-edits/open',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  // ...existing response handling...
};
```

`DiffViewer.fromEdit` (`diff-viewer.js:167-171`) remains
narrow: it constructs a DiffViewer from a pre-fetched poller
edit payload (working-tree-only). Callers:

- `openOrUpdateTab` (poller-driven): unchanged — poller only
  produces unstaged edits, so `fromEdit` is correct here.
- `applyAgentState`: unchanged — agent text selection is
  diff-only and unstaged-only by design (already filtered
  earlier in the function).
- Persistence rehydrate: V6 changes the staged/range rehydrate
  paths to use `DiffViewer.open` with the persisted
  `diffMode`/`diffRef` instead of the unstaged placeholder
  pattern (§6.2).

The descriptor passed to TabContainer for staged/range tabs
carries `diffMode` and `diffRef` so the constructor can wire
the id (§4.3) and the open path can pass through to
`DiffViewer.open`.

### 4.8 Refresh action for staged/range tabs

The files applet already has chrome-button infrastructure:
viewers expose `getChromeButtons()` and `TabContainer.updateChromeButtons()`
renders mode-conditional buttons
(`applets/files/script.js:461-571`). V6 adds:

- `DiffViewer.prototype.getChromeButtons` returning a refresh
  button object when `container.diffMode` is `'staged'` or
  `'range'`; empty array otherwise.
- `DiffViewer.prototype.reload` method that re-runs the
  fetch path (`DiffViewer.open`'s POST) for the current
  mode/ref, replaces `this.edit`, and re-renders.

The refresh button is **not** added for unstaged mode because
the poller already keeps that tab live via `caco.edit`.

## 5. Code analysis

### 5.1 `EditEntry` schema

`EditEntry` (defined in `src/types/edit.ts` or wherever — verify
during implementation) currently models a working-tree edit:
`relativePath`, `path`, `status`, `diff`, `isBinary`, etc. V6
**does not** add new fields to `EditEntry`. It produces the same
shape; only the `diff` content and `status` reflect the mode.

For `staged` mode, `status` becomes one of `'staged'` or
similar — TBD during implementation, based on what the existing
DiffViewer renders for. If the existing
status-driven rendering needs a new status value, add it; if it
treats unknown statuses as "show the diff as-is," no change.

For `range` mode, `status` is `'range'` and `diff` is the
output of `git diff <ref> -- <relPath>`. No working-tree
concepts apply.

### 5.2 Poller `openFile` extension

`git-edit-poller.ts:628` declares
`openFile(sessionId, relPath)`. V6 extends to
`openFile(sessionId, relPath, opts?: { diffMode?: 'unstaged' | 'staged' | 'range'; ref?: string })`.

- `diffMode === 'unstaged'` or omitted: existing code path
  unchanged.
- `diffMode === 'staged'`: skip the porcelain status flow; run
  `git diff --cached -- <relPath>` directly; build an
  EditEntry with the diff text and `status: 'staged'`. The
  poller doesn't track staged diffs in its session state (no
  watchers, no rev-after-rev compare) — staged is a snapshot
  at the moment of open.
- `diffMode === 'range'`: similarly run
  `git diff <ref> -- <relPath>`; build an EditEntry with
  `status: 'range'`. Validate `ref` before splicing into the
  args (§5.3).

### 5.3 `ref` validation — documented supported subset

`ref` arrives from a URL param. It is interpolated into a
`git diff <ref> --` argv. The `ref` value is passed as an array
element to `child_process.spawn`, NOT shell-interpreted, so
shell-injection is not a concern. The validation rules must
still protect against argv confusion and constrain the spec to
forms V6 actually intends to support.

**Supported subset (intentionally narrow for V6):**

- Branch / tag names: `master`, `v1.2.3`, `feature/x`
- Hashes (any length): `abc123`, `cafef00d`
- `HEAD` and ancestor shorthand: `HEAD`, `HEAD~`, `HEAD~3`,
  `HEAD^`, `HEAD^^`
- Ranges: `A..B`, `A...B`

**Not supported in V6:**

- `@{...}` reflog syntax (would need `{` and `}` allowed; few
  users hand-type these in URLs).
- `^{...}` peeling, `:/regex` magic, `^!`, `^-` (specialized).
- Pathspec-after-colon (e.g. `HEAD:src/foo.ts`) — conflicts with
  V6's "one file at a time, file passed separately" model.

**Validation regex:**

```
/^[A-Za-z0-9_][A-Za-z0-9_./^~-]*(\.\.\.?[A-Za-z0-9_][A-Za-z0-9_./^~-]*)?$/
```

- First char alphanumeric or `_` (excludes leading `-`, NUL,
  control chars, whitespace, `--`-confusion).
- Body chars limited to alphanumeric, `_`, `.`, `/`, `^`, `~`, `-`.
- Optional `..` or `...` separator between two ref-shaped tokens
  for ranges.

Invalid refs return 400 from the API. Legit-but-not-resolvable
refs (typo'd hash) return 404, surfaced as a tab error message.

If a user needs an unsupported form, they can use the agent or
a terminal. Expanding the grammar is a V7+ candidate.

### 5.4 Poller `caco.edit` events do NOT update staged/range tabs

The poller emits `caco.edit` events only for working-tree
changes (its purpose). Staged and range tabs are snapshots —
they do not update when the staging area or commits change.

`openOrUpdateTab` calls `findContainerByRelPath(relPath, { mode: 'unstaged' })`
(post-V6 mode-aware helper, §4.3.1) so the update lookup never
matches a staged or range tab even when one exists for the same
file path.

The refresh button added in §4.8 lets the user re-snapshot a
staged or range tab manually.

### 5.5 git-diff stub `ref`-only URL → git-status

`?applet=git-diff&path=REPO&ref=HEAD~1..HEAD` (no `file`) is
the multi-file ref-range case. V6's "one file per tab"
constraint means `files` can't render it. The stub redirects
to `?applet=git-status&path=REPO` instead of bare `files`:

- `git-status` knows what a repo path is and renders a useful
  default view.
- The user's repo context (`path=REPO`) is preserved.
- The user can navigate from git-status into a specific file's
  diff if they want.

This is a 1-call-site change accompanied by the §4.6 removal
of the only link site that generated this URL pattern. The
stub still handles the case gracefully for any manually-typed
deep link from before V6.

### 5.6 git-diff API route

Search for `/api/files/diff` or similar — the git-diff applet
currently fetches via `/api/shell` (script.js:30-37) running
git directly. No dedicated server route. **No server-side
removal** needed for V6; the stub never reaches it.

## 6. Considerations

### 6.1 V5 lessons applied

The V5 plan review caught five blockers V5 then fixed. Apply
the same lessons preemptively to V6:

- **Conditional redirect** — V6 stub redirects only when a
  session exists (§4.5).
- **Pass-through unknown URL params** — use
  `new URLSearchParams(p)` then translate known fields
  (§5.5 covers ref-only).
- **No global flag** — wrap the entire existing body in the
  outer IIFE and `return` to exit (same as V5 §7).
- **Test the API extension** — the unit test seam is the new
  `diffMode` option on `openFile`. Test that staged + range
  produce different git invocations.
- **Acceptance maps to test cases** — §8.

### 6.2 Persistence — additive on schemaVersion 2

The forward-compat is viable because the existing route and
client both ignore unknown object keys in card entries
(`src/routes/file-edits.ts:143-157`,
`src/file-edits-store.ts:68-90`). V6 adds `diffMode?: 'unstaged'
| 'staged' | 'range'` and `diffRef?: string` to `CardPersist`
**without** bumping `schemaVersion`.

`buildPersistBody` (currently `applets/files/script.js:1742-1757`)
gains:

```javascript
list.push({
  relativePath: container.relPath,
  defaultViewerType: container.defaultViewerType,
  activeViewerType: container.activeViewerType,
  diffMode: container.diffMode !== 'unstaged' ? container.diffMode : undefined,
  diffRef: container.diffRef || undefined,
});
```

`initFromPersistence` (`script.js:2995-3041`) becomes mode-aware
for diff-default cards:

- `c.diffMode == null` or `'unstaged'`: existing placeholder +
  `fetchSnapshot()` path (V5 behavior — diff entry materializes
  from the poller's working-tree state).
- `c.diffMode === 'staged'` or `'range'`: rehydrate via
  `DiffViewer.open(shell, container, abs, relPath, { diffMode, ref })`.
  No placeholder + fetchSnapshot path — those only know
  unstaged. The mode-aware open is the only way to restore the
  snapshot.

Schema stays at version 2. V6 does **not** bump because there's
no on-disk format change; the new fields are additive object
keys that V5 readers silently ignore (writes from V5 don't have
them, reads on V6 default to unstaged).

A future version that needs to remove an existing field or
change a field's type would bump to schemaVersion 3, with a
matching update to the validator at
`src/routes/file-edits.ts:143`.

### 6.3 Refresh button uses existing chrome infrastructure

The files applet already has chrome-button infrastructure:
viewers expose `getChromeButtons()` and
`TabContainer.updateChromeButtons()` renders them with
mode-conditional visibility
(`applets/files/script.js:461-571`). MarkdownViewer uses this
for its save button.

V6 adds:

- `DiffViewer.prototype.getChromeButtons` returning a refresh
  button object when `this.container.diffMode` is `'staged'`
  or `'range'`; empty array otherwise.
- `DiffViewer.prototype.reload` method that re-runs the
  mode-aware `DiffViewer.open` fetch for the current
  mode/ref, replaces `this.edit`, and re-renders.

The button is **not** added for unstaged mode because the
poller already keeps that tab live via `caco.edit`.

### 6.4 Session-less no-session UX

Like V5 §4.2, the git-diff stub falls through to the existing
standalone applet when no session exists. The fallback path
inside the standalone (which uses `/api/shell` with the URL's
`path` param as `cwd`) does NOT require a session id — it
proxies straight to a shell invocation. So no-session deep
links to `?applet=git-diff&path=REPO&file=REL` continue to
work without modification.

### 6.5 git-status's removed "View diff" link — honest regression

§4.6 removes the last-commit "View diff" link
(`git-status/script.js:517-522`). The original spec claimed the
file-list area still provides per-file commit diffs, but the
current clean-state UI shows only commit metadata + `--stat`;
there is **no clickable per-file list** in the last-commit
section today.

**Honest framing:** V6 loses the ability to view the previous
commit's full diff from git-status, with no in-V6 replacement.
Mitigations:

- The user can run `git show HEAD` in a terminal.
- The user can ask the agent to render the commit.
- The user can navigate to git-status's file-list area for
  currently-changed files (which is the common case).
- A future per-commit file list in git-status (out of V6
  scope) replaces the lost capability with something better
  than the original (clickable per-file diffs into `files`
  with `diffMode=range&diffRef=HEAD~1..HEAD`).

This is the only behavioral regression in V6. Everything else
is invisible to the user (alias redirects, viewer extensions,
mode-aware lookups).

### 6.6 Multi-file ref-range view as future work

The §3 non-goal acknowledges that "show me the whole commit"
is a real workflow. The right home is git-status's commit row
(§4.6 mitigation), not `files`. `files` is a per-file tab
model; multi-file diffs do not fit. V6 explicitly does not
weaken this constraint.

### 6.7 No `applet-browser` change

V6 reuses the V5 `deprecated: true` filter mechanism. The
applet-browser already filters deprecated entries from its
default list. No new UI work.

### 6.8 Documentation churn

`APPLETS.md` Built-in Applets table moves `git-diff` from the
main table to the Deprecated table at merge time. README, API,
EXTENSIONS, panel-state-architecture: no changes needed (none
reference git-diff today; verify via grep).

### 6.9 No `git-diff` agent suggestion churn

Prompts + `caco_applet_usage` already filter `deprecated: true`
(V5). Setting the flag on git-diff suppresses agent suggestions
automatically.

## 7. Use cases

**UC1.** User opens git-status, clicks an unstaged file. URL
becomes `?applet=files&openPath=ABS`. Files applet opens a
diff tab (unstaged mode, current behavior). No regression.

**UC2.** User stages a file in git-status, then clicks the
file to view the staged diff. URL becomes
`?applet=files&openPath=ABS&diffMode=staged`. Files applet
opens a new tab with the basename + dim "· staged" suffix.
DiffViewer renders `git diff --cached -- <file>`.

**UC3.** User opens a chat link from the agent:
`?applet=files&openPath=src/foo.ts&diffMode=range&diffRef=HEAD~1..HEAD`.
Files opens a diff tab labeled `foo.ts · HEAD~1..HEAD`. The
DiffViewer renders the diff between those refs for that file
only.

**UC4.** User has a bookmark for
`?applet=git-diff&path=REPO&file=README.md`. Stub fires (session
exists), redirects to `?applet=files&openPath=ABS`. Brief
"Redirecting…" flash, then the file opens. (The stub keeps
working for old bookmarks indefinitely.)

**UC5.** User has a bookmark for
`?applet=git-diff&path=REPO&ref=HEAD~1..HEAD` (the multi-file
case). Stub redirects to `?applet=files`. User lands on empty
state; can use the picker. (Acceptable; this is the §4.6
regression.)

**UC6.** No-session: user opens
`?applet=git-diff&path=REPO&file=README.md` in a fresh browser
tab. Standalone git-diff renders normally (stub falls through).

**UC7.** V5-era session reloads. Persisted cards include only
working-tree tabs (no staged/range cards from V5). They
rehydrate as unstaged tabs (default `diffMode`). No breakage.

**UC8.** User opens a staged tab, stages additional changes in
the terminal, returns to the tab. The diff is stale. User
clicks the refresh button → re-fetches snapshot. New diff
renders.

## 8. Acceptance

1. `applets/git-diff/meta.json` has `deprecated: true` and
   `replacedBy: "files"`.
2. `applets/git-diff/script.js` is wrapped in a conditional
   redirect IIFE that fires only when
   `window.appletAPI.getSessionId()` is truthy.
3. When session exists: `?applet=git-diff&path=REPO&file=REL`
   redirects to `?applet=files&openPath=<joinPath(REPO,REL)>`.
4. Same with `&staged=1` → adds `&diffMode=staged`.
5. Same with `&ref=R&file=REL` → adds
   `&diffMode=range&diffRef=R`.
6. `?applet=git-diff&path=REPO&ref=R` (no file) redirects to
   `?applet=git-status&path=REPO` (§5.5).
7. No-session deep links to `?applet=git-diff&path=&file=`
   render the standalone git-diff applet unchanged.
8. `files` applet handles `?diffMode=staged`: DiffViewer
   constructed against `git diff --cached -- <file>`, tab
   labeled `<basename> · staged`.
9. `files` applet handles `?diffMode=range&diffRef=R`:
   DiffViewer constructed against `git diff <R> -- <file>`,
   tab labeled `<basename> · <R>`.
10. Tab ids disambiguate modes via `diffTabId({mode, ref, relPath})`
    with NUL sentinels (§4.3). Opening the same file in
    unstaged and staged modes produces two coexisting tabs.
11. `findContainerByRelPath` accepts an optional
    `{mode, ref}` filter (§4.3.1). Poller `caco.edit` updates
    pass `{mode: 'unstaged'}` so they never match staged/range
    tabs. `routeOpen` passes the requested mode/ref so a
    deep link to a staged view does not focus an existing
    unstaged tab.
12. Invalid `diffRef` (regex in §5.3 fails) returns 400; the
    tab shows an error state instead of an empty diff.
    Tests cover at least: leading `-`, whitespace, NUL,
    valid `HEAD~1..HEAD`, valid hash, valid `branch/with-slashes`.
13. `git-status` `viewDiff` callsite produces `files` URLs
    using the §4.6.1 `joinPath` helper and `URLSearchParams`
    construction.
14. `git-status` last-commit row's "View diff" link is removed
    (§6.5 — honest regression). No other UI in git-status
    references `git-diff`.
15. New persistence fields `diffMode` and `diffRef` on
    `CardPersist`, additive on schemaVersion 2 (§6.2).
    Reading old cards (no `diffMode`) defaults to unstaged.
    Staged + range tabs persist across reload via the
    mode-aware `DiffViewer.open` rehydrate path.
16. `DiffViewer.prototype.getChromeButtons` returns a refresh
    button for `staged` and `range` modes; empty for unstaged.
    `DiffViewer.prototype.reload` re-runs the mode-aware
    `DiffViewer.open` fetch and re-renders.
17. `DiffViewer.open` signature gains a fourth `opts` arg
    `{ diffMode, ref }` and POSTs `diffMode` / `ref` in the
    request body when mode is not unstaged (§4.x). `fromEdit`
    is unchanged.
18. Prompts + `caco_applet_usage` exclude `git-diff` from the
    agent's applet list (inherited from V5 filter).
19. Applet-browser default view excludes `git-diff`; toggle
    reveals it (inherited from V5).
20. **No `SLUG_ALIASES` entry for `git-diff`.** Confirmed by
    grep on `src/applet-store.ts`.
21. Unit test: poller `openFile(sid, rel, { diffMode: 'staged' })`
    invokes `git diff --cached -- <rel>`.
22. Unit test: poller `openFile(sid, rel, { diffMode: 'range', ref: 'HEAD~1..HEAD' })`
    invokes `git diff HEAD~1..HEAD -- <rel>` (verifying ref
    escaping).
23. Unit test: invalid refs rejected at the API route per
    §5.3 regex.
24. Unit test: `findContainerByRelPath` with `mode` filter
    returns null when only a different-mode tab exists.
25. Unit test: `diffTabId` helper for all three modes,
    including a path that contains `diff-staged:` in its name
    (collision-safety verification).
26. `npm run build` passes.
27. Manual smoke covers UC1-UC8.

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Tab id collision (`diff-staged:` prefix in real file paths, or ambiguous range serialization) | NUL-sentinel + length-prefix `diffTabId` helper (§4.3). |
| `findContainerByRelPath` matching wrong-mode tabs | Mode-aware filter, every call site audited (§4.3.1). |
| Staged tabs go stale silently | Refresh button in chrome (§4.8); future event hook is V7+. |
| `diffRef` shell injection | argv (not shell); narrow regex (§5.3). |
| `diffRef` regex too tight rejects legit refs | V6 documents the supported subset (§5.3); expansion is V7+ when use cases emerge. |
| Persisted V5 cards lose state | Additive fields on schemaVersion 2; old cards default to unstaged (§6.2). |
| Persisted staged/range cards can't rehydrate via the placeholder pattern | Rehydrate uses mode-aware `DiffViewer.open` instead (§6.2). |
| `git-status` path-join brittleness | Dedicated `joinPath` helper (§4.6.1); `URLSearchParams` for URL construction. |
| Multi-file ref-range UX regresses | §6.5 honest framing; future per-commit file list deferred. |
| User opens staged tab on a clean file | `git diff --cached` returns empty; tab renders "(no changes)" via existing empty-diff handling. |
| `DiffViewer.open` callers in `openOrUpdateTab` and `applyAgentState` accidentally receive mode/ref | Both already use `DiffViewer.fromEdit` (working-tree only); V6 leaves `fromEdit` unchanged (§4.x). |
| Schema bump needed for diffMode | Not needed — additive (§6.2). Documented for future field changes. |
| The agent emits old git-diff URLs from cached prompts | Stub redirects (per-session, per-tab); the agent gradually relearns from new system prompts. |
| `git-diff` no-session standalone calls `/api/shell` which doesn't require session | Preserved unchanged (§6.4). |
| Ref-only stub redirect goes to empty `files` | Redirects to `git-status?path=REPO` instead, preserving repo context (§5.5). |
| `git-diff` aliased and stubbed | Spec explicitly forbids (§4.5, §8.20); URL param shapes differ. |

## 10. Out of scope (V7+ candidates)

- Multi-file ref-range view (per-commit file list in
  git-status row).
- Live update of staged tabs (event hook into stage/reset).
- Delete `git-diff` stub directory.
- Per-line interactive staging in the diff viewer.
- Three-way merge conflict view.
- `git show <commit>` as a `files` tab.
