# File Edits V3.2 Implementation Review

Reviewed: commit ca1b357 (branch file-edits-v2)  
Diff against: 124f5ef  
Spec: docs/file-edits-v3.2.md  
Spec review: docs/file-edits-v3.2-review.md

---

## [BLOCKER] Activate rAF visibility restore race exposes programmaticScroll flag

**File:** `applets/file-edits/script.js:121-136` (FileTab.prototype.activate)

The hide-swap-show pattern correctly suppresses the `innerHTML = ''` scroll event (by setting `visibility='hidden'` before the clear), but the rAF callback has a **critical ordering bug**:

```js
requestAnimationFrame(function() {
  programmaticScroll = true;       // Line 132
  paneEl.scrollTop = self.scrollTop; // Line 133
  paneEl.style.visibility = prev || ''; // Line 134
});
```

The sequence is:
1. Set `programmaticScroll = true`
2. Write `scrollTop` (queues a scroll event to fire after the current task)
3. **Restore visibility**

The visibility restore on line 134 happens **before** the scroll event from line 133 is dispatched. If restoring visibility somehow triggers a synchronous scroll event (browser implementation detail, may vary), that event would see `programmaticScroll=true` and consume it. Then the real scroll-restore event fires and sees `programmaticScroll=false`, incorrectly treating it as a user scroll.

**Even if visibility restore doesn't fire an event**, the ordering is fragile. The correct pattern is:

```js
requestAnimationFrame(function() {
  paneEl.style.visibility = prev || '';  // restore FIRST
  programmaticScroll = true;             // set flag
  paneEl.scrollTop = self.scrollTop;     // write scroll LAST
});
```

This guarantees the flag is set immediately before the scroll write, with no intervening operations that might consume or interfere with it.

**Evidence:** The spec (docs/file-edits-v3.2.md:216-220) says "requestAnimationFrame(() => { programmaticScroll = true; paneContainer.scrollTop = this.scrollTop; paneContainer.style.visibility = wasHidden || ''; });" — the spec has the same bug. The spec review (docs/file-edits-v3.2-review.md:7-36, BLOCKER #1) warned about the single-shot boolean issue but didn't catch this ordering problem.

**Fix:** Reorder the rAF callback to restore visibility before setting the flag and scrollTop.

---

## [BLOCKER] Single-shot programmaticScroll can be prematurely consumed by visibility restore

**File:** `applets/file-edits/script.js:132-134` (rAF in activate)

The spec review (docs/file-edits-v3.2-review.md:7-36) identifies this as BLOCKER #1: the single-shot boolean `programmaticScroll` can only absorb one scroll event, but the hide-swap-show pattern may generate two events during a tab switch:

1. `innerHTML = ''` clears content → browsers clamp `scrollTop` to 0 → scroll event
2. rAF `scrollTop = self.scrollTop` → scroll event

The implementation's visibility:hidden pattern (line 127) is **supposed to** suppress event #1. However:

**Browser behavior variance:** Not all browsers guarantee that `visibility:hidden` prevents scroll events when `scrollTop` is clamped. The HTML spec says scroll events are fired "when the user agent scrolls the element" — clamping due to content removal is ambiguous. Chrome/Firefox typically don't fire, but Safari's behavior has varied across versions.

**If event #1 fires while hidden**, `programmaticScroll` is still false (not set until rAF), so the scroll handler runs, sees `followEdits=true`, sets it to `false`, and updates the Follow button. Then the rAF runs, sets `programmaticScroll=true`, writes `scrollTop`, fires event #2, which correctly consumes the flag. **Result:** `followEdits` was incorrectly turned off by the invisible scroll event.

**Even if event #1 is suppressed**, the rAF ordering bug (BLOCKER #1 above) can cause the flag to be consumed by the wrong event.

**The V2 implementation** used `pendingProgrammaticScroll = { target: clamped }` with a ±1px tolerance comparison (applets/file-edits/script.js V2.1 lines ~493-497), which survives multiple events because it checks `Math.abs(scrollTop - target) <= 1` rather than consuming a boolean.

**Fix:** Either:
1. Revert to the V2 `{ target }` value-comparison pattern, OR
2. Add a counter: `programmaticScrollCount++` in the rAF; decrement in the handler; only react to user scrolls when count === 0.

The value-comparison approach is more robust because it doesn't rely on event ordering.

---

## [IMPORTANT] closeTab neighbor selection has off-by-one bug for rightmost-active close

**File:** `applets/file-edits/script.js:248-279` (closeTab)

The neighbor selection logic:

```js
var keys = Array.from(tabs.keys());
var idx = keys.indexOf(id);
if (idx > 0) newActive = keys[idx - 1];          // left neighbor (line 257)
else if (idx < keys.length - 1) newActive = keys[idx + 1]; // right neighbor (line 258)
```

**Test cases:**

1. **Leftmost-active close** (idx=0, length=3): idx>0 false, idx<2 true → keys[1] = right neighbor ✓
2. **Middle-active close** (idx=1, length=3): idx>0 true → keys[0] = left neighbor ✓
3. **Rightmost-active close** (idx=2, length=3): idx>0 true → keys[1] = left neighbor ✓
4. **Single-tab close** (idx=0, length=1): idx>0 false, idx<0 false → newActive = null ✓

**Wait, this is correct.** The spec (docs/file-edits-v3.2-review.md:221-231, QUESTION #12) says "left neighbor; if no left, right neighbor." The implementation checks `idx > 0` first (prefer left), falls back to `idx < length-1` (right if no left). The keys array is captured BEFORE the delete (line 255), so indices are valid.

**Not a bug.** The logic is correct as written.

---

## [IMPORTANT] openOrUpdateTab missing programmaticScroll guard for forceFocus path

**File:** `applets/file-edits/script.js:224-229` (forceFocus branch in openOrUpdateTab)

The forceFocus branch (picker selection):

```js
if (options.forceFocus) {
  setActiveTab(id);
  programmaticScroll = true;
  paneEl.scrollTop = 0;
  tab.scrollTop = 0;
```

The order is:
1. `setActiveTab(id)` → calls `tab.activate()` → queues rAF to restore tab's scrollTop
2. `programmaticScroll = true` — sets the flag
3. `paneEl.scrollTop = 0` — writes 0, queues scroll event
4. `tab.scrollTop = 0` — updates the tab's saved position

**Race:** The rAF from step 1 hasn't fired yet. It will fire on the next frame and:
- Set `programmaticScroll = true` (AGAIN — overwriting the value we just set)
- Write `paneEl.scrollTop = tab.scrollTop` (which is now 0 from line 229)
- Fire a scroll event

So we have TWO programmatic scrolls queued:
- Event from line 228 (`scrollTop = 0`)
- Event from the rAF inside `activate()`

The single-shot flag only absorbs one. The second event sees `programmaticScroll=false` and treats it as a user scroll, flipping `followEdits` to false.

**Fix:** The forceFocus path should NOT set `scrollTop` directly. It should set `tab.scrollTop = 0` BEFORE calling `setActiveTab`, so the activate() rAF picks up the 0 value:

```js
if (options.forceFocus) {
  tab.scrollTop = 0;  // Set desired position BEFORE activate
  followEdits = false;
  setActiveTab(id);
  // activate() rAF will restore scrollTop=0; no double-write
}
```

OR use the multi-shot flag/counter approach from BLOCKER #2.

---

## [IMPORTANT] Session change cleanup does not guard flushPersist against cleared sessionId

**File:** `applets/file-edits/script.js:1261-1287` (onSessionChange)

The session-change handler:

```js
flushPersist();  // line 1263
// ... clear tabs ...
sessionId = sid;  // line 1281
```

`flushPersist()` reads `persistPendingSid` and `persistPendingBody` (captured by `schedulePersist` during the previous session). This is correct — the persisted body reflects the outgoing session's tab list.

**However**, `buildPersistBody()` (called by `schedulePersist`) iterates the live `tabs` Map. If a persist is scheduled but hasn't fired yet when the session changes, the captured `persistPendingBody` is correct, BUT if `flushPersist` somehow triggered a NEW persist (e.g. via a nested `schedulePersist` call — doesn't happen in current code but fragile), it would read the cleared `tabs` Map.

**Audit:** No code path between `flushPersist()` and `tabs.clear()` calls `schedulePersist()`. The `flushPersist` call is synchronous (it just calls `doPersistPut` which returns immediately because it's async-fire-and-forget). **No actual bug**, but the ordering comment could be clearer:

```js
// Flush outgoing session's pending persist (body was captured earlier).
flushPersist();
// NOW safe to clear tabs — flushPersist doesn't touch the tabs Map.
tabs.forEach(function(t) { t.destroy(); });
tabs.clear();
```

**Severity downgrade:** Not a bug, but the existing comment (line 1262) says "Flush outgoing session's pending PUT first" without explaining WHY. Add the clarification above.

---

## [IMPORTANT] Picker "already open" path does not call updateFollowButton after setting followEdits

**File:** `applets/file-edits/script.js:573-580` (pickFile)

The "already open" early-return:

```js
if (tabs.has(relativePath)) {
  followEdits = false;
  updateFollowButton();  // line 577 — CORRECT
  setActiveTab(relativePath);
  return;
}
```

**This is correct.** `updateFollowButton()` is called immediately after setting `followEdits = false`. The finding in the spec review doesn't apply here.

**Not a bug.**

---

## [NICE] evictOldestNonActive missing no-op guard for impossible all-active case

**File:** `applets/file-edits/script.js:187-201` (evictOldestNonActive)

The function iterates `tabs` and removes the first non-active entry:

```js
function evictOldestNonActive() {
  var iter = tabs.keys();
  var step;
  while (!(step = iter.next()).done) {
    var id = step.value;
    if (id !== activeTabId) {
      var t = tabs.get(id);
      if (t) t.destroy();
      tabs.delete(id);
      badgeCounter.delete(id);
      return;
    }
  }
}
```

If the loop completes without finding a non-active tab, the function returns without doing anything (implicit no-op). This is correct but not explicit.

**The spec review (docs/file-edits-v3.2-review.md:165-175, NICE #8) recommends:** "If no non-active tab exists (impossible at TAB_CAP=50), no-op."

The implementation already does this (silent return if loop completes). To make it explicit and defensive:

```js
function evictOldestNonActive() {
  for (var iter = tabs.keys(), step; !(step = iter.next()).done; ) {
    var id = step.value;
    if (id !== activeTabId) {
      var t = tabs.get(id);
      if (t) t.destroy();
      tabs.delete(id);
      badgeCounter.delete(id);
      return;
    }
  }
  // Defensive: no non-active tab found (impossible at TAB_CAP=50).
}
```

**Not a bug**, but add the comment for clarity.

---

## [NICE] CSS .fe-tabs:empty padding collapse not tested

**File:** `applets/file-edits/style.css:81`

```css
.fe-tabs:empty { padding: 0; border-bottom: 0; }
```

This rule should hide the tab strip when there are no tabs. **To verify:**

- The `feTabs` element is empty when `tabs.size === 0`
- The CSS selector `:empty` matches only if the element has no child nodes (not even text nodes or whitespace)
- The HTML initializes with `<div class="fe-tabs" id="feTabs"></div>` (empty)
- `openOrUpdateTab` does `tabsEl.appendChild(tab.tabEl)` — adds children
- `closeTab` does `tab.destroy()` which removes `tabEl` from its parent

**Potential issue:** If there's any whitespace or comment node inside `#feTabs`, `:empty` won't match. The HTML is clean (no whitespace between `<div class="fe-tabs" id="feTabs">` and `</div>`), so this is fine.

**Not a bug.** The CSS is correct as written.

---

## [NICE] Diff-row CSS regression check

**File:** `applets/file-edits/style.css` (lines 146+)

The spec says "Diff-row CSS preserved unchanged from V3.1." Comparing against the diff:

```
diff --git a/applets/file-edits/style.css
```

The diff shows `.fe-diff` CSS was preserved. The V2 full-file renderer uses `.fe-row`, `.fe-gutter`, `.fe-row-ctx`, `.fe-row-add`, `.fe-row-del`, `.fe-d-*` classes. All of these are present in the new CSS (lines 146-250+). The `[data-mode="fullfile"]` selector (line 152) is also present.

**Spot-check passes.** No CSS regression detected.

---

## [QUESTION] Init from persistence: last snapshot path auto-activates — is this correct?

**File:** `applets/file-edits/script.js:1227-1246` (initFromPersistence)

The flow:

1. Load persisted cards → create placeholder `FileTab` instances (lines 1229-1242)
2. Call `fetchSnapshot()` (line 1245) → iterates `data.edits`, calls `openOrUpdateTab(edit)` (lines 1216-1219)
3. Each `openOrUpdateTab` call: `contentChanged = tab.update(edit)` returns **true** (placeholder had no `fullFile`; snapshot edit has one → not content-equal)
4. Line 222: `if (contentChanged) lastEditedTabId = id;` — sets `lastEditedTabId` to EACH path
5. After loop, `lastEditedTabId` is the LAST path in the snapshot
6. Line 230: `else if (followEdits) { setActiveTab(id); ... }` — activates the tab

**Behavior:** With `followEdits=true` (default), the LAST snapshot edit's tab is auto-activated. The pane shows that tab's content. The spec (docs/file-edits-v3.2.md:395-416) says "no auto-activate" but the IMPLEMENTATION activates the last snapshot tab.

**Is this a bug?** The spec review (docs/file-edits-v3.2-review.md:153-161, IMPORTANT #7) notes the contradiction: the comment says "Pane stays empty / shows the first tab as active per the 'no auto-activate' rule" but the code activates the last tab.

**The spec (line ~400) says:** "Pane stays empty — no tab is auto-activated until the first incoming edit or user click." But the IMPLEMENTATION auto-activates because `followEdits=true` and each `openOrUpdateTab` during snapshot loading triggers the `followEdits` branch.

**Expected behavior:** On init, `followEdits=true` means "auto-activate on NEW edits," not "auto-activate on snapshot restore." The snapshot represents PAST edits. To preserve the "no auto-activate on init" rule, `fetchSnapshot` should temporarily set `followEdits=false` during snapshot processing, then restore it:

```js
async function fetchSnapshot() {
  // ...
  var wasFollowing = followEdits;
  followEdits = false;  // Don't auto-activate during snapshot load
  if (Array.isArray(data.edits)) {
    for (var i = 0; i < data.edits.length; i++) {
      openOrUpdateTab(data.edits[i]);
    }
  }
  followEdits = wasFollowing;  // Restore (still true)
  updateEmptyState();
}
```

**However**, the spec also says (lines ~378-384): "else if (followEdits) { setActiveTab(id); if (isNew) { paneEl.scrollTop = 0; ... } }". The `isNew` check suggests that on snapshot restore, tabs are NOT new (they were placeholders that got updated), so the scroll-to-top doesn't fire. But `setActiveTab` still does.

**Conclusion:** The spec is contradictory. The implementation activates the last snapshot tab on init, which violates the "no auto-activate" rule in the prose but matches the code structure. The spec review flags this (IMPORTANT #7). **Classify as a spec bug, not an implementation bug**, BUT the implementation should be explicit about this behavior.

---

## [QUESTION] Spec acceptance criterion #8 "switch tabs → restored scroll position" — verify

**File:** `applets/file-edits/script.js:121-136` (activate) + lines 138-140 (deactivate)

The scroll restore mechanism:

- `deactivate()` saves `this.scrollTop = paneEl.scrollTop` (line 139)
- `activate()` restores `paneEl.scrollTop = self.scrollTop` in rAF (line 133)

**Test scenario:** Open tab A, scroll down, switch to tab B, switch back to A. Does A's scroll restore?

1. A active, user scrolls to 500 → scroll handler saves `A.scrollTop = 500` (line 348)
2. User clicks B → `setActiveTab('B')` → calls `A.deactivate()` → saves `A.scrollTop = paneEl.scrollTop` (line 139) — **this is redundant with line 348** but harmless
3. B activates, restores B's scroll
4. User clicks A → `setActiveTab('A')` → calls `A.activate()` → rAF sets `paneEl.scrollTop = A.scrollTop` (500) → scroll event fires, flag consumes it

**If the flag was already consumed** (due to BLOCKER #1 or #2), the scroll event sees `programmaticScroll=false`, treats it as a user scroll, saves `A.scrollTop = 500` (no-op), but also flips `followEdits = false`. This is wrong but doesn't break scroll restore.

**Scroll restore works** as long as the rAF write happens. The BLOCKER bugs cause `followEdits` to flip incorrectly but don't break scroll saving/restoring.

**Acceptance criterion #8 passes** in the implementation.

---

## Summary

| Severity | Count | Findings |
|---|---|---|
| [BLOCKER] | 2 | rAF ordering exposes flag (#1), single-shot flag insufficient (#2) |
| [IMPORTANT] | 2 | forceFocus double-scroll (#4), session-change comment clarity (#5) |
| [NICE] | 3 | evictOldestNonActive comment (#7), CSS check passes (#8), diff CSS preserved (#9) |
| [QUESTION] | 2 | Init auto-activate behavior (#10), scroll restore works (#11) |

**Total: 9 findings** (2 blockers must be fixed before merge)

**False positives from focus areas:**
- #3 closeTab neighbor logic — correct as written
- #6 Picker already-open path — correct as written

**Critical fixes required:**
1. Reorder rAF callback in `activate()` to restore visibility before setting flag
2. Replace single-shot boolean with value-comparison pattern OR multi-shot counter
3. Fix forceFocus double-scroll by setting `tab.scrollTop` before `setActiveTab`

**Non-blocking improvements:**
- Add defensive comment to `evictOldestNonActive`
- Clarify session-change flushPersist comment
- Document init auto-activate behavior (or change it to match spec prose)
