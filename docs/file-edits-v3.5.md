# file-edits V3.5 — native text selection as source of truth

## Goal

Replace V3.4's line-class selection model with one where the browser's
native text selection is the source of truth. The user can drag-select
any range — sub-word, mid-line, multi-line — and:

- the agent sees it as a line range,
- the agent can push back a line range that becomes a native text selection,
- the selection survives clicking outside the pane (chat input, tab strip,
  page chrome) without visual loss.

V3.4 shipped two parallel selection systems — native (browser-owned,
transient, character-precise) and `.fe-row-selected` (our class,
persistent, line-precise) — that didn't know about each other. Dragging
selected text only the browser knew about; clicking a line only we
knew about; copying never worked from a line-click; the native selection
vanished on focus-out. V3.5 collapses to one model.

## Non-goals

- **Column-precise echo to agent.** Selection sent over the wire stays
  `{startLine, endLine}`. Agents reason about line ranges; sub-line
  precision is a future extension if proven useful.
- **Multiple disjoint selections.** Browsers technically support
  multi-range selections; we treat selection as the single range
  spanning anchor→focus, like every code viewer does.
- **Selection in folded ranges.** Folded rows aren't in the DOM; native
  selection can't include them. No change from V3.4.

## Data model

Per FileTab, persisted in-instance only (not in the surface document):

```
tab.selection: {
  startLine: number,     // work-line number (1-based)
  endLine: number,       // work-line number (1-based), >= startLine
  savedRange: Range|null // cloned DOM Range for restore-on-focus
} | null
```

`savedRange` is the user's actual Range (potentially sub-line). It's
what gets re-applied to `window.getSelection()` when focus returns to
the pane. `startLine`/`endLine` are the *whole-line* envelope, derived
from the Range's anchor/focus by walking up to `.fe-row[data-work-line]`.

The line envelope is what the agent sees and what we send over
applet-state.

If `savedRange` ever becomes invalid (DOM mutation invalidates the
container nodes), it's discarded and the next focus-in falls back to
constructing a full-line Range from `startLine`/`endLine`.

## Selection lifecycle

### 1. User makes a selection inside the pane

Listen to `document.selectionchange` (the only event browsers fire for
selection updates). On each event:

1. Read `window.getSelection()`.
2. If the selection is empty or fully outside our pane, do nothing
   (preserves other applets' selections).
3. Otherwise, clip to the pane: if anchor or focus is outside, fall
   back to the side that's inside (or drop the event if neither is).
4. Find each endpoint's enclosing `.fe-row[data-work-line]` via
   `Node.parentElement` walk. If either endpoint is in a row without
   `data-work-line` (pure-deletion row), snap to the nearest row with
   one — start snaps DOWN to next valid line, end snaps UP to prev
   valid line. If the snapped envelope collapses (start > end), drop
   the update (don't clobber existing state).
5. Compute `{startLine, endLine}` envelope (min/max of the two row
   numbers).
6. If unchanged from `tab.selection?.startLine/endLine`, still update
   `savedRange` (the user may have shifted within the same line range)
   but skip the echo.
7. Otherwise update `tab.selection`, clone the Range for `savedRange`,
   echo to agent.

`selectionchange` fires *very* often during a drag. Debounce echo to
the next animation frame: coalesce multiple events into one echo when
the frame fires.

### 2. User clicks outside the pane (chat input, tab strip, etc.)

The browser clears `window.getSelection()`. We do *nothing* to
`tab.selection` — it stays. The visual highlight goes away (no
`.fe-row-selected` class). Instead we paint a **subtle persistent
indicator** so the user can still see "this is what's selected":

- Add `.fe-row-selected` class to the row range (gutter tint only, no
  line tint — distinguishes from active native selection).

When focus returns to the pane (see §3), we restore the actual Range,
and the gutter-only indicator gets replaced by the browser's full
native highlight.

### 3. Focus returns to the pane

On `paneEl` `focusin` (or any `mousedown` inside the pane that is
*not* shift-extend — for shift-extend we want the browser to extend
the existing selection naturally):

1. If `tab.selection` is null, do nothing.
2. If `window.getSelection()` already has a non-empty range inside the
   pane, do nothing (user is in mid-gesture).
3. If `tab.selection.savedRange` is still valid (containers still
   connected, offsets still in bounds), re-apply it:
   `selection.removeAllRanges(); selection.addRange(savedRange.cloneRange())`.
4. Else construct a full-line Range from `startLine`/`endLine`: start
   at first child text node of row[startLine] `.fe-line`, end at last
   text node of row[endLine] `.fe-line`. Apply.

`paneEl` needs `tabindex="-1"` so it's a focus target. Apply it
once in the FileTab constructor or via static markup.

Restoring a Range from script will itself fire `selectionchange`. To
avoid an echo loop, set `tab._restoringRange = true` before the
restore and clear it on the next microtask; the selectionchange
handler bails if the flag is set.

### 4. Agent pushes a selection

`applyAgentState` (V3.4) currently writes `pendingSelection` and lets
`finalizeAgentSelection` validate + paint two rAFs later. V3.5
replaces "paint" with "construct Range + addRange":

1. Validate `{startLine, endLine}` against rendered work-lines (same
   `validateSelection` as V3.4).
2. Update `tab.selection` to `{startLine, endLine, savedRange: null}`.
3. If this tab is active and the pane is focused, build the full-line
   Range and addRange (with `_restoringRange` guard). Otherwise just
   paint the gutter-only indicator and leave the actual Range
   application until focus-in.
4. Scroll-into-view stays as today (30%-from-top).
5. Echo back so the agent's state-roundtrip is consistent.

### 5. User clicks a line gutter / line number

This is a new gesture V3.4 had via row-click; in V3.5 the row's `.fe-line`
participates in normal text selection so a click there is a caret
placement (collapsed selection). We dedicate the **gutter** to
line-selection-only:

- Click on `.fe-gutter` → select that whole line (Range from start to
  end of `.fe-line` text).
- Shift-click on `.fe-gutter` → extend the existing selection's
  endpoint to that line's `.fe-line` boundary.

`preventDefault` on `mousedown` for shift+gutter so the browser
doesn't fight us. The gutter already has `user-select: none` so it
doesn't accidentally become part of the text selection.

`.fe-line` is unchanged — drag, click, double-click-to-select-word,
triple-click-to-select-line all work via browser default.

### 6. User clicks pane background (no row hit)

Browser will collapse the selection at the click point (or clear it
entirely if click is below all rows). The selectionchange handler
sees an empty/collapsed selection inside the pane and clears
`tab.selection` + echoes.

If we want to preserve the V3.4 "click background to clear" behavior
explicitly, the empty-selection path covers it.

### 7. Escape key

Same as V3.4: clear `tab.selection`, `selection.removeAllRanges()`,
echo. Skip if picker is open.

### 8. Tab switch and tab close

`setActiveTab` continues to deactivate the previous tab's pane.
Native selection is per-document, not per-pane, so deactivating a
pane (removing it from the DOM) implicitly invalidates any active
Range inside it. The new active tab restores its own selection via
the focus-in path. Tab state (line envelope) survives because it's
on the FileTab instance.

`closeTab` discards the tab and its `tab.selection` — fine.

## Selection rendering

Two visual states for the selected range:

| State | Native highlight | `.fe-row-selected` class | Trigger |
|---|---|---|---|
| Active (pane focused) | Yes (browser default) | No | focus inside pane |
| Persistent indicator (pane unfocused) | No (browser cleared it) | Yes, gutter only | focus left pane |

The gutter-only persistent indicator uses a new CSS class
(`.fe-row-selected-persist`) so we can distinguish it from V3.4's
full row highlight (which we drop):

```css
.fe-diff .fe-row.fe-row-selected-persist .fe-gutter {
  background: color-mix(in oklab, var(--color-accent) 40%, transparent);
  color: var(--color-text-bright);
}
/* no .fe-line rule — line background stays unstyled when unfocused */
```

V3.4's `.fe-row-selected` rules (line + gutter tint) are removed.

Painting is driven from `tab.selection`: a single `paintPersistent()`
function that runs when focus leaves the pane, and clears the class
when focus returns (because the native highlight then takes over).

## Agent ↔ applet protocol

Unchanged from V3.4:

```
fileEdits: {
  activeTab: string|null,
  selection: { start: number, end: number } | null,  // line envelope
  sourceId: string,
}
```

Wire compat: `start`/`end` are line numbers as before. The applet now
internally tracks `savedRange` too but doesn't serialize it.

## Echo cadence

- Debounce echo to next animation frame during drag-select to avoid
  flooding (selectionchange fires per pixel during a drag).
- Programmatic restores (`_restoringRange`) suppress the echo.
- All V3.4 echo paths (`setActiveTab`, `closeTab`, agent apply) are
  unchanged.

## Edge cases

| Case | Behavior |
|---|---|
| User drags from line 5 in tab A, switches to tab B, switches back | A's `tab.selection` restored from `savedRange` on focus-in; if `savedRange` invalid because A's pane was DOM-detached and re-rendered, fall back to full-line Range from envelope. |
| User drags backward (end above start) | Browser handles direction; we always take min/max for envelope. `savedRange` preserves the user's direction so backward drag stays backward on restore. |
| Selection straddles a fold | Native selection can't span folded (not-in-DOM) rows. The selection ends at the fold boundary; envelope reflects that. Expanding the fold doesn't auto-extend the selection. |
| Selection inside a pure-deletion block | Snap-to-nearest-work-line during envelope computation may collapse; drop the update. The native selection still exists visually but our state stays at the prior value. (Acceptable: the agent's "what lines does user care about" can't be expressed for del-only content.) |
| Programmatic restore fails (containers detached) | Catch the exception, fall back to full-line Range. If even that fails (envelope lines no longer rendered), clear `tab.selection`. |
| User triple-clicks a line | Browser selects the whole line's text. Our handler sees the Range, computes envelope = that one line, stores it. Works. |
| User double-clicks a word | Range spans the word. Envelope = that line. `savedRange` keeps the word range, so click-outside-then-back restores the word selection, not the whole line. ✅ |
| Agent push during user drag | The selectionchange handler holds the user's intent until the drag finishes. Agent push that arrives during drag overwrites the in-progress state. Acceptable: agent gestures win (rare); if it's a problem, gate agent push on "no active mouse drag" via a `_userDragging` flag set on mousedown/cleared on mouseup. |
| Picker open + click inside picker | Selection inside picker DOM is outside the pane — selectionchange handler ignores it. ✅ |
| Very large multi-line selection | Native browser perf, not ours. We just store envelope + cloneRange. O(1). |

## Risks

1. **selectionchange fires constantly.** During a 200ms drag across
   100 lines it can fire 50+ times. Mitigation: rAF coalescing.

2. **`savedRange` becomes stale on re-render.** Any time
   `renderBody` rebuilds row DOM (e.g., on `caco.edit` content update
   for the active tab), `savedRange`'s container nodes are detached.
   Mitigation: store envelope alongside Range and rebuild Range from
   envelope when stale.

3. **Programmatic addRange race with user input.** If we addRange
   while the user is starting a mousedown, the browser may discard
   our Range. Mitigation: only addRange on focusin (a settled event),
   not during arbitrary state changes.

4. **Cross-browser Range cloning behavior.** Range.cloneRange is well
   supported. Some browsers normalize text nodes which can shift
   offsets. Mitigation: store envelope as truth; cloneRange is best-effort.

5. **Per-document selection means tab switch nukes the Range.**
   Already handled by restore-on-focus.

## Open questions

- **Q1: Should we ever paint a "background" tint when focused?** No —
  let the browser's native selection paint be the only highlight when
  focused. Cleaner, no double-paint.
- **Q2: Do we still need the click-on-pane-background-clears
  behavior?** Selectionchange covers it (empty selection → clear).
  Remove the V3.4 background-click handler.
- **Q3: Should agent push include sub-line column info?** Out of
  scope; revisit if a use case appears.

## Implementation plan

In order, smallest first so each step is testable:

1. **Add `tabindex="-1"` to `paneEl`** so it can receive focus.
2. **Add `.fe-row-selected-persist` CSS, remove `.fe-row-selected`
   CSS.** (Class machinery still exists but won't visibly do anything;
   we'll repurpose it next.)
3. **Rewrite `paintSelection` → `paintPersistent`**: only adds the
   gutter-only class, only when called.
4. **Add `document.selectionchange` listener** that reads the
   selection, clips to the pane, computes envelope, updates
   `tab.selection`, echoes (rAF-debounced).
5. **Add `focusin` handler** that restores `savedRange` or builds
   full-line Range from envelope, with `_restoringRange` guard.
6. **Add `focusout` handler** that calls `paintPersistent` to draw
   the indicator.
7. **Update `applyAgentState` / `finalizeAgentSelection`** to build
   and apply a Range instead of just painting a class.
8. **Replace `userSelectLine`/`userClearSelection`/pane click
   handler** with gutter-only click + shift-click. Remove
   shift-mousedown preventDefault on rows (no longer needed; rows
   participate in normal text selection).
9. **Update Escape handler** to also call
   `selection.removeAllRanges()`.

## What changes from V3.4

| V3.4 | V3.5 |
|---|---|
| `tab.selection: {start, end}` | `tab.selection: {startLine, endLine, savedRange}` |
| Click row → select line | Click row text → caret placement (browser default); click gutter → select line |
| Shift-click row → extend line range | Shift-drag text (browser default); shift-click gutter → extend line range |
| `.fe-row-selected` (line + gutter tint) | `.fe-row-selected-persist` (gutter only, unfocused only) |
| paintSelection on render + after change | paintPersistent on focusout; native selection on focusin |
| Click pane background → clear | selectionchange with empty selection → clear |
| Wire payload `{start, end}` | Wire payload `{start, end}` (unchanged) |

## What stays from V3.4

- `SOURCE_ID` echo guard
- `validateSelection` (same line-envelope rules)
- `scheduleAgentFinalize` rAF cancellation
- `pendingOpenIds` for race-free agent-open
- `setActiveTab` / `closeTab` echo
- Agent push protocol & 30%-from-top scroll

## Tests

Manual:
- Drag-select text inside a line → copy works, agent sees that line as envelope.
- Drag across lines → agent sees correct envelope; click into chat, gutter indicator visible; click back into pane, selection restored.
- Triple-click line → whole line selected; agent sees that line.
- Double-click word, click chat, click pane → word selection restored (not full line).
- Agent set_applet_state to lines 10-20 → those lines highlighted natively (if pane focused) or via gutter indicator (if not).
- Shift-click a gutter → line range extends from existing selection's start row.
- Escape clears.

No automated tests in V3.4; not adding any in V3.5.
