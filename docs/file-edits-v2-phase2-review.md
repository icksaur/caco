# File Edits V2 Phase 2 Review

Review of Phase 2 implementation (word-level intra-line diff) comparing
84e3939 against ca8f33a.

Focus areas: Myers diff correctness, TreeWalker mark injection, pairing
logic, hasEqual heuristic, CSS interaction.

---

## [QUESTION] Adjacent ranges produce multiple <mark> elements

**File:** applets/file-edits/script.js:435-446

**Observation:** When two ranges are adjacent (e.g., [0, 5) and [5, 10)),
the code produces:
- `<mark class="fe-w-{kind}">frag1</mark>`
- `<mark class="fe-w-{kind}">frag2</mark>`

Both marks have the same class. Visually, they will appear as one contiguous
highlight due to adjacent backgrounds. Semantically, they are separate
elements, but this has no functional impact. The DOM is slightly less
compact than if the code detected adjacent same-class ranges and merged
them, but this is not a bug—it's a trade-off for simpler logic.

**Conclusion:** Not a bug. Expected behavior. No action needed.

---

## [QUESTION] Pairing logic assumes adjacent del/add runs

**File:** applets/file-edits/script.js:349-376

**Observation:** The pairing logic collects a run of `del` rows, then
immediately collects the following run of `add` rows. If there's a `ctx`
row between the dels and adds, the dels are collected, then the adds loop
starts but finds a `ctx`, so `adds.length === 0`, and no pairing occurs.

Per the spec (Phase 2), "Group consecutive `-`/`+` lines into change blocks."
The word "consecutive" implies no intervening context lines. Git's diff
output should never produce `del, ctx, add` in a single hunk—context lines
separate hunks.

**Conclusion:** The logic is correct per the spec. The assumption holds for
well-formed git diff output. No bug.

---

## [QUESTION] hasEqual heuristic: pathological inputs

**File:** applets/file-edits/script.js:334-341

**Observation:** The `hasEqual` heuristic skips word marks if the two lines
share no non-whitespace tokens. This handles the case where two unrelated
lines are paired (e.g., a deleted comment followed by an added function
call). Edge cases considered:

- Two lines of only punctuation: `";;;"` vs `":::"` → no equal tokens, so
  no word marks. The whole line stays solid-colored. This is correct (they
  are completely different).
- Two lines of only numbers: `"123 456"` vs `"789 012"` → no equal tokens.
  Correct (unrelated numbers).
- Two lines with shared punctuation: `"a + b"` vs `"a - b"` → tokens are
  `['a', ' ', '+', ' ', 'b']` vs `['a', ' ', '-', ' ', 'b']`. The 'equal'
  ops include `'a'` and `'b'`, which pass `/\S/.test()`, so `hasEqual` is
  true. Word marks would highlight the changed `+`/`-`. This is correct.

**Conclusion:** The heuristic works correctly for expected inputs. Edge cases
(all punctuation, all numbers) fall back to line-level coloring, which is
the correct UX.

---

## [QUESTION] CSS color inheritance with hljs tokens

**File:** applets/file-edits/style.css:242-253

**Observation:** The `mark.fe-w-add` and `mark.fe-w-del` styles set
`color: inherit`. This means the mark inherits the text color from its
parent or ancestor.

If the mark is inside an `<span class="hljs-keyword">` (which has its own
`color`), `inherit` copies the computed color from the immediate parent
(the hljs span), so the mark inherits the hljs color. The syntax
highlighting color shows through correctly.

If the mark is a direct child of the `<code>` element (not inside any hljs
span), it inherits from `<code>`, which inherits from the row, which has
the default text color. Also correct.

**Conclusion:** The CSS is correct. `color: inherit` preserves syntax
highlighting colors inside marks.

---

## [QUESTION] CSS background layering: mark over row

**File:** applets/file-edits/style.css:242-253

**Observation:** The mark background uses `color-mix(in oklab, var(--color-success-bright) 50%, transparent)`
for adds and `var(--color-error) 50%` for dels. These are semi-transparent.
The row background is also semi-transparent (Phase 1: `18%` opacity).

The row has a light green tint (18% opacity). The mark has a darker green
at 50% opacity, layered on top. The final color is the mark's background
composited over the row's background. Since both are green, the mark appears
as a darker green highlight within the lighter green row. This is the
intended design per the spec: "darker, fully-saturated highlight so the
changed tokens read distinctly."

**Conclusion:** The layering is correct and produces the desired visual effect.

---

## Summary

**Blockers:** 0  
**Important:** 0  
**Questions:** 5 (all observations, no action needed)

**Verification completed:**
- **Myers diff correctness:** Tested edge cases (n=0, m=0, n=m=0, identical
  inputs, common prefix/suffix, single-token replacements). All produce
  correct minimal edit scripts. No off-by-one errors in V array indexing or
  backtracking. Coalescing pass preserves token ordering.

- **TreeWalker mark injection:** Correctly enforces half-open interval
  semantics. Zero-length fragments are skipped. Nested hljs spans are
  preserved—marks wrap text fragments without re-parenting ancestor spans.
  Text node removal timing is safe (anchor captured before removal). Adjacent
  ranges produce multiple `<mark>` elements (acceptable trade-off for simpler
  logic).

- **Pairing logic:** Correctly groups adjacent del/add runs into blocks.
  Pairs lines in order up to min(N,M). Unpaired excess lines remain
  solid-colored (no mark entries). Context rows prevent pairing across
  separate hunks (correct per spec).

- **hasEqual heuristic:** Correctly detects totally-rewritten line pairs
  (no shared non-whitespace tokens) and skips word marks, leaving line-level
  coloring. Pathological inputs (all-punctuation, all-numbers) fall back
  correctly.

- **CSS interaction:** `color: inherit` on marks preserves syntax highlighting
  token colors from parent hljs spans. Background layering (50% mark opacity
  over 18% row opacity) produces the intended "darker highlight on lighter
  base" visual effect.

**Recommendation:** Phase 2 implementation is correct. No bugs found.
Approved for merge.
