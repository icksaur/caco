# file-edits V3.5 — drag-text-to-select-lines

Prerequisite reading: `docs/file-edits-v3.4.md` (locked).
Reuses without restating: `SOURCE_ID` echo guard, `validateSelection`
line-envelope rules, `scheduleAgentFinalize` rAF cancellation,
`pendingOpenIds` race-free open, `setActiveTab`/`closeTab` echo,
30%-from-top scroll.

## Goal

Let the user drag-select text in the diff pane the same way they
would in any code viewer — sub-word, mid-line, multi-line — and have
that gesture *be* the line-selection that V3.4 introduced. Copy
works because the browser's native selection is real text. The
agent's view (a line envelope) stays in sync with what the user
dragged. The line-level highlight remains visible after the user
clicks into the chat input or anywhere else outside the pane.

What V3.5 deliberately does **not** try to do: restore the native
text Range after the browser clears it. That gesture (click chat →
click back in pane → text re-highlighted) is fundamentally fighting
the browser's mousedown→focus→mouseup ordering. Reviewer
`docs/file-edits-v3.5-review.md` §B1 walks through why. Instead, we
keep the *line* state alive and visible via a persistent paint, and
accept that the character-precise Range is lost on focus-out (just as
in any other text-based UI). The user can re-drag to re-grab text.

## Non-goals

- Restoring the native Range after focus leaves the pane.
- Column-precise echo to the agent. Wire payload stays
  `{start, end}` (line envelope).
- Multi-range selection.
- Selection across folded ranges (folded rows aren't in the DOM).
- Selecting pure-deletion rows (V3.4 §"Pure-deletion / HEAD-only
  rows" inherits).

## Data model

Per FileTab:

```
tab.selection: { startLine: number, endLine: number } | null
```

Same shape as V3.4. There is no `savedRange` — we don't try to
preserve the actual Range. The line envelope is truth.

## Mental model

Three things, each with one job:

1. **Native text selection** — the user's input gesture. Drag updates
   it. Browser paints it. It is *not* persistent; the browser owns it
   and may clear it any time focus moves.
2. **`tab.selection`** — the line envelope. The agent's view of "what
   the user is interested in." Updated when a non-empty native
   selection lands inside the pane. Cleared by Escape, by clicking
   the empty pane background, or by an explicit agent push of `null`
   active-tab (V3.4 already declines to auto-clear on that, retained).
3. **`.fe-row-selected` paint** — the always-visible reflection of
   `tab.selection`. Independent of whether the pane has focus. Lets
   the user see what's selected after they click into chat.

The user sees both layers when the pane has focus: native blue
highlight from the browser, plus our subtle line tint underneath.
After focus moves, the native layer disappears; the line tint remains.

## Selection lifecycle

### 1. User drags text inside the pane

Listen to `document.selectionchange`. On each event, schedule a
single coalesce-handler via rAF (so one handler per frame even if
the drag fires 50 events). The coalesce-handler:

1. Reads `window.getSelection()`. Bails early if outside our pane.
2. If empty/collapsed: do **nothing** to `tab.selection`. A
   collapsed selection is a caret placement, not a clear. (Explicit
   clears go through Escape or background-click; see §4.)
3. If non-empty inside the pane: find each endpoint's enclosing
   `.fe-row[data-work-line]`. If an endpoint is in a row without
   `data-work-line` (pure-del row), snap to the nearest valid row —
   start snaps DOWN, end snaps UP. If the snapped envelope collapses
   (start > end), drop the update.
4. Compute `{start, end}` envelope.
5. If `_userDragging` is set (mousedown happened, mouseup hasn't),
   we're mid-drag — update `tab.selection` and repaint, but defer
   the echo to mouseup. Otherwise echo immediately.
6. If `tab.selection` changed, also set `followEdits = false` (only
   on the first non-empty selection of a drag — track via "was
   `tab.selection` null before this update").

The `_userDragging` flag is set on `paneEl mousedown` and cleared on
the *document's* `mouseup` (capture-phase, to catch mouseups outside
the pane). Echo on mouseup if any pending. This avoids flooding the
WebSocket with dozens of echoes during a single drag.

Programmatic restores (agent push only — see §5) suppress echo via
value-comparison, not a timed flag. Before calling `addRange`, store
`tab._expectedEnvelope = {start, end}`. The selectionchange handler,
on observing an envelope that matches `_expectedEnvelope`, consumes
the token (sets it to null) and skips the echo for that one event.
Token times out after 250ms to avoid leaks if the browser drops the
event.

### 2. selectionchange listener scope

Listener is on `document`. Most fired events are for other applets'
DOM. Step 1 ("bails early if outside our pane") must run *before*
scheduling the rAF — otherwise we burn a rAF per global event.
Recipe: synchronous inside-pane check on the raw event, then rAF
schedule only if relevant.

If the surface framework ever runs file-edits in its own iframe,
all of this is naturally scoped — but per `applets/file-edits/script.js`
today the applet runs in the shared document. State that assumption
in the implementation and revisit if it changes.

### 3. User clicks a gutter

Gutter clicks are the dedicated "select a whole line" gesture for
users who prefer point-and-click over drag.

- Click on `.fe-row[data-work-line] > .fe-gutter` → build a Range
  spanning the row's `.fe-line` from first to last text node, call
  `removeAllRanges` + `addRange`. The subsequent selectionchange
  picks it up via the normal §1 path. `_expectedEnvelope` set to
  `{start: line, end: line}` to suppress the redundant echo (echo
  fires once from the user gesture, not twice).
- Shift-click on `.fe-row[data-work-line] > .fe-gutter` → extend
  from `tab.selection.start` (treated as anchor, matching V3.4
  semantics — clicking line 10 then shift-clicking line 5 gives
  {5,10}, shift-clicking line 20 gives {10,20}). Build a Range from
  the anchor row's `.fe-line` start to the focus row's `.fe-line`
  end (swapping if reversed). Apply.

The handler MUST be scoped to `.fe-row[data-work-line] > .fe-gutter`
to avoid firing on fold/collapse rows (whose gutter spans are empty
grid placeholders) and pure-deletion rows. Fold/collapse rows have
their own click handlers on the fold button (`script.js:1444-1446,
1474-1481`); our gutter handler must not intercept those.

`mousedown` (capture phase) on shift+gutter calls `preventDefault`
so the browser's shift-extend-text-selection doesn't fight us.

### 4. User clicks empty pane background or hits Escape

- Click on `.fe-diff` background that isn't a row → clear:
  `tab.selection = null`, `removeAllRanges`, repaint, echo.
- Escape (and pane is the focus target, or document Esc with picker
  not open — same as V3.4) → same clear path.

A collapsed selection on a row's text (caret placement via single
click) does NOT clear; see §1 step 2.

### 5. Agent pushes a selection

`applyAgentState` flow from V3.4 unchanged in shape:
`validateSelection` → `scheduleAgentFinalize` → `finalizeAgentSelection`.
The change is what `finalizeAgentSelection` does:

1. `tab.selection = validated envelope` (or null if invalid).
2. `paintSelection()` (always — whether focused or not).
3. Scroll into view at 30%-from-top (unchanged).
4. If the pane is currently focused AND the active document doesn't
   show the user mid-drag (`_userDragging` is false), build a
   full-line Range from the envelope (start of startLine's `.fe-line`
   to end of endLine's `.fe-line`), set `tab._expectedEnvelope` to
   the envelope, then `addRange`. If `_userDragging` is true, skip
   the addRange — the user owns the native selection until their
   gesture finishes. (Without this, the agent push collapses the
   user's in-progress drag.)
5. `echoState()`.

If the tab is inactive (not the active tab), `paintSelection` still
runs on the (currently-deactivated, off-DOM) pane element — V3.4
already does this via the `paneEl` reference held on the FileTab
instance. The line tint will be visible the moment the user
activates the tab. No `addRange` for inactive tabs (no Selection
to apply to).

### 6. Tab switch

`setActiveTab` calls `prev.deactivate()` (detaches pane from DOM) and
`next.activate()` (re-attaches and re-runs render). Native Selection
is per-document, not per-element — but detaching the pane
invalidates any Range whose containers it held, and the next
activate replaces them. Behavior:

- On deactivate of a tab with `tab.selection`, leave `tab.selection`
  intact. Paint stays via `.fe-row-selected` (paint runs at render
  time, see §7).
- On activate, the new tab's pane mounts; its `render` runs and the
  paint reflects `tab.selection`.
- The previously-active tab's native Selection range is gone (the
  Range's containers are off-DOM). When the user re-activates it,
  the line tint is there; the native highlight is not. That's
  consistent with the general V3.5 principle (native is transient,
  line state is persistent).

### 7. render() repaint

V3.4 calls `paintSelection` at the end of `render`. V3.5 keeps that
hook — it ensures that when `caco.edit` content updates rebuild the
DOM rows for a tab that has a `tab.selection`, the new rows pick up
the `.fe-row-selected` class. Same code path as today; no extra
logic needed in `render`.

If the user's selection envelope no longer maps to rendered rows
(file shrunk, lines removed), `paintSelection` simply finds no
matching rows and paints nothing. `tab.selection` is left as-is so
the agent's wire view is unchanged; this matches V3.4 behavior. We
do NOT auto-clear envelopes that no longer have visible rows because
the file may grow back.

Optional rebuild-native-Range-after-render: if the tab is active AND
focused, after render also call the §5 step 4 path to put a fresh
Range on the new rows. This is a nice-to-have that ensures copy keeps
working after a content update; flag for V3.6 if perf is fine.

### 7a. Live edits arriving during an active selection

When a `caco.edit` event lands for the active tab while the user has
a non-null `tab.selection` (and possibly an active native Range or an
in-progress drag), V3.5 commits to **render-immediately** semantics
— the freshness of the diff view wins over the smoothness of the
user's gesture. Concretely:

- `render()` runs and rebuilds the row DOM. `paintSelection` reapplies
  `.fe-row-selected` to whatever rows now bear the envelope's
  line numbers.
- The browser drops the native Range because its container nodes
  were detached; a `selectionchange` fires with an empty selection,
  which §1 step 2 ignores (collapsed → no state change).
- If `_userDragging` was true, the drag is collateral damage: the
  browser's drag tracking lost its target, no further mousemove
  events update the selection, `mouseup` fires anywhere (capture-
  phase handler still clears `_userDragging` and runs the pending-
  echo flush — which is a no-op because `tab.selection` already
  matches the last echo).
- The user sees the line tint hop to the new rows that now carry
  those line numbers. They re-drag if they wanted character-precise
  text.

**Line-number drift is explicitly accepted.** The envelope is
`{start, end}` in *current-file work-line numbers*, not anchored to
content. If the agent inserts three lines above the user's selection,
the user's "lines 10-15" envelope now points at *different content*
sharing those line numbers in the new file. The user notices via the
visible tint hop; the agent sees the same envelope numbers it always
has. We do not attempt content-anchored re-mapping — the diff
machinery has no infra for it and the cost wouldn't pay back. This
is the same model VSCode and similar editors use when their files
are edited externally.

**Agent push arriving concurrent with a `caco.edit`.** Both go
through rAF chains; whichever finalizes last wins (last-write-wins).
The agent's envelope is interpreted in the post-edit line numbering
because by the time `finalizeAgentSelection` runs, `render` has
already executed. If the agent's envelope was computed against the
pre-edit numbering, it suffers the same drift as the user's
selection — accepted.

**Why not defer renders while `_userDragging`?** Considered and
rejected. Deferring would let the user finish a drag against stable
content, but would (a) silently hold the agent's edit invisible for
the duration of the drag, (b) compute the envelope against the
*pre-edit* numbering which would then be applied against post-edit
content moments later (the same drift, just hidden until mouseup),
and (c) add complexity (queue, flush-on-mouseup) for a corner case.
Render-immediately makes the disruption visible, which is honest.

### 8. Cross-session switch

V3.4 §"Session change with selection" says state resets. V3.5
inherits and adds: also call `window.getSelection().removeAllRanges()`
so the browser's selection state matches our wipe — the old session's
rows are about to be torn down and we don't want stale Range
references hanging on the global Selection.

### 9. followEdits interaction

V3.4 turned `followEdits = false` on every `userSelectLine` call.
V3.5 has no `userSelectLine`; the equivalent is "selectionchange
updated `tab.selection` from null to non-null." Only that
*transition* flips `followEdits = false`. Subsequent updates within
the same drag, or replacing one envelope with another, do not toggle
followEdits (it's already off).

Agent pushes do NOT flip followEdits (same as V3.4).

## Selection rendering

Single paint: `.fe-row-selected` class on rows in
`[tab.selection.start, tab.selection.end]`. CSS:

```css
.fe-diff .fe-row.fe-row-selected .fe-line {
  background: color-mix(in oklab, var(--color-accent) 20%, transparent);
}
.fe-diff .fe-row.fe-row-selected .fe-gutter {
  background: color-mix(in oklab, var(--color-accent) 40%, transparent);
  color: var(--color-text-bright);
}
```

(Slightly softer than V3.4's tint so the native blue highlight reads
clearly on top when present.)

When the pane has focus and the user just dragged, the visible state
is "browser blue selection box" + "our line tint underneath." When
the pane loses focus, only the line tint remains. Same when an
agent push paints a tab that isn't focused.

## Agent ↔ applet protocol

Unchanged: `fileEdits = {activeTab, selection: {start, end} | null, sourceId}`.
V3.4 contract preserved.

## Edge cases

| Case | Behavior |
|---|---|
| Drag-select "funcName" mid-line, click chat, look at pane | `.fe-row-selected` shows on that line via persistent tint. Browser-native blue highlight is gone. Agent sees `{start: lineN, end: lineN}`. |
| Drag-select 10 lines, click chat, click back into pane | Line tint stays on 10 lines. Click positions caret on whichever row was clicked (collapsed selection, ignored per §1 step 2). User can drag again. |
| User clicks in middle of a row's text (no drag) | Browser places caret (collapsed selection). selectionchange fires; we ignore (collapsed). `tab.selection` unchanged. Line tint stays. |
| User double-clicks a word | Browser selects the word. Envelope = that line. Echo. Native blue highlight on the word; line tint on the row. |
| User triple-clicks a line | Browser selects the whole line text. Envelope = that line. Same as above. |
| User shift-clicks gutter while pane has different native selection | Build new full-line Range, apply, browser replaces selection. Envelope updates via selectionchange. |
| Agent push while user is drag-selecting | `_userDragging` is true; agent push skips addRange (would collapse user's drag) but still updates `tab.selection`, paints, scrolls, echoes. User finishes drag → selectionchange overwrites with their final selection. (Last-write-wins; user's gesture wins because it finishes after the agent push.) |
| `caco.edit` rebuilds active tab's DOM while `tab.selection` is non-null | `render` repaints `.fe-row-selected` on new rows. Native Range is invalidated by the DOM rebuild and the browser drops it — line tint persists, copy is lost until user re-drags. (Acceptable: content just changed under the cursor.) |
| File shrinks and envelope lines no longer exist | `paintSelection` finds no rows, paints nothing. `tab.selection` retained. Agent still sees the envelope. Acceptable degradation; agent can clear by pushing `null`. |
| Selection in folded range | Browser can't include folded (off-DOM) rows. Envelope reflects whatever made it into the Range. Expanding fold doesn't auto-extend selection. |
| Two browser tabs open on same session, A drags, B receives echo | B's `applyAgentState` runs §5; B's pane may not be focused so just paints. SOURCE_ID still guards against self-echo cross-tab loops. |
| User Ctrl+A inside the pane | Browser selects everything inside the pane (and possibly outside if focus is unclear). selectionchange snaps envelope to whatever's inside the pane via §1. Echo. |

## Risks

1. **selectionchange flooding.** rAF coalesce + mouseup-bounded echo.
2. **Mid-drag agent push collapses user gesture.** `_userDragging` gate.
3. **Programmatic addRange triggers our own handler.** Value-comparison
   via `_expectedEnvelope` token, not a timing flag.
4. **Gutter handler races fold button.** Scope selector to
   `.fe-row[data-work-line] > .fe-gutter`. Fold buttons live inside
   fold/collapse rows that have no `data-work-line`.
5. **Pane focus and shared document.** paneEl gets `tabindex="-1"`
   so it can receive focus from mouse clicks; no conflict with the
   existing focusable elements (tab pills, follow-edits button,
   picker input — all are buttons/inputs that already manage their
   own focus).
6. **Native Range lost on DOM rebuild.** Line tint persists; copy is
   gone until re-drag. Documented as acceptable.

## What changes from V3.4

| V3.4 | V3.5 |
|---|---|
| Click row → select line | Drag text → select lines (also: click gutter → select line) |
| Shift-click row → extend line range | Shift-click gutter → extend; shift-drag → browser default extend |
| paneEl click handler routes row/background | paneEl click handler narrowed to background-only (clear); gutter click handler added |
| `userSelectLine` / `userClearSelection` functions | replaced by `selectionchange` handler + gutter click handler |
| Shift+mousedown preventDefault on rows | Removed (rows participate in normal text selection) |
| `_restoringRange` timing flag | `_expectedEnvelope` value-comparison token |
| No drag awareness | `_userDragging` flag set on pane mousedown, cleared on document mouseup |

## What stays from V3.4

- `tab.selection = {start, end}` shape
- `.fe-row-selected` class (CSS tints softened slightly)
- `SOURCE_ID` echo guard
- `validateSelection` with bounds-before-normalize + clamp-to-rendered
- `scheduleAgentFinalize` rAF chain cancellation
- `pendingOpenIds` race guard
- `setActiveTab` / `closeTab` echo
- 30%-from-top scroll
- Wire payload `{activeTab, selection, sourceId}`
- Agent push does not flip `followEdits`

## Implementation plan

1. **Add `tabindex="-1"` to `paneEl`** (constructor or static markup).
2. **Soften `.fe-row-selected` CSS tints** so native blue selection
   reads on top.
3. **Add `_userDragging` flag**: set on `paneEl mousedown` (any
   button), clear on `document mouseup` capture-phase. Also clear
   on `document blur` to be safe.
4. **Add `selectionchange` handler** on `document`. Synchronous
   inside-pane bail. rAF-coalesce. Compute envelope from current
   selection, snap to valid work-lines, update `tab.selection`,
   paint, echo (deferred until mouseup if `_userDragging`).
   Value-compare against `_expectedEnvelope` to suppress
   programmatic-restore echo.
5. **Add gutter click handler** scoped to
   `.fe-row[data-work-line] > .fe-gutter`. Build full-line Range for
   click; build cross-line Range from anchor for shift-click.
   `_expectedEnvelope` set before applying.
6. **Narrow pane click handler** to only handle background clicks
   (clear). Remove row-click and shift-mousedown row handlers.
7. **Update `finalizeAgentSelection`** to call the §5 step 4 Range
   restoration when pane is focused and `_userDragging` is false.
   Always paint regardless.
8. **Update Escape handler** to also call `removeAllRanges`.
9. **Update `onSessionChange` handler** to call `removeAllRanges`
   before tearing down tabs.
10. **Remove `pendingSelection` field and the `_agentRaf1/_agentRaf2`
    fields' use beyond what's needed**; the new model doesn't have a
    "selection pending until render" phase because paint always runs
    on `tab.selection` directly. Actually keep `pendingSelection` /
    `scheduleAgentFinalize`: the agent-push-to-not-yet-mounted-tab
    path still needs to wait for the first render to find rendered
    rows for `validateSelection`'s clamp step. The only change is
    that `finalizeAgentSelection` no longer reads `pendingSelection`
    into `tab.selection` differently — it just runs the §5 path.

## Tests

Manual:
- Drag-select "funcName" inside a line of code. Ctrl+C copies it.
  Agent sees that line as envelope.
- Drag-select 5 lines. Click into chat. Five rows show line tint.
  Agent sees the 5-line envelope.
- Click back into pane on row 3 of the selection. Caret placed; line
  tint still on all 5 rows.
- Triple-click a line. Native blue highlight + line tint on that
  one row.
- Click a gutter on line 10. Line 10 highlighted natively + tinted.
- Shift-click gutter on line 20. Range 10-20 highlighted.
- Escape clears both.
- Agent `set_applet_state` with line 22, pane focused: native blue
  highlight appears on line 22 + tint.
- Agent push during user drag: drag finishes correctly, ends as
  user's selection. Agent's intermediate push is overwritten.
- `caco.edit` updates the active tab while selection is live: line
  tint stays, native selection is gone, no JS errors.

No automated tests added (consistent with V3.4).

## Generalization for reuse

The selection model in §Mental model — *native browser selection is
the input gesture; a persistent envelope is truth; class-based paint
reflects the envelope; bidirectional sync with the agent via
appletState* — is not file-edits-specific. Any applet that displays
a list/grid/document of items with stable IDs and wants to expose
"what the user is looking at" to the agent (and let the agent push
back) faces the same problem. Candidate adopters:

- A grep-results applet (envelope: match indices).
- A log viewer (envelope: log-line numbers).
- A folder listing (envelope: file paths).
- A test-results panel (envelope: test IDs).

### The reusable pattern

A general `SelectionMirror` has these moving parts. None depend on
file-edits-specific data:

1. **Truth state.** A typed envelope value (line range, ID set,
   path list — applet's choice). Stored per-context (per-tab in
   file-edits; per-applet for single-view applets).
2. **Input listener.** `document.selectionchange` with synchronous
   inside-our-pane bail, then rAF-coalesce. Translates the native
   `Selection` into the envelope by walking endpoints to their
   nearest selectable item via a CSS selector (e.g.
   `.fe-row[data-work-line]`).
3. **Drag fence.** `_userDragging` flag set on pane `mousedown`,
   cleared on document `mouseup` (capture). Echoes deferred until
   mouseup. Optional but recommended.
4. **Echo-loop guard.** `_expectedEnvelope` value-comparison token
   set before any programmatic `addRange`, consumed when the
   handler observes a matching envelope. Times out after ~250ms.
5. **Source-ID guard.** Per-page-load UUID included in echo
   payloads; incoming pushes with matching `sourceId` are ignored.
   Prevents cross-tab loops in multi-window scenarios. (Already
   shipped at the applet-state layer in V3.4; reuse as-is.)
6. **Paint.** A CSS class applied to items whose ID is in the
   envelope. Single function, runs on render and on envelope change.
7. **Agent push handler.** Validates the incoming envelope against
   the rendered item set (`validateSelection` equivalent — clamp /
   drop). Schedules a finalize after layout. Applies a Range if the
   pane is focused and the user isn't mid-drag.
8. **Gutter / sidebar gesture.** Optional explicit "click-to-select"
   affordance distinct from the body's text-selection drag. Scoped
   to a separate selector so it doesn't conflict with the body's
   normal text behavior or with fold/expand controls.

### What a reusable module would look like

A future `public/ts/applet-selection.ts` could expose:

```ts
interface SelectionMirrorOptions<T> {
  paneEl: HTMLElement;
  itemSelector: string;     // e.g. '.fe-row[data-work-line]'
  itemIdAttr: string;       // e.g. 'data-work-line' (parsed as number for ranges)
  envelopeFromRange(range: Range): T | null;  // app-specific
  rangeFromEnvelope(env: T): Range | null;    // app-specific
  paint(env: T | null): void;                 // app-specific
  validate(env: T): T | null;                 // app-specific clamp/drop
  onEnvelopeChanged(env: T | null): void;     // for echo + downstream effects
  gutterSelector?: string;                    // optional click-to-select gesture
}
class SelectionMirror<T> {
  constructor(opts: SelectionMirrorOptions<T>);
  setEnvelope(env: T | null, source: 'user' | 'agent'): void;
  destroy(): void;
}
```

The applet supplies the envelope shape and the four type-specific
hooks (`envelopeFromRange`, `rangeFromEnvelope`, `paint`,
`validate`). The mirror handles `selectionchange`, `_userDragging`,
`_expectedEnvelope`, debounce, and the gutter gesture wiring.
Source-ID guarding stays at the applet-state callsite (each applet
knows its own state key).

### Don't extract yet

We have one consumer. Extracting now would lock in the wrong API.
Recipe to follow when a second adopter appears:

1. Implement the second applet using a literal copy of file-edits'
   selection block (rename the type parameters and selectors).
2. Diff the two implementations. Anything that didn't need to
   change is the API. Anything that did is consumer-specific.
3. Extract the common surface, file-edits and the second adopter
   both depend on the new module.

This V3.5 spec is the *anchor implementation*. It should be written
clearly enough that a copy-and-modify is reasonable, even before
formal extraction. Specifically:

- Selection state lives in a clearly-named object (don't scatter
  `_userDragging`, `_expectedEnvelope`, etc. across the file).
  Suggest a `selectionMirror` object held on each FileTab, with
  documented fields and a single `attach(paneEl)` method.
- The selectionchange handler's pane-clip and snap-to-item logic is
  a pure function `envelopeFromSelection(selection, paneEl): T | null`
  — easy to copy.
- `validateSelection` and `paintSelection` are already pure functions
  in V3.4; keep them that way in V3.5.

### What gets reused for free across applets

These pieces ship in V3.4 and don't need to be extracted to be
reusable, because they already live at the framework layer:

- `appletAPI.setAppletState` / `appletAPI.onStateUpdate` (per-applet
  state sync via WebSocket).
- `broadcastToAll(msg, ws)` sender-exclude semantics.
- The applet-state shallow-merge that lets each applet write its
  own top-level key without clobbering peers.

So *any* applet that wants bidirectional state with the agent gets
that layer for free. The V3.5 work is purely about the
*selection-as-input* gesture on top of it.

## Open questions

(None — all V3.4 open questions inherited and reviewer concerns
addressed in §Selection lifecycle.)
