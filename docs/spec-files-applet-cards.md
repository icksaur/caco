# spec-files-applet-cards

Status: **proposed**. Sub-spec of `docs/spec-files-applet.md`. Replaces the two
overlapping viewer-switch button mechanisms (`updateToggle` + `updateModeToggle`) with a
single declarative **card registry**: each file-type has an ordered list of navigable
**cards**, each card has a **verb**, and the tab's top-right strip shows a verb button for
every reachable card except the active one.

## Fit
- Goal it serves: a consistent, exhaustive, single-vocabulary way to move between a file's
  alternate renderings (source / edit / diff / preview / media) within one tab.
- Invariants in scope (must be actively honored — this spec exists because they were not):
  - **One button vocabulary, one source of truth.** Verbs come from the card registry, never
    from viewer descriptor `label`s AND viewer `getModes()` labels in parallel.
  - **Active state is a single derived card id.** The active card is *computed* from the real
    `(activeViewerType, activeMode)` via `currentCardId()`, never stored as a second field, so it
    cannot diverge from the viewer state — not after a cancelled dirty-prompt, a failed
    `switchViewer`, or a direct `setMode`/`switchViewer` call from the agent-replay or diff bridge.
    An `(activeViewerType, mode)` that names no card maps to the default; the strip only ever
    offers ids in the list.
  - **Every reachable alternate is directly reachable.** The strip shows all non-active cards
    at once — no "cycle to the next viewer," no verb that vanishes because the active viewer
    happens to lack `getModes()`.
  - **The card model is a thin layer over the existing viewer instances.** Lazy construction,
    eviction timers, the dirty-prompt on an outgoing viewer, and the diff selection bridge are
    unchanged — `switchCard` delegates to the current `switchViewer` + `setMode` machinery.
- Contradiction check: root spec §Design still says "one *default* viewer per type" — kept;
  default selection (`isDefault` order) is unchanged. Only the alternate-navigation UI changes.

## Goals
The tab's top-right corner shows one button per alternate card (labelled by verb). Clicking a
verb navigates to that card. The set of buttons is the same function of (file-type,
capabilities) every time, so the "diff/view/edit/source appear inconsistently" behavior is
gone. Default viewer, persistence, agent echo, diff selection, and Save all keep working.

## Design

### The card registry (the new source of truth)
A **card** is `{ id, verb, viewerType, mode? }`. The `id` is the persisted active-card key and
the strip's stable button id. The universe of cards:

| id | verb | realizes | availability predicate |
|---|---|---|---|
| `preview` | Preview | markdown viewer, view mode | markdown ext (`.md/.markdown/.mdx`) |
| `source` | Source | source viewer, view mode | non-binary |
| `edit` | Edit | the file's editable-text viewer, edit mode | non-binary AND `caps.canEdit` AND not read-only |
| `diff` | Diff | diff viewer | non-binary AND `caps.canDiff` AND not read-only (in-cwd git session; an external/read-only file isn't in the repo) |
| `image` | Image | image viewer | image ext |
| `audio` | Audio | audio viewer | audio ext |
| `html` | HTML | html viewer (sandboxed iframe) | `.html/.htm` |

**The `edit` card is singular per file** — it resolves to `(markdown, edit)` for markdown files
and `(source, edit)` otherwise. This is the key de-duplication: today "markdown edit mode" and
"source edit mode" would both surface an "Edit"; the registry collapses them into one `edit`
card so no file ever shows two Edit verbs.

**`cardsForFile(rel, caps, isReadOnly) → Card[]`** — pure, ordered, the whole contract:
- `.md/.markdown/.mdx` → `[preview, edit?, diff?, source]`
- image ext → `[image]`
- audio ext → `[audio]`
- `.html/.htm` → `[html, edit?, diff?, source]`
- other non-binary → `[source, edit?, diff?]`
- binary non-media (no viewer) → `[]` (unchanged: not openable)

(`edit?` present iff `caps.canEdit && !isReadOnly`; `diff?` present iff `caps.canDiff &&
!isReadOnly`.) Order is the strip render order. The **default card** is the first card whose
descriptor `isDefault` matches today (markdown→`preview`, image→`image`, audio→`audio`, html→`html`, else `diff` when
`canDiff` else `source`) — default selection is unchanged, only alternates change.

### Rendering: one strip replaces two toggles
Delete `updateToggle` (the viewer toggle) and `updateModeToggle` (the mode toggle) and their two
buttons. Add `renderCardVerbs()`: read `active = currentCardId()`, then for each card in
`this.cards` where `card.id !== active`, render a verb button `→ <verb>` whose click calls
`switchCard(card.id)`. **Every site that previously called `updateToggle()` or
`updateModeToggle()`** (construction, post-`switchViewer`, post-`setMode`, apply-state replay,
rehydrate) now calls `renderCardVerbs()` — a mechanical rename, and because the active id is
derived, none of those callers need card logic. Layout reuses the existing top-right stack
geometry (the chrome-button offset math in `updateChromeButtons` reads the number of visible verb
buttons instead of the old mode-toggle-visible flag).

**Save is not a card verb.** `getChromeButtons()` (Save, etc.) stays a per-viewer action surface,
rendered alongside but distinct from the verb strip — Save acts *within* the `edit` card, it does
not navigate.

### State: the active card is DERIVED, never independently stored
The reported odd states come from two pieces of state that can disagree; the fix is to have
**one** piece of truth. The tab's real state stays what it is today — the active viewer instance
and that viewer's internal mode. The active **card** is a *pure function of that*:
`currentCardId()` = reverse-map `(this.activeViewerType, activeViewer.getActiveMode?())` → the
matching card id in `this.cards` (e.g. `(source, edit) → edit`, `(markdown, view) → preview`,
`diff → diff`). It is **computed on read**, not stored. Consequences (both MUST guards become
structural, not procedural):
- **Transactional by construction.** `switchCard(cardId)` looks up the card (absent → no-op),
  then delegates to the existing `await switchViewer(card.viewerType)` + `setMode(card.mode)`.
  Those already own the dirty-prompt cancel and can fail — but `switchCard` commits **nothing**
  of its own. It just `renderCardVerbs()` afterward, which reads `currentCardId()`. If the
  transition was cancelled or threw, `activeViewerType`/mode are unchanged, so the derived card is
  unchanged and the strip is still correct. There is no `activeCardId` field to leave dangling.
- **No bypass.** Every existing direct caller of `switchViewer('diff')` / `setMode(...)` (the
  agent-selection/apply-state replay, the rehydrate open, the diff **selection bridge**) needs no
  card-awareness: because the id is derived, the strip re-derives correctly after any viewer/mode
  change. The one required edit is mechanical — **every site that today calls `updateToggle()` /
  `updateModeToggle()` after such a change instead calls `renderCardVerbs()`** (same call sites,
  one function). Optionally route human navigation through `switchCard` for uniformity, but
  correctness does not depend on it.

`this.cards = cardsForFile(relPath, caps, isReadOnly)` is still computed once at construction (the
available set). Only the *active* selection is derived.

### Persistence back-compat
`CardPersist` gains `activeCard?: string` (the card id) — on save, written as
`currentCardId()`. On rehydrate:
- If `activeCard` is present AND in `cardsForFile(...)` → open that card (resolve to its
  viewerType+mode).
- Else map the legacy `(activeViewerType, mode)` pair: `(source|markdown, edit) → edit`,
  `(markdown, view) → preview`, `(source, view) → source`, `diff → diff`, `image|audio|html →`
  that id.
- If the mapped id is not in the current card list (file/caps changed) → the **default card**.
The writer keeps emitting legacy `activeViewerType`/`mode` too (for one release) so a downgrade
still reads a sane tab; `diffMode` is unchanged. Rehydrate opens the card via the normal
viewer-open path, so the derived `currentCardId()` immediately agrees with what was persisted.

## Considerations
- **Strip width.** A writable in-cwd markdown file now shows 3 alternate verbs (Edit, Diff,
  Source) instead of today's 1–2. Intended ("show all alternatives"); the layout stacks them.
- **Concatenation constraint.** Applet files are browser globals concatenated at load, not ES
  modules. To give the registry a real (non-drifting) unit oracle, `cardsForFile` + the card
  table live in a new `applets/files/card-registry.js` with a UMD tail
  (`typeof module !== 'undefined' && (module.exports = …)`) so the browser sees a global and
  vitest CJS-imports the **same** source (no "inlined, keep in sync" copy).
- **`getModes()`/`setMode()` stay** on the text viewers — the `edit` card *uses* them. What moves
  to the registry is the *decision of which buttons exist*, not the mode mechanism.
- **Diff selection bridge + eviction unchanged.** `switchCard('diff')` is the same entrypoint the
  selection bridge already calls; verbs just replace how a human reaches it.
- **Agent echo.** `echoState` adds `activeCard`; keep `activeViewer`/`activeMode` fields for
  agent back-compat.

## Risks and Mitigations
- **Regressing the diff/selection or dirty-prompt flows** (they hang off `switchViewer`). →
  `switchCard` is a thin wrapper over the unchanged `switchViewer`/`setMode`; no diff/selection
  code changes. Visual signoff covers the diff→source→edit round-trip.
- **Persisted tabs from the old schema mis-restore.** → the legacy `(activeViewerType, mode)`→id
  mapping + default fallback is oracle-tested; the writer emits both shapes for one release.
- **Wider strip crowding small tabs.** → verbs use the existing 40px stack; if crowding is a
  visual problem at signoff, overflow handling is a follow-up, not a blocker.

## Acceptance
- Observable (visual signoff — the pin, per the applet convention): open `vitest.config.ts`
  in-cwd; the strip shows exactly the non-active verbs of `[source, edit, diff]` with ONE
  vocabulary; clicking any verb goes straight to that card (no cycling); switching to `diff` still
  shows `Source` + `Edit` (not just `Source`); a markdown file shows `[preview, edit, diff,
  source]` minus active; an external/read-only file drops `edit` and `diff`; Save still appears in
  the `edit` card; scroll/mode/active-card survive tab reopen + session switch.
- Budgets: no new per-turn cost; suite wall-clock unchanged (registry test is pure).
- Gates: `npm run build` green (typecheck ×2, lint:strict, knip, tests, build:client,
  check:coverage, check:frontend-coverage, check:specs).
- Oracles:
  - **Impossible-state pin (pure, the core guard):** `cardsForFile` hand cases —
    `.ts` in-cwd writable → `[source, edit, diff]`; `.ts` external read-only → `[source]`;
    `.md` in-cwd writable → `[preview, edit, diff, source]`; `.png` → `[image]`;
    `.html` in-cwd writable → `[html, edit, diff, source]`; and `edit?`/`diff?` toggle off with
    `canEdit:false`/`canDiff:false`.
  - **switchCard guard:** an id not in `this.cards` is a no-op (derived active card unchanged).
  - **Derived-id / transactional oracle:** `currentCardId()` returns the id matching the actual
    `(activeViewerType, activeMode)`; after a `switchCard` whose outgoing viewer is dirty and the
    discard prompt is declined (transition cancelled), the derived card id and the rendered strip
    are unchanged (no divergence). A direct `setMode('edit')`/`switchViewer('diff')` flips the
    derived id without any `switchCard` call.
  - **Registry↔viewer drift oracle (integration):** for a representative extension per branch
    (`.ts`, `.md`, `.png`, `.wav`, `.html`, a binary non-media), every card `cardsForFile` emits
    resolves to an installed viewer descriptor whose `canHandle` accepts that path — no card can
    name a viewer that isn't present/compatible.
  - **Rehydrate mapping:** `(source, edit) → edit`, `(markdown, view) → preview`,
    `diff → diff`, an unknown/incompatible legacy pair → the default card.

## Plan
| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 1 | Add `card-registry.js`: `CARD_KINDS` table + pure `cardsForFile(rel, caps, isReadOnly)` + `defaultCardId(...)` + legacy `(viewerType,mode)→id` mapper, UMD tail | `applets/files/card-registry.js` | pure hand-case tests (impossible-state pin, rehydrate mapping) | one-vocabulary; single-source registry |
| 2 | Unit-test the registry (CJS-import the same file): impossible-state pin, rehydrate mapping, AND the registry↔viewer drift oracle (every emitted card resolves to an installed compatible descriptor) | `tests/unit/files-applet-card-registry.test.ts` | ref/hand cases above | tests-assert-behavior; no-registry-drift |
| 3 | `TabContainer`: compute `this.cards`; add `currentCardId()` (derived) + `switchCard(id)` delegating to existing `switchViewer`/`setMode`, committing nothing of its own; guard unknown ids | `applets/files/script.js` | switchCard-guard + derived-id/transactional test + visual | thin-layer; derived-id (no divergence) |
| 4 | Replace `updateToggle` + `updateModeToggle` with `renderCardVerbs()`; **sweep every `updateToggle()`/`updateModeToggle()` call site → `renderCardVerbs()`** (construction, post-switch, post-setMode, apply-state replay, rehydrate, diff bridge); rewire chrome-button offset to verb count; keep Save separate | `applets/files/script.js`, `applets/files/style.css` | visual signoff | one-strip; no-bypass; Save-not-a-verb |
| 5 | Persistence: write `activeCard` (=`currentCardId()`, +legacy), rehydrate mapping + default fallback; `echoState` adds `activeCard` | `applets/files/script.js`, `src/file-edits-store.ts` (type only) | rehydrate-mapping test + visual | back-compat; default-fallback |
| 6 | Build + visual signoff (the walkthrough in Acceptance) | — | `npm run build`; visual | gate-green |

## Rationale (skippable)
The bug: two independent single-alternative buttons — the descriptor-driven viewer toggle
(`updateToggle`, labels Diff/Source/Markdown…) and the active-viewer's mode toggle
(`updateModeToggle`, labels View/Edit) — surfaced the `(viewerType × mode)` card space through
two vocabularies with independent visibility rules, so the alternates a user saw depended on
which viewer was active and collapsed multiple options into "cycle to next." Flattening to a
curated `fileType → cards` registry with one verb per card, and making the active state a single
id from that list, removes the second mechanism entirely and makes the inconsistent combinations
unrepresentable rather than merely discouraged.
