# Spec: Files-applet editor state persistence (Feature C)

Status: draft. Builds on `docs/session-lifecycle-architecture.md`. Two phases, divisible.

## Goal
Survive a session reload / switch with the files applet's **selected tab, per-tab scroll,
and viewer mode** intact (C1). Longer term, keep the top MRU applet DOM live so warm
applets restore instantly with no cold rebuild (C2). Persisted state must be cleaned up on
session delete (roadmap **R1**), not added as another orphan.

## What's lost today (and what already survives)
Tab list, strip order, `activeViewerType`, and `diffMode` already persist to
`files-cards.json` and restore on load. **Lost:** the selected tab (`activeTabId` is never
written), per-tab scroll (never captured), viewer mode (`view`/`edit`), and unsaved editor
text. On reload all panes are `display:none` and the empty state shows.

---

## C1 — Persist active tab + scroll + mode (do first; self-contained)

### Scope decision: persist mode, scroll, active-tab — NOT unsaved edits
Persisting unsaved `_editorText` is **rejected** (data-loss surface): on reload each viewer
re-`load()`s fresh `_diskText`, so a restored stale buffer breaks `isDirty()`'s baseline and
a later Ctrl+S would silently overwrite newer disk content — exactly what the
`_diskChangedWhileEditing` guard exists to prevent, which can't help because reload reset the
baseline. The existing `beforeunload` native confirm already guards accidental reloads.
Restoring `mode:'edit'` IS safe: `setMode('edit')` re-seeds `_editorText` from the freshly
loaded `_diskText`, landing the user back in an editor on current disk content with a clean
buffer. (Full autosave-with-conflict-detection is a separate, larger feature.)

### Server: zero schema change (use per-card additive fields)
`isCardPersist` validates only known props and does NOT strip unknown ones, so **new
PER-CARD fields round-trip untouched** through `setCardList`/`getCardList`. Encode:
- `active: true` on the selected card (a top-level `activeTabId` would be dropped by
  `putCardsHandler`, which forwards only `{cards, dismissed}` — so keep it per-card; resolve
  to the first card flagged active, ignore extras),
- `scroll: <number>` per card,
- `mode: 'edit'` per card (omit for view).
No `file-edits-store.ts` or route change required.

### Client — `applets/files/script.js` + viewers
1. **Capture** in `buildPersistBody` (`~2076-2099`): for each card add
   `active: container.id === activeTabId`, `scroll` (active viewer's scroll), and `mode`
   (only `'edit'`). Snapshot scroll lazily here from the viewer at persist time.
   **Persist triggers — must add (scroll/mode don't schedule persistence today):**
   - `setMode` (the UI toggle at `script.js:483-491`) does NOT call `schedulePersist()`; add
     one so a mode change is captured.
   - Scroll changes schedule no persist either. Add a debounced `schedulePersist` on the
     active viewer's scroll, OR — simpler and sufficient — rely on the fact that
     `buildPersistBody` snapshots scroll live at persist time AND ensure a persist is
     scheduled on tab switch/mode/edit (already frequent); note `flushPersist` only sends the
     *prior pending* body (`~2117-2126`), so a beforeunload flush needs a fresh
     `schedulePersist`/rebuild first to capture the latest scroll. Wire a rebuild-on-flush (or
     a final `buildPersistBody` in the beacon path) so the last scroll/mode isn't lost.
2. **Viewer scroll API**: add `getScrollState()/setScrollState(n)` to MarkdownViewer and
   SourceViewer (read/write `contentEl.scrollTop`). DiffViewer already tracks `scrollTop`
   (restored by its own `activate`) — just seed it from the card.
3. **Restore** in `initFromPersistence` (`~3592-3717`) at the construction-aware hooks
   (active-tab/scroll/mode must apply AFTER the viewer exists):
   - record `pendingActiveTabId`/`pendingScroll`/`pendingMode` from cards during the loop;
   - **sync diff fast-path** (`~3660-3674`): seed `scrollTop`, and if this card is active and
     `activeTabId` is still `null`, `setActiveTab` it;
   - **async factory path** (`~3692-3705`, in the `.then` after `viewers.set`): seed scroll,
     `setMode('edit')` if persisted (safe — `open` awaited `load`, so `_diskText` is set),
     and `setActiveTab` if this is the pending-active container and `activeTabId===null`.
     **Also mirror the live path's mid-rehydrate activation**: the live async path activates
     the viewer if its tab became active while rehydrating (`script.js:1722-1726`); the
     rehydrate `.then` (`~3692-3705`) does NOT — add the same `if (activeTabId === container.id)
     viewer.activate()` so a tab the user clicked during rehydrate actually renders.
   - **Selection-stomp guard**: only auto-select while `activeTabId===null` (never override a
     user tab-click that raced in during rehydrate).
   - **Missing/failed active card**: if the flagged-active card's file was deleted/dismissed
     before reload (its container is never created) or its async viewer factory rejects
     (`.then` error path → container destroyed), `activeTabId` stays `null` and the applet
     shows the empty state — acceptable; do NOT fall back to selecting an arbitrary tab.
   - **Scroll-after-layout + post-fetch reapply**: apply scroll on a double-rAF (as
     `scrollPaneToFirstDiffRow` does). `initFromPersistence` calls `fetchSnapshot(true)` AFTER
     the restore loop (`~3715-3716`), and a diff `update()` re-renders and resets scroll
     (`diff-viewer.js:96-109`). So a diff scroll seed MUST be re-applied after that snapshot
     completes (re-seed post-`fetchSnapshot`, or have `update` preserve a pending restore
     scroll) — a one-time seed before the fetch is not enough.
4. **R1 dependency**: ensure the new fields are cleaned on delete — covered once
   `SessionManager.delete()` removes the Caco dir (roadmap R1). C1 should be implemented with
   R1, or explicitly note the leak is pre-existing and R1 fixes it for all stores.

### Acceptance (C1)
- Visual: open several files (mix of diff/markdown/source), select one, scroll it, put a
  source/markdown tab in edit mode; switch away and back / reload → same tab selected, same
  scroll, edit mode restored on a clean buffer. A tab clicked during rehydrate wins over the
  restored selection. Cards saved before the feature (no new fields) load with defaults
  (no selection, scroll 0, view).
- Gate green. Mandatory visual signoff (UI/persistence).
- Oracle: a unit over the pure `buildPersistBody`→card mapping (active/scroll/mode encoded
  correctly) and the per-card `active`-resolution (first-flagged wins) if extractable.

---

## C2 — MRU live-DOM retention (large; depends on roadmap R3)

Keep the top 3-5 MRU applet instances alive (hidden) instead of destroy-on-switch; cold-load
only on cache miss. **Requires R3** (applet `activated`/`deactivated` hooks) and benefits
from R2 (single generation + clean deactivate). All applets benefit.

### Hard constraints (confirmed against code)
- **One live instance per slug**, keyed by current session — NOT N-per-slug. This sidesteps
  the slug-scoped CSS (`scopeAppletCSS`) and `[data-slug]` script-selector collisions that
  multiple same-slug instances would hit.
- **Session-tag** every cache entry `{slug, sessionId}`; reuse only on exact match, evict on
  mismatch. A cached files applet holds session A's tabs — never show it under B.
- **No event multi-delivery to hidden instances.** Listeners are kept alive by `cleanupFns`
  and are not visibility-gated; a hidden files applet would process `caco.edit` and race the
  visible instance's persist to the **same `files-cards` key** (last-writer corruption).
  Use **unsubscribe-on-hide + resync-on-show** (`fetchSnapshot(true)`), not a queue.
- **`pendingAppletState`** is a single global cleared on switch — must become per-instance or
  be gated so only the visible instance may stage send-state.

### Plan (C2)
1. Land **R3** (activated/deactivated lifecycle hook) from the architecture roadmap.
2. `applet-runtime.ts`: add an MRU map (size 3-5, one-per-slug, `{slug,sessionId}`-keyed); on
   switch hide+flush+unsubscribe instead of `destroyInstance`; evict LRU and on session
   mismatch.
3. Files applet: on `deactivated` → flush persist + unsubscribe; on `activated` → resubscribe
   + `fetchSnapshot(true)` (reuses live DOM/scroll/edit buffers — the point of C2).
4. Flag-gated rollout; C1 still required for the cold/evicted path.

### Acceptance (C2)
- Switch away from files applet and back within MRU window → instant restore, live scroll +
  unsaved edit buffers intact, no cold rebuild, no persist-key corruption, no cross-session
  tab leakage. Evicted/cold sessions fall back to C1 restore. Gate green + visual signoff.

---

## Order
1. **R1** (delete cleanup) — tiny, unblocks safe persistence.
2. **C1** — medium, self-contained, fixes the felt loss for cold and warm loads.
3. **R3 → C2** — large, general win; only after C1 and the lifecycle hook.
