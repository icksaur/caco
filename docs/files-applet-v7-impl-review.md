# Files Applet V7 Implementation Review

**Branch:** `files-v7`  
**Spec:** `docs/files-applet-v7-no-session.md` rev 3  
**Diff stats:** 32 files changed, 285 insertions(+), 1880 deletions(-)

---

## Issue 1: Missing `#feOpen` ID in applyCapabilities

**File:** `applets/files/script.js:2736`  
**Severity:** BLOCKER  
**Problem:** `applyCapabilities` references `openBtn.hidden` to hide the `+` button in sessionless mode, but the code never declares `openBtn`. The element declaration at line 19 is `var openBtn = document.getElementById('feOpen');` which will be null if the HTML doesn't have an element with that ID. The spec requires hiding `#feOpen` in sessionless mode (spec §4.2 + acceptance item 6).

**Evidence:** 
- Line 2736: `if (!capabilities.canPersist) openBtn.hidden = true;`
- Line 19: `var openBtn = document.getElementById('feOpen');`
- The code assumes `openBtn` exists, but if `getElementById` returns null, the assignment will throw at runtime.

**Suggested fix:** Add a null check: `if (!capabilities.canPersist && openBtn) openBtn.hidden = true;`. Same for `followBtn` and `notGitEl` in lines 2735, 2737.

---

## Issue 2: TabContainer constructor opts.external (verified correct)

**File:** `applets/files/script.js:362`  
**Severity:** N/A  
**Problem:** N/A  
**Evidence:** TabContainer constructor line 362: `this.external = !!(opts && opts.external);`. The flag is properly stored and used at line 372 to compute the tab ID as `'external:' + absPath`.

**Suggested fix:** N/A. Implementation is correct.

**VERDICT:** Not a bug. TabContainer properly stores and uses the external flag.

---

## Issue 3: routeOpenExternal error tab lacks destroy on failure

**File:** `applets/files/script.js:2648-2657`  
**Severity:** MINOR  
**Problem:** When `desc.open()` throws in `routeOpenExternal`, the code renders an error div into the container's contentEl and then **continues** to add the container to tabs, tabsEl, and paneEl. This means the tab strip will have a non-functional tab with an error message. However, the container object is added to `tabs` map (line 2658), so it will participate in tab eviction and other tab management. If the user tries to switch viewers on this error tab via the toggle menu, `TabContainer.switchViewer` will try to open a viewer and likely fail again.

**Evidence:** Lines 2650-2657 show the catch block renders an error but then execution falls through to lines 2658-2667 which add the container to the tab strip. Compare with `routeOpen` (line 2588) which calls `container.destroy()` on failure.

**Suggested fix:** This is actually intentional per spec §4.5.1 and acceptance item 11 ("Path the server can't read → inline error in tab content"). The tab stays so the user can see what failed. Document this as working-as-designed. The concern about viewer toggle on error tabs is a rare edge case and the existing `switchViewer` error handling (lines 850-859) will recover by logging a warning.

**VERDICT:** Not a bug. The implementation matches the spec. Mark as MINOR and note in acceptance tests.

---

## Issue 4: paneEmptyEl.textContent assignment in bootSessionless may not be visible

**File:** `applets/files/script.js:3603`  
**Severity:** IMPORTANT  
**Problem:** `bootSessionless` sets `paneEmptyEl.textContent = 'Open a file via ?openPath=ABSOLUTE_PATH or finder via ?openFinder=1&openFinderRoot=ABSOLUTE_DIR'` (line 3603). However, if the page loads with `openPath` or `openFinder` params, the code then calls `routeOpenExternal` or `openPicker`, which will create a tab and call `updateEmptyState()`. `updateEmptyState` may hide the paneEmptyEl when `tabs.size > 0`, so the custom hint would never be visible.

The issue is that the empty-pane hint is only visible when **no tabs exist**. Per acceptance item 9, closing the only sessionless tab should show the sessionless usage hint. This will work correctly because the hint is set early at boot time. However, the code also calls `setEmptyPaneError` three times (lines 3608, 3615, 3620) which replaces the textContent with error-specific messages. These three error paths are mutually exclusive with the tab-opening paths, so the user will see either:
- An error message (when params are invalid)
- A tab (when params are valid)
- The usage hint (when closing all tabs)

**Evidence:** 
- Line 3603 sets the default hint
- Lines 3608, 3615, 3620 call `setEmptyPaneError` which replaces it
- Closing a tab calls `updateEmptyState` which shows paneEmptyEl when `tabs.size === 0`

**Suggested fix:** This is actually correct. The empty-pane hint set at line 3603 acts as the default visible message when the page loads with no valid params AND when the user closes all tabs. The `setEmptyPaneError` calls replace it only in the error cases. Mark as working-as-designed.

**VERDICT:** Not a bug. The implementation is correct per spec §8 acceptance item 9.

---

## Issue 5: Missing watch opts in registry wrappers (already fixed)

**File:** `applets/files/script.js:2688, 2701, 2710, 2728`  
**Severity:** N/A  
**Problem:** N/A  
**Suggested fix:** Already implemented correctly. All registry wrappers forward `opts`.

---

## Issue 6: DiffViewer opts forwarding not verified

**File:** `applets/files/script.js:2719`  
**Severity:** IMPORTANT  
**Problem:** The DiffViewer registry descriptor (line 2719) forwards opts to `DiffViewer.open(s, c, a, r, opts)`. However, I haven't verified that `diff-viewer.js` properly handles the `opts.watch` flag. If DiffViewer unconditionally calls `watchPath`, it will throw in sessionless mode.

**Evidence:** The spec excludes DiffViewer from sessionless mode via the registry filter (line 2713: `if (DiffViewer && capabilities.canDiff)`). Sessionless has `canDiff: false`, so DiffViewer is never in the registry. This means DiffViewer.open is never called in sessionless mode, so it doesn't matter if it handles `opts.watch`.

**Suggested fix:** N/A. DiffViewer is registry-excluded in sessionless mode, so it's not reachable. Mark as not applicable.

**VERDICT:** Not a bug. DiffViewer is registry-excluded when `!canDiff`.

---

## Issue 7: Potential null deref in applyCapabilities (duplicate of Issue 1)

**File:** `applets/files/script.js:2734-2738`  
**Severity:** BLOCKER  
**Problem:** Lines 2735-2737 access `.hidden` on `followBtn`, `openBtn`, and `notGitEl` without null checks. If any `getElementById` at module init returned null (e.g., if the HTML is missing an element), this will throw.

**Evidence:** Same as Issue 1.

**Suggested fix:** Add null checks before accessing `.hidden`:
```javascript
function applyCapabilities(capabilities) {
  if (!capabilities.canFollowEdits && followBtn) followBtn.hidden = true;
  if (!capabilities.canPersist && openBtn) openBtn.hidden = true;
  if (!capabilities.canPersist && notGitEl) notGitEl.hidden = true;
}
```

---

## Issue 8: bootSessionless params not validated as strings

**File:** `applets/files/script.js:3605-3620`  
**Severity:** IMPORTANT  
**Problem:** `bootSessionless` reads `params.openFinder` (line 3605) and `params.openFinderRoot` (line 3606) and `params.openPath` (line 3612). The params are extracted from URLSearchParams at line 3637 via `new URLSearchParams(_bootSearch).forEach(function(v, k) { _bootParams[k] = v; })`. URLSearchParams values are always strings, so this is safe. However, line 3606 defensively calls `String(params.openFinderRoot)` but line 3613 also calls `String(params.openPath)`, which is redundant but harmless.

**Evidence:** Lines 3635-3638 build `_bootParams` from URLSearchParams, which always yields string values. The `String(...)` calls are defensive but unnecessary.

**Suggested fix:** Not a bug. The defensive `String()` calls are harmless and make the code more robust if someone later passes non-URLSearchParams-derived params. Mark as working-as-designed.

**VERDICT:** Not a bug. Defensive programming is acceptable here.

---

## Issue 9: Server redirect query param type coercion

**File:** `server.ts:106-112`  
**Severity:** MINOR  
**Problem:** Line 106 checks `typeof req.query.applet === 'string'` before calling the redirect helper. Line 108 constructs URLSearchParams from `req.query as Record<string, string>`, but Express query params can be `string | string[] | ParsedQs | ParsedQs[]`. The cast is unsafe if `req.query` contains array values (e.g., `?applet=files&openPath=/x&openPath=/y`).

**Evidence:** Express query parsing can yield arrays for duplicate keys. The redirect helper's tests don't cover non-string param values.

**Suggested fix:** Validate that all query param values are strings or filter them:
```typescript
if (slug) {
  const cleanQuery = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) {
    if (typeof v === 'string') cleanQuery.set(k, v);
  }
  const target = legacyAppletRedirectTarget(slug, cleanQuery);
  if (target) {
    res.redirect(302, '/?' + target.toString());
    return;
  }
}
```

---

## Issue 10: Legacy redirect unit tests missing unicode and edge cases

**File:** `tests/unit/legacy-applet-redirects.test.ts`  
**Severity:** MINOR  
**Problem:** The 14 tests cover the spec rules and param preservation, but they don't test:
- Unicode in path values (e.g., `path=/ファイル/文書.md`)
- Empty string values (e.g., `path=`)
- Special characters that need URL encoding (e.g., `path=/x y/file.md`)
- Very long path values (e.g., `path=/a/b/c/.../z` with 500+ chars)

**Evidence:** Test suite at lines 1-101 has good coverage of the redirect rules but no edge-case stress tests.

**Suggested fix:** Add tests for:
```typescript
it('preserves unicode in path values', () => {
  const out = legacyAppletRedirectTarget('markdown-viewer', p('path=/ファイル/文書.md'));
  expect(out!.get('openPath')).toBe('/ファイル/文書.md');
});
it('handles empty path value', () => {
  expect(legacyAppletRedirectTarget('markdown-viewer', p('path='))).toBeNull();
});
```

---

## Issue 11: Missing sessionless viewer toggle error (false alarm)

**File:** `applets/files/script.js:826-836`  
**Severity:** N/A  
**Problem:** Acceptance item 15b/15c requires that toggling a sessionless markdown/HTML tab to SourceViewer doesn't throw `watchPath` errors. The implementation forwards capability-derived `opts` at lines 826-829, which should prevent the error. Need manual smoke test to confirm.

**Evidence:** Lines 826-829 read `shell.capabilities` and forward `{ readOnly, watch }` to `desc.open()`. SourceViewer.open (line 164) wraps `watchPath` in `if (!opts || opts.watch !== false)`, so it should skip the call when `watch: false`.

**Suggested fix:** N/A. Implementation looks correct. Mark as requiring manual smoke test (acceptance item 15b/15c).

---

## Issue 12: Text editor link href uses window.location.href instead of appletAPI.navigate

**File:** `applets/text-editor/script.js:158, 176`  
**Severity:** MINOR  
**Problem:** Lines 158 and 176 set `window.location.href` to navigate to the files applet. This causes a full page reload instead of using the in-app navigation. The files applet's own code uses `window.location.href` for external navigations in some places (e.g., line 247 in the old file-finder stub), but within the Caco shell, links should prefer `appletAPI.navigateAppletUrlParam` or client-side routing when available.

**Evidence:** Lines 158, 176 use `window.location.href = '/?applet=files&...'`.

**Suggested fix:** Not a bug for V7. The text-editor is a standalone applet that doesn't have a shared routing helper. Using `window.location.href` is acceptable. If we want to optimize this, we'd need a shared client-side URL builder (spec §9 parking lot). Mark as working-as-designed for V7.

**VERDICT:** Not a bug. Acceptable for V7.

---

## Summary by Severity

### BLOCKER (1 issue, must fix)
- **Issue 1 & 7 (same root cause):** Missing null checks in `applyCapabilities` before accessing `.hidden` on `followBtn`, `openBtn`, `notGitEl`. Will throw at runtime if any element is missing from HTML.

### IMPORTANT (1 issue, review carefully)
- **Issue 9:** Server redirect query param type coercion is unsafe for array values. Add filtering or validation.

### MINOR (3 issues, note for future)
- **Issue 3:** routeOpenExternal error tabs participate in tab management (working as designed, but document).
- **Issue 10:** Legacy redirect tests missing unicode and edge-case coverage.
- **Issue 12:** Text editor uses full page reload instead of client-side nav (acceptable for V7).

### NOT BUGS (6 items, working as designed)
- Issue 2: TabContainer properly stores opts.external flag
- Issue 4: Empty-pane hint visibility logic is correct per spec
- Issue 5: Registry wrappers already forward opts correctly
- Issue 6: DiffViewer registry-excluded in sessionless mode
- Issue 8: Defensive string coercion is acceptable
- Issue 11: Requires manual smoke test but implementation looks correct

---

## High-Priority Smoke Tests (Before Merge)

After fixing the BLOCKER issues:

1. **Acceptance item 5** (highest risk): Open sessionless `?openPath=/abs/file.md`, `/abs/img.png`, `/abs/page.html`, `/abs/source.cpp` → verify no `watchPath` errors in console.
2. **Acceptance item 15b/15c**: Toggle sessionless markdown → source and HTML → source via per-tab viewer toggle → verify no `watchPath` errors.
3. **Acceptance item 9**: Open sessionless tab, close it → verify empty-pane shows sessionless usage hint, not session-mode "Click +".
4. **Acceptance item 16**: Session mode regression check — markdown Edit/Save, Follow edits, diff toggle, persistence all still work.
5. **Acceptance items 20-26**: Spot-check 3-4 legacy redirect URLs (markdown-viewer, file-finder, git-diff).

---

## VERDICT: FIX_THEN_SHIP

**Blocking issue:** `applyCapabilities` null pointer exceptions (Issue 1 & 7).  
**Important review:** Server query param safety (Issue 9).  
**Post-fix:** Run the 5 high-priority smoke tests above.

The implementation is architecturally sound and follows the spec closely. The boot split, capability plumbing, viewer `opts.watch` bypass, and external tab handling are all correctly implemented. The blocking issue is a simple null-check omission that will crash sessionless boot if the HTML is malformed. Fix that, review the server query param handling, and this is ready to ship.
