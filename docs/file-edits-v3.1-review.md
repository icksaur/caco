# File Edits V3.1 — Spec Review

Reviewed against: `docs/file-edits-v3.1.md`
Context: `docs/file-edits-v2.1.md`, `src/git-edit-poller.ts`,
`src/routes/file-edits.ts`, `applets/file-edits/script.js`,
`applets/file-edits/content.html`, `src/routes/api.ts:460–568`,
`public/ts/input-popup.ts`, `src/utils/fuzzy-score.ts`

---

## [BLOCKER] `buildUntrackedEntry` with `hunks:[]` renders nothing

**Spec:** `docs/file-edits-v3.1.md:140-145`

The spec proposes building `fullFile` with `headLines: null`,
`workLines: <file contents>`, `hunks: []` for untracked files, claiming
"V2 buildRows handles `headLines: null`." The claim is incomplete.
Trace `buildRows(null, workLines, [])`:

```js
var hasHead = Array.isArray(headLines);  // false — null is not an array
// hunks loop: hunks.length = 0 → never executes
// tail loop: guarded by `if (hasHead)` → skipped
return rows;  // []
```

Empty rows → `renderFullFile` shows `(no visible changes)`. Untracked
cards appear blank.

Compare `computeFullFile` for `status === 'untracked'` in
`git-edit-poller.ts`: it calls `parseHunks(diffText)` on the real
`git diff --no-index /dev/null <file>` output, producing
`{ headStart: 0, headLen: 0, workStart: 1, workLen: N }`. That hunk is
what makes `buildRows` emit add rows.

**Fix:** `buildUntrackedEntry` must follow the same path as `buildEntry`
for untracked status (call `fetchDiff` + `computeFullFile`), or
synthesize the hunk explicitly:

```ts
hunks: [{ headStart: 0, headLen: 0, workStart: 1, workLen: workLines.length }]
```

---

## [BLOCKER] `GitEditPoller` interface missing `openFile` — fresh agent is stuck

**Spec:** `docs/file-edits-v3.1.md:163-181`
**Code:** `src/git-edit-poller.ts:332-343` (interface), `:349-394` (helpers)

The new `POST .../file-edits/open` lives in `src/routes/file-edits.ts`,
which holds only a `GitEditPoller` interface reference exposing
`attachToSession`, `detachFromSession`, `triggerPoll`, `snapshot`.

`buildEntry`, `buildCleanEntry`, and the proposed `buildUntrackedEntry`
are all **closure-private** inside `createGitEditPoller()`. Not exported,
not on the interface, not reachable from the route.

The spec never adds a method (e.g.
`openFile(sessionId, relPath): Promise<EditEntry | null>`) nor exports
the helpers separately. The interface extension is mandatory and must
also resolve `repoRoot` from the session state (also private).

**Fix:** Add to `GitEditPoller`:
```ts
openFile(sessionId: string, relPath: string): Promise<EditEntry | null>;
```
Implement inside the closure using existing private helpers + new
`buildUntrackedEntry`.

---

## [IMPORTANT] Dismissal-leak pseudocode contradicts the stated fix

**Spec:** `docs/file-edits-v3.1.md:234-259` vs `:347`

The `pickFile` pseudocode deletes from `dismissed` before the fetch.
Edge-cases identifies this as a bug and recommends "only clear dismissed
AFTER successful open," but the pseudocode is not updated. An implementer
following the pseudocode ships the leak.

---

## [IMPORTANT] Autoscroll not suppressed on pick

**Spec:** `docs/file-edits-v3.1.md:100-108`
**Code:** `applets/file-edits/script.js:1243-1250`

Spec says "do NOT autoscroll" because picking is a user gesture. But
`applyEdits` in autoscroll mode unconditionally calls `scrollToCard`.
Nothing in the pick flow enters Sticky — clicking the picker doesn't
scroll the stream container, so `onStreamScroll` never fires. The
"user-gesture-enters-Sticky" rule is about scrolling within the stream,
not clicking UI controls.

**Fix options:**
- (a) `enterSticky()` before `applyEdits()` in `pickFile` — side
  effect: Follow-edits button appears.
- (b) `{ suppressScroll?: boolean }` to `applyEdits` — surgical, no
  side effects. Recommended.

---

## [IMPORTANT] In-flight `/open` request races with session change

**Spec:** `docs/file-edits-v3.1.md:343-344`

Closing the picker doesn't abort the in-flight `fetch('.../open')`.
When the response arrives after `onSessionChange` has wiped state and
attached the new session, `applyEdits` runs against the new session's
DOM, creating a card with the old session's file under the new
session's identity. `schedulePersist()` writes it to the new session's
JSON.

**Fix:** `AbortController` cancelled in `onSessionChange`.

---

## [IMPORTANT] Path validation incomplete

**Spec:** `docs/file-edits-v3.1.md:164-168`

The validation ("no `..` segments, no leading `/`") is necessary but
insufficient:

1. **Symlink traversal:** literal-segment check passes `realdir/link-to-parent/secret`
   where the link resolves to `..`. Need a post-join check:
   ```ts
   const abs = resolve(join(repoRoot, relPath));
   if (!abs.startsWith(repoRoot + sep)) { /* 400 */ }
   ```

2. **Directory path:** `src/` to `git status -- src/` returns multiple
   entries; branching expects one path. Add `stat.isFile()` guard.

3. **Null bytes:** unmentioned. NUL is the porcelain separator;
   `relativePath.includes('\0')` must reject.

---

## [IMPORTANT] `--no-renames` makes the R/C branch dead

**Spec:** `docs/file-edits-v3.1.md:169`

`--no-renames` means git never emits R or C; renamed files show as D
(old) + A (new). The "status = M/A/D/R/C" branch never fires for R/C.
Diverges from the poller (`git-edit-poller.ts:400`) which does NOT use
`--no-renames`. Either document that R/C is dead and renames materialize
as A, or drop `--no-renames` and handle the rename-source NUL field.

---

## [NICE] ASCII art in UX section violates SKILL.md

**Spec:** `docs/file-edits-v3.1.md:62-73`

Per the review-spec skill: "Ascii art is not allowed. Use mermaid in code blocks for diagrams." Replace the popup layout box-drawing diagram with mermaid or prose.

---

## [NICE] Empty query returns all files — client-side 50 cap not specified

**Spec:** `docs/file-edits-v3.1.md:77-78`
**Code:** `src/routes/api.ts:550-552`

`/project-files` returns ALL files for empty `q` (up to 10,000). The
spec's "50" is a client-side rendering cap that the spec never states.
Add: "Client slices to the first 50 entries for rendering."

---

## [NICE] Dotfiles silently absent from picker

**Spec:** `docs/file-edits-v3.1.md:113-125`
**Code:** `src/routes/api.ts:515, 542`

`/project-files` defaults `showDotfiles = false`. Files like `.env`,
`.eslintrc.json`, `.gitignore`, `.github/workflows/*.yml` will not
appear. Spec mentions gitignored as a non-goal but not dotfiles.

---

## [NICE] Acceptance criteria missing untracked file pick

**Spec:** `docs/file-edits-v3.1.md:352-369`

Criteria cover tracked-clean (3) and dirty (8); none cover **untracked**
(`??`). That's the code path that hits BLOCKER #1.

Add: "11. Pick a file that is new/untracked → card shows full content
with all-add highlighting."

---

## [NICE] `cachedCwd` source not specified

**Spec:** `docs/file-edits-v3.1.md:221`

Picker state lists `cachedCwd` but doesn't say where it's set.
Clarify: "set from `info.cwd` in `onSessionChange` and from session
meta in the initial `getSessionId` path."

---

## [QUESTION] `--no-renames` intentional?

If yes: document R/C branch is dead. If no: parse rename-source NUL
field.

---

## [QUESTION] Strategy for exposing `buildEntry` to the new route?

Three options:
(a) Add `openFile` method to `GitEditPoller` — cleanest. Recommend.
(b) Export helpers as module-level functions — breaks encapsulation.
(c) Duplicate in route handler — bad.

---

## [QUESTION] Autoscroll suppression mechanism?

(a) `enterSticky()` before `applyEdits` — side effect: Follow-edits
button appears.
(b) `{ suppressScroll?: boolean }` to `applyEdits` — surgical.
Recommend (b).

---

## Summary

| Level | Count |
|-------|-------|
| BLOCKER | 2 |
| IMPORTANT | 5 |
| NICE | 5 |
| QUESTION | 3 |
| **Total** | **15** |

**Recommendation: do not proceed to implementation yet.** Both BLOCKERs
are structural — one produces silently wrong output (blank untracked
cards), the other leaves the core implementation path undefined
(interface gap). All five IMPORTANTs are single-pass fixes.
