# files-applet V6.1 Code Review

**Branch:** `files-applet-v6.1`  
**Reviewer:** Code Review Agent  
**Date:** 2024-01-10  
**Status:** ✅ **APPROVED** — No blockers found

## Summary

V6.1 successfully rips out the range diff mode (~250 lines removed) while preserving staged mode functionality. The removal is clean, consistent, and complete. All 10 verification points passed. All tests pass (849 tests, 59 test files).

**Key finding:** Zero BLOCKER or IMPORTANT issues. One MINOR documentation observation below.

---

## Verification Checklist

### 1. ✅ No range leftovers
**Searched for:** `diffRef`, `'range'`, `isValidRef`, `REF_PATTERN`, `diff-range`

**Result:** Clean. All remaining references are in:
- Comments explaining V6.1 removal (expected)
- Historical V6 review docs in `docs/` (expected)
- `plan.md` historical planning (expected)

No live code references found.

### 2. ✅ Staged mode end-to-end trace
**Path verified:**
1. `git-status` → `viewDiff(file, true)` → `?applet=files&openPath=ABS&diffMode=staged` ✓
2. `onUrlParamsChange` → `routeOpen(rel, {diffMode:'staged'})` ✓
3. `findContainerByRelPath(rel, {mode:'staged'})` with symmetric mode filter ✓
4. `diffTabId({mode:'staged', relPath})` returns `'\u0000diff-staged\u0000' + rel` ✓
5. `DiffViewer.open` with `opts.diffMode='staged'` POSTs `body.diffMode='staged'` ✓
6. Route validates `diffMode in {'unstaged', 'staged'}` at `src/routes/file-edits.ts:90` ✓
7. Poller `openFile` with `opts.diffMode='staged'` runs `git diff --cached -- <rel>` at line 656 ✓
8. Returns `EditEntry` with `status: 'modified'` ✓
9. `DiffViewer` renders it ✓

All links verified.

### 3. ✅ Persistence cycle for staged tabs
**Write path:** `buildPersistBody` writes `diffMode: 'staged'` when `container.diffMode !== 'unstaged'` (lines 1812-1814).

**Read path:** `initFromPersistence`:
1. Reads `c.diffMode || 'unstaged'` (line 3091)
2. Computes `candidateId` via `diffTabId({mode: cardMode, relPath})` (line 3094)
3. Checks tab existence (line 3095)
4. Threads `diffMode` into descriptor (lines 3118-3120)
5. Async factory path for staged (lines 3138-3173)
6. Calls `DiffViewer.open` with `openOpts={diffMode: cardMode}` (lines 3151-3153)
7. Fetches staged snapshot via `DiffViewer.open → POST /api/.../file-edits/open`

Cycle complete.

### 4. ✅ No-rehydrate for V5 cards
V5 cards have no `diffMode` field. Code correctly:
1. Defaults to `'unstaged'` (line 3091: `c.diffMode || 'unstaged'`)
2. Uses fast placeholder path (lines 3122-3136) for `defaultType === 'diff' && cardMode === 'unstaged'`
3. Calls `DiffViewer.fromEdit` with placeholder
4. `fetchSnapshot` updates it

V5 behavior preserved.

### 5. ✅ TabContainer constructor
Without `descriptor.diffMode`:
- `this.diffMode = 'unstaged'` (line 258, default via `||`)
- `diffTabId({mode: 'unstaged', relPath})` returns bare `relPath` (line 159)
- Tab label: `basename(relPath)` (line 268), no suffix added (line 290 `if` only fires for `'staged'`)
- Title: bare `relPath` (line 283, ternary returns second branch)

V1-V5 behavior preserved for default case.

### 6. ✅ routeOpen pendKey
**Unstaged:** `pendKey = relativePath` (line 2348)
**Staged:** `pendKey = '\u0000' + diffMode + '\u0000' + relativePath` (line 2350)

Two concurrent unstaged opens of the same file correctly dedup via the same bare `relativePath` key. Unstaged and staged opens of the same file have distinct keys and don't dedup. V3.y guard preserved.

### 7. ✅ findContainerByRelPath mode filter
Code at lines 186-198:
```javascript
var wantMode = opts.mode !== undefined ? opts.mode : null;
// ...
if (wantMode !== null && c.diffMode !== wantMode) return;
```

**Symmetric filter logic:**
- `opts.mode === undefined` → `wantMode = null` → no filtering on mode (matches any)
- `opts.mode === 'staged'` → `wantMode = 'staged'` → filters to `c.diffMode === 'staged'` only
- `opts.mode === 'unstaged'` → `wantMode = 'unstaged'` → filters to `c.diffMode === 'unstaged'` only

Correctly skips opposite-mode tabs. Poller's `caco.edit` calls with `{mode: 'unstaged'}` won't match staged tabs.

### 8. ✅ git-diff stub
**With session:**
- `?applet=git-diff&path=R&file=F` → `files&openPath=R/F` ✓
- `?applet=git-diff&path=R&file=F&staged=1` → `files&openPath=R/F&diffMode=staged` ✓
- `?applet=git-diff&path=R&ref=X` (any ref, with or without file) → `git-status&path=R` ✓

**No session:** Falls through to standalone body (line 64+).

Stub redirects correctly.

### 9. ✅ Schema additivity preserved
**V6.1 card:** `{ relativePath, defaultViewerType, activeViewerType, diffMode: 'staged' }`

**V5 reader behavior:**
- Knows `relativePath`, `defaultViewerType`, `activeViewerType`
- Silently ignores unknown `diffMode` field (JSON parsing allows extra keys)
- Rehydrates as unstaged (its default behavior)
- **Additive schema 2 preserved** ✓

**V6.1 validation:** `isCardPersist` at lines 88-98 accepts `diffMode in {'unstaged', 'staged'}` only. Rejects `'range'`.

### 10. ✅ V6 acceptance regression check
Mapped original V6 §8 items to V6.1:

**Still satisfied:**
- §8.1-2: `git-diff` deprecation + conditional redirect IIFE ✓
- §8.3-4: `path+file`, `staged=1` redirects ✓
- §8.6: `path+ref` (no file) → `git-status` ✓
- §8.7: No-session standalone preserved ✓
- §8.8: Staged mode works end-to-end ✓
- §8.10-11: `diffTabId` + `findContainerByRelPath` mode filter ✓
- §8.13: `git-status` uses `joinPath` + `URLSearchParams` ✓
- §8.15: Persistence fields additive (V6.1 kept `diffMode`, dropped `diffRef`) ✓
- §8.17: `DiffViewer.open` fourth arg `opts` with `diffMode` ✓
- §8.18-19: `git-diff` excluded from prompts + browser ✓
- §8.20: No `SLUG_ALIASES` entry ✓
- §8.26: `npm run build` passes (inferred from test pass) ✓

**Deleted (expected):**
- §8.5, 8.9: Range mode + `diffRef` (intentional removal)
- §8.12: `isValidRef` validation (deleted with range)
- §8.14: Last-commit "View diff" already removed in V6
- §8.16: Chrome refresh button (deleted — staged can re-click)
- §8.21-25: Range-related unit tests (deleted)

**No unexpected regressions detected.**

---

## Detailed Findings

### MINOR: Documentation gap in V6 acceptance criteria

**File:** `docs/files-applet-v6.md`  
**Severity:** MINOR  
**Context:** V6.1 amendment header explains the removal clearly, but the original §8 acceptance criteria list at lines 99+ still references deleted items (§8.5, 8.9, 8.12, 8.16, 8.21-25).

**Impact:** Future readers might be confused about which acceptance items still apply.

**Recommendation:** Add a forward reference to V6.1 in the §8 header, e.g.:

```markdown
## 8. Acceptance

> **V6.1 note:** Items 5, 9, 12, 16, 21-25 (range-related) were deleted
> when range mode was removed. See V6.1 amendment at top of document.

1. `applets/git-diff/meta.json` has `deprecated: true` ...
```

Or tombstone the deleted items inline with strike-through + "(V6.1: deleted)" annotations.

**NOT A BLOCKER** — the amendment header is sufficient for navigating the doc.

---

## No Bugs Found

**Chrome button infrastructure:**
- V6.1 removed `DiffViewer.getChromeButtons` and `.reload()` methods
- The chrome-button reconciliation loop at `script.js:521-580` still calls `getChromeButtons()` on the active viewer
- **This is correct:** DiffViewer no longer defines `getChromeButtons`, so the call returns `undefined`, which the code safely treats as an empty array (line 524)
- Other viewers (MarkdownViewer, ImageViewer, HtmlViewer) can still define chrome buttons if needed
- No stray `.reload()` calls found in the codebase

**git-status integration:**
- The `viewDiff` callsite at `applets/git-status/script.js:173` correctly sets `diffMode=staged` only when `staged === true`
- URL construction uses `URLSearchParams` (safe)
- Path joining via inline `joinPath` logic (safe, mirrors V6 spec)

**Persistence backward compatibility:**
- V5 cards without `diffMode` rehydrate as unstaged (fast path)
- V6 cards with `diffMode='staged'` rehydrate via async factory + `DiffViewer.open`
- V6.1 cards with `diffMode='unstaged'` rehydrate via fast path (optimization preserved)
- No schema version bump needed (additive fields)

**Tab ID collision safety:**
- NUL sentinel `\u0000diff-staged\u0000` cannot appear in real paths (API rejects NUL at `file-edits.ts:73`)
- Unstaged tabs use bare `relPath` (V1 schema preserved)
- Staged tabs use prefixed form (collision-free)

**Race conditions:**
- `routeOpen` idempotency guard with mode-aware `pendKey` (lines 2348-2351)
- Post-await race check with mode-aware `findContainerByRelPath` (line 2372)
- Both correctly handle concurrent opens of unstaged+staged for the same file

**Test coverage:**
- 849 tests pass
- `files-applet-diff-tab-id.test.ts` correctly simplified to drop range cases
- `file-edits-route.test.ts` deleted entirely (was all ref-validation cases — no longer needed)

---

## Verification Summary

| Check | Status | Notes |
|-------|--------|-------|
| No range leftovers | ✅ | Clean grep results |
| Staged mode end-to-end | ✅ | All 9 steps traced |
| Staged persistence cycle | ✅ | Write + read verified |
| V5 card rehydration | ✅ | Fast path preserved |
| TabContainer constructor | ✅ | V1-V5 defaults intact |
| routeOpen pendKey | ✅ | Dedup logic correct |
| findContainerByRelPath | ✅ | Symmetric mode filter |
| git-diff stub | ✅ | All redirect cases work |
| Schema additivity | ✅ | V5 readers unaffected |
| V6 acceptance regression | ✅ | No unexpected breaks |

---

## Recommendation

**APPROVE** for merge to master. The removal is complete, consistent, and preserves all V6 staged-mode value while eliminating the unused range-mode complexity. The minor documentation gap is cosmetic and does not affect implementation correctness.

**Post-merge suggestion:** Update `docs/files-applet-v6.md` §8 with V6.1 tombstones for deleted acceptance items (see MINOR finding above). Not a blocker.
