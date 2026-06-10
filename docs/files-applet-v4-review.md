# files-applet V4 spec/plan review

Reviewed:

- `docs/files-applet-v4.md`
- `plan.md`
- `docs/files-applet-roadmap.md`
- `applets/file-finder/script.js` lines 1-230
- `applets/file-edits/script.js` lines 1836-2100, plus nearby helpers needed to verify references
- `applets/file-edits/style.css` lines 332-400
- `code-quality.md` at the repository root
- `~/.copilot/skills/code-review/code-quality.md`

Note: the requested `doc/code-quality.md` path does not exist in this checkout. The repository has `code-quality.md` at the root, and its contents match the code-review skill's guide.

## BLOCKER

### BLOCKER — V4 scope conflicts with the roadmap

`docs/files-applet-roadmap.md` still defines V4 as a different bucket: slug rename, standalone applet deprecation, global shortcuts, visual refresh, autosave, and dirty-prompt work (`docs/files-applet-roadmap.md:106-134`). Its status table says V4 is not started and the spec is "to be written" (`docs/files-applet-roadmap.md:20`).

The new V4 spec defines V4 as only picker icon + copy-button parity (`docs/files-applet-v4.md:8-20`), and the plan's merge step says to update the roadmap by simply marking V4 shipped (`plan.md:146-149`). That would mark the wrong roadmap scope as shipped and corrupt the version history.

Suggested fix: before implementation, either rename this work to a version that does not collide with the roadmap bucket, or update the roadmap's V4 bucket so the status table and V4 scope match the new finder-fidelity spec. The plan should include the exact roadmap edit, not just "V4 → shipped".

## IMPORTANT

### IMPORTANT — The spec contains an ASCII ownership diagram despite the stated preference

`docs/files-applet-v4.md:45-56` uses a fenced ASCII tree for ownership/relationships. The surrounding prose is useful, but the explicit review requirement and personal preference say specs should describe ownership, relationships, and class design in prose without diagrams.

Suggested fix: replace the tree with prose bullets. Keep the same facts: the file-edits IIFE owns picker shell, recent-files store, `_pickerIconFor`, `_pickerCopyPath`; `renderPickerList` composes the row; the delegated `pickerList` mousedown handler invokes copy behavior.

### IMPORTANT — Code-quality review path is wrong in the plan

`plan.md:141-144` tells the implementer to dispatch a code-review agent referencing `doc/code-quality.md`, but that path does not exist. The repository guide is `code-quality.md` at the repo root.

Suggested fix: change the plan's review instruction to reference `code-quality.md` or create/move the guide intentionally before implementation. Otherwise Sonnet will either fail the file lookup or silently review against the wrong/incomplete guidance.

### IMPORTANT — Recent-file path guarantees are POSIX-only, but the spec states them as absolute-path guarantees

The spec and plan correctly observe that the recent-files store is intended to hold absolute paths: `_pushRecentFile` converts non-absolute inputs with `absPathOf` and stores the result (`applets/file-edits/script.js:1908-1918`), and `renderPickerList` reads `rp` directly from `_loadRecentFiles()` (`script.js:2069-2088`).

However, the implementation only treats paths starting with `/` as already absolute (`_relativizePath` at `script.js:97-104`, `_pushRecentFile` at `script.js:1908-1912`). Windows absolute paths such as `C:\repo\file.ts` are treated as relative and can be stored/copied as `cachedCwd + sep + C:\repo\file.ts`. `absPathOf` has Windows separator logic (`script.js:2148-2152`), so the applet is at least partly cross-platform-aware.

Suggested fix: either state that V4 acceptance is POSIX-only, or add a small `_isAbsolutePath` helper used by `_relativizePath` and `_pushRecentFile` before relying on "absolute path" copy semantics. Add this to the risk table if deferred.

### IMPORTANT — `.copied` styling can visually erase the selected-row state

The proposed CSS appends `.fe-picker-item.copied { background: var(--color-surface-3, #333); }` after the existing `.fe-picker-item.selected` rule (`style.css:367-380`). Equal specificity plus later source order means a copied selected row will no longer show the selected accent while the copy feedback is active.

Acceptance says clicking copy must not change selection or advance `pickerSelectedIdx` (`docs/files-applet-v4.md:310-314`). The class may remain unchanged, but the visual selection affordance will be temporarily replaced by the copied background.

Suggested fix: specify the intended interaction explicitly. For example, use an outline/inset shadow for `.copied` instead of replacing `background`, or add a `.fe-picker-item.selected.copied` rule that preserves the selected background while still showing feedback.

### IMPORTANT — Disabled `(open)` rows need explicit copy affordance styling

V4 requires `(open)` rows to allow copy but not selection (`docs/files-applet-v4.md:294-295`, `docs/files-applet-v4.md:318`). The event order in the plan supports this because the copy branch runs before the disabled-row branch (`plan.md:59-74`).

The CSS plan does not address the existing disabled-row styling: `.fe-picker-item.disabled` sets `opacity: 0.45` and `cursor: not-allowed` on the whole row (`style.css:381-384`). A copy button inside that row inherits the muted visual treatment and may appear non-actionable even though it works.

Suggested fix: add CSS guidance for disabled rows, e.g. `.fe-picker-item.disabled .fe-picker-copy { cursor: pointer; }` and, if desired, a more explicit opacity rule so the copy affordance is visibly available on open rows.

### IMPORTANT — The no-tests decision is under-justified for changed event behavior

`docs/files-applet-v4.md:278-282` says V4 adds no unit tests because the change is "visual + delegation." But the core risk is behavior: a nested copy target must not call `pickSelected`, must not close the picker, and must preserve `pickerSelectedIdx`. The code-quality guide explicitly values tests for preventing regressions.

There does not appear to be an existing file-edits applet test harness, so this is not necessarily a demand for a large new harness. But the spec/plan should explain why manual smoke is sufficient, or carve out a small testable seam if practical.

Suggested fix: add an implementation-plan checkpoint to look for an existing DOM/appender test pattern. If none exists, strengthen the manual smoke steps with explicit before/after selected-index observations and document that applet IIFE unit coverage is intentionally deferred.

### IMPORTANT — Busy-state behavior is only partially specified

`plan.md:25-30` says `_pickerCopyPath` should guard concurrent clicks by checking `btn.dataset.busy`, but it does not say when to set it or when to clear it. If the flag is cleared immediately after `writeText` resolves, repeated clicks before the 800 ms restore can race multiple timers and produce stale label/class restoration.

Suggested fix: specify that `dataset.busy` is set before calling `navigator.clipboard.writeText` and cleared only after the success/failure restore timer completes. Also specify cleanup if the row disappears before the timer fires.

## MINOR

### MINOR — Several code references are approximate enough to slow implementation

Most names are correct, but these references are off:

- Picker mousedown delegation is at `applets/file-edits/script.js:1884-1892`, not `~1836` / `1836-1849`.
- `renderPickerList` starts at `script.js:2044`; recent rows are `2066-2090`; result rows continue at `2100-2119`.
- `absPathOf` is at `script.js:2148-2152`, not `~2103`.
- Existing `.fe-picker-item` flex rules are at `style.css:367-376`, and `.fe-picker-path` flexing is at `style.css:385-390`.

Suggested fix: update line references or say "search for function/rule name" for anything expected to drift.

### MINOR — The sample row markup uses HTML attribute names while code uses `dataset.flatIdx`

The spec's sample markup uses `data-flat-idx` (`docs/files-applet-v4.md:189`, `docs/files-applet-v4.md:198`), while code sets/reads `dataset.flatIdx` (`script.js:1889`, `2083`, `2106`, `2130`). This is technically the same DOM attribute, but the mixed naming can make implementers second-guess whether the key is `flatIdx`, `flat-idx`, or something new.

Suggested fix: add a sentence that V4 keeps the existing `dataset.flatIdx` / `data-flat-idx` contract unchanged.

### MINOR — Planned spacing duplicates the existing flex `gap`

Existing `.fe-picker-item` already has `gap: var(--space-sm)` (`style.css:373-375`). The plan also adds `margin-right: 8px` to `.fe-picker-icon` and `margin-left: 6px` to `.fe-picker-copy` (`plan.md:81-89`). That creates double spacing around the new controls.

Suggested fix: prefer the existing flex gap and only add margins if a visual smoke test shows the gap is insufficient.

### MINOR — File-finder parity should mention directories are intentionally excluded

The file-finder source has copy buttons on both file rows and directory rows (`applets/file-finder/script.js:137-143`, `164-171`, `198-202`). The V4 picker has no directory rows by design (`docs/files-applet-v4.md:31-36`), so this is not a bug.

Suggested fix: add one sentence in the parity section that parity applies only to picker file rows because directory rows are a non-goal.

## Duplication call-out

I would not consolidate `fileIcons` in V4. Code-quality warns against code that must be kept in sync, but a cross-applet sharing mechanism would be a larger abstraction change than this feature needs, and the roadmap may retire or absorb the standalone file-finder later. The duplication should remain deliberately bounded: exact copied map, exact acceptance check against file-finder, and a V5 consolidation note.

## Additional risks missing from §9

- Roadmap/version drift: V4 means different things in the roadmap and spec.
- Selected/copy visual-state conflict from `.copied` overriding `.selected`.
- Disabled/open row affordance conflict from `.disabled` styling muting an allowed copy button.
- Windows absolute path handling in the recent-files store.
- Concurrent copy timer races if `dataset.busy` is underspecified.
- Browser clipboard permission denial may leave no durable user-visible error beyond an 800 ms glyph; acceptable for V4, but worth stating as a UX limitation.
