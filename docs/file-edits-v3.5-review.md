# Review — file-edits V3.5

Reviewer was not the author. Reviewed against
`docs/file-edits-v3.5.md`, `docs/file-edits-v3.4.md` (locked),
`applets/file-edits/script.js` (V3.4 implementation), and
`code-quality.md`. Skipping nits and style.

## BLOCKER

### B1. "Restore on focus-in" is defeated by mouse re-entry

`docs/file-edits-v3.5.md:100-122` (§3) makes "focus returns to the
pane" the trigger for restoring `savedRange`. But the canonical
re-entry gesture is **click back into the pane**, and browsers fire
`mousedown` → `focus` → `mouseup` → `click`. By the time `focusin`
fires and we call `addRange`, the user's `mousedown` has already
started collapsing the selection at the click point; the next
`selectionchange` (from the same mousedown) will immediately
overwrite our restored range.

Net effect: the headline use case in the Goal ("survives clicking
outside the pane … without visual loss" — `docs/file-edits-v3.5.md:10-12`)
silently does not survive the round trip the user actually performs
(click chat → click back into pane). The restore only "works" when
focus returns via keyboard (Tab) or programmatically, which is not
how anyone uses this.

Required: pick one of —
- Restore on `focusout` of the *outgoing* element instead, capturing
  the range while it still exists (the browser only clears the
  visible highlight when focus actually moves; the Range often
  survives in `getSelection()` until the next user gesture — verify
  per browser).
- Or: don't restore on mouse re-entry at all; keep the gutter-only
  persistent indicator as the only "selected" affordance when the
  pane is unfocused, and require an explicit gesture (Esc-to-cancel,
  click gutter to re-select, keyboard re-focus) to bring back the
  Range. This is honest about the constraint.
- Or: on `mousedown` inside the pane, if `getSelection()` is empty
  *and* we have a `savedRange`, suppress the default and synthesize
  the restore, then let a subsequent click extend/replace. This is
  fiddly; spec it out fully if chosen.

The spec must answer this before implementation, because the chosen
answer drives most of §3 and the §Selection-rendering table.

### B2. `_restoringRange` guard relies on undefined timing

`docs/file-edits-v3.5.md:118-122` says set `_restoringRange = true`
before the restore and "clear it on the next microtask". But
`selectionchange` is dispatched asynchronously (as a task, not a
microtask) in Chromium and WebKit — the microtask queue drains
*before* the selectionchange handler runs, so the flag is already
false when the handler fires and the echo loop is not suppressed.

This is the exact mechanism that caused the V3.4-era spurious-scroll
issue resolved by `pendingProgrammaticScroll` value-comparison
(`script.js:42-54`). Same lesson applies: don't gate on a boolean
toggled around an async dispatch; gate on the *value* the writer
just installed and ignore any event whose observed envelope matches
the expected one. Concretely: store an expected
`{startLine,endLine}` token before restore, consume it in the
handler when the observed envelope matches, drop the token after
a short timeout to avoid leaks.

This is independent of B1 and must be fixed regardless.

### B3. Gutter-click handler will fire on fold / collapse rows

Spec §5 (`docs/file-edits-v3.5.md:140-154`) says
"Click on `.fe-gutter` → select that whole line". But fold rows
(`.fe-row-fold`, `script.js:1432-1451`) and collapse rows
(`.fe-row-collapse`, `script.js:1455-1465`) also contain
`.fe-gutter` spans (empty placeholders for grid alignment), and
those rows have no `data-work-line`. A literal `.fe-gutter`
delegated handler will fire on them and either no-op silently, swap
focus away from the fold button, or — worse — race the fold
button's own `click` handler (`script.js:1444-1446`,
`script.js:1474-1481`). The spec needs to scope the gutter handler
to `.fe-row[data-work-line] > .fe-gutter` and explicitly call out
fold/collapse interaction.

Same applies to pure-deletion rows (HEAD-only) which carry a head
gutter but no `data-work-line` (V3.4 §"Pure-deletion / HEAD-only
rows", `docs/file-edits-v3.4.md:247-257`). Selecting them is
explicitly out of scope for V3.4 and V3.5 inherits that, but the
new gutter handler must not silently consume the click either.

## IMPORTANT

### I1. `_userDragging` guard should be required, not optional

`docs/file-edits-v3.5.md:246` (Edge cases) and §Risks make
agent-push-during-drag a "rare, acceptable" overwrite. But the
visible failure mode is the user's drag selection collapsing
mid-gesture as the browser cancels the range when we call
`removeAllRanges()` from `applyAgentState`. The user perceives this
as the applet stealing their cursor while they're dragging. The
mitigation (`mousedown`→set flag, `mouseup`→clear flag, bail
agent-restore while set) is two lines and removes the worst-case UX
failure. Make it required.

### I2. render() must re-apply selection from envelope

`script.js:121-128` (`FileTab.prototype.render`) is called on every
`update()` that detects a content change (`script.js:130-138`,
triggered by every `caco.edit` for that tab). After V3.5's rewrite,
this path needs an explicit hook: re-derive the Range from
`{startLine,endLine}` and either `addRange` (if pane is focused) or
call `paintPersistent` (if not). The spec mentions
`savedRange`-stale-on-rebuild as a Risk
(`docs/file-edits-v3.5.md:255-260`) but does not enumerate the
caller side. Without an explicit step, an in-flight selection on a
hot-edited tab will silently lose its visible affordance after the
next edit, regression vs. V3.4 (which repaints in `render()`).

Add to §Implementation plan: "render() invokes the same restore
path used by focusin, with savedRange forced to null so it always
rebuilds from envelope."

### I3. followEdits semantics for native selection are unspecified

V3.4 explicitly turns `followEdits = false` on `userSelectLine`
(`script.js:330-333`, V3.4 §Interaction with followEdits resolved
to "yes"). V3.5 deletes `userSelectLine` and replaces it with a
`selectionchange` listener — but never says whether that listener
flips `followEdits` off. If it doesn't, the act of selecting text
no longer pauses follow-edits, which is a behavior regression
against an explicitly-resolved V3.4 question. If it does, every
mid-drag selectionchange flips it (or we have to flip only on
"new non-empty selection from empty"). Spec needs an explicit rule.

### I4. Agent push to a non-focused / inactive tab leaves no Range

`docs/file-edits-v3.5.md:132-137` (§4 step 3) says "if pane is
focused, build the Range and addRange; otherwise just paint the
gutter indicator and leave Range application until focus-in."
Combined with B1 (mouse-click re-entry collapses the restore), this
means an agent push targeting an inactive tab is never visible as
a native highlight — only the gutter tint. Plus, the
`tab.selection.savedRange` stays `null`, so the eventual focus-in
path always falls through to the full-line Range branch. Confirm
that's intended and document it; otherwise add a hook in
`FileTab.activate()` that applies the Range on the rAF after the
pane mounts.

### I5. Shift-click-gutter "extend" endpoint is ambiguous

`docs/file-edits-v3.5.md:148-150` says shift-click extends "the
existing selection's endpoint". Native Selection has an anchor and
a focus; "endpoint" is undefined. V3.4 extended from
`tab.selection.start` (always treated as anchor;
`script.js:322-324`). Spec needs to say which one — recommend
"extend from anchor, replace focus" to match browser shift-click
semantics.

### I6. selectionchange listener scope

`docs/file-edits-v3.5.md:60-85` installs the listener on
`document`. On surfaces with multiple applets sharing one document,
every applet's selection inside any pane fires our handler. The
spec's step-2 "if outside our pane, do nothing" is correct but the
rAF coalesce in step 7 should also bail before scheduling, not just
before echoing — otherwise we burn a rAF per global
selectionchange. Trivial fix; call it out so the implementer
doesn't schedule first and decide later.

Also confirm that file-edits applet really shares a document with
other applets on the surface. If it always runs inside its own
iframe, this concern is moot — but state that assumption.

### I7. Cross-Caco-session switch behavior unstated

The prompt called this out. Native `Selection` is per-document; if
the file-edits applet survives a session switch (same document,
new session data), the in-document Range may point at DOM nodes
that no longer exist (rows rebuilt from the new session's edits).
The spec must say either (a) session switch wipes `tab.selection`
and calls `removeAllRanges()` explicitly, or (b) the existing tab
teardown handles it. V3.4 says "Session change with selection.
State resets" (`docs/file-edits-v3.4.md:295-297`) — V3.5 should
quote the same rule and add the `removeAllRanges()` call so the
browser's selection state matches our tab-state reset.

### I8. Spec is not self-contained for a fresh agent

Sections "What stays from V3.4" and "What changes from V3.4" name
symbols (`SOURCE_ID`, `validateSelection`, `scheduleAgentFinalize`,
`pendingOpenIds`, the SOURCE_ID echo loop) without restating
their contract. A fresh agent will need V3.4 open in parallel to
implement V3.5 — which is fine if explicitly stated. Add a
one-line "Prerequisite reading: docs/file-edits-v3.4.md" at the
top, or inline the contract for the four named symbols. Pick one.

## NICE-TO-HAVE

### N1. Divisibility: capture before restore

The change is implementable as one PR, but two checkpoints would
de-risk B1/B2: (1) install selectionchange listener and echo
envelope to agent (drop V3.4's click-to-select machinery in the
same patch — read path only); (2) add savedRange + focusin restore
(write path). Each is independently testable; bug landing in (2)
doesn't regress (1). Worth considering if B1's answer turns out
to require more work than expected.

### N2. paneEl `tabindex="-1"` interaction with focus elsewhere

Tab strip pills are `<button>` (`script.js:75-119`, focusable by
default), Follow-edits is a button, picker has its own input. None
of these compete with `paneEl` for focus; `tabindex="-1"` on the
pane just enables mouse-click focus, which is what we want. No
conflict expected, but the spec should note the existing focusable
elements so an implementer doesn't second-guess.

### N3. Open Q3 "sub-line column info" — leave open

Reasonable to defer. No action needed; flagging only because the
non-goal in §Non-goals already settles this and the open question
re-asks it. Drop Q3 to avoid contradiction.

## Wire compat (asked)

Wire payload `{activeTab, selection:{start,end}, sourceId}` is
preserved (`docs/file-edits-v3.5.md:215-226` and
`script.js:222-231`). V3.4 agent contract is fully intact. ✅

## Goal / use-case / divisibility / self-containment summary

- Goal clearly defined. ✅
- Use cases enumerated; missing the **return-from-chat-via-mouse**
  use case (B1) which is implicit in the goal but not explicitly
  walked through in §Selection lifecycle.
- UX defined for the happy paths; underdefined for the gesture
  collisions (B3, I5).
- Risks comprehensive on flooding/staleness; missing the focus-vs-
  mousedown ordering risk (B1) and the selectionchange dispatch
  timing risk (B2).
- Divisible into 2 steps if B1 grows (N1); otherwise one PR is fine.
- Self-containment: needs an explicit "prerequisite reading"
  pointer (I8).
- No transient state in the spec. ✅
