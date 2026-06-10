# Files-applet V2 spec review

Spec: `docs/files-applet-v2.md` (draft).
Reviewer: code-review pass against V1/V1.1 contract + current
implementation in `applets/file-edits/` and `src/routes/`.
Findings are organized by tier; each cites the spec section and
the concrete code that motivates the finding.

---

## BLOCKER

### B1. §4.3.3 is wrong — backend rejects `schemaVersion !== 1`

§4.3.3 claims:

> `src/routes/file-edits.ts` does not need a code change. The PUT
> handler stores opaque JSON; the GET handler returns opaque JSON.

That is not what the code does. `src/routes/file-edits.ts:144`:

```ts
if (body.schemaVersion !== SCHEMA_VERSION) {
  res.status(400).json({ error: `unknown schemaVersion: ${body.schemaVersion}` });
  return;
}
```

`SCHEMA_VERSION` is defined as `1` in `src/file-edits-store.ts:26`
and the route imports it (`src/routes/file-edits.ts:16`). The
moment the V2 client posts `schemaVersion: 2`, the server returns
400 and the persist silently fails (the client logs and moves on
— there is no UI surface for persist failure). V2.c rehydrate
would then never see any v2-shaped state because no v2 was ever
stored.

Additionally `isCardPersist` (route-local at line 166 AND the
store's variant at `file-edits-store.ts:66`) require
`collapsed: boolean`. If V2 drops `collapsed` from the writer
(see N1 below), the per-card validator also rejects the body
with 400.

**Required for V2.c:**

1. Bump `SCHEMA_VERSION = 2` in `src/file-edits-store.ts`, OR
   change the route validator to accept `{1, 2}` (a Set or
   `body.schemaVersion === 1 || body.schemaVersion === 2`). The
   cleaner option is the latter for a transition window: the
   server stays version-tolerant, the client writes 2.
2. Either keep `collapsed` in the V2 writer (a vestigial field
   that costs nothing — see N1) OR widen `isCardPersist` so the
   field is optional. The store's persisted shape
   (`CardPersist` interface, `src/file-edits-store.ts:28`) must
   also be widened to accept the new `defaultViewerType` /
   `activeViewerType` fields if they are to round-trip — TS will
   currently strip unknown properties at the type boundary (the
   route casts `body.cards as CardPersist[]` line 156, so they
   survive at runtime, but they are undeclared and any future
   typed-write would drop them).

This finding alone gates V2.c. The spec must be updated to
include a small backend change list, even if it is "one
constant + two validator tweaks". The §5 "V2.c — none required"
claim is incorrect.

### B2. §7.2 / §4.1 silently require an `openOrUpdateTab` refactor

§7.2 says:

> The poller emits the edit, but `openOrUpdateTab` calls
> `defaultViewer(abs, rel)` which now returns ImageViewer for
> `.png`.

The current implementation does NOT do this. `openOrUpdateTab`
at `applets/file-edits/script.js:1102-1118` hard-codes a
diff-default container:

```js
var diffDesc = null;
for (var i = 0; i < viewerRegistry.length; i++) {
  if (viewerRegistry[i].viewerType === 'diff') { diffDesc = viewerRegistry[i]; break; }
}
...
container = new TabContainer(shell, diffDesc, abs, relPath);
var viewer = DiffViewer.fromEdit(shell, container, edit);
container.viewers.set('diff', viewer);
```

For V2.a to produce the UX §7.2 describes, `openOrUpdateTab`
must be rewritten to (a) call `defaultViewer(abs, relPath)` and
(b) construct via the descriptor's `open()` (async!) instead of
the synchronous `DiffViewer.fromEdit`. That is a non-trivial
change tucked silently into "port the image viewer". Specifically:

- `openOrUpdateTab` becomes async (or fire-and-forget) for
  non-diff defaults because ImageViewer/HtmlViewer/MarkdownViewer
  all need a fetch in their factories.
- The `edit` payload (with its `.diff`, `.status`, `.isBinary`)
  is meaningless to an image-default container. The existing
  caco-edit flow MUST decide: is this edit interesting enough to
  open an image tab if one is not already open? Probably yes for
  the first edit, but the snapshot/dismissed logic at lines
  1080-1099 was designed around diff content. It needs to be
  taught how to compare "image edited again" (probably: just
  compare the `status` field; binary files have no `.diff`).
- The dismissed-snapshot recording at lines 1177-1188 only
  records `dvForSnap.edit` for diff viewers and a path-only
  entry for markdown defaults. Image/html closes need the same
  path-only treatment, OR `caco.edit` for a closed image tab
  will keep re-opening it on every poll.

§4.1 (ImageViewer design) and §4.2 (HtmlViewer design) must
spell out:
- That `openOrUpdateTab` is rewritten to dispatch via
  `defaultViewer`.
- That the dismissed-path branch is widened to cover
  non-markdown non-diff defaults.
- The new contract: for binary defaults, the `edit` payload is
  discarded — only the path matters.

Without this, V2.a in isolation would ship a regression: every
`caco.edit` for a `.png` still creates a diff-default container
whose `DiffViewer.canHandle` is now false. The toggle would be
hidden and the user would see a diff card for a binary file
with no way to flip to the image. The image picker (+) path
would work, but caco-driven opens would not.

---

## IMPORTANT

### I1. §7.4 rehydrate race — `setActiveTab` on a not-yet-constructed viewer

§7.4 mitigates the rehydrate-vs-caco.edit race by inserting the
container into `tabs` synchronously and clearing `rehydrating`
when the async factory completes. The reviewer asks: what if
the user CLICKS the rehydrating tab before the factory
finishes?

`TabContainer.prototype.activate` (`script.js:259-263`):

```js
TabContainer.prototype.activate = function() {
  this.contentEl.style.display = '';
  var v = this.viewers.get(this.activeViewerType);
  if (v) v.activate();
};
```

The `if (v)` guard means there is no crash, but the user sees a
blank content pane until the factory resolves. The spec does
not call this out. Required additions:

- Either render a "Loading…" placeholder element inside
  `contentEl` while `rehydrating === true`, and replace it on
  factory resolution, OR
- Disable the tab button while rehydrating (no click possible),
  OR
- Document that the empty pane is acceptable and `echoState`
  exposes a `rehydrating` flag.

Related: §4.3.2 step 4 ("if `activeViewerType !== defaultViewerType`,
call `container.switchViewer(activeViewerType)`") starts a SECOND
async factory before the first has resolved. `switchViewer`
calls `prior.deactivate()` first (`script.js:340`), but `prior`
is `viewers.get(priorType)` which is undefined while the first
factory is still in flight. The deactivate is a no-op, the
second `open()` starts, and both factories race to populate
`viewers`. Spec must sequence these: `await default.open()`
THEN `await switchViewer(active)`. Today's implementation does
not allow safe overlap.

### I2. §4.4.1 optimistic `_diskText = _editorText` before PUT

The spec acknowledges this is risky and adds a "revert on
failure" path. But the failure window is wider than the spec
admits:

```
T0: user edits, _editorText = "new"
T1: save() begins; sets _diskText = "new"
T2: PUT in flight (takes 100ms)
T3: external write happens (agent saves file = "external")
T4: server watcher fires; load() runs in 'edit' mode branch
    of §4.4.2. _diskText (currently "new") !== fetched
    ("external") → sets _diskChangedWhileEditing = true.
T5: PUT returns 200. save() succeeds. UI clears the indicator
    per §4.4.1 ("On success: clear _diskChangedWhileEditing").
T6: User believes their save landed and disk has their content.
    But the file on disk is now "new" (we just wrote it),
    OVERWRITING the external write at T3 silently. The
    "(disk changed)" indicator was cleared at T5 and the user
    never saw it.
```

The optimistic update reorders cause and effect. Safer
sequence:

1. Snapshot `pending = _editorText` BEFORE PUT.
2. Do PUT.
3. On success: `_diskText = pending` (not the live editor
   value, which may have moved on).
4. The watcher event for our own write fetches and compares
   against this `_diskText`; equal → no-op (correct, this is
   our write). Different → external write happened between our
   PUT and the watcher fire → set indicator.

The race in T3 is still possible, but at least the indicator
survives because step 3 sets `_diskText` to the value WE wrote,
so a subsequent watcher fire that sees something else will
correctly flag it. The current spec sets `_diskText` BEFORE the
PUT, which means a concurrent external write between T1 and T5
gets silently lost.

Also: the spec says "On failure: revert `_diskText` to its
prior value". The prior value at T1 may be stale by T5 (the
watcher may have updated it on a benign re-poll). Needs to
snapshot the prior `_diskText` at T1 and restore that exact
value, which the spec implies but does not explicitly state.

### I3. `confirm()` blocking modal — acceptable but missing one prompt

§4.0.B says `confirm('Discard unsaved changes?')` is used in
V2, with "a nicer modal in V3". The spec covers:

- U7 (mode toggle while dirty) — confirm in `setMode('view')`.
- U8 (close tab while dirty) — confirm in `closeTab`.

Not covered:

- **Session switch while dirty.** §7.5 explicitly defers this
  to V3 with the rationale "session-switch is user-initiated".
  That is defensible but should be reflected in the U-table so
  testers don't expect a prompt. Add U-row or expand non-goals.
- **Browser tab close / reload while dirty.** No
  `beforeunload` handler is described. The existing applet's
  beforeunload posts the cards list via sendBeacon
  (`script.js`'s schedulePersist flow); it does not check for
  unsaved markdown. The user would lose edits silently on
  Ctrl+R / browser close. Either add a `beforeunload` check (5
  lines of code, queries every container for `isDirty()`) or
  document it as deferred. The spec currently does neither.

### I4. §4.0.C mode toggle CSS scoping

Position math:
- viewer-type toggle: `top: 8px`
- mode toggle: `top: 40px`
- save button: `top: 72px`

The spec says these are absolutely positioned inside
`container.contentEl`. For tabs without a mode (diff, image,
html in V2), the mode toggle is hidden via `getModes() === null`.
But the shell still needs to:

- Render exactly one mode-toggle button per container (not per
  viewer), because viewers are constructed lazily.
- Re-evaluate visibility on `switchViewer` (the new viewer may
  have different modes).
- Re-position the save button when `isDirty` flips (the spec
  says "between viewer-type and mode toggle when isDirty"
  which conflicts with the position math "save at top: 72px"
  — these can't both be true). Pick one and state it.

Clarification needed in §4.4.3: is Save BETWEEN (pushing mode
toggle down) or BELOW (stacking under mode toggle)? The math
implies below; the prose implies between. Pick.

Also state: when `getModes()` returns null and only the
viewer-type toggle exists, the toggle stays at `top: 8px` (no
gap injected). When the mode toggle is present, the save
button slot is reserved (top: 72px) even when hidden — or is
it not? A class on `contentEl` (`.has-modes`, `.is-dirty`) is
the clean implementation; the spec should say so.

### I5. §4.3.2 cards rehydrate — "errors on individual cards log + skip"

Reasonable, but the spec doesn't say what the persisted state
becomes if a card fails to rehydrate. Scenario:

- User closes the applet with 3 tabs: README.md (markdown),
  src/foo.ts (diff), screenshot.png (image).
- User deletes `screenshot.png` from disk via a terminal.
- User reopens the applet. Image factory fetches
  `/api/file?path=…/screenshot.png` → 404. Card is skipped.
- Next persist fires (any tab event triggers schedulePersist).
  Should the persisted card list now drop `screenshot.png`,
  or keep it so the user gets the tab back if they re-create
  the file?

The V1 behavior is "persist whatever's currently in `tabs`",
which means the failed rehydrate would silently drop the
persisted state of the missing file. Probably fine, but spec
should pin this down in §4.3.2 — one sentence ("Cards that
fail to rehydrate are dropped from `tabs` and from the next
persisted snapshot").

### I6. Multiple Save buttons / future write viewers

§4.0.D says the shell renders a Save button when the ACTIVE
viewer's `isDirty()` returns true. That's correct for V2 (only
MarkdownViewer is writeable). The contract supports it: per
TabContainer, only the active viewer's save is reachable.

One thing to note for the future: `isDirty` only checks the
ACTIVE viewer; if a user is mid-edit in markdown view, toggles
to diff view (via the viewer-type toggle), the markdown viewer
becomes inactive and `isDirty()` is no longer queried by the
shell — the Save button vanishes. If the diff viewer doesn't
expose `isDirty`, the user has unsaved markdown edits with no
visible save. Today's path: §4.0.B says switchViewer consults
`isDirty()` on the relevant viewer and prompts. Good. But the
spec should pin: switchViewer queries the OUTGOING viewer's
`isDirty`, not the incoming one. State this in §4.0.B
explicitly; the current prose is ambiguous ("on the relevant
viewer").

Same prompt applies to closeTab: it queries every CONSTRUCTED
viewer's `isDirty` (not just active), because a markdown
viewer toggled away from is still constructed and dirty. Spec
should be explicit.

### I7. V1 reader reading V2 data — degraded but not graceful for binaries

Reviewer's question (#2 last clause): V1 client reads v2 cards
JSON, sees `screenshot.png` listed, ignores the extra fields,
creates a diff-default container with a placeholder
`DiffViewer.fromEdit(placeholder)`. The placeholder has
`status: 'clean'`, no diff. The card renders empty. Then
`fetchSnapshot` runs, which calls the poller's `openFile`
flow. For a binary file the poller returns an `edit` whose
`isBinary: true` and `diff` is a synthetic "Binary files
differ" placeholder. DiffViewer renders that. Not great UX,
but no crash, no data loss.

Verdict: acceptable graceful degradation, BUT the spec's §6
claim "Backward-compat is therefore graceful" should add the
qualifier that v1 readers will show binary tabs as diff
placeholders. Minor doc update.

### I8. `_diskChangedWhileEditing` is informational with no diff view

§4.4.2 sets a "(disk changed)" indicator. The user has no way
to see what changed without losing edits. Reviewer's question
flags this as acceptable; agreed for V2. But document the
escape hatch explicitly: the user's options are (a) save
(overwrite disk), (b) discard via View toggle (loses edits),
(c) copy editor content elsewhere first, then discard. The
spec mentions (a) and (b); add (c) as the "preserve both"
path so testers know the workaround. One sentence in §4.4.2.

---

## NICE-TO-HAVE

### N1. `collapsed: false` is vestigial

Reviewer's question #8: `collapsed` is in both v1 and v2 wire
shapes but nothing in `applets/file-edits/` reads it. It's
required by `isCardPersist` in BOTH the route
(`src/routes/file-edits.ts:166-170`) and the store
(`src/file-edits-store.ts:66`).

Three options:

- **Keep it in V2 writer** — zero churn, server validators
  unchanged. Recommended for V2.c minimal-diff.
- **Drop it from V2 writer** — requires loosening BOTH
  validators to make `collapsed` optional. Small cleanup but
  another backend touch.
- **Defer cleanup to V3** — explicit non-goal.

Spec should pick one and state it. Currently §4.3.1 includes
`collapsed: false` in the V2 shape silently, which means
"keep it" by default — that's fine, just make it intentional.

### N2. Ctrl+S capture phase

§4.4.5 says "textarea keydown handler intercepts Ctrl+S".
Browser default for Ctrl+S is "Save page", which Chromium
fires on `keydown` before bubbling. A normal (bubble-phase)
handler on the textarea works because the textarea is the
event target — `preventDefault()` on the first listener
suppresses the browser default. Capture phase is not required.

But: Cmd+S on macOS, and AZERTY keyboards where Ctrl+S is
Ctrl+; — handle `e.key === 's' && (e.ctrlKey || e.metaKey)`.
The spec says "Ctrl+S / Cmd+S" which is correct; just confirm
the implementation uses `e.key` not `e.keyCode` (deprecated).
Nit.

### N3. §4.0.A `isBinaryExtension` collision with image extensions

```js
function isBinaryExtension(rel) {
  return /\.(png|jpg|jpeg|gif|webp|svg|ico|pdf|zip|gz|tar|bin|exe|class|jar)$/i.test(rel || '');
}
```

`svg` is technically text (XML). Treating it as binary means
DiffViewer hides for SVG files. Probably correct UX (SVG diff
is gibberish), but worth a sentence in §4.0.A: "SVG is XML but
treated as binary because its diff is line-by-line noise; users
who want the diff can use a real editor." Same call for the
others is obvious.

Also `htm` is not in the regex (HtmlViewer handles both `.html`
and `.htm` per §4.2) — correct because both should be
toggleable to diff.

### N4. §4.0.D save Promise reject signature

```ts
save?(): Promise<void>;
```

Rejects with "an error message string" per §4.0.D. JS Promise
rejections are typed as any. The spec should pin: reject with
`Error` instance (so `.message` is the surface text) rather
than a bare string, because the shell will likely
`String(err)` it and a bare string ends up as `"foo"` (fine)
while an Error ends up as `"Error: foo"` (worse). Pick one and
state it; the implementer will appreciate the pin.

### N5. §4.3 dismissed-paths regression for non-markdown defaults

(See B2 for the larger issue.) Once `openOrUpdateTab` routes
through `defaultViewer`, the dismissed-snapshot logic at
`script.js:1177-1188` needs to handle image/html closes. Today
only `defaultViewerType === 'markdown'` gets a path-only
dismissed entry. The spec should make this explicit: "Image
and HTML closes record a path-only dismissed entry, same as
markdown" (since they have no diff snapshot).

### N6. §4.5 envelope additions — `isDirty: false` default for null viewer

The new `files.tabs[]` fields are `activeMode: string | null`
and `isDirty: boolean | null`. Two nulls + one bool is three
values for what is fundamentally a 2x2 (has-mode × is-dirty).
Defaulting `isDirty: false` (boolean, never null) avoids the
"null vs false" trap for consumers. Minor.

### N7. Open question implementers WILL hit, not in §7.7

- **Watcher acquire failure on V2.a/V2.b factories.** What
  happens if `watchPath` rejects during ImageViewer.open()?
  MarkdownViewer's pattern is "close in-flight watcher and
  bail" (`markdown-viewer.js:124`). The spec §4.1 says
  "acquire watcher first" but doesn't state the failure mode.
  Pin: on watcher acquire failure, the factory rejects → the
  card is skipped in rehydrate / the picker open shows a
  toast. State this in §4.1.

- **MarkdownViewer.load() in edit mode must NOT replace the
  textarea contents.** §4.4.2 implies this but the
  implementation surface is in MarkdownViewer.load(). The
  current load() unconditionally writes to the rendered DOM.
  Refactor: split into `_fetchDisk()` (raw text) and
  `_renderToDom(text)` (DOM mutation). load() in view mode
  does both; load() in edit mode only fetches and compares.
  Spec §4.4.2 should sketch this split — "load() must check
  `this.mode === 'edit'` and skip DOM mutation, instead
  comparing fetched text to `_diskText` and setting
  `_diskChangedWhileEditing`".

- **Tab label on dirty markdown.** Convention in many editors
  is a `*` or `●` prefix on the tab label when dirty. Not
  required, but the spec is silent — implementers will ask.
  Pin yes-or-no for V2.

### N8. Implementation order — V2.a → V2.b → V2.c → V2.d

Reviewer's question #13: can each commit ship independently?

- V2.a: requires the `openOrUpdateTab` refactor (B2). Once
  done, the schema is still v1, image tabs do NOT persist
  across reload. Ship-able with the §8 V2.a checklist's
  caveat "image tab does NOT persist".
- V2.b: same shape as V2.a. Ship-able.
- V2.c: requires the backend change (B1) and depends on
  V2.a/V2.b having added the descriptors. Otherwise the
  rehydrate has no ImageViewer/HtmlViewer descriptor to look
  up. Order-dependency exists; spec should call this out
  ("V2.c depends on V2.a + V2.b registering their descriptors
  so cards with `defaultViewerType: 'image'` rehydrate
  correctly").
- V2.d: independent of persistence. Depends only on the V1.1
  MarkdownViewer + the new §4.0.B/C/D contract extensions.
  Ship-able in any order.

So the parts are not fully scope-independent: V2.c hard-depends
on V2.a + V2.b having shipped. Make this explicit in §7.1 or
§9 (Roll-back) — rolling back V2.a but keeping V2.c would
crash on rehydrate of image cards (no descriptor found).

### N9. Code-quality risk surface

§7.4 rehydrating-flag plus the §4.4 dirty-state plus the
shell-rendered Save button plus the mode toggle: these are all
new STATE on the TabContainer/viewer pair. The class-quality
risks from the V1.1 cycles ("global state across forms",
"destroy ordering") are not directly repeated, but the
rehydrate path (B2 + I1) introduces a NEW state — `rehydrating`
— that interacts with `destroyed`, `switching`, and
`activeViewerType` in ways the spec sketches but does not
formally invariant. Suggest adding to §4.0.H (V1.1's invariant
table, which §4.0 should extend):

| Invariant | Why |
|---|---|
| `rehydrating === true` implies `viewers.get(activeViewerType)` may be undefined. | Rehydrate factory has not resolved yet. |
| `destroy()` while `rehydrating === true` sets `destroyed = true`; the in-flight factory checks `destroyed` after each await and aborts. | Prevents resource leaks on close-while-rehydrating. |
| `isDirty()` is queried only for CONSTRUCTED viewers (`viewers.has(type)`), not all registered types. | An unconstructed viewer has no state to be dirty about. |
| The Save button is owned by TabContainer (not by any one viewer); the shell renders it based on `viewers.get(activeViewerType)?.isDirty?.()`. | Single source of truth for the button's visibility. |

These four invariants would make the implementation surface
obvious and reduce the risk of a regression cycle on V2.

---

## Summary

Two BLOCKERs (B1 backend schema validator, B2 silent
`openOrUpdateTab` refactor) gate V2.c and V2.a respectively.
Both are addressable with small additions to the spec text and
small code changes; neither requires a redesign.

Seven IMPORTANTs cluster around the same theme: V2 introduces
async state (rehydrate, save in flight, watcher-vs-editor) and
the spec sketches behavior without pinning invariants. Adding
the invariants table in N9 plus the load()-split in N7 and the
optimistic-save reordering in I2 closes most of the gaps.

Nine NICE-TO-HAVEs are documentation polish + small contract
pins (Error vs string, capture phase, label convention).

Recommendation: spec is close to ready. Address B1 and B2
before any V2 commit lands; address I1/I2/I4/I6 before V2.d
implementation begins; the rest can be folded in during
implementation review.
