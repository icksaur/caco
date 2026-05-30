# File Edits V2 Phase 1 — Code Review

Branch: `file-edits-v2-phase1` (commit 88f7d2d)
Spec: `docs/file-edits-v2.md` (Phase 1)
Reviewer focus: server hunk parser, client buildRows/collapseFolds, CSS display:contents, concurrency, rename handling

---

## [BLOCKER]

### 1. CSS `display: contents` breaks row backgrounds

**File:** `applets/file-edits/style.css:192`

**Problem:** The `.fe-row` elements use `display: contents`, which removes them from the box tree. Background colors are applied to `.fe-row-add .fe-line` and `.fe-row-add .fe-gutter` (lines 217-224), but these selectors depend on `.fe-row-add` existing as a parent box. With `display: contents`, the `.fe-row` div is invisible to rendering, so the background selectors targeting its children via descendant combinators will apply, but the backgrounds are then painted on the individual `.fe-gutter` and `.fe-line` spans directly.

**Evidence:** CSS spec states that `display: contents` causes the element to generate no boxes. The background is correctly applied to the child spans (`.fe-gutter`, `.fe-line`), not to a non-existent row box. Testing with a minimal HTML page shows that backgrounds DO render on the children when the parent has `display: contents`. **This is actually correct behavior** — the CSS applies backgrounds directly to the grid children (the spans), not to the row div.

**Resolution:** After verification, this is NOT a bug. The backgrounds render correctly because they are applied to the `.fe-gutter` and `.fe-line` elements, which ARE real boxes in the grid. The `.fe-row` serves only as a logical grouping. **Withdraw this as a blocker.**

---

## [IMPORTANT]

### 1. Concurrency bound doubled by second subprocess

**File:** `src/git-edit-poller.ts:303, 383`

**Problem:** `DIFF_CONCURRENCY = 8` bounds the `mapWithConcurrency` fan-out for `buildEntry` calls. Each `buildEntry` spawns:
1. One `fetchDiff` subprocess (`git diff`)
2. One `readHeadBlob` subprocess (`git show HEAD:path`) inside `computeFullFile` (line 303)

With 8 concurrent `buildEntry` calls, that's up to 16 `git` subprocesses in flight simultaneously. The original V1 code had at most 8 subprocesses (one `git diff` per file). V2 doubles the load.

**Evidence:** 
- `buildEntry` calls `fetchDiff` (lines 188-213) → spawns `git diff`
- `buildEntry` calls `computeFullFile` (line 344) → calls `readHeadBlob` (line 303) → spawns `git show`
- Both happen within the same concurrency-bounded task

**Impact:** On large dirty sets (branch checkout, stash pop), this could saturate file descriptors or git's internal locks. The 2000ms timeout per subprocess provides some safety, but the concurrency bound should account for the doubled subprocess count.

**Suggested fix:** Either reduce `DIFF_CONCURRENCY` to 4, or introduce a separate concurrency limit for `readHeadBlob` calls. Alternatively, batch `git show` calls for multiple files into a single subprocess (non-trivial, deferred to V3).

---

### 2. Race condition: file deleted between status and read

**File:** `src/git-edit-poller.ts:308-314`

**Problem:** `computeFullFile` reads the working-tree file with `stat` + `readFile` (lines 308-311). The file might be deleted or moved between the `git status` check and this read, causing the `catch` block to silently return `undefined` and fall back to hunk view.

**Evidence:**
```typescript
try {
  const absPath = join(repoRoot, relPath);
  const st = await stat(absPath);
  if (!st.isFile()) return undefined;
  workText = await readFile(absPath, 'utf-8');
} catch {
  // Working tree file absent or unreadable — treat as fallback case.
  return undefined;
}
```

The comment acknowledges "absent or unreadable," so this is **intentional graceful degradation**, not a bug. However, it means the user might briefly see a full-file card, then see it degrade to hunk view on the next poll if the file is deleted mid-flight.

**Resolution:** This is correct behavior for a best-effort poller. The fallback to `undefined` (hunk view) is the right choice. **Withdraw as IMPORTANT; this is acceptable.**

---

## [NICE]

### 1. Dead parameter `body` in `expandFold`

**File:** `applets/file-edits/script.js:209, 217`

**Problem:** `buildFoldEl` captures the `body` parameter (line 196) and passes it to `expandFold` (line 209), but `expandFold` never uses it. The parameter is dead code.

**Evidence:** `expandFold` signature is `function expandFold(foldDiv, row, lang, body)` (line 217), but the function body only references `foldDiv`, `row`, and `lang`. The `body` parameter is never accessed.

**Suggested fix:** Remove the `body` parameter from both `buildFoldEl` and `expandFold` signatures. This is a minor cleanup, not a functional bug.

---

### 2. `fullFileEqual` O(N) per line on every poll

**File:** `applets/file-edits/script.js:503-526`

**Problem:** `fullFileEqual` performs a deep line-by-line string comparison for the no-op poll guard (lines 515-523). For a 5000-line file polled every 1.5 seconds, this is 5000 string comparisons per poll per file.

**Evidence:** The function iterates over `workLines` and `headLines` arrays, comparing each element with `!==` (lines 516, 522). For a file with 5000 lines, that's 5000 comparisons.

**Impact:** Acceptable for V2 Phase 1. Modern JS engines optimize string equality checks well, and the 5000-line cap bounds the worst case. However, for Phase 2/3, consider caching a hash of the `fullFile` payload (e.g., `workLines.join('\n').length` or a simple checksum) to short-circuit the comparison.

**Suggested fix (deferred to V3):** Add a `contentHash` field to `FullFile` on the server side (cheap to compute during the existing line split), then compare hashes first before falling back to the deep check.

---

## [QUESTION]

### 1. `color-mix(in oklab, ...)` browser support

**File:** `applets/file-edits/style.css:219, 223`

**Problem:** The CSS uses `color-mix(in oklab, var(--color-success-bright) 18%, transparent)` for row backgrounds. `color-mix` with `oklab` interpolation requires:
- Chrome 111+ (March 2023)
- Firefox 113+ (May 2023)
- Safari 16.4+ (March 2023)

**Question:** Is this acceptable for the Caco target environment in 2026? If the target includes older browsers (e.g., enterprise environments locked to Chrome 90), this will silently fail and rows will have no background.

**Suggested fallback:** Add a simple `background: rgba(...)` rule before the `color-mix` line so older browsers ignore the unsupported property and use the fallback:

```css
.fe-diff[data-mode="fullfile"] .fe-row-add .fe-line,
.fe-diff[data-mode="fullfile"] .fe-row-add .fe-gutter {
  background: rgba(0, 200, 100, 0.15); /* Fallback */
  background: color-mix(in oklab, var(--color-success-bright) 18%, transparent);
}
```

---

## ✓ Verified Correct

The following focus areas were tested and found to be correct:

1. **Hunk parser (parseHunks):** Correctly handles:
   - Default length 1 when omitted (`@@ -10 +12 @@` → `{10, 1, 12, 1}`)
   - `headStart=1` (file start)
   - `headLen=0` (pure addition) and `workLen=0` (pure deletion)
   - Edge case `@@ -0,0 +1,5 @@` (pure addition at file start)

2. **buildRows merge walk:** Correctly handles:
   - Hunk at file start (`headStart=1`)
   - Pure addition (`headLen=0`) and pure deletion (`workLen=0`)
   - Untracked files (`headLines=null`)
   - Files where `headLines.length < hunks claim` (graceful empty-string fallback)
   - Tail emit: `while (h - 1 < headLines.length)` is equivalent to spec's `while (h <= headLines.length)`

3. **collapseFolds:** Correctly handles:
   - Empty `rows` array (no crash, returns `[]`)
   - Single `ctx` row (not folded)
   - Exactly `FOLD_THRESHOLD` ctx rows (20) → not folded (threshold is `>`, not `>=`)
   - `FOLD_THRESHOLD + 1` ctx rows (21) → folded into one fold row

4. **Rename handling (computeFullFile):** Correctly uses `originalRelPath` (which is `renamedFrom ?? path`) for the `readHeadBlob` call at line 303. The HEAD blob is read from the old path, and the working-tree file is read from the new path. ✓

5. **hljs XSS safety:** `hljs.highlight()` returns `{ value: escapedHTML }`, and the code assigns `hl.value` to `innerHTML` (line 184). This is safe because highlight.js escapes HTML in the `value` field. ✓

---

## Summary

**Findings:**
- **BLOCKER:** 0 (display:contents issue withdrawn after verification)
- **IMPORTANT:** 1 (concurrency doubled by second subprocess)
- **NICE:** 2 (dead parameter, fullFileEqual O(N) perf)
- **QUESTION:** 1 (color-mix browser support)

**Recommendation:** Fix the concurrency issue before merge (reduce `DIFF_CONCURRENCY` to 4 or add separate limit for `readHeadBlob`). The rest are polish items for Phase 2/3.
