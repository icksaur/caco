# Files applet V3.x — chrome decoration hook + inactive-viewer eviction

Status: draft.
Predecessors: V2.a-V2.d (shipped, `docs/files-applet-v2.md`).
Roadmap: `docs/files-applet-roadmap.md` §V3.x.
Branch target: NEW `files-applet-v3.x` off master.

## 1. Goal

Two small contract-polish features that follow naturally from V2.d:

- **V3.x.1 Per-viewer chrome decoration** — generalize V2.d's
  Save button into a "viewer may declare extra chrome buttons"
  hook. Lets a future viewer add Format / Lint / Reset zoom
  without shell changes.
- **V3.x.2 Inactive-viewer eviction (opt-in)** — TabContainer
  may destroy non-active viewers after N seconds idle to bound
  memory. Ship with the policy DISABLED by default; provide the
  knob so a future memory-pressure trigger can flip it without
  another release.

Both are refactors of existing V2 code into more general shapes.
Neither adds a user-visible feature; both shrink the contract
surface for future viewers.

## 2. Use cases

| # | Story | V3.x part |
|---|---|---|
| U1 | A future ImageViewer feature adds a "Reset zoom" button. It declares the button via `getChromeButtons()`; the shell renders it next to the viewer-type toggle. No shell-code change. | V3.x.1 |
| U2 | MarkdownViewer's existing Save button is rewritten to use the same `getChromeButtons()` hook. The shell-side modeBtn + saveBtn special-case code goes away; both buttons are produced by the viewer. | V3.x.1 |
| U3 | A user opens 30 markdown files, toggles each to diff and back, leaves them open for 10 minutes. With eviction enabled and timeout = 5 minutes, every inactive non-default viewer is destroyed. Reactivating one re-fetches and re-renders (~200ms latency). The user sees no functional difference except first-toggle-back-after-eviction takes a moment. | V3.x.2 |
| U4 | Eviction is off (default in V3.x ship). Behavior is identical to V2.d: every constructed viewer lives until tab close or session switch. | V3.x.2 |

## 3. Non-goals (V3.x)

- No new viewer types.
- No new persistence schema.
- No autosave (deferred to V4).
- No dirty-prompt on session-switch (deferred to V4 with autosave).
- No global keyboard shortcuts (deferred to V4).
- No eviction default-on. V3.x ships the mechanism; turning it
  on is a follow-up if memory data warrants.

## 4. Design

### 4.1 Per-viewer chrome decoration (V3.x.1)

#### 4.1.A Contract addition

A viewer may declare extra chrome buttons via:

```ts
interface ChromeButton {
  /** Stable id for change-detection. */
  id: string;
  /** Button label. May be a glyph + text or text-only. */
  label: string;
  /** Tooltip. Optional. */
  title?: string;
  /** Click handler. Synchronous; if it kicks off async work,
   *  return a Promise and the shell disables the button during
   *  the await. Errors surface via the per-tab error surface
   *  (V2.d §7.3 option B). */
  onClick(): void | Promise<void>;
  /** Visibility predicate. If returns false, the button is
   *  hidden. Re-evaluated on every echoState tick. */
  visible?: () => boolean;
  /** Disabled predicate. Re-evaluated on every echoState tick. */
  disabled?: () => boolean;
  /** Optional CSS class for styling (e.g. 'primary', 'danger'). */
  className?: string;
}

interface ViewerInstance {
  // ... V2 methods unchanged
  /** Optional. Returns the viewer's chrome buttons. Called
   *  on every echoState tick (cheap; viewer should cache its
   *  ChromeButton objects). Order is render order
   *  (top-to-bottom). */
  getChromeButtons?(): ChromeButton[];
}
```

**Cache invariant** (resolves review I2): `getChromeButtons()`
MUST return the same array reference across calls within a
viewer instance. To change set membership (button
appears/disappears), declare the button in the array and gate
it via the `visible` predicate; do NOT mutate the array or
return a new one. The shell's reconciliation uses `id` for
identity but assumes array length is stable as a fast-path;
per-tick reallocation is wasted work. If a future viewer truly
needs structural change, a `invalidateChromeButtons()` callback
on the contract is a V4 extension.

The shell renders chrome buttons stacked below the mode toggle,
in the order returned by `getChromeButtons()`. Stacking math:

- Viewer toggle: `top: 8px` (V1.1)
- Mode toggle: `top: 40px` (V2.d, when present)
- Chrome buttons: stacked starting at `top: 72px` when the
  mode toggle is visible, or `top: 40px` when no mode toggle is
  present. Each button is 32px tall with 8px gap below; the
  shell sets `style.top` per-button at render time.

**Trigger ordering** (resolves review I1): `updateChromeButtons`
MUST be tail-called from `updateModeToggle` after the mode
toggle's `hidden` attribute is set, so the chrome buttons read
the post-update mode-toggle state when computing their base
offset. Without this, the first chrome button after a mode-
count change is off-by-32px for one frame.

#### 4.1.B V2.d Save migration

V2.d's MarkdownViewer Save button moves from being a shell
special-case to being a ChromeButton declared by MarkdownViewer:

```js
MarkdownViewer.prototype.getChromeButtons = function() {
  var self = this;
  // Build once + cache; recompute only if mode changes (rare).
  if (!this._chromeButtonsCache) {
    this._chromeButtonsCache = [
      {
        id: 'save',
        label: 'Save',
        title: 'Save (Ctrl+S)',
        className: 'primary',
        visible: function() { return self.isDirty(); },
        disabled: function() { return self._saveInFlight; },
        onClick: function() { return self.save(); },
      },
    ];
  }
  return this._chromeButtonsCache;
};
```

Shell removes:
- `TabContainer.saveBtn` field and its construction.
- `TabContainer.updateSaveButton()` method.
- `updateSaveButton` calls from setActiveTab + echoState
  microtask + saveBtn click handler.

Shell renames + extends (resolves review I3 — "Save failed:"
is baked into a now-generic surface):
- `TabContainer._showSaveError(msg)` → `_showChromeError(msg)`.
- `TabContainer._clearSaveError()` → `_clearChromeError()`.
- The rendered prefix changes from `'Save failed: ' + msg` to
  `<button-label> + ': ' + msg`. The shell knows which button
  produced the error (the click handler captured the ChromeButton
  reference) and uses that label. MarkdownViewer's call site in
  `setMode` ("clear save error on discard") becomes
  `_clearChromeError`. The migrated Save button's `onClick`
  throws `new Error(message)` with whatever message; the shell
  composes the surface text from button label + the message.

Shell adds:
- `TabContainer.chromeButtonsEl` (a div containing N dynamically-
  managed buttons).
- `TabContainer.updateChromeButtons()` method that:
  - Reads `viewer.getChromeButtons()` (or [] if undefined).
  - Reconciles vs current DOM: by id, create new buttons,
    remove gone ones, update label/title/className/disabled/
    visible state.
  - Re-evaluates visible+disabled predicates on each call.
  - Computes per-button `style.top` based on the post-update
    mode-toggle visibility (see §4.1.A trigger ordering).
  - Called from setActiveTab + echoState microtask + tail-call
    from updateModeToggle.

The per-tab error surface (`TabContainer.errEl`) stays. The
ChromeButton's `onClick` Promise rejection surfaces there
exactly as V2.d's Save did.

#### 4.1.C CSS scoping

Chrome buttons share the V2.d save-button base style:

```css
.files-chrome-btn {
  position: absolute;
  right: 16px;
  z-index: 5;
  background: var(--color-bg, #1e1e1e);
  border: 1px solid var(--color-border, #3c3c3c);
  border-radius: 4px;
  padding: 4px 14px;
  font: inherit;
  font-size: var(--text-sm, 12px);
  color: var(--color-text, #d4d4d4);
  cursor: pointer;
}
.files-chrome-btn.primary {
  background: var(--color-success, #4caf50);
  border-color: var(--color-success-bright, #66bb6a);
  color: #fff;
  font-weight: 600;
}
.files-chrome-btn.primary:hover {
  background: var(--color-success-bright, #66bb6a);
}
.files-chrome-btn:disabled { opacity: 0.5; cursor: default; }
```

Position is set in JS per-button at render time (top: 72px,
top: 112px, etc. with 8px gap), because the count varies and
:has() selectors would be brittle.

The V2.d `.files-save-btn` class is removed (replaced by
`.files-chrome-btn.primary`).

### 4.2 Inactive-viewer eviction (V3.x.2)

#### 4.2.A Contract addition

Optional shell-level config:

```ts
interface ShellEvictionConfig {
  /** Milliseconds after which an inactive constructed viewer
   *  is destroyed. 0 / null disables. Default: null (disabled). */
  inactiveViewerTimeoutMs: number | null;
}
```

Lives at `shell._eviction.inactiveViewerTimeoutMs`. Read from
localStorage key `caco:files-applet:inactiveViewerTimeoutMs` at
shell init; defaults to null. A future agent or user can flip it
via `localStorage.setItem('caco:files-applet:inactiveViewerTimeoutMs', '300000')`
(5 minutes).

When non-null, TabContainer.switchViewer schedules an eviction
timer for the OLD viewer (the one being deactivated):

```js
// In switchViewer after activeViewerType = viewerType:
if (prior && prior !== this.viewers.get(viewerType)) {
  this._scheduleEviction(priorType);
}
```

`_scheduleEviction(viewerType)`:
- Cancel any existing eviction timer for `viewerType`.
- `setTimeout(() => this._evictViewer(viewerType), shell._eviction.inactiveViewerTimeoutMs)`.
- Store the timer id in `this._evictionTimers: Map<viewerType, timerId>`.

`_evictViewer(viewerType)`:
- If `viewerType === this.activeViewerType`: cancel (the viewer
  became active again; should not happen since switchViewer
  reschedules, but defensive).
- If `!this.viewers.has(viewerType)`: already gone.
- If the viewer reports `isDirty() === true` (V2.d): SKIP
  (do NOT evict — the editor has unsaved content). **Do not
  re-arm the timer** (resolves review I4 — policy A): the next
  `switchViewer` is the only entry point that arms eviction,
  so a dirty viewer that the user never re-visits is never
  evicted. Acceptable — the user has unsaved changes and we
  refuse to discard them.
- Else: `viewer.destroy()`, `this.viewers.delete(viewerType)`,
  `shell.echoState()`.

`switchViewer(targetType)`:
- Cancel any eviction timer for `targetType` (it's becoming
  active; do not evict).
- Schedule eviction for the OUTGOING `priorType` after the
  switch resolves.
- Both timer operations live in `_scheduleEviction(viewerType)`
  / `_cancelEviction(viewerType)`; switchViewer is the only
  arming entrypoint.

Eviction timers are cleared in TabContainer.destroy (alongside
the viewers iteration).

#### 4.2.B Default policy

V3.x ships with `inactiveViewerTimeoutMs = null` (disabled).
Rationale: V2.d has been live; no memory-pressure signal yet.
The mechanism is in place so flipping it on is a one-line
config change (no release needed).

V3.x acceptance does NOT include behavior change visible to a
user with the default config. The smoke test toggles a viewer,
sets the localStorage key to 2000, waits 3s, toggles back, and
verifies a re-fetch happens (viewer factory rebuilt).

### 4.3 Spec dependency between V3.x.1 and V3.x.2

V3.x.2 (eviction) depends on V3.x.1 (chrome hook) only weakly:
the eviction logic refers to `viewer.isDirty()` which exists
since V2.d. No coupling to chrome buttons. The two parts can
ship in either order; spec sequences chrome hook first because
it's the bigger refactor and lets eviction land on a cleaner
shell.

## 5. Backend changes

None.

## 6. Migration / deprecation

- V2.d's `.files-save-btn` CSS class is removed; the migrated
  Save button uses `.files-chrome-btn.primary`. Any user CSS
  override targeting `.files-save-btn` would break — none known.
- V2.d's `TabContainer.saveBtn` field and `updateSaveButton`
  method are removed. No external consumers (shell-internal).
- The new `getChromeButtons` hook is opt-in; viewers without it
  get no chrome buttons (same as today for image/html).

## 7. Considerations

### 7.1 Why not include autosave in V3.x?

Autosave is a feature (visible save-status change, save-failure
indicator, debounce-timing decisions). V3.x is contract-polish.
Mixing them would blur the scope. V4 picks up autosave on top
of the V3.x chrome hook, which gives autosave a natural place
to surface its status indicator (a ChromeButton).

### 7.2 Why eviction default-off?

Eviction trades memory for latency-on-toggle. Without measured
memory pressure, the latency tax is pure cost. Ship the
mechanism, leave the policy off, flip when data justifies.

### 7.3 Why localStorage for eviction config (not meta.json)?

The applet doesn't persist its own config (only cards). Adding
applet-level config would mean another backend endpoint /
schema. localStorage is the smallest tool that solves it for a
single-user system; agents can also flip it via the existing
`appletAPI.setState` if useful in V4+.

### 7.4 isDirty veto on eviction — correctness

V2.d's `isDirty()` returns true only when the viewer is in edit
mode with editor != disk. If the user is in markdown view mode,
isDirty is false → MarkdownViewer can be evicted. Toggle back
takes ~200ms (re-fetch + re-render). Acceptable.

If the user is in edit mode and the viewer is INACTIVE (they
toggled to diff while still dirty), the eviction veto kicks in.
The dirty viewer is preserved. Once they toggle back and save
(or discard), the next eviction cycle is allowed to take it.

### 7.5 Risks

| Risk | Mitigation |
|---|---|
| ChromeButton onClick rejects with a non-Error — string error message becomes "[object Object]". | The shell wraps with `String(err.message || err)`. V2.d already does this; reuse. |
| Many chrome buttons + visible/disabled predicates fire on every echoState tick (coalesced microtask). Cost grows O(buttons × tabs). | Viewers cache their ChromeButton arrays (don't reallocate on every getChromeButtons() call). Predicates are cheap getters. Coalesce already bounds frequency to 1/tick. |
| Eviction enabled + user toggles rapidly between viewers — thrashing reload cost. | The eviction timer is reset on activation. Rapid toggles within the timeout never evict. Default-off ships without this risk. |
| Eviction destroys an in-flight save's viewer mid-PUT. | isDirty veto: a viewer with a save in flight has _saveInFlight=true which sets _editorText !== _diskText (the editor hasn't won yet) → isDirty returns true → eviction skipped. |
| Two chrome buttons with the same id — DOM gets confused. | Shell logs a warning and uses the first one. Document in the contract. |
| Eviction destroys the viewer's watcher; reactivation re-acquires it. Server watcher-lease churn scales with eviction rate. | Default-off ships without churn. When enabled, prefer `inactiveViewerTimeoutMs >= 60_000` in production. Document in §4.2.A that values below ~30s are smoke-test only. |

### 7.6 Open questions (answered)

1. **Why not just generalize Save and skip "ChromeButton" naming?**
   Generalization is the point. The name "chrome" matches the
   shell-decoration vocabulary already used in V1.1 ("chrome
   decoration" appears in V1.1 spec §10 V2 stub).
2. **Should ChromeButton support arbitrary HTML / icons?** No.
   V3.x supports text labels only. Icons land with V4's visual
   refresh.
3. **What about chrome that isn't a button (e.g. a status
   text)?** Out of scope; the contract is buttons. A future
   `getChromeWidgets()` could generalize further.
4. **Where do MarkdownViewer's mode toggle live in the
   ChromeButton model?** It stays separate. Modes are first-
   class viewer state with a dedicated toggle; chrome buttons
   are per-mode actions. The mode toggle is mode-aware
   (View ↔ Edit), while a chrome button like Save is just
   "do an action."

## 8. Acceptance

### V3.x.1 chrome decoration hook

- [ ] MarkdownViewer's Save button is migrated to a ChromeButton.
      Functional behavior identical to V2.d (save works,
      disabled during in-flight, hidden when not dirty).
- [ ] `TabContainer.saveBtn` / `updateSaveButton` removed; no
      stale references.
- [ ] New `TabContainer.chromeButtonsEl` renders viewer-declared
      buttons.
- [ ] Adding a second ChromeButton on MarkdownViewer (e.g. a
      "Discard" button) just works without shell changes.
- [ ] `npm run build` passes.

### V3.x.2 eviction (mechanism only)

- [ ] With localStorage `caco:files-applet:inactiveViewerTimeoutMs`
      = `2000`, toggling away from a viewer and waiting 3s
      destroys the inactive viewer (verified via console: count
      of `container.viewers.size` drops from 2 to 1).
- [ ] Toggling back triggers a re-fetch (visible: brief
      load-state, watch lease re-acquired).
- [ ] With the localStorage key unset / null, behavior matches
      V2.d (no eviction).
- [ ] Dirty MarkdownViewer is not evicted (verified via console
      after typing in edit mode + toggling away + waiting).
- [ ] `npm run build` passes.

## 9. Roll-back

Each V3.x part is its own commit on the V3.x branch. Roll-back
V3.x.1: revert removes the chrome-button infrastructure and
restores the V2.d save button. Roll-back V3.x.2: revert removes
the eviction mechanism; default behavior is unchanged.

## 10. V4+ stubs (carry-forward)

Unchanged: rename to `files`, deprecate standalone applets,
global keyboard shortcuts, visual refresh, autosave, dirty-on-
session-switch (likely superseded by autosave).

## 11. Test plan

Manual acceptance per §8. No new unit tests.
