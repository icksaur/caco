# Review — file-edits V3.5 (pass 2)

Reviewer was not the author. Reviewed against
`docs/file-edits-v3.5.md`, the prior review
`docs/file-edits-v3.5-review.md`, `docs/file-edits-v3.4.md`,
`docs/file-edits-v3.4-impl-review.md`, `applets/file-edits/script.js`,
and `code-quality.md`. Skipping nits and style.

## Summary

The rewrite genuinely closes every prior BLOCKER (B1, B2, B3) and
every prior IMPORTANT (I1, I3, I5, I6, I7, I8). I2 and I4 are
absorbed by the new "paint always runs from `tab.selection`,
regardless of focus" model — `render()` paint hook is unchanged
(`script.js:127`, `paintSelection` at `script.js:153-167`), and
inactive-tab agent push paints on the off-DOM `paneEl` (§5
lines 176-181). N1/N2/N3 are either moot or absorbed.

No new BLOCKERs. The IMPORTANTs below are real but localized — most
are editorial fixes to §7a and §Implementation plan rather than
design defects.

## BLOCKER

None.

## IMPORTANT

### I-v2-1. §7a step 3 mouseup-flush description is wrong

`docs/file-edits-v3.5.md:236-241` claims that when render-during-drag
fires `mouseup`, the "pending-echo flush … is a no-op because
`tab.selection` already matches the last echo." This contradicts §1
step 5 (`docs/file-edits-v3.5.md:87-89`), which is the entire reason
`_userDragging` exists: during a drag the handler **updates
`tab.selection` and repaints but defers the echo to mouseup**. So at
the moment the rebuild lands, `tab.selection` carries the user's
most-recent drag-derived envelope which has **not yet been echoed**.
The mouseup flush therefore DOES fire and sends that envelope —
which is the same envelope but now interpreted against post-edit
line numbering.

This isn't a bug in the chosen behavior; it's the same line-number
drift that §7a explicitly accepts in the next paragraph. But the
parenthetical is misleading and a future implementer will either (a)
optimize the flush away on the false belief it's a no-op, or (b) be
confused when their logging shows an echo the spec said wouldn't
happen. Rewrite the parenthetical as: "the pending-echo flush emits
the last drag-derived envelope reinterpreted against post-edit line
numbers — the same drift documented below."

### I-v2-2. Endpoint-outside-pane case is missing from §1

§1 step 3 (`docs/file-edits-v3.5.md:82-85`) handles "endpoint is in a
row without `data-work-line` (pure-del row)" via snap-down/snap-up.
It does not handle the strictly more common case where an endpoint
is **outside the pane subtree entirely**: user mousedowns on a row,
drag-extends down past the pane bottom into the chat region (or
header), or vice-versa (drag from chat into pane — anchor outside,
focus inside). Browsers happily report a Range whose
`startContainer` or `endContainer` is anywhere in the document.

§2 line 78 ("Bails early if outside our pane") describes the *whole-
selection*-outside case but not the half-and-half case. The
synchronous inside-pane check from §2 would presumably keep these
events alive (one endpoint is inside the pane), so they reach §1
step 3, which then crashes trying to find an enclosing
`.fe-row[data-work-line]` for the outside endpoint.

Required: spec a rule. Recommend "for each endpoint, if it has no
ancestor `.fe-row[data-work-line]` inside our pane, snap to the
pane's first/last work-line (start endpoint → first, end endpoint →
last)." Mirrors the pure-del snap direction logic.

### I-v2-3. Implementation plan step 10 is editorially confused

`docs/file-edits-v3.5.md:406-414`: "**Remove `pendingSelection` …
Actually keep `pendingSelection` / `scheduleAgentFinalize`** …"
reads as an unresolved draft note. The decision is right (keep —
needed for the agent-push-to-not-yet-mounted-tab path so
`validateSelection`'s clamp step (`script.js:288-291`) sees rendered
rows), but a fresh implementer will think the section is still
under debate.

Rewrite as a single positive statement: "Keep `pendingSelection`
and `scheduleAgentFinalize` (`script.js:351-364`). They are required
for the agent-push-during-tab-open path: `validateSelection`'s
clamp-to-rendered step needs `paneEl` populated, which only happens
after `activate()`. `finalizeAgentSelection` no longer routes
through any pending-vs-immediate branching — it just runs the §5
path once `pendingSelection` is non-null."

This is consistent with the "always paint on `tab.selection`" model:
`pendingSelection` is purely the raw-unvalidated holding area for
deferred validation, not a parallel "selection that hasn't been
applied to UI yet" concept. Step 10 should make that distinction
explicit so a reader doesn't believe there's leftover dead state.

### I-v2-4. Scrollbar-drag triggers `_userDragging`, suppresses agent addRange

`docs/file-edits-v3.5.md:385-387` and §5 step 4 wire `_userDragging`
to **any** `paneEl mousedown`. The scrollbar sits inside
`paneEl` (`script.js:455` already attaches mousedown there), so a
user dragging the scrollbar to scroll the diff sets the flag for
the duration of the scroll-drag. If the agent pushes a selection
during that window, §5 step 4 skips `addRange` even though the user
isn't text-selecting — they're scrolling. Result: copy doesn't work
on the pushed selection until the user re-drags.

Mild degradation, not catastrophic, but it's an asymmetry worth
either fixing (filter mousedown by `e.target` ∈ a text node /
`.fe-line` descendant, not the pane element itself or the
scrollbar pseudo-element) or documenting in §Edge cases as
"acceptable, rare."

## NICE-TO-HAVE

### N-v2-1. §Generalization should enumerate deferred-to-extraction concerns

The "don't extract yet" recipe (`docs/file-edits-v3.5.md:518-528`) is
defensible — single consumer, rule-of-three holds — and the
`SelectionMirrorOptions<T>` shape is plausible. But the
"diff implementations when a second adopter appears" step will be
easier if the spec lists what's *known* missing from the sketched
API today, so the second adopter doesn't accidentally re-discover
each one:

- **Focus management ownership.** Who sets `tabindex="-1"` on the
  pane — the applet or the mirror?
- **Escape / background-click clear gestures.** §4 currently owns
  these in the applet; the sketched API has no hook for them.
  Likely belongs on the mirror as `clearGesture` options.
- **Keyboard extension** (Shift+Arrow to grow the envelope without
  re-dragging). V3.4 didn't have it either, so omitting from V3.5 is
  consistent — but it's a known gap.
- **Accessibility.** The persistent paint after focus-out is not
  exposed via ARIA. Native selection covers AT during the drag
  gesture itself; the line-tint affordance does not. Mention as
  out-of-scope rather than silently omit.

These don't change the V3.5 design, but pre-listing them protects
the future API extraction from being immediately re-litigated.

### N-v2-2. §Edge cases additions

Two cases worth adding to the table for completeness, both implied
by the new selectionchange-driven model but not enumerated:

- **Drag started inside pane, mouse leaves the pane** before
  release. Covered by I-v2-2's proposed snap rule once that's
  resolved.
- **Right-click on existing selection.** Browser shows context menu
  without clearing; no selectionchange fires; `tab.selection`
  untouched. Trivial but worth a one-liner so an implementer
  doesn't add a defensive clear on contextmenu.

### N-v2-3. The collapsed-doesn't-clear divergence from VSCode mental model

`docs/file-edits-v3.5.md:327` already enumerates the "single click
on a row's text leaves the line tint" behavior, so the spec is
honest. But it's the exact tradeoff that traditional code-viewer
users will trip on (in VSCode/most editors, clicking elsewhere
collapses the selection visually and the highlight disappears
entirely). The trade is forced by the headline goal — if collapsed-
selectionchange cleared `tab.selection`, then clicking-back-into-
the-pane-after-focus-out would also clear the line tint, defeating
the persistence claim.

Add one sentence to §Risks calling this out as an explicit
product choice rather than burying it in the table, so a future
reviewer doesn't re-open it as a bug:

> The "collapsed selectionchange does not clear `tab.selection`"
> rule (§1 step 2) is the load-bearing decision that makes line-
> tint persistence work across click-out / click-in round trips.
> The cost is that single-clicking a different position on an
> already-selected row leaves the tint in place, which diverges
> from VSCode-style "click anywhere collapses." Explicit clears go
> through Escape, background-click, or agent push of null.

## What I checked (focus areas)

1. **Prior BLOCKERs survive in new form?** No.
   - B1: option (b) chosen explicitly in §Goal (lines 18-26) and
     materialized in §Mental model layer 3. No focus-in restore
     anywhere. The race the prior review identified can't happen
     because the mechanism is gone.
   - B2: `_expectedEnvelope` value-comparison token at lines 99-105.
     250ms timeout for leak safety. Same pattern as
     `pendingProgrammaticScroll` (`script.js:42-54`). ✅
   - B3: §3 line 138 scopes selector to
     `.fe-row[data-work-line] > .fe-gutter` and explicitly cites
     fold/collapse-row interaction. ✅

2. **§7a render-immediately walk-through.** Mostly consistent.
   selectionchange fires empty → §1 step 2 ignores → `tab.selection`
   preserved. ✅ `_userDragging` stays true until document mouseup
   regardless of intermediate DOM rebuilds. ✅ The browser's drag
   tracking is broken by the detach, so no further mousemove-driven
   selectionchanges fire; the eventual mouseup releases the flag and
   flushes the pending echo. The **one wrong detail** is the
   parenthetical claim that the flush is a no-op (I-v2-1).

3. **§Generalization "don't extract yet."** Defensible. Hooks
   plausible. Missing concerns are deferrable per N-v2-1.

4. **Wire compat / plan ordering.** Wire payload preserved (§Agent
   ↔ applet protocol line 318, matches `script.js:222-231`). Plan
   ordering is sound (CSS+tabindex first, then handlers, then
   integration). Step 10 needs editorial cleanup (I-v2-3) but no
   reordering needed.

5. **New edge cases.** Two missing (I-v2-2 endpoint-outside-pane;
   N-v2-2 drag-leaves-pane and contextmenu). Scrollbar interaction
   is a third (I-v2-4).

6. **"Ignore collapsed selectionchange" safety.** The
   double-click-then-single-click-elsewhere case IS documented at
   line 327. The behavior diverges from VSCode-style code viewers
   but is the forced consequence of the persistence goal. N-v2-3
   recommends surfacing it in §Risks rather than only in the
   edge-case table.

7. **Plan step 10 consistency with always-paint model.** The kept
   complexity (`pendingSelection` + `scheduleAgentFinalize`) is
   load-bearing for one specific path (agent push to a not-yet-
   mounted tab needing `validateSelection`'s clamp). It is NOT
   dead. The editorial confusion in step 10 makes it read like
   dead code. Fix per I-v2-3.

## Spec hygiene

- Self-contained for a fresh agent: yes, with the line-3
  prerequisite pointer.
- No transient state in the spec: ✅
- No ASCII art: ✅
- Open questions section honest about the empty state: ✅
