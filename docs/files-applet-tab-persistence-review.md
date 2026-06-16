# Files Applet — Tab-Persistence UX Review

**Scope:** why reopening a session reopens "17 tabs," and what the
restore model *should* be. Design-level; informs a follow-up spec.

## 1. What actually happens on reopen (verified)

`initFromPersistence(sid)` (script.js:3506) does two things, in order:

1. Rehydrates the **persisted cards** — the tabs the user explicitly
   had open (script.js:3520–3627). This is correct and desirable.
2. Unconditionally calls **`fetchSnapshot()`** (script.js:3630), which
   GETs `/file-edits/snapshot` and calls `openOrUpdateTab()` for
   *every* entry (script.js:3495–3499). The server's `snapshot()`
   returns the entire git-dirty set via `git status --porcelain`
   (git-edit-poller.ts:618–648). One dirty file ⇒ one tab.

The suppression that *would* stop step 2 from re-opening closed tabs —
`dismissedPaths` / `dismissedSnapshots` (script.js:1637–1656,
1821–1828) — is **in-memory only** and is **cleared on every session
switch** (script.js:3707–3708) and **never persisted**. So on reopen
the dismissed set is empty and *nothing* filters the dirty-file flood.

**Conclusion:** the "17 tabs" are not restored user tabs. They are the
dirty-file snapshot replayed as editor tabs, with the only suppression
mechanism reset to empty. The user closing tabs in a prior session has
zero effect on the next open. This is a design bug, not a tuning bug.

Supporting facts:
- The server card list carries a `dismissed: string[]` field
  (file-edits-store.ts CardList) that the client **always writes as
  `[]`** (script.js:2036) and the snapshot path **never reads**. It is
  fully vestigial — dead state kept in the schema and across two
  validators (routes file-edits.ts + store).
- `TAB_CAP = 50` (script.js:90); `enforceTabCap` evicts oldest
  non-active tabs (script.js:1620). So the flood is bounded at 50, not
  truly unbounded — but 50 is well past "a lot of middle-clicking."

## 2. Recommended restore model

**Persisted open tabs are the editor. The dirty set is not.**

| Source | Role | On reopen |
|---|---|---|
| Persisted cards | The user's open editor tabs | Restore exactly these |
| Dirty-file snapshot | Live working-tree state | Do **not** auto-open as tabs |
| `git-status` view | Survey of all dirty files | Opt-in panel/tab the user opens |

Argue for **(a) only the tabs the user explicitly had open**, plus a
*separate, single* git-status surface for "what else is dirty." Reasons:

- **One source of truth for tabs.** Tabs = persisted cards. Full stop.
  The snapshot stops being a tab source on reopen; it only *refreshes
  content* of already-restored diff tabs (which is what the
  placeholder fast-path at script.js:3574–3588 actually needs).
- **No suppression bookkeeping.** If the snapshot never opens tabs, the
  entire `dismissedPaths` / `dismissedSnapshots` machinery and the
  `dismissed[]` field exist only to fight a self-inflicted flood. Kill
  the flood and the bookkeeping evaporates. Correct-by-design: there is
  nothing to keep in sync.
- **Matches user mental model.** "I closed it, it stays closed" is the
  invariant every editor honors. Today we violate it on reopen.

Hybrid (c) is the wrong default: it reintroduces the exact "tabs I
didn't open" problem and forces persisted suppression to tame it.

## 3. Follow-edits × persistence

"Follow edits" (auto-open + focus on agent edit; `followEdits`,
script.js:1700) is correct **during a live session** — the user is
watching the agent work. The bug is conflating *live auto-open* with
*reopen replay*.

Rules:

| Phase | caco.edit auto-opens tab? | Snapshot opens tabs? |
|---|---|---|
| Live session, followEdits on | Yes (intentional) | n/a |
| Live session, followEdits off | No (update existing only) | n/a |
| **Reopen / session switch** | n/a | **No** — restore cards only |

Note `followEdits` already auto-disables on any manual close
(script.js:1842) and resets to `true` on session switch
(script.js:3701). Keep that. The fix is solely: **on reopen, the
snapshot must not be a tab-creation source.** Live `caco.edit` events
arriving *after* reopen still auto-open under followEdits — that's the
agent actively editing, which is the feature working as intended.

## 4. Bulk-close affordances

Middle-clicking N tabs is a genuine UX failure. The applet has
per-tab auxclick close (script.js:438–444) but **no bulk close**.
Warranted, in priority order:

1. **Close all** — clears the tab strip in one gesture. Highest value
   given the complaint. Honor the existing isDirty prompt
   (script.js:1793) once, aggregated.
2. **Close others** — right-click a tab ⇒ keep this one, close the
   rest. Standard editor affordance; cheap once "close all" exists.
3. **Close to the right** — optional; lower value, skip for v1.

Surface: a tab-strip context menu (right-click) plus an overflow
"×" / "Close all" control. These are pure client additions; no schema
or server change. They also become the *manual* escape hatch if any
residual snapshot tabs ever appear.

## 5. Is the dirty snapshot the right default at all?

No — not as **editor tabs**. The dirty set is *status*, not *open
documents*. It belongs in a dedicated **git-status surface** (a single
panel/tab listing dirty files with per-file "open diff" links — the
infrastructure already exists; `git-status`'s per-file diff link is
referenced in routes file-edits.ts and openFile supports diffMode).

The snapshot should remain available on reopen for exactly one
non-tab-creating purpose: **hydrating the content of already-restored
diff cards** (the placeholder tabs at script.js:3577–3588 need real
working-tree diffs). That is an *update*, not an *open*. Make the
reopen path call a "refresh restored tabs" routine that updates
existing containers and ignores paths with no container — instead of
`openOrUpdateTab`, which creates.

## 6. Minimal fix vs. ideal redesign

### Minimal, correct-by-design fix

**Make the reopen snapshot update-only.** One behavioral change:
`fetchSnapshot()` called from `initFromPersistence` must not create
tabs for paths that have no restored container.

- Add an `updateOnly` flag to the snapshot consumption so that, for a
  path with no existing container, it returns instead of constructing
  (guard at script.js:1659, before the `if (!container)` create block).
- Pass it only from the reopen call site (script.js:3630). Live
  `caco.edit` (script.js:3683) keeps full open semantics.

Effect: reopen restores exactly the persisted cards and refreshes their
content. The "17 tabs" disappear by construction. No new persistence,
no dismissed-set replay.

**Then delete the now-dead machinery** (separate, low-risk commit):
`dismissedPaths`, `dismissedSnapshots`, the close-time snapshotting
(script.js:1811–1829), the suppression branch (script.js:1636–1656),
and the `dismissed[]` field across client write (script.js:2036),
route validators, and store (file-edits-store.ts). With the snapshot no
longer a reopen tab-source, suppression has nothing to suppress.

Add **bulk-close** (§4 items 1–2) as a small independent change.

### Ideal redesign

- **Two distinct surfaces.** Editor tabs (persisted cards only) and a
  first-class **git-status panel** (opt-in, single tab) for the dirty
  set with per-file open-diff actions. The snapshot feeds the status
  panel, never the tab strip.
- **Single tab-source invariant.** Tabs are created by exactly two user
  gestures (open-a-file, agent-edit-under-followEdits) and restored
  from cards. The snapshot is demoted to a data feed. This removes the
  whole class of "tabs I didn't open" bugs.
- **Persistence stays minimal:** cards = `{ relativePath,
  defaultViewerType, activeViewerType, diffMode }`. Drop `dismissed[]`
  and `collapsed` (already vestigial). No second code path to sync.
- **Bulk-close + context menu** as the standard editor affordance set.

The minimal fix and the ideal share the same core move — *the dirty
snapshot stops creating tabs on reopen* — so the minimal fix is a
strict subset of the redesign, not throwaway work.
