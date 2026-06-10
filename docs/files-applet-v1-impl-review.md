# Files-Applet V1 Implementation Review

**Branch:** `files-applet-v1`  
**Spec:** docs/files-applet-v1.md §4.0  
**Plan:** plan.md  
**Build Status:** ✓ PASSING (npm run build: typecheck + lint + 836 tests all green)  
**Review Date:** 2025-01-09  

---

## Executive Summary

**Overall Assessment: NO BLOCKER ISSUES FOUND**

The files-applet V1 implementation correctly follows the §4.0 spec across all critical areas:
- ✓ §4.0.5 lifecycle rules (delete-before-destroy, capture-clear-destroy)
- ✓ §4.0.6 invariants (contentEl display, setActiveTab ordering, TAB_CAP enforcement)
- ✓ §4.0.3 shell API completeness and correct usage
- ✓ echoState coalescing implementation
- ✓ Sibling-script loader security
- ✓ Backward compatibility (tab.paneEl alias, applyAgentState)
- ✓ Routing edge cases and _pinnedType handling
- ✓ Diff filters in persistence and navigation

Two minor observations documented below as NICE-TO-HAVE items.

---

## Files Reviewed

### Implementation Files
- **applets/file-edits/script.js** (2105 lines, +109 net from master)
- **applets/file-edits/diff-tab.js** (205 lines, new)
- **applets/file-edits/markdown-tab.js** (186 lines, new)
- **applets/file-edits/content.html** (chevron menu button added)
- **applets/file-edits/style.css** (.files-md-content, .fe-tab-md, .fe-tab-diff, .fe-menu)
- **applets/file-edits/meta.json** (description and agentUsage updated)
- **src/applet-store.ts** (sibling-script loader, lines 229-253)

### Specification & Planning Docs
- docs/files-applet-v1.md (§4.0 class-level design)
- plan.md (10 implementation steps)
- docs/files-applet-v1-review.md (prior design review)
- docs/files-applet-v1-arch-review.md (prior arch review)
- ./code-quality.md (coding standards)

---

## Findings

### NICE-TO-HAVE #1: Sibling-Script Loader Applies to All Applets

**File:** src/applet-store.ts:229-253  
**Severity:** NICE-TO-HAVE  

**Observation:**  
The sibling-script loader (which reads all `*.js` files except `script.js` from an applet's root directory and concatenates them before `script.js`) applies to ALL applets—both bundled and user-saved applets. This is a behavior change for existing user-saved applets if they happen to have other `.js` files in their directory.

**Analysis:**
- Security: ✓ Correct. `paths.root` is server-controlled, no user input in file path construction. `readdir` failure is caught and non-fatal (applet falls back to single-file mode).
- Ordering: ✓ Deterministic. Files sorted alphabetically, concatenated before `script.js`.
- Error handling: ✓ Robust. Individual file read failures are swallowed (non-fatal); directory read failure makes applet single-file.

**Potential Impact:**
- If a user-saved applet directory contains stray `.js` files (e.g., backup copies, unrelated scripts), those files will now be executed as part of the applet.
- This is unlikely to cause issues in practice (user applet directories are typically clean), but it's a subtle behavior change.

**Suggested Mitigation (optional):**
- Document the sibling-script behavior in user-facing applet creation docs
- OR: Restrict sibling-script loading to bundled applets only (check if applet is from `bundledApplets` vs `applets`)
- OR: Accept as-is (reasonable default; users can clean up their applet directories if needed)

**Evidence:**
```typescript
// src/applet-store.ts:229-253
try {
  const files = await fs.readdir(paths.root);
  const jsFiles = files
    .filter(f => f.endsWith(".js") && f !== "script.js")
    .sort();
  if (jsFiles.length > 0) {
    const siblings = await Promise.all(
      jsFiles.map(async f => {
        try {
          return await fs.readFile(path.join(paths.root, f), "utf-8");
        } catch {
          return "";
        }
      })
    );
    script = siblings.join("\n") + "\n" + script;
  }
} catch {
  // directory read failed; single-file mode
}
```

---

### NICE-TO-HAVE #2: _pinnedType Persists if User Dismisses Picker

**File:** applets/file-edits/script.js:1345, 1203-1252  
**Severity:** NICE-TO-HAVE  

**Observation:**  
When the user clicks the chevron menu and selects "New markdown tab" or "New diff tab", `_pinnedType` is set to `'markdown'` or `'diff'`. If the user then dismisses the file picker dialog without selecting a file, `_pinnedType` remains set until the next `routeOpen` call.

**Analysis:**
- This is unlikely to cause issues in practice because:
  1. `routeOpen` clears `_pinnedType` at line 1206 (top of function, before any logic)
  2. The next file selection (via agent or user) will work correctly
  3. The persisted value doesn't affect state correctness—it's just a one-shot hint for the next open
- The behavior is acceptable and doesn't violate any spec invariants.

**Current Flow:**
1. User clicks menu → "New markdown tab" (line 1345: `_pinnedType = 'markdown'`)
2. Picker opens (line 1346)
3. User dismisses picker without selecting → `_pinnedType` still `'markdown'`
4. User triggers another open via different means → `routeOpen` clears `_pinnedType` at line 1206

**Suggested Mitigation (optional):**
- Listen for picker cancellation event and clear `_pinnedType`
- OR: Accept as-is (current behavior is harmless and self-healing)

**Evidence:**
```javascript
// script.js:1345-1351 (menu handler)
} else if (item === "newMarkdown") {
  _pinnedType = "markdown";  // Set here
  window.applet.pickFile();
} else if (item === "newDiff") {
  _pinnedType = "diff";      // Set here
  window.applet.pickFile();
}

// script.js:1206 (routeOpen always clears at top)
async function routeOpen(pathParts) {
  _pinnedType = null;  // Always cleared before any logic
  // ... rest of function
}
```

---

## Detailed Verification Results

### ✓ §4.0.5 Lifecycle Rules (ALL CORRECT)

**Rule 2: closeTab must delete-before-destroy**
- **File:** script.js:808-840
- **Result:** ✓ CORRECT
- **Evidence:** `tabs.delete(id)` at line 823, THEN `tab.destroy()` at line 839
```javascript
// script.js:808-840
closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  // ...
  tabs.delete(id);  // Line 823: delete FIRST
  // ...
  tab.destroy();    // Line 839: destroy SECOND
}
```

**Rule 6: onSessionChange must capture-clear-destroy**
- **File:** script.js:2036-2064
- **Result:** ✓ CORRECT
- **Evidence:** Capture at 2055, `tabs.clear()` at 2056, `activeTabId = null` at 2059, THEN destroy loop at 2062-2064
```javascript
// script.js:2055-2064
const toDestroy = Array.from(tabs.values());  // Line 2055: capture
tabs.clear();                                  // Line 2056: clear map
// ...
activeTabId = null;                            // Line 2059: clear activeTabId
// ...
for (const t of toDestroy) t.destroy();       // Line 2062-2064: destroy
```

**MarkdownTab.open must acquire-watcher-first, load-second, destroy-on-rejection**
- **File:** markdown-tab.js:160-182
- **Result:** ✓ CORRECT
- **Evidence:** `shell.api.acquireFileWatcher` at line 166 BEFORE `inst.load()` at line 172, with `.catch(() => inst.destroy())` at line 175
```javascript
// markdown-tab.js:166-175
const watcher = await shell.api.acquireFileWatcher(/* ... */);  // Line 166: watcher FIRST
// ...
inst.load(filepath, rootDir).catch(() => {                      // Line 172: load SECOND
  inst.destroy();                                                // Line 175: destroy on rejection
});
```

**MarkdownTab.load must check destroyed after every await**
- **File:** markdown-tab.js:87-118
- **Result:** ✓ CORRECT
- **Evidence:** `if (this.destroyed) return;` checks at lines 88, 97, 100, 115 (after each await)

---

### ✓ §4.0.6 Invariants (ALL CORRECT)

**Invariant: contentEl.style.display = 'none' in constructors**
- **Result:** ✓ CORRECT
- **Evidence:**
  - diff-tab.js:34: `this.contentEl.style.display = 'none';`
  - markdown-tab.js:41: `this.contentEl.style.display = 'none';`

**Invariant: setActiveTab must deactivate-old BEFORE activate-new**
- **File:** script.js:715-745
- **Result:** ✓ CORRECT
- **Evidence:** `prev.deactivate()` at line 726, THEN `next.activate()` at line 733
```javascript
// script.js:726-733
if (prev) prev.deactivate();  // Line 726: deactivate old FIRST
// ...
next.activate();              // Line 733: activate new SECOND
```

**Invariant: TAB_CAP enforcement**
- **File:** script.js:772, 1242
- **Result:** ✓ CORRECT
- **Evidence:**
  - `openOrUpdateTab` calls `evictOldestNonActive()` at line 772
  - `routeOpen` calls `evictOldestNonActive()` at line 1242

---

### ✓ §4.0.3 Shell API (COMPLETE)

**Required Shell Methods:**
- **Result:** ✓ ALL PRESENT
- **Evidence:** script.js:86-102 defines shell object with:
  - `api`, `paneEl`, `tabStripEl`, `basename`, `badgeCounter`
  - `get sessionId()`, `closeTab`, `setActiveTab`, `echoState`
  - DiffTab-only helpers: `openFromAgent`, `buildPersistBody`, `onDidEdit`, `jumpToMostRecent`

**DiffTab usage:**
- **Result:** ✓ CORRECT
- **Evidence:** diff-tab.js uses all shell methods via `this.shell` prefix

**MarkdownTab usage:**
- **Result:** ✓ CORRECT
- **Evidence:** markdown-tab.js uses only generic shell methods (no DiffTab-only helpers)

---

### ✓ echoState Coalescing (CORRECT)

**Implementation:**
- **File:** script.js:166-185
- **Result:** ✓ CORRECT
- **Evidence:** Uses `echoPending` flag + `queueMicrotask` to collapse multiple calls in same tick
- **Key Detail:** Payload composed at FLUSH time (lines 177-180), not at first call's snapshot
```javascript
// script.js:166-185
function echoState() {
  if (echoPending) return;
  echoPending = true;
  queueMicrotask(() => {
    echoPending = false;
    const payload = {            // Line 177: compose at flush time
      state: buildFilesState(),
      legacyState: buildFileEditsLegacyState(),
    };
    window.applet.setAppletState(payload);
  });
}
```

---

### ✓ Sibling-Script Loader Security (CORRECT)

**File:** src/applet-store.ts:229-253  
**Result:** ✓ SECURE  
**Analysis:**
- ✓ Paths are server-controlled (`paths.root` from applet metadata, no user input)
- ✓ Directory read failure is caught and non-fatal (falls back to single-file mode)
- ✓ Individual file read failures are swallowed (non-fatal)
- ✓ Alphabetic sorting ensures deterministic concatenation order
- ⚠️ Applies to ALL applets (see NICE-TO-HAVE #1)

---

### ✓ Backward Compatibility (CORRECT)

**tab.paneEl alias:**
- **File:** diff-tab.js:54-56
- **Result:** ✓ CORRECT
- **Evidence:** Getter returns `contentEl`
```javascript
// diff-tab.js:54-56
get paneEl() {
  return this.contentEl;  // Alias for V3.5 compat
}
```
- **V3.5 selection code works:** script.js:236, 490, 892 check `tab.paneEl.parentNode !== paneEl`; this works because `contentEl` IS mounted in `paneEl`

**applyAgentState:**
- **File:** script.js:664-669
- **Result:** ✓ CORRECT
- **Evidence:** Constructs DiffTab, attaches `tabEl`/`contentEl`, works correctly for agent-driven restores

---

### ✓ Routing Edge Cases (CORRECT)

**routeOpen _pinnedType handling:**
- **File:** script.js:1203-1252
- **Result:** ✓ CORRECT
- **Evidence:** `_pinnedType` cleared at line 1206 (top of function, before any logic)
- **Race handling:** Lines 1233-1240 check `tabs.has(inst.id)`; if duplicate, destroys new instance and switches to existing

---

### ✓ Diff Filters (ALL CORRECT)

**buildPersistBody:**
- **File:** script.js:976
- **Result:** ✓ CORRECT
- **Evidence:** Filters to `t.type === 'diff'`
```javascript
// script.js:976
return Array.from(tabs.values()).filter(t => t.type === 'diff').map(/* ... */);
```

**jumpToMostRecent:**
- **File:** script.js:854, 859, 867
- **Result:** ✓ CORRECT
- **Evidence:** Filters to `t.type === 'diff'` in all three branches

**caco.edit handler:**
- **File:** script.js:2028
- **Result:** ✓ CORRECT
- **Evidence:** Calls `openOrUpdateTab` per edit; `openOrUpdateTab` always creates DiffTab; no collision with MarkdownTab ids (markdown ids are `'markdown:'` prefixed)

---

## Recommendations

### Critical (None)
No blocker issues found.

### Important (None)
No important issues found.

### Nice-to-Have

1. **Consider restricting sibling-script loader to bundled applets** (or document behavior for users)
   - Current behavior is safe but may surprise users with stray `.js` files in applet directories
   - See NICE-TO-HAVE #1 for details

2. **Consider clearing _pinnedType on picker cancellation** (or accept as-is)
   - Current behavior is harmless and self-healing
   - See NICE-TO-HAVE #2 for details

---

## Conclusion

The files-applet V1 implementation is **production-ready**. All critical areas—lifecycle correctness, invariants, shell API, coalescing, security, backward compatibility, routing, and diff filters—are correctly implemented per the §4.0 spec. The two observations documented above are minor and do not affect correctness.

**Approval Status:** ✓ APPROVED for merge

---

**Reviewer Notes:**
- Build status verified: `npm run build` passes (typecheck + lint + 836 tests all green)
- All §4.0.5 lifecycle rules verified with line-level code inspection
- All §4.0.6 invariants verified with line-level code inspection
- Shell API completeness verified against §4.0.3 requirements table
- Security review of sibling-script loader completed
- No code modifications made during review (per instructions)
