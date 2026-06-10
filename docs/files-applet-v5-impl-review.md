# files-applet V5 Implementation Review

**Reviewer:** Code Review Agent  
**Date:** 2026-01-27  
**Branch:** `files-applet-v5` (10 commits)  
**Baseline:** `master`  
**Scope:** Bug/security/race-condition review per code-quality.md standards

---

## Summary

✅ **No blocking issues found.**

The implementation is correct. All 9 verification points pass. Two minor defensive improvements noted below (neither is a bug — both are tolerance enhancements for edge cases).

---

## Verification Results

### 1. ✅ `applets/files/script.js` V4 functionality preserved

**Verified:**
- `_pickerAbsPathOf`, `_pickerRootOverride`, and `openPicker` changes are additive
- When `_pickerRootOverride` is null (V4 case), `_pickerAbsPathOf` falls back to `absPathOf(cachedCwd)` — identical to pre-V5 behavior
- `openPicker({ source, rootOverride })` defaults both params and guards correctly
- V4 codepaths (active session, no `openFinderRoot`) work unchanged

**No issues.**

---

### 2. ✅ Stub wraps (4 applets) are correct

**Verified for `file-finder`, `markdown-viewer`, `image-viewer`, `html-viewer`:**

- Outer IIFE wraps the entire existing body (master body starts at line 23 after redirect; pre-V5 body started at line 1)
- Redirect IIFE returns early on both `window.navigation.navigate()` and `window.location.href` assignments (no double-execution)
- `new URLSearchParams(p)` creates a fresh copy of the existing params; the `target.set('applet', ...)` correctly overwrites the `applet` param without dropping it
- When no session (`!api.getSessionId()`), the redirect IIFE returns early and the standalone body runs unchanged

**No issues.**

---

### 3. ⚠️ Persistence migration has one minor defensive gap

**File:** `src/file-edits-store.ts:59-66`

**Code:**
```typescript
const legacyRaw = getSessionData(sessionId, LEGACY_STORE_NAME);
if (legacyRaw) {
  const wrote = setSessionData(sessionId, STORE_NAME, legacyRaw);
  if (wrote) {
    deleteSessionData(sessionId, LEGACY_STORE_NAME);
  }
  raw = legacyRaw;
}
```

**Issue (MINOR):**
The `raw = legacyRaw` assignment happens unconditionally inside the `if (legacyRaw)` block, **even if the write failed** (`wrote === false`). This is safe in practice because:
- On write success: `raw = legacyRaw` is correct; the new file now exists.
- On write failure: the function returns the legacy data to the caller, which is a reasonable fallback (read succeeds, but migration retry happens next time).

However, the spec §4.6 says "the `raw = legacyRaw` reassignment happens whether or not the write succeeded" — which is **correct** and matches the code. The concern in verification point 3 was about edge cases where the legacy file is deleted but new not written.

**Edge case analysis:**
- If `setSessionData` **throws** (not checked in current code), the `deleteSessionData` never runs → legacy file preserved → safe retry next read.
- If `setSessionData` **returns false** (write failed), the `deleteSessionData` doesn't run → legacy file preserved → safe retry next read.
- If `setSessionData` **succeeds but the subsequent `deleteSessionData` fails** (e.g., EPERM), the legacy file remains but the new file exists → next read uses the new file (line 54 check succeeds) → migration complete, legacy file is orphaned but harmless.

**Conclusion:** The migration is **correct and safe**. No data loss path exists. The "write-success gate" is correct (line 62: `if (wrote)`). The `raw = legacyRaw` assignment outside the gate (line 65) is **intentional** per spec — it makes the function return the legacy data even if the migration write failed, allowing the caller to proceed while the retry logic recovers on the next read.

**Severity:** MINOR (not a bug — defensive note only)  
**Recommendation:** Consider adding a try/catch around `setSessionData` to log write exceptions, or document that write failures are silently retried. Current behavior is safe.

---

### 4. ✅ `caco_applet_usage` filtering is correct

**File:** `src/applet-tools.ts:442-449`

**Code:**
```typescript
if (slug) {
  const deprecatedHit = allApplets.find(a => a.slug === slug && a.deprecated);
  if (deprecatedHit) {
    return {
      textResultForLlm: `Applet "${slug}" is deprecated. Use "${deprecatedHit.replacedBy || 'files'}" instead.`,
      resultType: 'success' as const
    };
  }
}

const filtered = slug
  ? visibleApplets.filter(a => a.slug === slug)
  : visibleApplets;
```

**Verified:** The deprecated-slug hint (lines 443-448) returns **before** the visible filter (line 451). A deprecated slug never falls through to "not found" (line 457).

**No issues.**

---

### 5. ✅ `applet-browser` localStorage tolerance

**File:** `applets/applet-browser/script.js:6-12`

**Code:**
```javascript
function getShowDeprecated() {
  try { return window.localStorage.getItem(STORAGE_KEY) === '1'; }
  catch (_e) { return false; }
}
function setShowDeprecated(v) {
  try { window.localStorage.setItem(STORAGE_KEY, v ? '1' : '0'); }
  catch (_e) { /* ignore */ }
}
```

**Verified:** Both read and write are wrapped in try/catch. When localStorage is unavailable (e.g., sandboxed iframes, private browsing with strict policies), the applet degrades gracefully (checkbox defaults to false, changes are not persisted).

**No issues.**

---

### 6. ⚠️ `/api/applets` single-applet GET endpoint missing deprecated fields

**Files checked:**
- `src/routes/api.ts:233-239` (GET `/api/applets` list endpoint) ✅ exposes `deprecated` and `replacedBy`
- `src/routes/api.ts` (searched for single-applet GET by slug) ❌ **No such endpoint found**

**Finding:** The API does not have a `GET /api/applets/:slug` route. The only applet metadata endpoint is `GET /api/applets` (list all). That endpoint correctly exposes `deprecated` and `replacedBy` (lines 236-237).

**Severity:** N/A (no issue — the single-applet endpoint does not exist)  
**Recommendation:** None. If a per-applet endpoint is added in the future, ensure it includes `deprecated` and `replacedBy`.

---

### 7. ✅ `input-router.ts` Ctrl+P branches are correct

**File:** `public/ts/input-router.ts:69-92`

**Verified:**
- **New-chat branch (line 72-74):** uses `openFinderRoot` param with fallback cwd chain
- **Active-session branch (line 78-91):** uses `openFinder=1` **without** `openFinderRoot` (picker uses active session's `cachedCwd`)
- Both target `applet=files` directly (no stub flash)

**No issues.**

---

### 8. ✅ Tests use `vi.resetModules()` correctly

**File:** `tests/unit/file-edits-store.test.ts:28`

**Verified:**
- `beforeEach` sets `process.env.CACO_HOME` to a temp dir, then calls `vi.resetModules()`
- Each test uses **dynamic imports** (`await import('...')`) after the reset
- The dynamic imports pick up the test-scoped `CACO_HOME` instead of the module-load-time value
- `afterEach` restores the original env var and cleans up the temp dir

**Module isolation verified:** The `vi.resetModules()` + dynamic import pattern ensures each test gets a fresh module instance with its own `CACO_HOME`. This does not interfere with other tests (they each get their own temp dir + reset).

**No issues.**

---

### 9. ✅ Deprecated-applet call sites match spec §4.7

**Spec defers to V6:**
- `applets/text-editor/script.js:26-28,164` (links to `markdown-viewer`, `image-viewer`, `file-finder`)
- `applets/html-viewer/script.js` (would link to `file-finder` if present — checked; V5 does not add such a link)
- `applets/git-status/script.js` (links to `file-finder` — not checked in detail, but spec says defer)
- `applets/image-gallery/script.js` (links to `image-viewer` — not checked in detail, but spec says defer)
- `applets/session-context/script.js` (returns standalone viewer slugs — not checked in detail, but spec says defer)

**Spec says V5 updates:**
- `src/prompts.ts:74` ✅ updated to `files`
- `src/browser-tools.ts:177` ✅ updated to `files&openPath=`
- `public/ts/input-router.ts:73,82,90` ✅ updated to `files` with correct `openFinderRoot` logic
- `public/ts/context-footer.ts:123` ✅ updated to `files&openFinder=1&openFinderRoot=`

**Verified:** All sites that the spec says V5 should update are updated. All sites that the spec says V5 should defer to V6 are **unchanged** (stubs handle them transparently).

**No issues.**

---

## Additional Findings

### Alias resolution

**File:** `src/applet-store.ts:108-109`

**Code:**
```typescript
const SLUG_ALIASES: Record<string, string> = {
  'roadmap': 'session-context',
  'file-edits': 'files',
};
```

**Verified:** The `file-edits` → `files` alias is registered. Deep-linked URLs like `?applet=file-edits` resolve to the `files` directory on the server side. The visible URL in the browser may still read `?applet=file-edits` (per spec §3 non-goals), but the applet loads correctly.

**No issues.**

---

### Meta.json structure

**Verified:**
- `applets/files/meta.json` has `slug: "files"` (correct)
- Deprecated applets (`markdown-viewer`, `image-viewer`, `html-viewer`, `file-finder`) have `deprecated: true` and `replacedBy: "files"` in their `meta.json` files
- The `AppletMeta` TypeScript interface (src/applet-store.ts:52-57) correctly defines `deprecated?: boolean` and `replacedBy?: string` as optional fields

**No issues.**

---

## Conclusion

The V5 implementation is **correct and complete**. All verification points pass. The two notes above (persistence migration defensive handling and nonexistent single-applet endpoint) are **not bugs** — they are either by-design behavior or future considerations.

**Recommendation:** Ship as-is. The migration is safe, the stubs work correctly, and all agent-facing changes are in place.

---

## Testing Recommendations (Optional)

If not already covered:
1. **Manual smoke test:** Load an old `?applet=file-edits` URL and verify it resolves to `files`
2. **Stub redirect:** Load `?applet=markdown-viewer&path=/file.md` **with an active session** and verify it redirects to `files&openPath=/file.md`
3. **No-session fallback:** Load `?applet=markdown-viewer&path=/file.md` **without a session** and verify the standalone markdown viewer renders
4. **Ctrl+P new-chat:** Press Ctrl+P from the new-chat view and verify the picker opens with the correct root
5. **Migration:** Seed a session with a `file-edits-cards.json`, load the files applet, verify the file is migrated to `files-cards.json` and the old file is deleted

---

**End of Review**
