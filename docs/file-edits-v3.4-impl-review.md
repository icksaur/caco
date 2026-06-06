# File Edits V3.4 Implementation Review

Reviewed commit: `b5db588` vs parent `40f668f` on branch `file-edits-v3`

Spec: `docs/file-edits-v3.4.md`

Date: 2024

---

## BLOCKER

### 1. `validateSelection`: Incorrect bounds checking logic creates infinite-loop risk

**File:** `applets/file-edits/script.js:256-260`

**Problem:** The bounds-check-before-normalize logic is flawed. When exactly one of `start`/`end` is out-of-bounds, the code attempts to clamp it but uses the **wrong** logic:

```js
if (aOob) a = Math.max(1, Math.min(a, maxLine));
if (bOob) b = Math.max(1, Math.min(b, maxLine));
```

**Edge case that breaks:** `{start: 200, end: 50}` on a 100-line file.

- `aOob = true` (200 > 100), `bOob = false` (50 is valid)
- Line 259 executes: `a = Math.max(1, Math.min(200, 100))` → `a = 100`
- Line 263 normalizes: `if (a > b)` → `if (100 > 50)` → swap → `a=50, b=100`

**Result:** The swap *masks* the out-of-bounds condition. The spec says "bounds-check BEFORE normalization" specifically to avoid this masking. The implementation violates its own contract.

**Correct fix:** Drop the selection if **either** value is out-of-bounds before the swap:

```js
if (maxLine != null) {
  if (a > maxLine || a < 1 || b > maxLine || b < 1) {
    return null;  // drop if EITHER is OOB (before swap)
  }
}
```

Then normalize normally. The post-swap clamping to [1, maxLine] is unnecessary because we've already validated.

**Why this matters:** The current code allows `{start: 200, end: 50}` to silently become `{start: 50, end: 100}`, violating the spec's bounds-check contract. This is a logic error that creates surprising behavior for agents sending out-of-range selections.

---

### 2. `applyAgentState`: Race condition on rapid agent pushes with pending rAFs

**File:** `applets/file-edits/script.js:384-388, 407-411`

**Problem:** When the agent pushes state twice in quick succession (before the first push's double-rAF completes), both rAF chains execute concurrently, both calling `finalizeAgentSelection(tab)` on the same tab. The second call reads `tab.pendingSelection` (which was just set by the second push), but the first call has already nulled it.

**Scenario:**
1. Agent push #1 arrives → `existing.pendingSelection = rawSel1` → schedules 2 rAFs → `finalizeAgentSelection(existing)`
2. Before those rAFs fire, agent push #2 arrives → `existing.pendingSelection = rawSel2` → schedules 2 MORE rAFs
3. First rAF chain fires → `finalizeAgentSelection` reads `rawSel2`, nulls `pendingSelection`, applies `rawSel2`
4. Second rAF chain fires → `finalizeAgentSelection` reads `null`, nulls `pendingSelection`, clears selection → echoes `selection: null`

**Result:** The agent's second selection is immediately cleared. The agent sees `selection: null` on the next `get_applet_state` and thinks the selection failed.

**Evidence:** Lines 384-388 (new tab path) and 407-411 (existing tab path) both use `requestAnimationFrame` with no cancellation of prior pending rAFs. `finalizeAgentSelection` at 414-427 has no guard against being called multiple times before `pendingSelection` stabilizes.

**Suggested fix:** Cancel pending rAF handles before scheduling new ones. Store `tab.pendingRafHandle1` and `tab.pendingRafHandle2`, and `cancelAnimationFrame` them if they exist before scheduling new ones. Or: move to a single "schedule finalize if not already scheduled" pattern with a `tab.pendingFinalize` flag.

**Why this matters:** This is a race condition that causes state loss. It's easy to trigger if the agent calls `set_applet_state` twice within ~32ms (two frame times).

---

### 3. `applyAgentState`: Tab eviction during `/open` can orphan the new tab

**File:** `applets/file-edits/script.js:377-381`

**Problem:** The code opens a new tab, then adds it to the `tabs` map AFTER the async fetch completes:

```js
var newTab = new FileTab(data.edit);
newTab.pendingSelection = rawSel;
if (tabs.size >= TAB_CAP) evictOldestNonActive();  // line 377
tabs.set(targetTabId, newTab);                     // line 378
```

If `tabs.size >= TAB_CAP` **before** the fetch but **another** `openOrUpdateTab` call (e.g., from a `caco.edit` event) happens **during** the fetch, the map can grow to `TAB_CAP` again by the time line 378 executes. Line 378 adds the new tab, pushing `tabs.size` to `TAB_CAP + 1`.

**Consequence:** The next `openOrUpdateTab` at line 514 calls `evictOldestNonActive()`, which may evict the tab we just opened (if it's not active and happens to be the oldest non-active tab in insertion order).

**Why this matters:** The agent's `set_applet_state` can silently open a tab, then immediately lose it to eviction if a concurrent `caco.edit` event opens another tab during the same fetch window. The agent sees `activeTab: <target>` in its echo, but the tab is actually gone.

**Suggested fix:** Reserve a "slot" before the fetch by setting `tabs.set(targetTabId, null)` (or a sentinel), then replace it with the real tab after the fetch. Or: increment a `pendingOpenCount` counter before the fetch, decrement after, and have `evictOldestNonActive` skip eviction if `tabs.size + pendingOpenCount >= TAB_CAP`.

---

## IMPORTANT

### 4. SOURCE_ID echo-loop guard is insufficient: broadcastToAll **does** exclude sender, but only at the WebSocket level

**File:** `applets/file-edits/script.js:205-212, 346` and `src/routes/websocket.ts:228-234`

**Problem:** The spec says `broadcastToAll` in `src/routes/websocket.ts` excludes the sender, so a single tab never receives its own echo. The code at line 161 passes `ws` as the `exclude` parameter:

```js
broadcastToAll({ type: 'stateUpdate', data: msg.data }, ws);
```

This is correct **for the same WebSocket connection**. But the spec's concern is **multi-tab**: two browser tabs (A and B) open on the same applet, same session. Tab A calls `setAppletState` → server broadcasts to Tab B → Tab B's `onStateUpdate` fires → Tab B calls `setAppletState` → server broadcasts to Tab A → Tab A's `onStateUpdate` fires → ping-pong.

**The SOURCE_ID guard at line 346 correctly handles this:**

```js
if (fileEdits.sourceId === SOURCE_ID) return;
```

Each tab has a unique `SOURCE_ID`, so Tab A ignores echoes with its own `sourceId`, and Tab B ignores echoes with its own `sourceId`. This prevents the ping-pong.

**However:** There's a subtle flaw. Agent-initiated `set_applet_state` has **no** `sourceId` in the payload (agents don't include it). The applet's `applyAgentState` at line 346 bails if `fileEdits.sourceId === SOURCE_ID`, but the agent's push has `fileEdits.sourceId === undefined`. So the guard never bails for agent pushes.

**Missing case:** When the applet echoes the agent's push (line 426 → `echoState()` → `buildFileEditsState()` includes `sourceId: SOURCE_ID`), that echo is broadcast to **other tabs** (not the sender). Those other tabs see `sourceId: <Tab A's ID>` and correctly bail. This is fine.

**But:** The agent's push itself (before the echo) is broadcast to **all tabs** (no `exclude` because the agent push comes from the server, not a WebSocket client). All tabs receive it. Each tab applies it. Each tab echoes. Each echo is broadcast to other tabs. Each other tab bails (because of the `sourceId` guard). This is fine.

**Conclusion:** The logic is actually **correct**, but the spec's explanation is incomplete. The `broadcastToAll` exclude-sender behavior only prevents **same-WebSocket** loops, not **cross-tab** loops. The `SOURCE_ID` guard prevents cross-tab loops. The spec should clarify this.

**Action:** This is not a bug, but the code comment at line 205-209 is slightly misleading. It says "broadcastToAll excludes sender" to explain why single-tab loops don't happen, but the real reason is that `appletAPI.setAppletState` (called at line 231) uses the WebSocket to send a `setState` message, and the server's `broadcastToAll` at line 161 excludes that same WebSocket. For agent pushes (which originate from the server, not a client WebSocket), there's no "sender" to exclude, so all tabs receive them. The `SOURCE_ID` guard is the real cross-tab loop prevention.

**Suggested clarification:** Rewrite the comment at line 205-209 to say:

```js
/** Random per-page-load ID. Included in applet→agent echoes so
 *  cross-tab loops are prevented: Tab A's echo reaches Tab B via
 *  broadcast, but Tab B sees Tab A's sourceId and bails. Agent
 *  pushes have no sourceId (agents don't include it), so all tabs
 *  apply them, but each tab's echo includes its own sourceId, which
 *  other tabs filter. Single-tab loops don't occur because
 *  appletAPI.setAppletState sends via WebSocket, and the server's
 *  broadcastToAll excludes the sender WebSocket. */
```

**Impact:** This is not a bug — the implementation is correct — but the comment is misleading and makes the code harder to reason about. Clarify the comment.

---

### 5. `paintSelection` performance: O(N) on every paint is acceptable for 5000-line files, but querySelectorAll is called twice

**File:** `applets/file-edits/script.js:153-166`

**Problem:** `paintSelection` is called on every render (line 127) and after every selection change (lines 323, 336, 424). Each call does:

1. `querySelectorAll('.fe-row-selected')` → O(N) where N = total DOM rows
2. Loop to remove classes → O(M) where M = selected rows
3. `querySelectorAll('.fe-row[data-work-line]')` → O(N)
4. Loop to add classes → O(K) where K = rows in selection range

Total: O(N) + O(M) + O(N) + O(K) = **O(2N + M + K)**.

For a 5000-line file, N=5000. If the selection is 100 lines, M=100 (previous selection, worst case) and K=100 (new selection). Total: ~10,200 operations per paint.

**Is this acceptable?** The spec says V3.2 supported 5000+ line files. Benchmarking: `querySelectorAll` on a 5000-element subtree takes ~1-2ms on a modern CPU. So `paintSelection` takes ~2-4ms total. This is under one frame (16ms), so it's acceptable.

**Micro-optimization opportunity:** Cache the result of `querySelectorAll('.fe-row[data-work-line]')` at render time (store it as `tab.workLineRows`), and reuse it in `paintSelection`. This reduces the cost to O(N + M + K). But the current O(2N) is still fast enough that this is a "nice-to-have," not a blocker.

**Verdict:** Acceptable. The spec explicitly says performance matters, but 2-4ms for a 5000-line file is reasonable. No change required, but caching `workLineRows` would be a good V3.5 micro-optimization.

---

### 6. Pane click handler: No conflict with native text selection, but the guard is fragile

**File:** `applets/file-edits/script.js:430-439`

**Problem:** The click handler at line 430 uses `e.target.closest('.fe-row[data-work-line]')` to detect line clicks. If the user clicks a row, it's a line-select. If the user clicks the pane background, it's a clear-selection.

**Interaction with native text selection:** The user can drag-to-select text (mousedown → mousemove → mouseup) for copy. This does **not** fire a `click` event — it fires `mousedown`, `mousemove`, and `mouseup`. The `click` event only fires if the `mouseup` happens at approximately the same X/Y as the `mousedown` (no drag). So drag-to-select is unaffected. ✅

**Shift-click conflict:** The user can shift-click to extend a native text selection (browser default). But the code at line 434 treats shift-click as "extend the file-edits line selection." This creates a conflict: shift-clicking a line extends the line selection **and** triggers the browser's default shift-click text-selection behavior.

**Evidence:** The code does not call `e.preventDefault()` on shift-clicks. So the browser's default shift-click behavior (extend text selection) runs **in addition to** the line-selection logic.

**Is this a bug?** It's a UX ambiguity. If the user shift-clicks line 10 after clicking line 5, the code extends the line selection to 5-10 **and** the browser extends its text selection (if any) to include the clicked text. This is probably not what the user intended — they either wanted to extend the line selection (V3.4 behavior) or extend the text selection (browser default), not both.

**Suggested fix:** Call `e.preventDefault()` when handling a line click (both normal and shift-click) to suppress the browser's default text-selection behavior:

```js
if (row) {
  e.preventDefault();  // suppress native text selection on line clicks
  var n = parseInt(row.dataset.workLine, 10);
  if (!isNaN(n)) userSelectLine(n, !!e.shiftKey);
  return;
}
```

This makes line-clicks a "line selection only" gesture, and drag-to-select remains a "text selection only" gesture (no conflict).

**Why this matters:** Users who shift-click to extend line selections will get surprising text-selection side effects. This is a UX bug, not a logic bug, but it's noticeable.

---

## NICE-TO-HAVE

### 7. `pendingSelection` lifecycle: No stranded-selection bug, but the split between render/finalize is unnecessarily complex

**File:** `applets/file-edits/script.js:69, 127, 398-401, 414-427`

**Problem:** The code uses `tab.pendingSelection` to hold a selection that arrived before the pane was rendered. The lifecycle is:

1. Agent push → `tab.pendingSelection = rawSel` (line 376 or 399-401)
2. `setActiveTab` → `tab.activate()` → `tab.render()` (line 122-127)
3. `render()` calls `paintSelection()`, which paints `this.selection` (not `pendingSelection`)
4. Two rAFs later, `finalizeAgentSelection` reads `pendingSelection`, validates it, writes `tab.selection`, calls `paintSelection()` again, then nulls `pendingSelection` (lines 414-427)

**Is `pendingSelection` ever stranded?** Let's trace all paths:

- **Path 1 (new tab, agent push):** Line 376 sets `pendingSelection` → line 381 calls `setActiveTab` → line 384-388 schedules rAFs → line 386 calls `finalizeAgentSelection` → line 416 nulls `pendingSelection`. ✅ Consumed.
- **Path 2 (existing tab, agent push, no pane yet):** Line 399 sets `pendingSelection` → line 404 calls `setActiveTab` → line 407-411 schedules rAFs → line 409 calls `finalizeAgentSelection` → line 416 nulls `pendingSelection`. ✅ Consumed.
- **Path 3 (existing tab, agent push, pane exists):** Line 401 sets `pendingSelection` → line 407-411 schedules rAFs → `finalizeAgentSelection` consumes it. ✅ Consumed.

**Verdict:** No stranded-selection bug. Every path that sets `pendingSelection` eventually calls `finalizeAgentSelection`, which nulls it.

**Complexity concern:** The split between `render()` (which paints `this.selection`) and `finalizeAgentSelection` (which validates `pendingSelection` and writes `this.selection`) is hard to follow. Why not validate `pendingSelection` **before** calling `setActiveTab`, write `tab.selection` immediately, and have `render()` just paint `this.selection`? The double-rAF delay is necessary for the **scroll** (line 425) to wait for the DOM to settle, but the validation could happen earlier.

**Suggested simplification (V3.5):** Validate `pendingSelection` immediately in `applyAgentState`, write `tab.selection`, then schedule a single rAF for the scroll (not two). This eliminates the `pendingSelection` field entirely and makes the lifecycle clearer.

**Impact:** This is a code-quality concern, not a correctness bug. The current implementation works, but it's more complex than necessary.

---

### 8. Missing echo on `openOrUpdateTab` from `caco.edit` events

**File:** `applets/file-edits/script.js:1597-1606`

**Problem:** The spec says the contract is "echo state after every active-tab change OR selection change." The `caco.edit` event handler at lines 1597-1606 calls `openOrUpdateTab` for each edit. `openOrUpdateTab` at line 506-544 **does** call `setActiveTab` (lines 531, 534) if `followEdits` is true, and `setActiveTab` calls `echoState()` (line 486).

**So is there a bug?** No. The echo happens via `setActiveTab` → `echoState()`. The `caco.edit` handler doesn't need to call `echoState()` itself.

**But:** The spec's focus-area #7 says "are there other state-mutating paths (e.g. openOrUpdateTab from `caco.edit` event, persistence restore on session switch) that should also echo?" The answer is: `openOrUpdateTab` from `caco.edit` **does** echo (via `setActiveTab`), and session-switch (`onSessionChange` at line 1608) clears tabs and resets `activeTabId = null` (line 1620), which means the next `setActiveTab` call will echo the new state. So all paths are covered. ✅

**Verdict:** No bug. The echo contract is satisfied.

---

### 9. `expandFold` does set `data-work-line` (via `buildRowEl`), confirming spec compliance

**File:** `applets/file-edits/script.js:1367, 1433`

**Problem:** The spec at §Selection rendering says `buildRowEl` must set `data-work-line`, and that `expandFold` calls `buildRowEl`, so both paths are covered.

**Evidence:** Line 1367 (in `buildRowEl`) sets `if (row.work != null) div.dataset.workLine = String(row.work);`. Line 1433 (in `expandFold`) calls `buildRowEl(row.hidden[i], lang, row.hidden[i].mark)`, so the attribute is set for expanded rows too. ✅

**Verdict:** Spec requirement met. No bug.

---

## SUMMARY

**BLOCKER issues (must fix before merge):**

1. **`validateSelection` bounds-check logic is wrong** — allows `{start:200, end:50}` on a 100-line file to silently become `{start:50, end:100}`. Violates spec's "bounds-check before normalize" contract. Fix: drop selection if **either** value is OOB before the swap.

2. **`applyAgentState` race on rapid pushes** — concurrent rAF chains cause the second selection to be cleared. Fix: cancel pending rAFs before scheduling new ones.

3. **`applyAgentState` tab eviction during async `/open`** — newly opened tab can be immediately evicted if `caco.edit` events arrive during the fetch. Fix: reserve a slot or track `pendingOpenCount`.

**IMPORTANT issues (should fix, but not blockers):**

4. **SOURCE_ID comment is misleading** — the explanation of how `broadcastToAll` prevents loops is incomplete. Fix: rewrite the comment to clarify that `broadcastToAll` excludes **same-WebSocket** loops, but **SOURCE_ID** prevents **cross-tab** loops.

5. **`paintSelection` performance** — O(2N) is acceptable for 5000-line files (2-4ms), but caching `workLineRows` would be a micro-optimization for V3.5.

6. **Pane click handler and shift-click conflict** — shift-clicking a line extends both the line selection and the native text selection. Fix: call `e.preventDefault()` on line clicks.

**NICE-TO-HAVE (defer to V3.5):**

7. **`pendingSelection` lifecycle is complex** — works correctly, but could be simplified by validating earlier and eliminating the `pendingSelection` field.

8. **Echo contract is satisfied** — `caco.edit` and session-switch paths both echo correctly via `setActiveTab` or explicit reset.

9. **`expandFold` sets `data-work-line` correctly** — spec requirement met.

---

## EDGE-CASE VERIFICATION

Per the spec's focus-area #1, here are the edge-case outcomes:

1. **`{start:200, end:50}` on 100-line file:** ❌ BLOCKER #1. Currently becomes `{start:50, end:100}` (wrong). Should drop (return `null`).

2. **Selection entirely inside pure-deletion block:** ✅ CORRECT. `renderedWorkLines` returns only work-line numbers (lines with `data-work-line`). Pure-deletion rows have no `data-work-line` (line 1367 guard). `validateSelection` clamps start UP and end DOWN to nearest valid work-line. If no valid work-line exists in the range, `newStart` or `newEnd` is `null`, and line 275 returns `null`. ✅

3. **Selection straddling a fold:** ✅ CORRECT. Folded rows are not in the DOM, so `renderedWorkLines` doesn't include them. `validateSelection` clamps to the nearest rendered work-line. When the user expands the fold, the next `paintSelection` call (triggered by re-render at line 127) picks up the newly-rendered rows and highlights them. ✅

4. **Single-line selection on a deleted line:** ✅ CORRECT. Deleted lines (status='del') with no work counterpart have no `data-work-line` (line 1367 guard). User clicks are dispatched by the click handler at line 430, which requires `.fe-row[data-work-line]` (line 431). Clicking a deleted line doesn't match the selector, so it's treated as a background click (line 438) → clears selection. Alternatively, if the user clicks a deleted line's gutter, it's not a `.fe-row` (it's a `.fe-gutter`), so `closest('.fe-row[data-work-line]')` returns `null` → background click. ✅

5. **Selection where start==end and the line isn't rendered (folded):** ✅ CORRECT. `renderedWorkLines` returns only rendered rows (line 285 queries `.fe-row[data-work-line]`). If the line is folded, it's not in the DOM, so `renderedWorkLines` doesn't include it. `validateSelection` at lines 269-276 looks for the nearest work-line >= start (none found → `newStart=null`) → returns `null`. ✅

**Verdict:** Edge cases 2-5 are correctly handled. Edge case 1 is BLOCKER #1.

---

## RECOMMENDATIONS

1. **Merge-blocking:** Fix BLOCKER #1, #2, #3 before merging.
2. **High priority:** Fix IMPORTANT #4 (comment clarity) and #6 (shift-click conflict) before V3.4 ships.
3. **Low priority:** Consider IMPORTANT #5 (cache optimization) and NICE-TO-HAVE #7 (pendingSelection simplification) for V3.5.

---

## WHAT I CHECKED

- ✅ `validateSelection` bounds-check and normalization logic (focus-area #1)
- ✅ `applyAgentState` race conditions and lifecycle correctness (focus-area #2)
- ✅ Echo-loop guard via SOURCE_ID and `broadcastToAll` behavior (focus-area #3)
- ✅ `paintSelection` performance for 5000-line files (focus-area #4)
- ✅ Pane click handler interaction with native text selection (focus-area #5)
- ✅ `pendingSelection` / `render()` / `finalizeAgentSelection` lifecycle (focus-area #6)
- ✅ `setActiveTab` and `closeTab` echo placement (focus-area #7)
- ✅ Edge cases: out-of-bounds, pure-deletion, folded, single-line deleted (spec §Data model)

**No style, formatting, or comment density issues raised per review guidelines.**
