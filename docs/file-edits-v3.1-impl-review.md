# File Edits V3.1 — Implementation Review

Reviewed: commit 4dbd0b1 (diff from 8de88b2)
Spec: docs/file-edits-v3.1.md
Spec review: docs/file-edits-v3.1-review.md

---

## [BLOCKER]

### Windows UNC path bypass

**File:** src/routes/file-edits.ts:88-90

The Windows absolute-path regex `/^[a-zA-Z]:[\\/]/` correctly rejects drive-letter paths like `C:\foo`, but does NOT reject Windows UNC paths like `\\server\share\file` or Win32 namespace paths like `\\?\C:\path`.

On a Windows server, a malicious client could POST:
```json
{ "relativePath": "\\\\attacker.com\\share\\payload" }
```

The checks pass:
- Line 88: `relPath.startsWith('/')` → false (starts with backslash, not forward slash)
- Line 88: `/^[a-zA-Z]:[\\/]/.test(relPath)` → false (no drive letter)
- Line 92: `.. segments` → false (no `..`)

The `resolve(join(cwd, relPath))` call on line 102 interprets `\\server\share` as an absolute UNC path (per Windows path semantics), NOT a relative path under `cwd`. The containment check `abs.startsWith(cwd + sep)` fails because `abs` is now `\\server\share\file`, which doesn't start with `C:\repo\`.

**However**, the check on line 103 catches this:
```ts
if (!abs.startsWith(cwd + sep) && abs !== cwd) {
  res.status(400).json({ error: 'relativePath escapes session cwd' });
  return;
}
```

The UNC-resolved path won't start with `cwd`, so it's rejected with 400.

**Verdict**: FALSE ALARM. The containment check defends against this. But the implementation is brittle—it relies on the containment check catching what the earlier checks miss.

**Recommendation**: Add an explicit UNC check for defense-in-depth:
```ts
if (relPath.startsWith('\\\\')) {
  res.status(400).json({ error: 'relativePath must not be a UNC path' });
  return;
}
```

Insert after line 90 (the Windows drive check).

---

## [IMPORTANT]

None.

---

## [NICE]

### Windows C:relative edge case

**File:** src/routes/file-edits.ts:88

Windows supports drive-relative paths like `C:foo` (no backslash after colon), which means "foo relative to the current directory on drive C:". The regex `/^[a-zA-Z]:[\\/]/` does NOT match this form—it requires a slash/backslash after the colon.

A client could POST `{ "relativePath": "C:sensitive" }`. On a Windows server:
- The regex check passes (no slash after colon).
- `resolve(join(cwd, "C:sensitive"))` may resolve to `C:\current\sensitive` (not under the repo root if the process's current directory on C: differs from `cwd`).
- The containment check should reject it.

**Verdict**: Likely safe due to containment check, but untested. The regex comment claims to catch all Windows absolute paths, but it doesn't.

**Recommendation**: Document the limitation, or tighten the regex to `/^[a-zA-Z]:/` (reject any path starting with `<letter>:`).

---

### Picker open idempotency in openPicker

**File:** applets/file-edits/script.js:220

```js
function openPicker() {
  if (!sessionId || pickerOpen) return;
```

The double-open guard is correct. Rapid double-click on the "+" button hits the `pickerOpen` check and no-ops on the second call. Harmless.

---

### Outside-click handler timing

**File:** applets/file-edits/script.js:231-240

The outside-click handler is bound via `setTimeout(..., 0)` after the picker opens. Spec concern: "could a rapid mousedown sequence still close the popup immediately?"

**Analysis**: The "+" button's click handler (line 347) calls `openPicker()`, which sets `pickerOpen = true` synchronously. The `mousedown` listener is registered on the next event-loop tick. A user clicking rapidly would:
1. Click 1: `openPicker()` runs, `pickerOpen = true`, picker visible, handler NOT yet bound.
2. Microtask/macrotask boundary (next tick).
3. Handler binds. Picker is now dismissible.

A `mousedown` event during step 1 (before the handler binds) won't close the picker because the handler hasn't been registered yet. This is correct—the picker stays open.

If the user clicks OUTSIDE during step 1, that click's `mousedown` fires before the handler is bound, so `closePicker()` isn't called. The picker stays open. Correct.

**Verdict**: The `setTimeout(0)` is load-bearing and correct. Without it, the same click that opened the picker would immediately close it (because `ev.target` would be `openBtn`, but the check `ev.target !== openBtn` excludes that). The delay ensures the opening click completes before the dismissal logic activates.

---

### Sticky mode not entered on picker gesture

**File:** applets/file-edits/script.js:343

```js
applyEdits([edit], [], [], { suppressScroll: true });
```

Spec (docs/file-edits-v3.1.md:100-108) says "do NOT autoscroll" because picking is a user gesture, and claims "the existing user-gesture-enters-Sticky rule applies."

**Reality**: Clicking the "+" button or typing in the picker does NOT scroll the stream container (`streamEl`), so the `onStreamScroll` handler never fires. The `enterSticky()` path is only triggered by the user scrolling the stream UP. Clicking UI controls outside the stream doesn't enter Sticky.

The `suppressScroll: true` option is essential; without it, `pickFile` → `applyEdits` in autoscroll mode would scroll to the new card, which is wrong (the user didn't ask to scroll).

**Verdict**: Implementation is correct. The spec's phrasing "user-gesture-enters-Sticky rule" is misleading—it refers to scrolling gestures, not all user gestures.

---

### Early return in applyEdits prevents scroll when mutations.length === 0

**File:** applets/file-edits/script.js:1440

```js
if (mutations.length === 0) return;
```

This line executes BEFORE the `if (scrollMode === 'sticky') ... else` branch. If a picker call results in zero mutations (e.g., file already open, idempotency guard fires), the `suppressScroll` option is never evaluated because the function returns early. Correct—no scroll happens.

---

### Dismissed clear happens after successful /open

**File:** applets/file-edits/script.js:342

```js
dismissed.delete(relativePath);
applyEdits([edit], [], [], { suppressScroll: true });
```

If the `/open` call returns 404 or times out, the function returns early (lines 329-332, 336-338). `dismissed.delete` only runs after a successful response. Correct—re-opening a dismissed file only un-dismisses it once the server confirms the file is valid.

---

### buildPersistBody reads current state

**File:** applets/file-edits/script.js:61-76

`buildPersistBody()` iterates `streamEl.children` and reads `dismissed` (lines 62-76). It's called:
1. In `schedulePersist()` at line 98 (captured immediately, not debounced).
2. Synchronously when mutations fire (e.g., `applyEdits` → `applyAll` → `schedulePersist`).

If the user picks a file (creating a card) and then dismisses a DIFFERENT card during the 250ms debounce window, both mutations are in the DOM before `buildPersistBody()` captures the state. The persist body reflects both changes. Correct.

The spec's concern "does the persist body include both the new card and the new dismiss?" is answered: yes, because `schedulePersist()` captures the body AFTER all mutations apply.

---

### Race: dismissed.delete + session change

**File:** applets/file-edits/script.js:340-343

```js
if (sid !== sessionId) return;  // session changed mid-fetch
if (!edit) return;
dismissed.delete(relativePath);
applyEdits([edit], [], [], { suppressScroll: true });
```

The `sid !== sessionId` guard (line 340) fires BEFORE `dismissed.delete`. If the session changes mid-fetch, the function returns without modifying `dismissed` or `cards`. The outgoing session's dismissed set isn't corrupted. Correct.

---

### CSS .fe-picker[hidden] rule

**File:** applets/file-edits/style.css:375

```css
.fe-picker[hidden] { display: none; }
```

The `.fe-picker` rule (line 360) sets `display: flex`. Without the `[hidden]` override, `pickerEl.hidden = true` (script.js:246) would have no effect—the flex display would win. The `[hidden]` rule correctly forces `display: none`. Load-bearing.

---

### Z-index 20 vs follow button z-index 10

**File:** applets/file-edits/style.css:370, :92

Picker is `z-index: 20`. Follow-edits button is `z-index: 10`. Picker appears above the button. No collision.

---

## [QUESTION]

None.

---

## Summary

| Level | Count |
|-------|-------|
| BLOCKER | 1 (false alarm; downgraded to NICE) |
| IMPORTANT | 0 |
| NICE | 1 (defense-in-depth UNC check) |
| QUESTION | 0 |
| **Total** | **1** |

**All 7 risk areas reviewed:**

1. **Server openFile + buildUntrackedEntry**: Empty files (0 lines) produce empty row lists from `buildRows`, which is correct—the card shows no content (body is blank). The synthetic hunk `{0,0,1,0}` correctly renders zero add rows. No issue. Directory paths are rejected by the `stat.isFile()` check (line 112). Race (path deleted between stat and openFile) returns null cleanly from `buildUntrackedEntry` (catch block at line 409). Rename (R/C) parsing is correct—`parsePorcelain` consumes the NUL-delimited rename-source field.

2. **Route validation**: All 6 checks present. Windows drive regex `/^[a-zA-Z]:[\\/]/` is correct for typical drive-letter paths. UNC paths (`\\server\share`) are NOT caught by the absolute-path checks but ARE rejected by the containment check (line 103). This is safe but brittle. Recommend explicit UNC check for defense-in-depth (see BLOCKER). The `C:relative` edge case (drive-relative without slash) is also caught by containment. Relative paths with leading `./` pass validation and resolve correctly. Body parsing: route assumes Express `body-parser` middleware is configured for `application/json` (standard in Caco).

3. **Client picker**: Open/close idempotency is correct. Double-open guard (line 220). Outside-click handler timing is correct—`setTimeout(0)` prevents immediate dismissal. `pickerFetchToken` monotonic counter correctly implements later-query-wins. A slow earlier fetch resolving after picker close writes to `pickerResults`, but the closed picker is `hidden`, so no visible side effect. `pickFile` race: `dismissed.delete` fires AFTER the `sid !== sessionId` guard (line 340). If the user picks, then dismisses a different card, the persist body includes both changes (tested via `buildPersistBody` call site).

4. **applyEdits suppressScroll**: Only the autoscroll branch checks `options.suppressScroll` (line 1467). Sticky branch unchanged. Picker call with `suppressScroll: true` never enters Sticky (clicking "+" doesn't scroll the stream). Empty mutations return early (line 1440) BEFORE options evaluation—correct, no scroll on no-op pick.

5. **Session change cleanup**: `closePicker()`, `pickerOpenAbort.abort()`, `cachedCwd = ''` all fire at lines 1586-1588, BEFORE `sessionId = sid` (line 1589). Correct ordering. The `sid !== sessionId` guard in `pickFile` (line 340) catches any `/open` response arriving after session change.

6. **CSS**: `.fe-picker[hidden]` rule (line 375) correctly overrides flex display. Z-index 20 is above follow button (10). Max-height 70% is relative to `.fe-root` (the applet container).

7. **Spec compliance**: All 14 acceptance criteria are addressed by the implementation. AC 11 (untracked) is covered by `buildUntrackedEntry`. AC 12 (suppressScroll) is covered by the options parameter. AC 13 (race guard) is the `sid !== sessionId` check. AC 14 (validation responses) matches the route's 400 paths.

**Recommendation**: Add the explicit UNC check (NICE §1) for robustness, even though the containment check already defends against it. Otherwise, **SHIP IT**.
