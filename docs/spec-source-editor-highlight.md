# Spec: Syntax highlighting in the source editor (overlay)

Status: draft. Light. Extends fix A (source edit mode in `applets/files/source-viewer.js`).

## Goals
The source editor (edit mode of `SourceViewer`) is a plain `<textarea>`. Add syntax
highlighting by reusing the SAME hljs path the code view uses (`_renderToPre` →
`hljs.highlightElement`), via a highlighted backdrop behind a transparent textarea — no
CodeMirror, no new dependency.

## Design
In edit mode, stack two pixel-aligned layers inside `.fe-source-content` (already
`position: relative`):
- **Backdrop** = the existing `_preEl` (`<pre class="fe-source"><code class="hljs language-X">`),
  kept VISIBLE in edit mode (today edit hides it), `pointer-events: none`, driven (not
  user-scrolled).
- **Textarea** = `_editEl`, on top, `color: transparent`, `background: transparent`,
  `caret-color: var(--color-text)`, so the user sees the highlighted backdrop through the
  textarea while typing into the real textarea (caret + selection live).

Both layers MUST share identical box metrics or the text drifts. The shared metric block
(applied to `.fe-source` backdrop AND `.fe-source-editor`, plus the inner `<code>`) must lock
ALL of: `font-family`, `font-size`, `line-height`, `font-weight`, `letter-spacing: normal`,
`word-spacing: normal`, `tab-size` (same value on backdrop, `<code>`, AND textarea),
`white-space: pre`, `overflow-wrap: normal`, `word-break: normal`, `padding` (identical),
`border: 0`, `margin: 0`, `box-sizing: border-box`, `text-indent: 0`, and matching
`inset: 0`/width/height. The textarea adds only: `color: transparent`,
`-webkit-text-fill-color: transparent` (WebKit needs this in addition to `color`),
`background: transparent`, `caret-color: var(--color-text)`, `resize: none`, `outline: none`.
Set non-wrapping on the textarea via BOTH `ta.wrap = 'off'` AND `white-space: pre` +
`overflow: auto` (attribute alone is insufficient for alignment).

**Sync (hooks):**
- On textarea `input`: set `_editorText`, then refresh the backdrop from the textarea value
  (`_renderToPre(value)`), coalesced via `requestAnimationFrame` (one re-highlight per frame).
  Skip the render if the text is unchanged from the last backdrop render (cheap guard).
  **`_renderToPre` rebuilds `_preEl`, which resets its scroll to (0,0) — so immediately after
  every rAF render, re-mirror `_preEl.scrollTop/scrollLeft = _editEl.scrollTop/scrollLeft`**
  (otherwise the backdrop snaps to top while typing mid-file). Cancel/ignore a pending rAF if
  mode left 'edit' or the viewer is destroyed.
- On textarea `scroll`: mirror `_preEl.scrollTop = _editEl.scrollTop` and
  `_preEl.scrollLeft = _editEl.scrollLeft`. Also call this sync after `setMode('edit')` and
  after each backdrop refresh (caret-driven scrolling via arrow keys fires `scroll`, but the
  re-render path must re-sync explicitly).
- **Trailing-newline guard (conditional):** when the textarea value ends with `\n`, the final
  empty line has no glyph for the backdrop to give height — append ONE extra `\n` (or a
  sentinel) to the text passed to `_renderToPre` ONLY in that case. Do NOT unconditionally
  append a newline (it would make the backdrop taller than the textarea for normal files).

**Mode transitions:**
- `setMode('edit')`: keep `_preEl` visible as backdrop (don't hide it), show textarea over
  it, seed textarea from `_diskText`, refresh backdrop once, focus.
- `setMode('view')`: hide textarea, re-render `_preEl` from `_diskText` (already done), and
  restore the pre to a normal interactive view — backdrop-only styles (`pointer-events: none`,
  the overlay positioning) MUST be edit-mode-scoped (e.g. a state class on `.fe-source-content`)
  so view mode keeps a selectable, pointer-interactive `<pre>`. Cancel any pending input rAF.
- `save()`/disk-changed: unchanged; on save the backdrop already reflects the edited text.

## Considerations
- **Alignment is the whole risk.** A single mismatched padding/line-height/tab-size pixel
  drifts caret vs. token. Lock both layers to one CSS rule set; the textarea adds only
  transparency + caret. Verify visually with indented code (tabs AND spaces) and a long
  line (horizontal scroll).
- **Perf:** rAF-coalesced re-highlight; hljs on a multi-KB file per frame is fine for
  "basic." No incremental tokenization needed (that's CodeMirror's job — out of scope).
- **Reuse, not fork:** highlighting goes through the existing `_renderToPre` (same
  `detectLang` + `hljs.highlightElement` as the read-only view), so language coverage and
  theme match the code view exactly. No new hljs calls.
- **Markdown editor** keeps its plain textarea (raw markdown highlighting is low value;
  out of scope). Only `SourceViewer`'s editor gets the backdrop.
- **read-only** files never enter edit mode, so no overlay there.

## Acceptance
- Visual signoff (UI): open a `.ts`/`.cpp`, Edit → typing shows live-highlighted code; caret
  and selection track the tokens; tabs/spaces and long lines stay aligned; horizontal +
  vertical scroll keep backdrop and textarea locked; Save writes; toggle to View matches.
- Gate green (`npm run build`).
- No oracle (pure-visual); rely on gate + signoff.

## Plan
1. `source-viewer.js`: in `setMode`, stop hiding `_preEl` in edit mode (use it as backdrop);
   add the `input` rAF-coalesced `_renderToPre(value)` refresh + trailing-newline guard, and
   the `scroll` mirror handler. Ensure view mode restores `_preEl` interactivity.
2. `style.css`: make `.fe-source-content` the positioning context; give the edit-mode
   `_preEl` backdrop + `.fe-source-editor` textarea ONE shared metric block (font, size,
   line-height, padding, white-space: pre, tab-size, border:0); textarea gets transparent
   text/bg + visible caret + `pointer-events` on top; backdrop `pointer-events: none`.
3. `npm run build`; visual signoff; commit with A+B.
