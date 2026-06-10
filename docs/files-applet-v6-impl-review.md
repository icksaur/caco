# files-applet V6 Implementation Review

**Branch:** `files-applet-v6`  
**Reviewer:** code-review agent  
**Date:** 2025-01-30  
**Scope:** 10 commits against master (63a775e..ac1c900)

## Summary

Reviewed all 12 verification points from the review request. Found **1 BLOCKER** and **2 IMPORTANT** issues requiring fixes before merge. The remaining items are solid.

---

## BLOCKER Issues

### B1: findContainerByRelPath filter logic is asymmetric

**File:** `applets/files/script.js:191-202`  
**Severity:** BLOCKER

**Problem:**  
The `wantMode` and `wantRef` filtering logic is asymmetric:

```javascript
if (wantMode && c.diffMode !== wantMode) return;
if (wantRef !== null && c.diffRef !== wantRef) return;
```

- `wantMode`: Only filters when `wantMode` is truthy. If `wantMode` is `null` (the default from `opts.mode || null`), it matches any container mode.
- `wantRef`: Filters whenever `wantRef !== null`. If `wantRef` is `null` (the default), it ONLY matches containers where `c.diffRef` is also `null`.

**Impact:**  
When a caller passes `{ mode: 'unstaged' }` (common case), `wantMode` is `'unstaged'` (truthy) and `wantRef` is `null`. The function will:
1. Filter to containers with `diffMode === 'unstaged'` ✓
2. Filter to containers with `diffRef === null` ✓

This works correctly for the intended use case. However, the asymmetry creates a footgun: if someone passes `{ mode: null, ref: 'HEAD~1' }` (trying to find any container with that ref), they'll get no matches because `wantMode` is falsy (won't filter by mode) but `wantRef` is non-null (will filter to containers with that exact ref).

**Evidence:**  
All current call sites pass either:
- `{ mode: 'unstaged' }` (poller caco.edit + applyAgentState + openOrUpdateTab)
- `{ mode: diffMode, ref: diffRef }` (routeOpen, where both are always set)

So the bug doesn't manifest in V6, but the inconsistency will cause confusion in V7+ when the code evolves.

**Suggested fix:**  
Make the filtering symmetric. Change line 193-194 to:

```javascript
var wantMode = opts.mode !== undefined ? opts.mode : null;
var wantRef = opts.ref !== undefined ? opts.ref : null;
```

And update the filters:

```javascript
if (wantMode !== null && c.diffMode !== wantMode) return;
if (wantRef !== null && c.diffRef !== wantRef) return;
```

Now both filters behave the same: `null` means "don't filter on this field", non-null means "must match exactly".

---

## IMPORTANT Issues

### I1: echoState called 3 times in reload — intentional or oversight?

**File:** `applets/files/diff-viewer.js:162-192`  
**Severity:** IMPORTANT

**Problem:**  
The `reload()` method calls `this.shell.echoState()` three times:
1. Line 165: immediately after setting `_reloading = true`
2. Line 188: after successful render
3. Line 191: in the finally block

**Question:**  
Is this intentional (to push three incremental state updates: "started reloading", "render complete", "guard released"), or is it redundant? The guard check on line 153 prevents concurrent reloads, so the three echoes can't overlap.

**Possible issues:**  
- If echoState is expensive (serializes and broadcasts the full applet state), three calls per reload is wasteful.
- The chrome button's `disabled()` predicate checks `self._reloading === true`. The first echoState (line 165) broadcasts the disabled state. The finally echoState (line 191) broadcasts the re-enabled state. The middle one (line 188) is while `_reloading` is still true, so it's a duplicate of the first.

**Evidence:**  
No other viewer method in the codebase calls echoState more than once per user action. The pattern elsewhere is: change state, echoState once.

**Suggested fix:**  
If the intent is just to disable the button during reload and re-enable after, remove line 188 (the middle call). Keep line 165 (broadcasts "reloading, button disabled") and line 191 (broadcasts "done, button enabled").

If the three calls are intentional for some client-side animation or progress reason, add a comment explaining why.

---

### I2: git-diff redirect doesn't preserve unknown params

**File:** `applets/git-diff/script.js:21-26`  
**Severity:** IMPORTANT

**Problem:**  
The redirect IIFE constructs a new `URLSearchParams(p)` to clone the original params, then deletes the known git-diff params (`path`, `file`, `staged`, `ref`). The intent is "pass-through any params we don't recognize" (comment line 21).

However, the spec (docs/files-applet-v6.md §4.5) says the stub is V5-style. V5 stubs (e.g., mcp-explorer) preserved `applet=<slug>` in the URL and conditionally redirected. This stub **replaces** `applet=git-diff` with `applet=files` or `applet=git-status`, so the pass-through logic is correct for future params but slightly different from the V5 pattern.

**Actual issue:**  
The code does NOT preserve the `applet=git-diff` param in the target URL (line 34/31 set `applet=files` or `applet=git-status`). This is **correct** — the redirect needs to change the applet. But the comment on line 21 ("pass-through any params we don't recognize") might mislead a future maintainer into thinking the original applet param should be preserved.

**Not a bug, but a clarity issue:**  
The code is correct. The comment could be clearer: "Pass through any params we don't recognize (except applet, which we're replacing)."

**Suggested fix:**  
Update comment on line 21:

```javascript
// Pass through any params we don't recognize (applet is replaced below).
```

---

## Verification Checklist (remaining 9 items)

### ✅ V1: diffTabId collision-safety

**Status:** VERIFIED CORRECT

- NUL (`\u0000`) sentinels prevent collision with real relPaths.
- `src/routes/file-edits.ts:88` rejects NUL on input: `if (relPath.includes('\0'))`.
- `diffTabId` staged form: `\u0000diff-staged\u0000<relPath>`.
- `diffTabId` range form: `\u0000diff-range\u0000<refLen>\u0000<ref><relPath>`.
- Length-prefix correctly disambiguates (ref, relPath) pairs.
- Tests in `tests/unit/files-applet-diff-tab-id.test.ts` cover collision cases.

**No issues.**

---

### ✅ V2: findContainerByRelPath call sites

**Status:** VERIFIED (with caveat from B1)

Five call sites found:

1. `applyAgentState` (line 1317): `{ mode: 'unstaged' }` ✓
2. `applyAgentState` race-recheck (line 1346): `{ mode: 'unstaged' }` ✓
3. `openOrUpdateTab` (line 1488): `{ mode: 'unstaged' }` ✓
4. `routeOpen` existing-tab check (line 2345): `{ mode: diffMode, ref: diffRef }` ✓
5. `routeOpen` race-recheck (line 2390): `{ mode: diffMode, ref: diffRef }` ✓

All call sites pass the correct mode/ref. The poller's caco.edit code path (applyAgentState, openOrUpdateTab) correctly scopes to unstaged. User-initiated opens (routeOpen) pass through the requested mode/ref.

**No issues** (B1 is about the filter logic itself, not the call sites).

---

### ✅ V3: routeOpen pendKey logic

**Status:** VERIFIED CORRECT

**Concurrent unstaged + staged opens of same file:**  
Lines 2365-2367 compute `pendKey`:

```javascript
var pendKey = diffMode === 'unstaged' && !diffRef
  ? relativePath
  : '\u0000' + diffMode + '\u0000' + (diffRef || '') + '\u0000' + relativePath;
```

- Unstaged: `pendKey = 'README.md'`
- Staged: `pendKey = '\u0000staged\u0000\u0000README.md'`

Different keys → no dedup. ✓

**Two concurrent unstaged opens of same file:**  
Both calls compute `pendKey = 'README.md'`. Second call hits `if (pendingOpenIds.has(pendKey))` (line 2368) and short-circuits. ✓

The V3.y ghost-tab-fix guard is preserved.

**No issues.**

---

### ✅ V4: Poller diffMode=range with deleted file

**Status:** VERIFIED CORRECT

**Code:** `src/git-edit-poller.ts:649-678`

For `diffMode === 'range'`, the poller runs:

```javascript
const args = ['diff', '--no-color', String(opts!.ref || ''), '--', relPath];
const result = await runGit(args, state.repoRoot, DIFF_TIMEOUT_MS);
```

This is `git diff <ref> -- <relPath>`. For a file deleted between A and B in range `A..B`, git produces:

```
diff --git a/file.txt b/file.txt
deleted file mode 100644
index 9daeafb..0000000
--- a/file.txt
+++ /dev/null
@@ -1 +0,0 @@
-test
```

Git exit code is 1 (diff found), which the poller handles as success (line 669: `if (result.code !== 0 && result.code !== 1)`).

**Manual test confirms:**

```bash
cd /tmp/test-repo && git init && echo "test" > file.txt && git add file.txt && git commit -m "add"
git rm file.txt && git commit -m "delete"
git diff HEAD~1..HEAD -- file.txt
# exit code: 1, output: deleted file diff
```

The route skips the on-disk stat for range mode (lines 132-141), so a missing working-tree file doesn't cause a 400.

**No issues.**

---

### ✅ V5: CardPersist additive on schemaVersion 2

**Status:** VERIFIED CORRECT

**Code:** `src/file-edits-store.ts:30-43, 91-104`

- V6 adds `diffMode?: 'unstaged' | 'staged' | 'range'` and `diffRef?: string` to `CardPersist`.
- `isCardPersist` (lines 91-104) accepts these fields if present, validates their types.
- `schemaVersion` remains `2` (line 28: `export const SCHEMA_VERSION = 2`).
- V5 readers: The TS type is additive. V5 runtime `isCardPersist` doesn't check for unknown keys — it only validates known fields. A V6 card with `diffMode: 'range'` will pass V5's `isCardPersist` because V5 doesn't reject extra keys. ✓
- V6 reading a V5 card: `cardMode = c.diffMode || 'unstaged'` (script.js line 3112) defaults to unstaged. ✓

**No issues.**

---

### ✅ V6: rehydrate code path

**Status:** VERIFIED CORRECT

**Code:** `applets/files/script.js:3107-3199`

Three cases:

1. **V5 card (no diffMode):**  
   - Line 3112: `cardMode = c.diffMode || 'unstaged'` → `'unstaged'`
   - Line 3147: `if (defaultType === 'diff' && cardMode === 'unstaged')` → fast path
   - Lines 3148-3162: placeholder + `fetchSnapshot`

2. **V6 card with diffMode='staged':**  
   - Line 3112: `cardMode = 'staged'`
   - Line 3147 condition fails → async factory path (line 3163+)
   - Lines 3176-3178: `openOpts = { diffMode: cardMode, ref: cardRef }`
   - Line 3179: `desc.open(shell, container, abs, c.relativePath, openOpts)`
   - `DiffViewer.open` (diff-viewer.js:195) receives `opts.diffMode = 'staged'`, constructs body with `diffMode: 'staged'` (line 201).

3. **V6 card with diffMode='range', diffRef='HEAD~1..HEAD':**  
   - Same async path as case 2.
   - Line 3177: `openOpts.ref = cardRef = 'HEAD~1..HEAD'`
   - Body sent to route includes `diffMode: 'range', ref: 'HEAD~1..HEAD'`.

**Dedup check (line 3117):**  
```javascript
var candidateId = cardMode === 'unstaged' && !cardRef
  ? c.relativePath
  : diffTabId({ mode: cardMode, ref: cardRef, relPath: c.relativePath });
if (tabs.has(candidateId)) return;
```

This uses the same `diffTabId` computation as the TabContainer constructor (script.js line 262), so the dedup is correct.

**No issues.**

---

### ✅ V7: DiffViewer.reload

**Status:** VERIFIED (see I1 for echoState count question)

**Chrome button hidden for unstaged mode:**  
Lines 144-146:

```javascript
var mode = this.container && this.container.diffMode;
if (mode !== 'staged' && mode !== 'range') return [];
```

Unstaged tabs return `[]` → no chrome buttons. ✓

**Concurrent reload guard:**  
Line 163: `if (this.destroyed || this._reloading) return;`  
Line 164: `this._reloading = true;`  
Line 190-191: `finally { this._reloading = false; ... }`

The guard prevents concurrent reloads. ✓

**echoState count:** See I1 above (3 calls — intentional?).

**No bugs**, but see I1 for clarification request.

---

### ✅ V8: git-diff stub

**Status:** VERIFIED CORRECT (see I2 for comment clarity)

**IIFE early-return:**  
Line 12: `(function() {`  
Line 14: `if (api && typeof api.getSessionId === 'function' && api.getSessionId()) {`  
Line 56: `return;`  
Line 58: `// === No session: fall through to the standalone behavior. ===`

The redirect code path (lines 14-56) ends with `return` at line 56. No flag, actual early return. ✓

**Existing body wrapped and unchanged:**  
Line 59-onwards is the original V5 standalone git-diff code. It's not modified. ✓

**Ref-only redirect preserves path:**  
Lines 28-32:

```javascript
if (!file && ref) {
  target.set('applet', 'git-status');
  if (repoPath) target.set('path', repoPath);
}
```

Ref-only (no file) redirects to git-status with path preserved. ✓

**No-session fallthrough:**  
Line 14 condition fails if no session → skip to line 58 → original body runs. ✓

**No issues** (I2 is about a comment, not behavior).

---

### ✅ V9: git-status changes

**Status:** VERIFIED CORRECT

**joinPath implementation:**  
`applets/git-status/script.js:15-23`

```javascript
function joinPath(base, rel) {
  if (!base) return rel;
  if (!rel) return base;
  const trimmedBase = base.replace(/[/\\]+$/, '');
  const trimmedRel = rel.replace(/^[/\\]+/, '');
  const sep = trimmedBase.indexOf('\\') >= 0 && trimmedBase.indexOf('/') < 0
    ? '\\' : '/';
  return trimmedBase + sep + trimmedRel;
}
```

**Edge cases:**
- Trailing slash on base: stripped by `replace(/[/\\]+$/, '')` ✓
- Leading slash on rel: stripped by `replace(/^[/\\]+/, '')` ✓
- Empty base: return rel ✓
- Empty rel: return base ✓
- Windows path (backslashes): sep logic checks `indexOf('\\') >= 0 && indexOf('/') < 0` → uses `\\` ✓
- Mixed slashes: defaults to `/` ✓

**URLSearchParams construction (viewDiff function, lines 173-180):**

```javascript
function viewDiff(filePath, staged) {
  const url = new URL('/', window.location.origin);
  const sp = url.searchParams;
  sp.set('applet', 'files');
  sp.set('openPath', joinPath(repoPath, filePath));
  if (staged) sp.set('diffMode', 'staged');
  window.location.href = url.toString();
}
```

When `staged` is true: `?applet=files&openPath=<joined>&diffMode=staged` ✓  
When `staged` is false/undefined: `?applet=files&openPath=<joined>` ✓

**No issues.**

---

### ✅ V10: Ref validation (isValidRef)

**Status:** VERIFIED CORRECT

**Pattern:** `src/routes/file-edits.ts:35`

```javascript
const REF_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_./^~-]*(\.\.\.?[A-Za-z0-9_][A-Za-z0-9_./^~-]*)?$/;
```

**Documented subset (docs/files-applet-v6.md §5.3):**
- Branch/tag names: `master`, `v1.2.3`, `feature/x` ✓
- Hashes: `abc123`, `cafef00d1234567890` ✓
- HEAD with ancestor: `HEAD`, `HEAD~3`, `HEAD^^` ✓
- Ranges: `A..B`, `A...B` ✓

**Shell-dangerous chars rejected:**
- Space, newline, NUL: not in `[A-Za-z0-9_./^~-]` ✓
- Semicolon, pipe, dollar, backtick: not in charset ✓

**Tests (tests/unit/file-edits-route.test.ts):**
- 24 valid refs accepted ✓
- 13 invalid refs rejected ✓
- Non-string input rejected ✓

**No issues.**

---

### ✅ V11: Backward compat

**Status:** VERIFIED CORRECT

**Pre-V6 link:** `?applet=git-diff&path=/repo&file=src/foo.ts&staged=1`

**Redirect path (git-diff/script.js:34-48):**

1. Line 17: `file = 'src/foo.ts'`
2. Line 18: `staged = true`
3. Line 34: `target.set('applet', 'files')`
4. Lines 36-41: `openPath = joinPath('/repo', 'src/foo.ts')` → `/repo/src/foo.ts`
5. Line 46-47: `target.set('diffMode', 'staged')`

Result: `?applet=files&openPath=/repo/src/foo.ts&diffMode=staged` ✓

**Unusual inputs:**
- Empty file: line 17 `file = ''`, line 35 `if (file)` skips openPath set → `?applet=files` (valid, opens applet without a tab)
- Empty path: line 37 `trimmedBase = ''`, line 41 `trimmedBase ? ... : trimmedRel` → openPath = `file` (relative path, valid)
- Both empty: `?applet=files` (valid)

**No issues.**

---

### ✅ V12: Type changes

**Status:** VERIFIED CORRECT

**AppletMeta (applets/git-diff/meta.json):**  
No signature changes. The stub is JS-only; meta.json unchanged except description/purpose text.

**EditEntry (src/git-edit-poller.ts:54-73):**  
No new fields added to `EditEntry` interface. V6 reuses existing fields (`diff`, `status`, `timestamp`, etc.). The poller's `openFile` method gained optional params but doesn't change the return type.

**CardPersist (src/file-edits-store.ts:30-43):**  
Additive fields `diffMode?` and `diffRef?`. No existing field removed or type-changed. Backward-compatible per V5 above.

**No breaking changes.**

---

## Summary of Findings

| ID | Severity | Issue | File | Lines |
|----|----------|-------|------|-------|
| B1 | BLOCKER | findContainerByRelPath filter logic asymmetric | script.js | 191-202 |
| I1 | IMPORTANT | echoState called 3 times in reload — intentional? | diff-viewer.js | 162-192 |
| I2 | IMPORTANT | git-diff redirect comment misleading | git-diff/script.js | 21 |

**Action items:**

1. **B1:** Fix the `wantMode` / `wantRef` defaulting to be symmetric.
2. **I1:** Remove redundant echoState call OR add a comment explaining why 3 calls are needed.
3. **I2:** Clarify comment about pass-through params.

**All tests pass:**
- `tests/unit/files-applet-diff-tab-id.test.ts`: 6/6 ✓
- `tests/unit/file-edits-route.test.ts`: 32/32 ✓

Once the three fixes are applied, this is ready to merge.
