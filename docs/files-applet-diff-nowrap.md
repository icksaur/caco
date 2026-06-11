# Files applet — diff line layout: no-wrap + horizontal scroll

## Status

Proposed. Amends `file-edits-v2.md` §"DOM structure per row" and
§"Phase 1 acceptance", which defined the full-file grid renderer but
left long-line behavior unspecified.

## Problem

The full-file diff renderer (`.fe-diff[data-mode="fullfile"]`) is a CSS
grid (`grid-template-columns: auto auto 1fr`) where each line is a
`.fe-row` with `display: contents`; its three children (head gutter,
work gutter, `<code class="fe-line">`) become direct grid items.

`file-edits-v2.md` specified the column structure and that "column
alignment is stable", but **never specified what happens to a line that
is wider than the pane**. The implementation defaulted to:

```css
.fe-diff[data-mode="fullfile"] .fe-line {
  white-space: pre-wrap;
  word-break: break-word;
}
```

i.e. long lines **wrap inside the `1fr` code cell**. Consequences:

- Every wrapped line gets a **variable, multi-line grid track height**.
  Row heights are no longer uniform.
- With a fractional line box (`font-size: --text-base` × `line-height:
  1.5`), wrapped/odd rows round inconsistently, so glyph descenders
  clip and a wheel tick can leave a row partially cut off at the
  top/bottom edge ("each line looks individually scrollable / cropped").
- Wrapping at the pane's width makes the rendered output reflow on
  every pane resize and looks messy for code.

This is the under-specified behavior the change addresses.

## Desired behavior

Match VS Code / GitHub default diff behavior:

- **Lines do not wrap.** Each row is exactly one text line tall.
- **Long lines scroll horizontally.** The whole grid scrolls
  horizontally inside `.fe-diff` (which already has `overflow-x: auto`).
- **Gutters stay visible** during horizontal scroll: pin the two
  gutter columns to the left with `position: sticky; left: 0`.

Single-line rows give uniform row heights, which also removes the
sub-pixel cropping/jitter as a side effect (each row's track is one
line box, not a wrapped multiple).

## CSS changes (`applets/files/style.css`)

1. **No wrap on the line:**
   ```css
   .fe-diff[data-mode="fullfile"] .fe-line {
     white-space: pre;          /* was: pre-wrap */
     /* drop: word-break: break-word; */
   }
   ```

2. **Let the code column grow past the viewport** so `overflow-x`
   actually engages (a `1fr` track is capped at container width and
   would clip instead of scroll):
   ```css
   .fe-diff[data-mode="fullfile"] {
     grid-template-columns: auto auto max-content;   /* was: auto auto 1fr */
   }
   ```
   In a grid, a `max-content` track sizes to the widest line and **all**
   code cells take that width — so row tints (add/del/selected) span the
   full scroll width uniformly with no ragged right edge. This is an
   improvement over the `1fr` + wrap behavior.

   The `data-clean-only` variant changes the same way:
   ```css
   .fe-diff[data-mode="fullfile"][data-clean-only="true"] {
     grid-template-columns: auto max-content;        /* was: auto 1fr */
   }
   ```

3. **Pin gutters during horizontal scroll.** Gutters are grid items;
   `position: sticky` works in grid. They need an opaque base
   background so code doesn't show through when scrolled under them:
   ```css
   .fe-diff[data-mode="fullfile"] .fe-gutter {
     position: sticky;
     left: 0;
     z-index: 1;
     background: var(--bg-base);   /* base; add/del/selected tints override */
   }
   .fe-diff[data-mode="fullfile"] .fe-gutter-work { left: <head-gutter-width>; }
   ```
   The work gutter must offset by the head gutter's width so the two
   sticky columns don't overlap. Head gutter width is `auto`
   (content-sized). Options, in preference order:
   - **A (preferred):** give both gutters a fixed `width`/`min-width`
     (e.g. `width: 5ch`) so the work gutter's `left` is a known
     constant. This also fixes the spec's stated-but-unimplemented
     "gutters are fixed-width" claim and stops gutter width shifting
     between renders.
   - B: keep `auto` and set work-gutter `left` via a measured CSS var
     updated on render (more JS, more brittle — avoid).

   Existing add/del/selected gutter backgrounds already set a background
   and will layer over the sticky base correctly (they're more specific).

## Interactions to preserve

- **`measureDiffRow()` / scroll logic:** unchanged. It still measures
  the `.fe-gutter` child; sticky positioning does not change the
  gutter's `getBoundingClientRect().top` used for vertical scroll math.
  (Sticky only affects horizontal offset, and the helper is used for
  vertical follow-edits.)
- **Selection paint (`.fe-row-selected`):** still per-row class toggle.
  With `max-content` the selected `.fe-line` background now spans the
  full row width — desired.
- **Word marks (`<mark class="fe-w-*">`) and hljs spans:** inline
  children of `.fe-line`; `white-space: pre` is inherited and does not
  change their flow. No change needed.
- **Fold / collapse rows:** `.fe-fold-btn` uses `grid-column: 1 / -1;
  width: 100%`. With a `max-content` code column the button spans the
  full (possibly wider-than-viewport) width — acceptable; the separator
  reaches across the scroll region. Gutters on fold rows are
  `display: none`, so the sticky rule does not apply to them.
- **Markdown viewer width fix (just landed):** independent; this change
  is scoped to `[data-mode="fullfile"]` only.

## Out of scope

- The broader `display: contents` → real-row-box / subgrid refactor
  (separate proposal). This change deliberately keeps the existing DOM
  and only adjusts line-wrap + column sizing + gutter pinning.
- Virtualization.

## Acceptance

- A file with lines longer than the pane shows a **horizontal**
  scrollbar; no line wraps; row heights are uniform.
- Horizontally scrolling keeps both line-number gutters fixed at the
  left, fully opaque, with code scrolling beneath them.
- Add/del/selected row tints span the full horizontal extent with no
  ragged right edge.
- Vertical follow-edits / scroll-to-first-diff still lands on the
  correct row (no regression in `measureDiffRow` consumers).
- Word-level marks and syntax highlighting render unchanged.
- `data-clean-only` (all-unchanged) files render with a single
  line-number column and the same no-wrap horizontal-scroll behavior.

## Review revisions (incorporated — supersede the CSS above)

Background review (2026-06-11) found two P0 regressions in the naïve
approach and confirmed a **CSS-only** fix (no DOM wrapper needed). The
final implementation is:

### R1 — code column: `minmax(max-content, 1fr)`, not `max-content`

`max-content` alone leaves dead space (no row tint) to the right of the
widest line on any file whose lines are all shorter than the pane —
i.e. most files. `1fr` alone clips/:doesn't-scroll for long lines and
leaves the overflow region untinted. `minmax(max-content, 1fr)` does
both correctly because `.fe-diff` is itself the scroll container:

```css
.fe-diff[data-mode="fullfile"] {
  grid-template-columns: var(--fe-gutter-w) var(--fe-gutter-w) minmax(max-content, 1fr);
}
.fe-diff[data-mode="fullfile"][data-clean-only="true"] {
  grid-template-columns: var(--fe-gutter-w) minmax(max-content, 1fr);
}
```

- Lines shorter than pane → `1fr` max wins, track fills the viewport,
  row tints span full width (no dead space).
- Lines longer than pane → `max-content` min wins, track = widest line,
  grid overflows → horizontal scroll; every code cell is the column
  width (widest line) so tints span the full scroll width with no
  ragged edge.

No inner grid wrapper and no `renderBody` change required.

### R2 — fixed-width gutter columns via `--fe-gutter-w`

Sticky gutters need a deterministic `left` offset for the second
column. Use explicit fixed columns (also satisfies v2's stated-but-
unimplemented "fixed-width gutters"):

```css
.fe-diff[data-mode="fullfile"] { --fe-gutter-w: 3.5rem; }   /* fits 4-digit line #s at --text-xs; renderer caps files at 5000 lines */
.fe-diff[data-mode="fullfile"] .fe-gutter {
  position: sticky;
  z-index: 1;
  background: var(--bg-base);
}
.fe-diff[data-mode="fullfile"] .fe-gutter-head { left: 0; }
.fe-diff[data-mode="fullfile"] .fe-gutter-work { left: var(--fe-gutter-w); }
.fe-diff[data-mode="fullfile"][data-clean-only="true"] .fe-gutter-work { left: 0; }
```

### R3 — gutter tints must be opaque (P0 #1)

Existing add/del/selected backgrounds use `color-mix(…, transparent)`.
On a sticky gutter that is semi-transparent, code scrolls visibly
underneath. Split the combined `.fe-line, .fe-gutter` tint rules: keep
the `.fe-line` mix transparent (lines don't stick), but composite the
`.fe-gutter` mix over the base so it is fully opaque:

```css
/* gutter variants only — mix over --bg-base instead of transparent */
.fe-diff[data-mode="fullfile"] .fe-row-add .fe-gutter {
  background: color-mix(in oklab, var(--color-success-bright) 18%, var(--bg-base));
}
.fe-diff[data-mode="fullfile"] .fe-row-del .fe-gutter {
  background: color-mix(in oklab, var(--color-error) 18%, var(--bg-base));
}
.fe-diff[data-mode="fullfile"] .fe-row.fe-row-selected .fe-gutter {
  background: color-mix(in oklab, var(--color-accent) 40%, var(--bg-base));
  color: var(--color-text-bright);
}
```
The `.fe-line` add/del/selected rules are unchanged (stay transparent
so hljs token colors and row layering still read).

### R4 — accepted minor / notes

- **Fold/collapse button** (`grid-column: 1 / -1; width: 100%`): with
  the `minmax(max-content, 1fr)` grid it spans the full grid width
  (≥ viewport). Its left-aligned label scrolls left with content on
  horizontal scroll — accepted minor, matches typical diff viewers.
- **`measureDiffRow()`**: only `.top` is consumed (vertical scroll
  math), which sticky horizontal positioning does not affect — no
  regression. Add a doc comment noting `.left`/`.width` now reflect the
  sticky-pinned position for any future consumer.
- **`max-content` perf**: bounded by the 5000-line render cap; one
  layout pass. Pathological single long line (minified/base64) widens
  the grid but stays scrollable; no clamp added (documented residual).

## Spec amendment

Add to `file-edits-v2.md` §"DOM structure per row":

> **Long-line behavior.** Lines do not wrap. `.fe-line` uses
> `white-space: pre`; lines wider than the pane scroll horizontally
> within `.fe-diff`. The two gutter columns are fixed-width and pinned
> (`position: sticky; left`) so line numbers remain visible during
> horizontal scroll. This matches VS Code / GitHub diff behavior and
> keeps every row exactly one line tall.
