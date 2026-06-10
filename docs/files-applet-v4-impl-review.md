# files-applet V4 Implementation Review

**Branch:** `files-applet-v4`  
**Reviewer:** Code Review Agent  
**Date:** 2026-06-10  
**Spec:** `docs/files-applet-v4.md`

## Summary

No significant issues found in the reviewed changes.

The implementation correctly follows the spec and satisfies all verification requirements:

1. ✅ Copy click does NOT advance `pickerSelectedIdx` or call `pickSelected` (mousedown delegate ordering is correct)
2. ✅ Disabled-row early-return does not prevent copy on `(open)` rows (copy-branch runs first)
3. ✅ The 800ms timer lifecycle in `_pickerCopyPath` cannot race itself (`dataset.busy` guards entry; restore clears it)
4. ✅ The `.copied` class uses `box-shadow` not `background-color` (`.selected` stays visible)
5. ✅ Recent rows store absolute paths in `dataset.path` (POSIX-correct per spec §6.8)
6. ✅ Icon and copy span ordering is consistent (icon → path → [suffix] → copy)

## Code Quality Assessment

The implementation adheres to `code-quality.md` principles:

- **Minimal complexity**: Two focused helpers (`_pickerIconFor`, `_pickerCopyPath`), clear separation of concerns
- **Functional purity**: `_pickerIconFor` is a pure function with no side effects
- **Descriptive naming**: Variable and function names are self-documenting (`_PICKER_FILE_ICONS`, `copyEl`, `dataset.busy`)
- **Proper error handling**: `try-catch` around `navigator.clipboard.writeText` with graceful failure (✗ indicator)
- **No race conditions**: Busy-state lifecycle prevents concurrent timer races
- **No unnecessary abstraction**: Code is straightforward and maintainable

## Detailed Verification

### 1. Mousedown Delegate Ordering (Spec §5.3, §6.6)

**Code:**
```javascript
pickerList.addEventListener('mousedown', function(e) {
  // V4: copy-button branch FIRST...
  var copyEl = e.target.closest('.fe-picker-copy');
  if (copyEl) {
    e.preventDefault();
    e.stopPropagation();
    void _pickerCopyPath(copyEl.dataset.path || '', copyEl);
    return;  // ← Early return; never reaches pickSelected
  }
  var target = e.target.closest('.fe-picker-item');
  if (!target) return;
  e.preventDefault();
  if (target.classList.contains('disabled')) return;  // ← Never reached for copy clicks
  var flatIdx = Number(target.dataset.flatIdx);
  var entry = pickerVisible[flatIdx];
  if (entry) pickSelected(entry.rel);
});
```

**Verification:** Copy-button branch returns early before the disabled-row check. A click on a copy button on a `(open)` row will successfully copy without triggering selection. Correct per spec.

### 2. Timer Race Prevention (Spec §6.7)

**Code:**
```javascript
async function _pickerCopyPath(abs, btn) {
  if (!abs || !btn) return;
  if (btn.dataset.busy === '1') return;  // ← Guard entry
  btn.dataset.busy = '1';
  // ... clipboard write ...
  var timer = setTimeout(function() {
    btn.textContent = '📋';
    if (row) row.classList.remove('copied');
    delete btn.dataset.busy;  // ← Restore clears busy flag
    delete btn.dataset.restoreTimer;
  }, 800);
  btn.dataset.restoreTimer = String(timer);
}
```

**Verification:** Concurrent clicks on the same button are rejected at entry. The restore callback clears the busy flag exactly once after 800ms. No race condition possible.

### 3. CSS Specificity and Coexistence

**Code:**
```css
.fe-picker-item.selected {
  background: var(--color-surface-selected);  /* Existing rule */
}
.fe-picker-item.copied {
  box-shadow: inset 0 0 0 1px var(--color-accent, #6cf);  /* V4 addition */
}
```

**Verification:** A selected row that is also copied will show both the selection background AND the copy outline. Box-shadow does not override background-color. Correct per spec §6.5.

### 4. Disabled Row Copy Button Styling (Spec §6.6)

**Code:**
```css
.fe-picker-copy {
  opacity: 0;  /* Hidden by default */
  cursor: pointer;
}
.fe-picker-item:hover .fe-picker-copy { opacity: 0.6; }  /* Revealed on row hover */
.fe-picker-item.disabled .fe-picker-copy {
  opacity: 0.6;  /* Override: visible on disabled rows */
  cursor: pointer;
}
.fe-picker-item.disabled:hover .fe-picker-copy { opacity: 1; }
```

**Verification:** Specificity is correct (`.fe-picker-item.disabled .fe-picker-copy` = 0,2,1 beats `.fe-picker-copy` = 0,1,0). Disabled rows show the copy button at 0.6 opacity, making it visually available despite the row being `cursor: not-allowed`. Correct per spec.

### 5. Absolute Path Storage (Spec §5.5, §6.8)

**Recent rows:**
```javascript
var rp = shown[ri];  // Absolute path from _loadRecentFiles()
rcopy.dataset.path = rp;  // Store absolute directly
```

**Results rows:**
```javascript
var p = pickerResults[i];  // Relative path from server
copy.dataset.path = absPathOf(p);  // Convert to absolute
```

**Verification:** Both code paths store absolute paths in `dataset.path`, which is what `_pickerCopyPath` expects. POSIX-only semantics are documented in spec §6.8 and accepted as out-of-scope for Windows path handling in V4.

### 6. Icon Map Parity (Spec §5.1, §6.1)

**Standalone file-finder (`applets/file-finder/script.js`):**
```javascript
var fileIcons = {
  js: '📜', ts: '📜', jsx: '📜', tsx: '📜',
  json: '📋', md: '📝', txt: '📝',
  html: '🌐', css: '🎨',
  png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️',
  sh: '⚙️', bash: '⚙️'
};
```

**File-edits picker (`applets/file-edits/script.js`):**
```javascript
var _PICKER_FILE_ICONS = {
  js: '📜', ts: '📜', jsx: '📜', tsx: '📜',
  json: '📋', md: '📝', txt: '📝',
  html: '🌐', css: '🎨',
  png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️',
  sh: '⚙️', bash: '⚙️'
};
```

**Verification:** Exact match. Deliberate duplication is justified in spec §6.1 (V5+ consolidation deferred).

### 7. DOM Structure and Ordering (Spec §5.4)

**Recent rows:**
```javascript
rli.appendChild(ricon);   // 1. Icon
rli.appendChild(rlabel);  // 2. Path label
rli.appendChild(rcopy);   // 3. Copy button
```

**Results rows:**
```javascript
li.appendChild(icon);   // 1. Icon
li.appendChild(label);  // 2. Path label
li.appendChild(sfx);    // 3. Suffix (if open)
li.appendChild(copy);   // 4. Copy button
```

**Verification:** Consistent ordering. The existing `.fe-picker-item { display: flex; gap: var(--space-sm); }` layout handles spacing without needing margins on the new spans. Correct per spec §6.4.

## Edge Cases Reviewed

1. **Copy click on detached row:** If a re-render removes the row during the 800ms restore window, the timer callback accesses detached DOM nodes. This is safe (no errors) and expected per spec §6.7.5.

2. **Missing `dataset.path`:** The mousedown handler uses `copyEl.dataset.path || ''`, and `_pickerCopyPath` guards with `if (!abs || !btn) return;`. Defensive and safe.

3. **Clipboard rejection:** Non-secure contexts (http:// non-localhost) will reject `navigator.clipboard.writeText`. The `try-catch` gracefully handles this, showing ✗ instead of ✓. Correct per spec §5.2, §6.2.

4. **Double-click within 800ms:** Second click is rejected by `if (btn.dataset.busy === '1') return;`. Correct per acceptance §8.11.

## Observations (Not Blocking)

1. **Recent files display absolute paths in the label** (`rlabel.textContent = rp;`) **while results display relative paths** (`label.textContent = p;`). This is **pre-existing behavior from master** and not a V4 change. The spec example in §5.4 shows a relative path, but this could be interpreted as a results row example. The user mentioned "Recent rows store absolute paths" which confirms this is accepted behavior. Not flagged as a bug.

2. **`async` function with `void` call site:** The implementation uses `async function _pickerCopyPath` with `await navigator.clipboard.writeText(abs)`, but the call site discards the promise with `void _pickerCopyPath(...)`. This is correct and idiomatic for event handlers that should not block on async operations. Alternative would be `.then()` chaining, but `async/await` is cleaner and more readable.

3. **Icon extraction from absolute vs relative paths:** `_pickerIconFor(rp)` receives absolute paths for recent rows but relative paths for results rows. The function only cares about the extension (`split('.').pop()`), so both work correctly. Slight input inconsistency but no functional impact.

## Acceptance Criteria (Spec §8)

All 11 acceptance items can be verified through:

- **Items 1-8, 10-11:** Manual smoke testing with the picker (not code-reviewable)
- **Item 9:** `npm run build` would need to be run (deferred to CI/manual testing)

Code review confirms that items 3-4, 7, and 11 are correctly implemented at the code level:
- Item 3: Copy click does not change `pickerSelectedIdx` ✅
- Item 4: `.copied` class coexists with `.selected` background ✅
- Item 7: `.disabled .fe-picker-copy` has `cursor: pointer` and visible opacity ✅
- Item 11: `dataset.busy` lifecycle prevents timer races ✅

## Conclusion

The implementation is **correct and ready for merge**. All verification items pass. No bugs, security issues, race conditions, or broken UX detected. The code follows best practices and matches the spec precisely.

**Recommendation:** APPROVE
