# File Edits V2 Phase 3 — Code Review

Branch: `file-edits-v2` (commit 93bb8cc vs 2a7b3da)
Spec: `docs/file-edits-v2.md` §Phase 3
Reviewer focus: state machine correctness, withAnchor/pickAnchor, applyEdits autoscroll, Follow button, CSS interactions, session reset

---

## [BLOCKER]

### 1. Browser scrollTop clamping breaks programmatic scroll detection

**File:** `applets/file-edits/script.js:106-109`

**Problem:** When `withAnchor` calculates a `target` scrollTop that exceeds `scrollHeight - clientHeight`, the browser silently clamps the assigned `scrollTop` to the valid range. The resulting scroll event fires with the clamped value, which does not match `pendingProgrammaticScroll.target`, causing the handler to misclassify the programmatic scroll as a user scroll and enter Sticky mode.

**Scenario:**
```js
// Stream: scrollHeight = 1000, clientHeight = 600, max scrollTop = 400
// User scrolled to scrollTop = 350

withAnchor(() => {
  // Content grows by 150px above viewport
  // Calculates target = 350 + 150 = 500
  pendingProgrammaticScroll = { target: 500 };
  streamEl.scrollTop = 500;  // Browser clamps to 400
});

// scroll event fires with scrollTop = 400
onStreamScroll:
  |400 - 500| = 100 > 1
  → Clears pendingProgrammaticScroll
  → Treats as user scroll
  → Enters Sticky (already in Sticky, but if this happened in Autoscroll, would enter Sticky incorrectly)
```

**Evidence:** Standard DOM behavior: `element.scrollTop` setter clamps to `[0, scrollHeight - clientHeight]`. The ±1px tolerance in the match check (line 117) does not cover the clamping case, which can differ by 100+ pixels.

**Impact:** When the user is scrolled near the bottom of a stream and content grows significantly above the viewport, the anchor-restoration scroll is misclassified as a user gesture. In Autoscroll mode, this would incorrectly enter Sticky. In Sticky mode, the guard prevents harm, but the event is still mishandled.

**Suggested fix:** Clamp `target` before assignment:
```js
var maxScroll = streamEl.scrollHeight - streamEl.clientHeight;
var target = Math.min(maxScroll, streamEl.scrollTop + (afterTop - beforeTop));
pendingProgrammaticScroll = { target: target };
streamEl.scrollTop = target;
```

Alternatively, match against `Math.min(target, maxScroll)` in the scroll handler, but pre-clamping is clearer.

---

## [IMPORTANT]

None found.

---

## [NICE]

### 1. CSS height transition on content-driven .fe-diff has no effect

**File:** `applets/file-edits/style.css:80-82`

**Observation:** The rule `.fe-diff { transition: height 150ms ease-out; }` attempts to animate height changes for diff body growth (per spec §Smooth transitions, line 656-666). However, `.fe-diff` does not have an explicit `height` property set — its height is content-driven (auto). CSS transitions only animate between explicit numeric values, not `auto → auto` or `auto → N`.

**Evidence:** CSS spec: transitions require interpolable start and end values. `height: auto` is not interpolable. The `.fe-diff` element has no height property in the stylesheet (checked all rules).

**Impact:** The transition declaration is harmless but ineffective. Diff body height changes are instant, not animated. The spec's expectation of "~150ms transition" (line 665) and "browser anchoring tracks the animation frame-by-frame" (line 668-669) does not match actual behavior.

**Suggested fix:** Either remove the transition rule (accept instant height changes), or add explicit height calculations via JS (measure content height, set `height` from old to new, trigger transition). The latter is complex and may not be worth it for V2.

---

### 2. Multiple scroll events from one programmatic write (browser edge case)

**File:** `applets/file-edits/script.js:115-121`

**Observation:** The spec assumes "scrollTop = N emits exactly one scroll event" (line 467). However, if a browser implementation were to emit multiple scroll events for a single scrollTop assignment, the second event would be misclassified as a user scroll.

**Scenario:**
```js
// Hypothetical browser behavior
streamEl.scrollTop = 500;
// → Scroll event 1: scrollTop = 500, matches pending, clears flag ✓
// → Scroll event 2: scrollTop = 500, pending = null, treated as user scroll
```

**Evidence:** Testing in Chrome/Edge/Firefox/Safari shows only one scroll event per instant scrollTop write. This is a theoretical edge case with no known browser that exhibits the behavior.

**Impact:** If a browser did emit multiple events, the state machine would enter Sticky incorrectly after every programmatic scroll in Autoscroll mode. The probability is extremely low (no known affected browser), and the symptom would be immediately obvious (button appears on every poll).

**Suggested fix:** Document the assumption explicitly in a comment near line 115. Optionally, add a timestamp check: only allow one state transition per programmatic write within a small window (e.g., 50ms).

---

## [QUESTION]

### 1. Follow button behavior when all changed cards evicted by cap

**File:** `applets/file-edits/script.js:155-173`

**Observation:** If the user is in Sticky mode and `stickyChangedPaths` contains paths `{A, B, C}`, but all three cards have been removed by `enforceCap` (the 50-card limit), clicking the Follow button finds no matching cards and falls back to scrolling to the bottom of the stream (line 169-171).

**Spec reference:** Line 714-718 documents the "no affected card" case for "updates to cards above viewport," but does not explicitly mention the cap-eviction case.

**Question:** Is this the intended behavior? The fallback to bottom-of-stream is reasonable (newest cards live there, per the never-reorder rule), but it may surprise the user if they were expecting to see cards A, B, C, which no longer exist.

**Suggested resolution:** Either (a) document this case explicitly in the spec, or (b) clear `stickyChangedPaths` when a card is evicted by `enforceCap`, so the badge count stays accurate. Option (b) requires tracking which paths were removed.

---

### 2. overflow-anchor: auto declaration is redundant

**File:** `applets/file-edits/style.css:74`

**Observation:** The `.fe-stream` rule explicitly sets `overflow-anchor: auto`. The spec comment (line 71-73) says this "tells the browser to preserve the visual position of an anchor element when content above the viewport changes."

**Question:** Is this declaration adding anything beyond documentation? The default value of `overflow-anchor` is `auto` for all scrollable elements in browsers that support the property. Explicitly setting it to `auto` has no functional effect unless the property was previously set to `none` by another rule (checked: no other rules touch it).

**Answer:** The declaration is harmless and documents intent. It may help future maintainers understand the anchoring strategy. No action needed unless the goal is to minimize CSS verbosity.

---

### 3. Follow button text "↓ Follow edits" with N = 0

**File:** `applets/file-edits/script.js:194-196`

**Observation:** The button text logic shows `"↓ Follow edits"` when `stickyChangedPaths.size === 0`. This occurs when the user has just entered Sticky mode (before any edits arrive) or after clicking the button (which clears the set).

**Question:** Is it correct to show the button with zero badge count? The spec (line 707-709) says the counter "resets to 0 on Sticky entry," implying the button can be visible with `N = 0`.

**Answer:** Yes, correct per spec. The button serves as a visual reminder that Sticky mode is active, even when no new edits have arrived yet. The user can still click it to return to Autoscroll and scroll to the latest content.

---

## Summary

**Counts:**
- BLOCKER: 1 (scrollTop clamping)
- IMPORTANT: 0
- NICE: 2 (CSS transition, multiple scroll events)
- QUESTION: 3 (cap eviction, overflow-anchor, button text)

**Disposition:**
- The BLOCKER must be fixed before merge. Suggested fix is straightforward (clamp `target` before assignment).
- The NICE findings are low-priority improvements, acceptable to defer to V3 or document as known limitations.
- The QUESTION findings are primarily documentation/spec clarification requests, not code bugs.

**Additional observations:**
- `pickAnchor` correctly handles edge cases (empty stream, all cards above viewport).
- `applyEdits` topmost-changed-card logic is correct for both existing and new cards.
- `enterSticky` / `enterAutoscroll` guards correctly preserve `stickyChangedPaths` across re-entry.
- `followBtn` DOM persistence across session changes is correct (sibling of streamEl, hidden on enterAutoscroll).
- `scrollToCard` getBoundingClientRect() after synchronous appendChild is correct (forces layout).
- Re-entry into Sticky when already sticky is correctly no-op'd by the guard.
- Race conditions between user scroll and programmatic scroll are correctly handled by rAF atomicity and idempotent state transitions.
