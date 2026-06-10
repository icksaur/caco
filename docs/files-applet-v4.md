# files-applet V4 — finder fidelity

**Status:** spec (not yet implemented)
**Branch:** `files-applet-v4` (to be created)
**Predecessors:** V3.y (`docs/files-applet-v3.y.md`), V3.x (`docs/files-applet-v3.x.md`)
**Roadmap:** `docs/files-applet-roadmap.md`

## 1. Goal

Bring the file-edits picker (Ctrl+P finder, V3.y.2) to feature parity
with the standalone `file-finder` applet on two specific affordances:

1. **Per-type icon** at the left of every picker row.
2. **Copy-path button** on the right of every picker row, revealed on
   row hover, with the same "✓ → 📋" feedback the standalone applet
   already uses.

These are the only V4 items. Autosave, dirty-prompt-on-session-switch,
and the broader visual refresh remain in the roadmap parking lot
(roadmap §13-14, §12) and are explicitly **out of scope** for V4.

## 2. Why now

The Ctrl+P finder is the picker most users will reach for; the
standalone file-finder applet is being de-emphasized (V3.y.1
collapsed its open-file links into file-edits). Anything the
standalone applet does that the picker doesn't is a step backward
for users who shipped V3.y. Parity closes that gap before V3.y's
behavior becomes the new normal.

## 3. Non-goals

- Breadcrumb navigation in the picker.
- Directory rows in the picker.
- Recursive sub-directory traversal beyond what `/api/project-files`
  already returns.
- Loading-state spinners (the picker is fast enough that the eye
  doesn't notice the fetch).
- A "refresh" button.
- Visual restyling of selection / hover / chip colors. V4 reuses
  existing tokens.
- Removing or deprecating the standalone file-finder applet.
  (Discussed for V5; deferred so V4 stays small.)

## 4. Ownership and relationships

The file-edits applet is a single IIFE (`applets/file-edits/script.js`).
V4 adds two new helpers inside that IIFE, alongside the existing
V3.y.2 picker helpers (`_loadRecentFiles`, `_pushRecentFile`,
`_fuzzyScore`, `_parseTypeFilter`).

- The IIFE owns the picker shell — `openPicker`, `closePicker`,
  `runPickerFetch`, `renderPickerList` — and the recent-files
  store. V4 does not change these ownership boundaries.
- New helper `_pickerIconFor(rel)` is a pure function. It owns
  the picker's icon mapping. The standalone `file-finder` applet
  retains its own copy of the same map; the duplication is
  deliberate at V4 (see §6.1) and is tracked in the roadmap as
  a V5+ consolidation item.
- New helper `_pickerCopyPath(absPath, btn)` owns the clipboard
  write, the button label toggle (📋 → ✓ or ✗), the
  `copied` class on the enclosing row, and the 800 ms restore
  timer. It also owns the `dataset.busy` flag that prevents
  concurrent clicks racing the restore timer (§6.7).
- `renderPickerList` owns row layout. It calls `_pickerIconFor`
  once per row and inserts an icon span + a copy-button span
  around the existing `.fe-picker-path` (and optional
  `.fe-picker-suffix`). It already owns the recent / results
  section structure from V3.y.2.
- The existing delegated `pickerList` `mousedown` handler owns
  routing clicks to the right action. V4 extends it with a
  copy-button branch checked **before** the row-selection
  branch, so a click on the copy button does not also advance
  selection or close the picker. The handler does not install
  new per-row listeners.
- `_pickerCopyPath` reads the absolute path from the button's
  `dataset.path`, which is populated at render time (results
  rows use `absPathOf(rel)`; recent rows store absolutes
  already). It does not mutate `pickerSelectedIdx` or the
  `pickerVisible` array.

### 4.1 dataset contract is unchanged

V4 keeps the existing `dataset.flatIdx` contract on
`.fe-picker-item` from V3.y.2 (it is the only routing key
keyboard nav and selection depend on). The new `.fe-picker-copy`
span carries its own `dataset.path` and **does not** carry a
`flatIdx` — copy clicks never participate in flat-index routing.

### 4.2 Directory rows are out of scope

The standalone `file-finder` shows directory rows alongside file
rows and gives both a copy button (`applets/file-finder/script.js:137-202`).
The picker has no directory rows by design (§3 non-goals), so V4
parity covers file rows only.

## 5. Code analysis

### 5.1 File-finder icon mapping (`applets/file-finder/script.js:16-27`)

```javascript
var fileIcons = {
  js: '📜', ts: '📜', jsx: '📜', tsx: '📜',
  json: '📋', md: '📝', txt: '📝',
  html: '🌐', css: '🎨',
  png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️',
  sh: '⚙️', bash: '⚙️'
};
function getIcon(name) {
  var ext = name.split('.').pop().toLowerCase();
  return fileIcons[ext] || '📄';
}
```

V4 ports this verbatim (renamed `_pickerIconFor`) into file-edits.
The map should be a `var` literal in the helper block, not in a
shared module — applet-store concatenates sibling `*.js`, but
the standalone file-finder is a separate applet and does not share
files. Cross-applet refactor is V5+.

### 5.2 File-finder copy logic (`applets/file-finder/script.js:210-227`)

```javascript
results.querySelectorAll('.copy-btn').forEach(function(btn) {
  btn.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    var path = this.getAttribute('data-copy');
    var row = this.closest('.result-item');
    navigator.clipboard.writeText(path).then(function() {
      btn.textContent = '✓';
      row.classList.add('copied');
      status.textContent = 'Copied!';
      setTimeout(function() {
        btn.textContent = '📋';
        row.classList.remove('copied');
        filter(searchInput.value);
      }, 800);
    });
  });
});
```

V4 changes from this:

- No `status.textContent` write — the picker has no status bar.
  Visual feedback is button label + `copied` class only.
- No `filter()` re-call on restore — the picker fetch is async
  and idempotent; a re-render is wasteful and would visually
  flicker. Restoring the button label and class is enough.
- Use event delegation on the existing `pickerList` listener
  rather than per-row `addEventListener` (avoids handler leaks
  on re-render).
- Use `try/catch` around `writeText` — `navigator.clipboard`
  rejects in non-secure contexts (file://, http:// non-localhost).
  Failure flips the button to `✗` for 800 ms instead of `✓`.

### 5.3 Picker `mousedown` delegation (`applets/file-edits/script.js:1884-1892` after V3.y.2 fixes)

Existing handler structure:

```javascript
pickerList.addEventListener('mousedown', function(e) {
  var target = e.target.closest('.fe-picker-item');
  if (!target) return;
  e.preventDefault();
  if (target.classList.contains('disabled')) return;
  var flatIdx = Number(target.dataset.flatIdx);
  var entry = pickerVisible[flatIdx];
  if (entry) pickSelected(entry.rel);
});
```

V4 extension (insert as the **first** check, before
`closest('.fe-picker-item')`, so the disabled-row early-return
does not prevent copy on `(open)` rows):

```javascript
var copyEl = e.target.closest('.fe-picker-copy');
if (copyEl) {
  e.preventDefault();
  e.stopPropagation();
  var absToCopy = copyEl.dataset.path || '';
  void _pickerCopyPath(absToCopy, copyEl);
  return;
}
```

### 5.4 Picker row structure today

Current `.fe-picker-item` (renderPickerList — `script.js:2044`
for the function start, recent rows ~`2066-2090`, results rows
~`2100-2119`):

```html
<li class="fe-picker-item" data-flat-idx="3">
  <span class="fe-picker-path">applets/file-edits/script.js</span>
  <!-- optional: <span class="fe-picker-suffix">(open)</span> -->
</li>
```

V4 structure:

```html
<li class="fe-picker-item" data-flat-idx="3">
  <span class="fe-picker-icon">📜</span>
  <span class="fe-picker-path">applets/file-edits/script.js</span>
  <!-- optional: <span class="fe-picker-suffix">(open)</span> -->
  <span class="fe-picker-copy" data-path="/abs/path/applets/file-edits/script.js" title="Copy absolute path">📋</span>
</li>
```

Recent-files rows (`.fe-picker-recent`) get the same treatment
since they're also `.fe-picker-item`.

### 5.5 `absPathOf` already exists in script.js

`absPathOf(relativePath)` (`script.js:2148-2152`) is the canonical
abs-path helper. `_pickerCopyPath` must receive abs paths so users
can paste them into terminals without prefixing cwd. The
`dataset.path` for live results is `absPathOf(rel)`; for recent
rows, `pickerVisible` already stores the relative path but the
recent-files store keeps absolutes — read from there directly
(POSIX-only, see §6.8).

## 6. Considerations

### 6.1 Duplication with standalone file-finder

The icon map and copy logic exist twice after V4. This is
intentional:

- Applets are independent IIFEs; sharing a JS file across applets
  is not in the current applet-store contract (V3.5 onwards).
- The standalone file-finder is on a deprecation path (V5+
  conversation). Spending V4 budget on a sharing mechanism that
  V5 may delete is wasteful.
- The map is 8 lines. Duplication risk is bounded by the small
  surface area.

A future V5 (or whichever version absorbs/retires the standalone
file-finder) can consolidate. **V4 does not block on this.**

### 6.2 Clipboard API availability

`navigator.clipboard.writeText` requires a secure context (HTTPS
or localhost). Caco runs on `localhost:53000` for the user's main
flow — clipboard works. For self-hosted Caco on a non-secure
remote origin, clipboard silently fails. V4 handles failure with
a transient `✗` indicator (see §5.2); no fallback `document.execCommand`
shim is included.

### 6.3 Mouse-only copy interaction

The copy button is `opacity: 0` until the row is hovered. This is
keyboard-inaccessible by design — keyboard users select the row
with arrows and have other paths (selecting label text, Caco's
own copy tools). Adding a Ctrl+C keyboard binding inside the
picker would conflict with the user's expectation that Ctrl+C in
a text input copies highlighted text. Deferred to V5+ if needed.

### 6.4 Layout shift on hover

`opacity` not `display` — the button reserves its layout space at
all times, so hover does not reflow the row. Also: avoid adding
`margin-left` / `margin-right` on the new icon and copy spans,
because `.fe-picker-item` already declares `gap: var(--space-sm)`
(`style.css:367-376`). Adding margins on top would double-space.
CSS:

```css
.fe-picker-icon {
  flex-shrink: 0;
  font-size: var(--text-md);
}
.fe-picker-copy {
  opacity: 0;
  cursor: pointer;
  flex-shrink: 0;
  padding: 0 4px;
  transition: opacity 0.15s;
  user-select: none;
}
.fe-picker-item:hover .fe-picker-copy { opacity: 0.6; }
.fe-picker-copy:hover { opacity: 1; }
```

### 6.5 `.copied` feedback must not erase `.selected`

The existing `.fe-picker-item.selected` rule sets the row's
background (`style.css:377-380`). A naïve `.fe-picker-item.copied
{ background: ... }` rule at equal specificity later in source
order would temporarily hide the selected affordance during the
800 ms feedback window — which violates acceptance §8.3 ("clicking
copy must not change selection").

Solution: implement `.copied` as an **inset box-shadow** outline,
not a background-color override. Selected background remains
visible underneath:

```css
.fe-picker-item.copied {
  box-shadow: inset 0 0 0 1px var(--color-accent, #6cf);
}
```

The 800 ms restore removes the class; both selection and the
copy outline coexist for the duration.

### 6.6 Disabled `(open)` rows still allow copy

`.fe-picker-item.disabled` sets `opacity: 0.45` and `cursor:
not-allowed` on the whole row (`style.css:381-384`). The mousedown
delegate's copy-branch runs **before** the disabled-row early
return (see §5.3), so the click reaches `_pickerCopyPath` even
on disabled rows. But the inherited row styling makes the copy
button look non-actionable. To match the spec promise that
`(open)` rows allow copy:

```css
.fe-picker-item.disabled .fe-picker-copy {
  opacity: 0.6;
  cursor: pointer;
}
.fe-picker-item.disabled:hover .fe-picker-copy { opacity: 1; }
```

### 6.7 `_pickerCopyPath` busy-state lifecycle

Multiple rapid clicks on the same copy button (or one row's
button while another is still in its restore window) must not
race the 800 ms restore timer and leave the wrong label/class on
the row.

Lifecycle:

1. Entry: if `btn.dataset.busy === '1'`, return immediately.
2. Set `btn.dataset.busy = '1'` **before** calling
   `navigator.clipboard.writeText`.
3. On success or failure, update label and class, then schedule
   a single 800 ms `setTimeout`. Store the timer id on
   `btn.dataset.restoreTimer` (as a string).
4. The timer callback restores the label to 📋, removes the
   `copied` class, deletes `dataset.busy`, and deletes
   `dataset.restoreTimer`.
5. If the row is removed from the DOM during the 800 ms window
   (rare: a new fetch arrives and re-renders), the timer fires
   but its DOM lookups no-op because the `<li>` is gone. No
   cleanup needed beyond the existing closure-scope `btn`
   reference, which the GC will reap.

### 6.8 POSIX-only absolute-path semantics in V4

V4 acceptance assumes the copied text is an absolute path
suitable for paste into a terminal. The applet's existing
`_relativizePath` / `_pushRecentFile` only recognise paths
starting with `/` as already-absolute (`script.js:97-104`,
`1908-1912`). `absPathOf` does have Windows separator handling
(`script.js:2148-2152`), so the path stored in `dataset.path` is
correctly absolute on Linux/macOS but may be wrong on Windows
in the recent-files store specifically (a Windows path
`C:\repo\file` would be misclassified as relative by
`_relativizePath` on the way in).

V4 ships as **POSIX-only** for the copy-path semantics. Windows
support is added when `_isAbsolutePath` is introduced — out of
scope here, listed in §9 risks.

### 6.9 No unit tests in V4 — justification

The IIFE has no existing test harness; introducing one is its
own change. V4 is a small DOM-and-delegation change whose
correctness is observable in a 30-second manual smoke (acceptance
§8 items 1-10). The behavioural risk is concentrated in two
places:

- Copy click must not advance `pickerSelectedIdx` or close the
  picker (§5.3 delegated-handler ordering).
- Restore timer must reliably reset the row (§6.7 busy-state).

Both are covered by acceptance §8.3-8.4 with an explicit
before/after `pickerSelectedIdx` observation in the smoke
script. A small DOM unit harness for the picker is a worthwhile
V5+ investment (filed in the roadmap) but does not block V4.

## 7. Use cases

**UC1.** User presses Ctrl+P, sees a tsx file in recent — the row
shows 📜 instead of 📄.

**UC2.** User mouses over a `.png` row, sees the copy button
appear at the right, clicks it. The button flips to ✓ for 800 ms,
the row highlights briefly, and the absolute path is on their
clipboard. The picker stays open. The selection does not change.

**UC3.** User clicks the copy button on a `(open)`-marked row.
Copy still works; the row remains disabled-for-selection.

**UC4.** Clipboard write rejects (non-secure origin or denied
permission). The button flashes ✗ for 800 ms; the picker keeps
working.

**UC5.** User types `>img`. The filter chip + filtered recent
rows still render their icons (🖼️) correctly.

## 8. Acceptance

1. Every row in the picker (recent + results, with or without
   filter chip) has an icon span on the left.
2. The icon for known extensions matches file-finder's mapping
   exactly. Unknown extensions get 📄.
3. Hovering a row reveals a 📋 button on the right. Clicking it
   does **not** change `pickerSelectedIdx`, does **not** close
   the picker, and does **not** call `pickSelected` / `routeOpen`.
   Smoke verification: select row 3 with arrow keys (visible
   selection ring), click the copy button on row 7, confirm row
   3 still shows the selection ring and the picker is still open.
4. After clicking, the button shows ✓ and the row has a
   `.copied` class for 800 ms, then resets. The selected row's
   selection background remains visible underneath the copy
   feedback (§6.5).
5. The absolute path is on the system clipboard immediately after
   the click resolves.
6. Clipboard failure surfaces as a transient ✗ on the button.
7. `(open)`-marked rows still allow copy (cursor is `pointer`
   on the copy button despite `.disabled` row styling).
8. Keyboard nav (arrow up/down, Enter, Esc, Backspace-on-empty)
   is unchanged.
9. `npm run build` passes (typecheck + lint + tests + pii + vendor).
10. Manual smoke: open picker on master branch with current diff
    staged, copy two different paths, paste into a terminal,
    verify both paste correctly as absolute POSIX paths.
11. Double-click the same copy button (~100 ms apart). No timer
    race: the button still resets to 📋 after exactly one
    800 ms window (§6.7).

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Icon map drift from standalone file-finder | Accept duplication for V4 (§6.1). Consolidate in V5+. |
| Clipboard rejection on non-secure origin | ✗ indicator; do not block picker (§5.2, §6.2). |
| Copy click bubbles to row selection | `e.stopPropagation()` + explicit early-return branch in delegated handler (§5.3, §6.5). |
| Hover reveal causes layout shift | Use `opacity` not `display`; rely on existing `gap`, no margins (§6.4). |
| `.copied` background hides `.selected` background during feedback | Use inset box-shadow for `.copied` instead of background-color (§6.5). |
| Disabled-row styling makes copy button look non-actionable | Override copy-button cursor + opacity inside `.disabled` rows (§6.6). |
| Concurrent copy clicks race the restore timer | Specified `dataset.busy` lifecycle (§6.7). |
| Windows absolute-path detection in recent-files store | V4 ships POSIX-only; Windows fix is a V5+ `_isAbsolutePath` helper (§6.8). |
| Emoji renders inconsistently across OSes | Same emojis as standalone file-finder which has been in production; if it works there it works here. |
| Roadmap drift — old roadmap V4 bucket meant something else | Roadmap moved old V4 items to V5+; new V4 = this spec. Status table updated. |

## 10. Out of scope (V5+ candidates)

- Consolidate icon mapping into a shared module.
- Keyboard copy (Ctrl+C / Y) inside the picker.
- Replace emoji with SVG glyphs.
- Retire standalone file-finder applet.
- Status-bar feedback strip below the input.
