# Code review — `file-edits-v2` spec

Scope: `docs/file-edits-v2.md`. Reviewed against `docs/file-edits.md` (V1 spec),
`docs/file-edits-review.md` (V1 review log), `applets/file-edits/script.js`,
`src/git-edit-poller.ts`, and `code-quality.md`.

Focus: Phase 3 (sticky auto-scroll) proportional to stated risk. Phase 1
self-containedness and fallback handling. Cross-phase correctness.

---

## BLOCKERs

### B1. `programmaticScroll` flag is cleared before the async `scroll` event fires — every programmatic scroll enters Sticky

**Spec:** `docs/file-edits-v2.md` §withAnchor pseudocode (lines 351–365) and
§"Note: a scroll generated programmatically…" (lines 274–276).

**Problem:** The `withAnchor` pseudocode is:

```ts
programmaticScroll = true;
fn();                                // mutate DOM
// ... read afterTop ...
if (afterTop !== null && afterTop !== beforeTop) {
  stream.scrollTop += (afterTop - beforeTop);
}
programmaticScroll = false;          // ← cleared synchronously
```

`stream.scrollTop +=` is a synchronous write, but the `scroll` event it
generates fires asynchronously — after all synchronous code in `withAnchor`
has completed. By the time the scroll event handler runs, `programmaticScroll`
is already `false`. The guard check (`if (programmaticScroll) return`) in the
scroll handler always sees `false` and enters Sticky.

The prose at line 274–276 says "ignore the **next** `scroll` event" — implying
the flag is consumed *inside the handler*, not pre-cleared by the writer. The
pseudocode directly contradicts this intent and encodes a guaranteed bug.

**Evidence from v1:** The same pattern would fire. The `scrollTop = 0` in
`applyEdits` (script.js:315) would immediately transition the applet into
Sticky on every real edit, making Autoscroll unreachable.

**Fix:** Remove `programmaticScroll = false` from the end of `withAnchor`.
Instead, clear it in the scroll handler:

```ts
stream.addEventListener('scroll', () => {
  if (programmaticScroll) { programmaticScroll = false; return; }
  // ... enter Sticky logic ...
});
```

This must be resolved before Phase 3 implementation begins.

---

### B2. Smooth scroll emits many `scroll` events — single-shot flag incompatible; autoscroll locks into Sticky mid-animation

**Spec:** `docs/file-edits-v2.md` line 302: "Always use `behavior: 'smooth'`
for autoscroll moves." Lines 274–276: "ignore the next `scroll` event."

**Problem:** `behavior: 'smooth'` causes the browser to emit a continuous
stream of `scroll` events throughout the animation — not just one. The
single-shot `programmaticScroll` flag suppresses the first event (assuming B1
is fixed and the handler consumes the flag). But every subsequent `scroll`
event during the smooth animation arrives with `programmaticScroll === false`
and executes the "enter Sticky" branch. Result:

1. Autoscroll edit arrives → applet sets `programmaticScroll = true` and
   begins smooth scroll.
2. First scroll event fires → handler clears flag, suppresses.
3. Second scroll event (2–3ms later, animation still in progress) → handler
   sees `false`, enters Sticky.
4. "Follow edits" button reappears while the smooth scroll is still animating.
5. User is now in Sticky watching an incomplete scroll. The applet is
   effectively stuck: autoscroll immediately self-cancels.

This is a design-level conflict. The spec needs to specify how programmatic
smooth scrolls are distinguished from user scrolls throughout the animation
duration. Possible approaches (choose one and document it):

- Track "programmatic scroll in progress" as a persistent flag; clear it only
  on `scrollend` event. (`scrollend` has partial browser support; check
  caniuse and specify a polyfill or fallback.)
- After initiating smooth scroll, poll `scrollTop` in a rAF loop until it
  stabilizes, suppressing Sticky entry throughout.
- Drop `behavior: 'smooth'` for the autoscroll-on-edit path and use instant
  jumps (`scrollTop =`) which produce exactly one `scroll` event.

The spec must decide before Phase 3 implementation begins.

---

### B3. Phase 1 render algorithm not specified — spec is not self-contained for Phase 1

**Spec:** `docs/file-edits-v2.md` §Data path (lines 100–148), §Render (lines
150–165). The `fullFile` payload is fully specified (headLines, workLines,
hunks with headStart/headLen/workStart/workLen). The client-side algorithm that
merges these into the unified row sequence is not.

**Problem:** A fresh implementer knows the data but not the algorithm. Specific
gaps:

1. **Indexing convention:** Are `headStart`/`workStart` 0-indexed or
   1-indexed? Git unified diff `@@ -1,3 +5,2 @@` headers are 1-indexed; the
   spec says "parsed from `git diff -U0` or unified" but doesn't state the
   convention. An off-by-one error here produces systematically wrong line
   numbers on every file, passing visual inspection most of the time.

2. **Merge walk:** The spec names the data (headLines, workLines, hunks) but
   never says: "Walk headLines; for positions between hunks emit unchanged
   rows; inside a hunk emit removed rows from headLines then added rows from
   workLines." This is standard unified diff theory, but there is no pointer
   to a reference and the spec is scoped to "self-contained for a fresh
   agent." Without the walk specified, two implementers will produce
   incompatible orderings for the edge case where a hunk starts on line 1 or
   ends on the last line.

3. **DOM structure per row:** CSS class names for the new view are scattered
   or absent. The spec mentions `fe-d-add`/`fe-d-del`/`fe-d-ctx` (v1 classes,
   repurposed) and `<code class="hljs language-…">` for the token child, but
   never specifies the structure of the gutter: which element wraps the gutter
   column cells, what class the fold row takes, whether the gutter is inside
   or outside the line content element. A consistent DOM structure is required
   for Phase 2 word-mark injection and Phase 3 anchor logic.

**Minimum fix:** Add a "Render algorithm" subsection to Phase 1 that:
- States the indexing convention for hunk fields.
- Describes the two-pointer merge in 5–6 sentences (or pseudocode).
- Specifies the DOM shape for one row (gutter-HEAD cell, gutter-work cell,
  line-content wrapper) with class names.

---

## IMPORTANTs

### I1. `withAnchor` runs "inside a single rAF" per prose but the rAF is absent from the pseudocode

**Spec:** Line 368: "This runs inside a single rAF so layout is read/written
atomically." Pseudocode lines 351–365: no `requestAnimationFrame` anywhere.

**Problem:** An implementer following the pseudocode literally will call
`getBoundingClientRect()` synchronously mid-JavaScript-task. This forces a
synchronous layout recalculation on every anchor-save/restore — potentially
expensive if called on each incoming poll event during rapid edits. It also
means the read and write of layout do not happen in the same animation frame,
making the position delta unreliable under concurrent CSS transitions (e.g.,
the 150ms height transition described at line 413).

The rAF wrapper must appear in the pseudocode:

```ts
function withAnchor(fn) {
  if (state !== 'sticky') { fn(); return; }
  requestAnimationFrame(() => {
    const anchor = pickAnchor(stream);
    const beforeTop = anchor ? anchor.getBoundingClientRect().top : 0;
    fn();
    // ... read afterTop, adjust scrollTop ...
  });
}
```

Note: with a rAF wrapper, `fn()` cannot run synchronously. If any callers
depend on synchronous DOM mutation (e.g., immediately reading card height
after insertion), that dependency must be documented.

---

### I2. Append-at-bottom-in-Sticky is an undecided design documented as settled; Phase 3 cannot start without operator confirmation

**Spec:** Lines 374–387 document "append-at-bottom in Sticky, re-sort on exit"
with specific implementation details (DOM append, re-sort by timestamp). Lines
523–524: "Append-at-bottom-in-Sticky behavior — operator confirm before Phase
3 implementation."

**Problem:** The spec contradicts itself. The design section writes
implementation specifics; the open questions section says the operator hasn't
signed off. If the operator chooses "always prepend (simplest)," the re-sort
machinery, the badge counter definition, and parts of the `withAnchor` reorder
discussion all change materially.

Additionally, the re-sort-on-exit design has a usability problem the spec does
not address: every card that received an in-place update during Sticky has its
timestamp bumped and will therefore move on re-sort. If the user has been in
Sticky for 30 seconds during an active edit session, clicking "Follow edits"
could cause 15–20 cards to shuffle simultaneously while a smooth scroll is
in progress. This is potentially as jarring as the problem the design is trying
to solve. The spec should consider limiting the re-sort to newly-appended
cards only, or document why the full re-sort is acceptable.

**Gate:** Promote open question #5 to a DECISION REQUIRED gate. Phase 3
implementation should not start until the operator has confirmed the
insert-order strategy.

---

### I3. Truncation threshold mismatch between `diff` and `fullFile`

**Spec:** Line 138: `fullFile` skipped for files exceeding "5000 lines."
`src/git-edit-poller.ts:54`: `DIFF_LINE_CAP = 1000` (applies to the `diff`
string field, unchanged in v2 per line 8: "The git poller stays exactly
as-is for V2").

**Problem:** A 2000-line file sends:
- `diff`: truncated at 1000 lines, `truncated.hiddenLines` populated.
- `fullFile`: all 2000 lines present, no truncation.

The `truncated` flag on the payload reflects the `diff` truncation. The card
header's "fallback: hunk view" note (Phase 1 acceptance, line 172) would show
an "↘" indicator referencing hidden lines that are in fact visible in the
full-file view. More subtly: when `fullFile` is absent and the `diff` fallback
is used, the user sees different truncation behavior depending on file size
(1000-line diff cap vs. 5000-line fullFile cap), with no in-spec explanation
of the gap.

**Fix options:**
- Raise `DIFF_LINE_CAP` to match the `fullFile` cap (5000), accepting that
  fallback payloads grow.
- Document in the spec that the `truncated` field refers to the `diff` string
  and should not be shown when `fullFile` is present.
- Harmonize to a single cap and note the change to the existing constant.

---

### I4. Deleted file fallback rationale missing; full-file view is likely better than fallback for deletions

**Spec:** Line 137: "Skip `fullFile` for … deleted (working tree absent)."
Phase 1 acceptance, line 172: "Binary, deleted, and files >5000 lines fall
back to v1 hunk view."

**Problem:** A deleted file has a HEAD blob and no working-tree file.
`workLines` would be `[]`; `headLines` would be the full HEAD content. A
full-file view of a deletion shows all HEAD lines colored red — arguably the
most informative possible view (the user sees exactly what was removed, in
context, with syntax highlighting). The v1 hunk fallback shows the same
information but stripped of the full-file context that Phase 1 is explicitly
designed to add.

The spec does not explain the design rationale for falling back on deletions.
If the intent is "working tree absent makes the data model degenerate," that
reasoning should be stated. If it's "simplify Phase 1," that's fine but say
so. As written, an implementer will reasonably wonder whether deleted files
were intentionally excluded or accidentally omitted.

---

### I5. Phase 2 DOM walk across nested hljs spans — split algorithm not specified, non-trivial to implement correctly

**Spec:** Lines 207–212: approach (a): "Highlight first → walk the resulting
DOM and inject `<mark>` spans, taking care to split text nodes at token
boundaries while preserving the parent hljs spans." Line 218: "walking it with
a text-offset cursor and splitting at word boundaries is well-understood."

**Problem:** hljs produces nested spans. A realistic example for TypeScript:

```html
<span class="hljs-comment">
  /* <span class="hljs-doctag">@param</span> name — the <strong>old</strong> value */
</span>
```

When a word-diff boundary falls in the middle of a text node inside a nested
span, "split at the boundary and preserve parent spans" requires:
1. Split the text node at the offset.
2. Wrap the second fragment in a clone of the *immediate* parent span (same
   class).
3. If the immediate parent is itself mid-element (the split falls inside a
   span that also contains content before the split point), clone all
   ancestors from that span up to the line container.

Getting step 3 wrong produces a span that extends past its original token
(classes bleed across words), or empty `<mark>` elements that break layout.
The spec calls this "well-understood" but Phase 2's acceptance criteria
(lines 228–234) do not include a test case for a change that falls inside a
nested hljs span. This is a specific, high-probability bug site.

**Fix:** Add one acceptance criterion: "A word change that falls inside a
nested hljs token (e.g., a renamed identifier inside a comment) produces
correct `<mark>` wrapping with no orphaned or empty spans." Add a note to the
algorithm section that the walk must clone the ancestor span stack at split
points.

---

### I6. v1 no-op poll check does not cover `fullFile` — silent render suppression possible in v2

**Spec:** No mention of updating the no-op check.
**Code:** `applets/file-edits/script.js:289–296`: the no-op guard compares
`prev.diff === edit.diff && prev.status === edit.status &&
prev.renamedFrom === edit.renamedFrom && prev.isBinary === edit.isBinary`.

**Problem:** In v2, `fullFile` is the canonical source of truth for what the
card renders. The `diff` field is described as "kept for fallback" (line 114).
If the server sends a new `fullFile` (e.g., after a fix to the hunk parser)
but the raw `diff` string happens to be byte-identical, the no-op guard skips
the re-render silently. The user sees stale full-file content with no
indication anything changed.

More practically: during Phase 1 development, the server-side hunk parser may
go through several iterations. Each iteration could change `fullFile` without
touching `diff`. The no-op check will mask these changes in a running applet.

**Fix:** Extend the no-op check to include `fullFile` content, or document
explicitly that the `diff` field equality is sufficient because any change to
`fullFile` necessarily implies a change to `diff`.

---

## NICEs

### N1. "N changed regions" is not defined

**Spec:** Line 78: "Add a small 'viewing N changed regions' indicator next to
the path."

"Changed region" is not defined. Is it the count of entries in `fullFile.hunks`?
Adjacent groups of add+delete lines (which could merge multiple hunks)? One-off
contextual hunks collapsed differently? Without a definition the acceptance
criterion at line 168 ("the 3 changes are visible without scrolling") is not
verifiable by inspection. One sentence of definition suffices.

---

### N2. Fold rows: re-collapse behavior not specified

**Spec:** Lines 161–164: "Folds for unchanged runs: a single clickable row …
rendering on click replaces the row with the collapsed lines."

The spec says a fold row expands on click but does not say whether the
expanded lines can be re-collapsed. For a 3000-line file with many fold regions,
a user may expand one fold to read context and want to collapse it again. The
omission will produce inconsistent implementations. One sentence to clarify
(e.g., "Expanded folds show a 'collapse' affordance; clicking it re-folds.") is
all that's needed.

---

### N3. `pickAnchor` edge case — all cards above viewport

**Spec:** `withAnchor` pseudocode line 354: `pickAnchor(stream)` —
"first card whose top >= scrollTop."

If the user has scrolled far enough that every card is above the viewport
(scrollTop > last card's offsetTop + height), `pickAnchor` returns null.
The pseudocode handles this: `beforeTop = 0`, `afterTop = null`, no adjustment.
But content inserted above a fully-scrolled-past stream will still displace
the viewport. The correct fallback is to pick the last card in the DOM (the
lowest visible boundary) or to document that this case is acceptable (the
stream has no visible content to protect). Either way, document the decision.

---

## QUESTIONs

### QUESTION 1. "Follow edits" badge count — what is one "edit"?

**Spec:** Lines 446–448: "If new edits arrived while in Sticky, add a count
badge: `↓ 3 new edits`. Counter resets on click."

What increments the counter? Options:
- Each `caco.edit` WebSocket event (event-level granularity).
- Each changed-file entry within an event (file-level granularity).
- Only new cards (files not previously shown); updates to existing cards
  don't count.

If 10 consecutive polls each update the same file, the badge shows "10 new
edits" vs. "1 new edit" depending on the choice. The correct answer shapes
the implementation significantly and the spec does not decide.

---

### QUESTION 2. Untracked files missing from Phase 1 acceptance criteria

**Spec:** Phase 1 acceptance, lines 168–175. `fullFile` schema line 117:
`headLines: string[] | null` ("null for untracked").

Untracked files render differently from modified files: no HEAD column numbers,
all lines green, no removed lines possible. The Phase 1 acceptance criteria
do not include a test case for untracked files. Given that the headLines=null
path requires distinct rendering logic, should acceptance explicitly require:
"An untracked file renders with all lines green, HEAD gutter column blank
throughout, and no removed lines."?

---

### QUESTION 3. hljs lazy-load failure — graceful degradation path?

**Spec:** Lines 96–98: "Lazy-load via a separate bundle the applet pulls on
first card render."

If the hljs bundle fails to load (network error, CSP restriction), what
happens? The spec doesn't say. Acceptable options are: render without
highlighting (no error, just plain text with diff colors) or show a small
"syntax highlighting unavailable" note in the header. Either is fine, but the
behavior should be specified so the implementation doesn't have an
unhandled-rejection path.

---

## Verdict

**3 BLOCKERs, 6 IMPORTANTs.** Do not begin Phase 3 implementation until
B1, B2, and the Phase 3 design gate (I2) are resolved. Phase 1 implementation
requires B3 (render algorithm) to be addressed first. B1 and B2 are both
bugs in the spec's own pseudocode, not in the overall design; they are
surgical fixes. B3 requires a new "Render algorithm" subsection of modest
size. I1–I6 should be addressed before each phase's implementation, not
deferred to review.
