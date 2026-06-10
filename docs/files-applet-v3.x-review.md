# Files-applet V3.x spec review

Reviewer: spec-review pass against
`docs/files-applet-v3.x.md` (draft) with cross-checks to
`docs/files-applet-v2.md`, `docs/files-applet-v1.1.md`,
existing `applets/file-edits/{script.js,markdown-viewer.js,style.css}`,
and `code-quality.md`.

Verdict: spec is in good shape. No BLOCKERs. A handful of
IMPORTANTs cluster around stacking math, eviction cadence, and
naming hygiene; the rest are NICE-TO-HAVE polish.

Tier legend: **BLOCKER** must fix before implementation;
**IMPORTANT** should be resolved in the spec to avoid rework;
**NICE-TO-HAVE** clarification that strengthens the doc.

---

## BLOCKER

None.

---

## IMPORTANT

### I1. Stacking math is under-specified for the "no mode toggle" case (criterion 2)

§4.1.A says chrome buttons stack starting at `top: 72px` "or
`top: 40px` when no mode toggle". §4.1.C says "Position is set
in JS per-button at render time … because the count varies."
Two gaps:

- The spec does not pin **who** computes the base offset. The
  base offset depends on `updateModeToggle`'s visibility result,
  which today runs independently from `updateSaveButton`.
  Implementation note needed: `updateChromeButtons` must read
  `this.modeBtn.hidden` (or equivalent state) AFTER
  `updateModeToggle` has run for the current echoState tick, or
  the first chrome button after a mode-count change will be
  off-by-32px for one frame.
- The trigger surface should be explicit: `updateChromeButtons`
  MUST be called every time `updateModeToggle` is called (mode
  toggle visibility can change between echoStates — e.g. an
  image tab → markdown tab switch). Today's code calls
  `updateSaveButton` from inside `updateModeToggle` (script.js
  lines 399, 412). The migrated shell should do the same:
  `updateModeToggle` calls `updateChromeButtons` at its end so
  the two never desync.

Suggested addition to §4.1.B: list `updateChromeButtons` as
*tail-called* from `updateModeToggle`, in addition to its own
direct trigger sites.

### I2. ChromeButton cache invalidation policy is unstated (criterion 3)

§4.1.B's example sets `this._chromeButtonsCache` on first call
and never invalidates. The comment says "recompute only if mode
changes (rare)" — but no code path recomputes. For the V2.d
Save migration this is harmless (the array doesn't change shape
across modes; only the `visible`/`disabled` predicates re-fire).
But the spec contract should pin it explicitly so the second
consumer doesn't trip over it:

> **Cache invariant**: `getChromeButtons()` returns the SAME
> array reference across calls within a viewer instance. To
> change set membership (button appears/disappears), declare
> the button in the array and gate it via the `visible`
> predicate; do NOT mutate the array or return a new one. The
> shell's reconciliation uses `id` for identity but assumes
> array length is stable as a fast-path; per-tick reallocation
> is wasted work.

If a future viewer truly needs structural change, the spec
should add an `invalidateChromeButtons()` callback that the
viewer calls and that wipes the shell's reconciliation cache.
Not needed for V3.x scope; flag for V4.

### I3. `_showSaveError` naming is now misleading (criterion 4)

§4.1.B says ChromeButton.onClick rejections "surface via the
per-tab error surface … exactly as V2.d's Save did." The
existing methods are `_showSaveError` / `_clearSaveError` and
the rendered text is `'Save failed: ' + msg` (script.js:427).

After migration the error surface is generic (any ChromeButton
can reject). Spec should mandate the rename:

- `_showSaveError` → `_showChromeError` (or `_showButtonError`)
- `_clearSaveError` → `_clearChromeError`
- Rendered text: drop the `'Save failed: '` prefix; let the
  ChromeButton's `onClick` rejection message speak for itself
  (the migrated Save's `save()` method can throw
  `new Error('Save failed: …')` to preserve the wording, or the
  shell can prefix with the button's `label`, e.g.
  `'Save: <msg>'`, `'Format: <msg>'`).

This is a pit-of-failure issue (criterion 14): leaving
"Save failed" baked into a generic surface guarantees a future
Format-button rejection will render "Save failed: invalid
syntax" and confuse the user. Cheap to fix in the same commit
that migrates Save. Also update MarkdownViewer's call site
(`this.container._clearSaveError()` at line 119) to the new
name.

### I4. Eviction re-schedule cadence is wasteful as written (criterion 7)

§4.2.A and §7.4 say a dirty viewer is "re-schedule[d] for
another timeout." Literal reading: the timer fires every N
seconds for as long as the user leaves a dirty editor inactive.
With N=300_000 this is cheap; with N=2000 (the smoke-test
value) it's a wakeup every 2s forever.

Two viable policies; pick one and document:

- **A. Stop polling on dirty veto.** Cancel the eviction timer
  entirely; rely on the next `switchViewer` (the user toggling
  back into and away from the dirty viewer) to re-arm.
  Consequence: a dirty viewer that the user never re-visits is
  never evicted. Acceptable — they have unsaved changes; we'd
  refuse to evict anyway.
- **B. Re-schedule once with backoff.** Re-arm at N*4 or cap at
  a fixed long interval (e.g. 5 min). Simpler than (A) for the
  case where the user eventually saves elsewhere.

Recommend **A**. It matches the existing trigger model
(switchViewer is the only entry point that arms the timer);
the dirty veto becomes "skip and don't re-arm." This also
removes the need for `_evictViewer` to call `setTimeout` itself,
keeping all timer creation in `_scheduleEviction`.

### I5. Eviction-driven watcher churn deserves a one-line note (criterion 9)

§7.4 covers the user-facing latency cost (~200ms re-fetch +
re-render). It does not mention that
`ViewerInstance.destroy()` closes the watcher (MarkdownViewer
line 271, etc.), so every eviction returns a watch lease to the
server and every reactivation acquires a new one. With N=2000
in the smoke test, a user rapidly toggling could churn watch
leases at ~0.5 Hz.

Add a row to §7.5 risks table:

| Risk | Mitigation |
|---|---|
| Eviction destroys the viewer's watcher; reactivation re-acquires it. Server watcher churn scales with eviction rate. | Default-off ships without churn. When enabled, prefer N ≥ 60_000 in production configs. Document in §4.2.A that the eviction config's effective minimum is bounded by acceptable watcher-lease churn. |

---

## NICE-TO-HAVE

### N1. ChromeButton shape — foreseeable second consumers (criterion 1)

The shape (`id/label/title/onClick/visible/disabled/className`)
covers the V3.x.1 surface. Fields a future consumer might want
that are NOT in scope but worth a one-liner of "deferred":

- **keyboard shortcut** (e.g. Format on Shift+Alt+F). Today
  MarkdownViewer's Ctrl+S is wired in the viewer's textarea
  keydown handler (markdown-viewer.js:75-82); per-button
  shortcut declaration would centralize this. Defer to V4
  alongside global shortcut work (roadmap item 11).
- **icon** — §7.6 Q2 already defers to V4.
- **submenu / split button** — out of scope; mention as "not
  planned."
- **status text widget** — §7.6 Q3 already defers.

Add a single sub-bullet to §7.6 covering shortcut: "Per-button
keyboard shortcuts: deferred to V4 with global-shortcut work."

### N2. Tooltip alignment / placement (criterion 1)

`title?: string` uses the browser-native tooltip, which is
consistent with `.files-viewer-toggle` (no `title` today) and
`.files-mode-toggle`. Worth one sentence noting "native `title`
attribute; no custom positioning" so a future contributor
doesn't invent a tooltip system.

### N3. Eviction trigger only fires on switchViewer (criterion 5)

§4.2.A schedules eviction inside `switchViewer`. This is
correct for the "user toggled away" case. Consider whether any
other path constructs an inactive viewer that should be
eligible:

- **Cards rehydrate** constructs the default viewer for each
  card on load (script.js:2519-2522). If the default is
  markdown but the persisted `activeViewerType` is `'diff'`,
  the rehydrate sequence runs `switchViewer('diff')` post-
  construction. That switchViewer call fires the eviction
  schedule on the markdown viewer — correct.
- **applyAgentState** path also goes through `switchViewer`
  (script.js:1050, 1077) — correct.

Conclusion: no missing trigger. Recommend the spec call this
out explicitly in §4.2.A: "All paths that construct an inactive
viewer route through `switchViewer`, so it is the only place
that needs to arm the timer." Saves a future reader the trace.

### N4. applyAgentState ↔ eviction interaction (criterion 6)

If diff was previously evicted, `applyAgentState` calls
`switchViewer('diff')` → factory rebuilds → `pendingSelection`
is set on the NEW instance, and `scheduleAgentFinalize(dv)` is
called with the fresh `dv` reference (script.js:1056). The
two-rAF finalize runs on the new instance. Correct as-is.

Suggest §4.2.A add a one-line walkthrough:

> Eviction is transparent to `applyAgentState`: it re-enters
> through `switchViewer`, which rebuilds the viewer via the
> factory; the agent's `pendingSelection` and
> `scheduleAgentFinalize` operate on the fresh viewer instance
> by reference, so no agent-state path is broken by a prior
> eviction.

### N5. Eviction rapid-toggle reset — both branches must execute (criterion 8)

§7.5 row 3 says "The eviction timer is reset on activation."
The spec text in §4.2.A says `switchViewer` schedules eviction
for the OLD viewer (`priorType`). For the resetting behavior
to hold, `switchViewer` must ALSO cancel any pending eviction
for the INCOMING viewer (i.e. the type that just became
active). Spec snippet only shows the schedule-for-priorType
half. Add:

```js
// In switchViewer BEFORE activeViewerType = viewerType:
this._cancelEviction(viewerType);   // incoming
// ... existing factory/activate logic ...
if (prior && prior !== this.viewers.get(viewerType)) {
  this._scheduleEviction(priorType);   // outgoing
}
```

Make `_cancelEviction(viewerType)` an explicit method (clears
the timer in `_evictionTimers` and deletes the map entry).
Calling it from `switchViewer`, `_evictViewer` (for the
defensive "became active again" branch), and
`TabContainer.destroy` covers all cancellation sites.

### N6. localStorage in iframed applet (criterion 10)

Confirmed: applets run in iframes (search hits in
`docs/files-applet-v1.md` §118 and v2 §707). Same-origin iframes
share localStorage with the parent, so the `caco:` namespace
is preserved. If applets are ever moved cross-origin (e.g.
sandboxed null-origin), this assumption breaks. Add to §7.3:

> Assumption: the applet iframe is same-origin with Caco's
> shell. If applets move to a sandboxed null-origin in a
> future release, eviction config must migrate to
> `appletAPI.getState/setState` (which uses Caco's persistence
> layer, not browser localStorage).

### N7. Memory measurement hook (criterion 11)

§7.2 says "flip when data justifies." Spec is silent on the
measurement. Add to §7.2:

> A future change wanting to flip the default should first
> instrument with `performance.memory.usedJSHeapSize` (Chromium-
> only) sampled on a long-lived session with N≥20 tabs, or
> count DOM nodes in `this.viewers` × per-viewer node count.
> Threshold for flipping default-on: TBD pending instrumentation.

Concrete, even if loose.

### N8. Inter-part ordering (criterion 12)

§4.3 already covers this correctly: V3.x.2 only depends on
V2.d's `isDirty()` and is independent of V3.x.1's chrome hook.
Re-confirm with one sentence: "V3.x.2 can ship before V3.x.1
without changes — eviction touches `switchViewer`'s
deactivation path, not chrome buttons."

### N9. Mode toggle unification (criterion 13)

§7.6 Q4 correctly says modes are state and chrome buttons are
actions. The visual styling overlap (`.files-mode-toggle`,
`.files-chrome-btn`, `.files-viewer-toggle` all share the same
dark/border/padding base in style.css:467-633) suggests a
future shared base class (`.files-chrome-control`?) would
deduplicate three near-identical CSS blocks. Add a one-line
note to §10 V4+ stubs:

> CSS de-dup: `.files-viewer-toggle`, `.files-mode-toggle`, and
> `.files-chrome-btn` share a common visual base. A future
> visual refresh (roadmap item 12) could collapse them into a
> single `.files-chrome-control` base + modifier classes.

### N10. Single unit test worth writing (criterion 15)

Manual-only is consistent with V2/V1.1 precedent. One
exception worth surfacing: the chrome-button reconciliation by
`id` is the kind of code that's easy to write wrong and silent
when it breaks (a stale DOM node lingers, a `disabled`
predicate doesn't re-fire, etc.). If the project has any
applet-side unit-test harness, the reconciliation function is
a natural target: given a sequence of
`getChromeButtons()` returns (button added, removed, predicate
flipped), assert the DOM state. Out of scope if no harness
exists; mention as "candidate for V4 if a test harness lands."

### N11. Duplicate ChromeButton id risk row is good — pin behavior (criterion 1 / 14)

§7.5 last row says "Shell logs a warning and uses the first
one." Reinforce by noting the contract is enforced by `id`
collision check at reconciliation time, and that violation is a
viewer-author bug, not a user-facing failure. This protects
against the pit-of-failure pattern from `code-quality.md`
("only one way to do one thing" — id uniqueness within a
viewer is the invariant; the shell enforces it loudly).

---

## Sanity checks (criteria with no findings)

- **Criterion 14 (code-quality.md violations)**: the spec
  generally aligns. Removing `saveBtn` / `updateSaveButton`
  shell-internal special-casing is a textbook "less is more"
  win. The cache-invariant point (I2) and the naming hygiene
  point (I3) are the only pit-of-failure smells; both are fixed
  by spec edits, not new code.
- **Criterion 12 (independent shipping)**: spec is already
  correct; reinforced in N8.
- **Criterion 6 (eviction × applyAgentState)**: implementation
  is correct as designed; spec walkthrough requested in N4.

---

## Summary table

| # | Tier | Topic |
|---|---|---|
| I1 | IMPORTANT | Stacking math: pin updateChromeButtons trigger and base-offset ordering vs updateModeToggle |
| I2 | IMPORTANT | ChromeButton cache invariant (stable array reference; visible-gated membership) |
| I3 | IMPORTANT | Rename `_showSaveError`/`_clearSaveError` → `_showChromeError`/`_clearChromeError`; drop "Save failed:" prefix |
| I4 | IMPORTANT | Eviction dirty-veto re-schedule cadence: stop polling instead of re-arming |
| I5 | IMPORTANT | Document watcher-lease churn under eviction; recommend min N |
| N1 | NICE | ChromeButton: defer keyboard shortcut to V4 explicitly |
| N2 | NICE | Tooltip alignment: native `title`, no custom system |
| N3 | NICE | State explicitly that switchViewer is the only eviction-arming entrypoint |
| N4 | NICE | One-line applyAgentState ↔ eviction walkthrough |
| N5 | NICE | Show both cancel-incoming + schedule-outgoing in §4.2.A snippet |
| N6 | NICE | Same-origin iframe assumption for localStorage |
| N7 | NICE | Memory measurement hook for flipping default-on |
| N8 | NICE | V3.x.2 can ship before V3.x.1 |
| N9 | NICE | CSS de-dup of chrome controls deferred to V4 visual refresh |
| N10 | NICE | Chrome-button reconciliation as a unit-test candidate when a harness lands |
| N11 | NICE | Pin duplicate-id behavior as a contract violation |
