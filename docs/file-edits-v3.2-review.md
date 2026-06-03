# File Edits V3.2 Review

Reviewed against: `docs/file-edits-v3.2.md`, context code as of current HEAD.

---

## [BLOCKER] programmaticScroll single-shot boolean cannot absorb two events from one tab switch

**File:** `docs/file-edits-v3.2.md` §"Pane scroll listener" (spec lines ~347–363)

The spec replaces V2's `{ target, ±1px }` value-comparison with a plain boolean
`programmaticScroll`. The justification: "only auto-scrolls are exactly 0 or saved —
no ±1px tolerance issue." That reasoning is wrong for the `activate()` path.

`activate(paneContainer)` does:
1. `paneContainer.innerHTML = ''` — if the container was scrolled, browsers clamp
   `scrollTop` to 0 as a side effect. **This fires a scroll event** (scroll event
   fires on any `scrollTop` change, programmatic or not).
2. `paneContainer.appendChild(this.paneEl)` — content added back.
3. rAF: `paneContainer.scrollTop = this.scrollTop` — **second scroll event**.

A single-shot boolean absorbs exactly one. If the innerHTML side-effect fires first,
the rAF write is treated as a user scroll: `followEdits` is flipped off and the new
active tab's `scrollTop` is overwritten with whatever the pane happens to be at.

The V2 implementation uses `pendingProgrammaticScroll = { target: clamped }` with
`Math.abs(st - target) <= 1` at `applets/file-edits/script.js:493–497`. This
survives multiple firings because each event is compared against the known target
value, not consumed by a flag-clear. V3.2 needs the same approach — or avoid the
innerHTML side-effect by hiding the pane rather than clearing it (`display:none`
while swapping children).

**Resolution:** Either revert to the `{ target }` value-comparison pattern, or
change `activate()` to hide the pane container, swap content, then unhide (no
scrollTop side-effect). Document the chosen approach.

---

## [BLOCKER] FileTab constructor calls `this.render()` but spec also recommends lazy — contradiction breaks `update()` under either interpretation

**File:** `docs/file-edits-v3.2.md` §FileTab class (lines ~167–228) vs §Risks (lines ~623–625) and §Open questions Q1 (lines ~634–637)

The constructor code in the spec explicitly calls `this.render()` (eager). But the
Risks section says "Mitigated by lazy rendering: each tab's `paneEl` is built on
first `activate()`, not on construction." Open Question 1 asks the same and answers
"Recommend lazy."

This is a contradiction within the spec. The problem it creates:

**If eager (constructor renders):** `initFromPersistence` creates 50 placeholder
`FileTab` instances synchronously — all 50 get a full `renderFullFile` call on
their placeholder edit (which has no `fullFile`, so falls back to hunk-view showing
"(no diff)"). Then `fetchSnapshot` arrives and calls `tab.update(edit)` which
re-renders each. Two full render passes per tab on startup. The Risks section says
this is mitigated by lazy; it is not mitigated if render is in the constructor.

**If lazy (`paneEl` built on first `activate()`):** `update()` calls `this.render()`
(spec line ~189) which touches `this.paneEl`. If `paneEl` is null (not yet
activated), `render()` must be a no-op (just update `this.edit`). The spec does not
say `update()` checks `if (!this.paneEl) { this.edit = newEdit; return; }`. An
implementer following the spec as written will try to render into null and either
crash or create a detached pane that is never inserted.

**Resolution:** Pick lazy (the spec's own recommendation). Explicitly state:
1. `render()` is not called in the constructor — `paneEl` is null until first `activate()`.
2. `update(newEdit)` does: `if (!this.paneEl) { if (!contentEqual) this.edit = newEdit; return; }` — deferred render.
3. `activate()` calls `render()` if `paneEl` is null, then appends.

---

## [IMPORTANT] `badgeCounter` referenced in `openOrUpdateTab` but never declared

**File:** `docs/file-edits-v3.2.md` §"Tab open flow" (spec line ~331): `badgeCounter.add(id)`

`badgeCounter` appears only once in the entire spec. The state machine section
(lines ~240–244) declares `followEdits`, `activeTabId`, `tabs`, `lastEditedTabId` —
no `badgeCounter`. The Follow-edits button reads a count (`N` badge), so a
`Set<string>` or counter is needed. Spec must define:

- Type: `Set<string> badgeCounter` (tracks paths edited while followEdits was off).
- Cleared when: `followEdits` becomes true (Follow button click), and on session change.
- Does a manual tab click on a badged path decrement the badge? The spec doesn't say.
  Omitting this means the badge count never decreases until the Follow button is clicked.

---

## [IMPORTANT] `fetchSnapshot` V3.2 implementation missing from spec

**File:** `docs/file-edits-v3.2.md` §"Initial load" (lines ~395–416)

`initFromPersistence` ends with `await fetchSnapshot()`. The current implementation
at `applets/file-edits/script.js:1550–1579` calls `applyEdits(data.edits, cleared)`.
V3.2 replaces `applyEdits` with `openOrUpdateTab`. But the spec never shows what
`fetchSnapshot` looks like in V3.2 — no updated pseudocode, no description of how
"paths in persisted list but absent from snapshot" are handled (in V2.1 this was
the `cleared` array fed to `applyEdits`; in V3.2 there's no equivalent path shown).

Specifically, when `fetchSnapshot` returns, V3.2 must:
1. For each edit in the snapshot: call `tab.update(edit)` if tab exists, else
   `openOrUpdateTab(edit)`.
2. For each tab whose path is NOT in the snapshot: mark as clean (no analogous
   mechanism is defined for V3.2 tabs — the card concept of `markClean` is gone).

The spec needs a `fetchSnapshot` section.

---

## [IMPORTANT] `setActiveTab` does not set `followEdits = false` — caller contract not stated

**File:** `docs/file-edits-v3.2.md` §`setActiveTab` (lines ~280–297)

The transition table (line ~252) says "User clicks a tab in the strip → `false`."
But `setActiveTab` itself only calls `updateFollowButton()`; it never touches
`followEdits`. The click listener (not shown in spec) must set `followEdits = false`
BEFORE calling `setActiveTab`.

The danger: `initFromPersistence` and `fetchSnapshot` both call paths that end in
`setActiveTab` (via `openOrUpdateTab` when `followEdits=true`). Those calls must NOT
set `followEdits = false`. The spec correctly achieves this by not setting it in
`setActiveTab`, but the spec never states "setting `followEdits = false` is the
CALLER's responsibility, not `setActiveTab`'s." Without this statement, an
implementer might add `followEdits = false` to `setActiveTab` and break
auto-follow-on-first-edit.

**Resolution:** Add one sentence to §`setActiveTab`: "`setActiveTab` does not modify
`followEdits`; callers that represent user gestures (tab click, X, picker) must set
`followEdits = false` themselves before calling it."

---

## [IMPORTANT] `jumpToMostRecent` picks highest `mtimeMs` across ALL tabs — misaligned with badge semantics

**File:** `docs/file-edits-v3.2.md` §`jumpToMostRecent()` (lines ~259–275)

The badge counts "distinct files edited while followEdits was off." The Follow button
implies "take me to what changed while I was away." But `jumpToMostRecent` picks the
tab with the highest `edit.mtimeMs` across **all open tabs** — including tabs that
were already at their current state when followEdits turned off.

Scenario: user has 49 old tabs with mtimes from earlier sessions, then turns off
followEdits, then one file is edited (a new or updated tab). `jumpToMostRecent`
should jump to that one file. But if any of the old 49 tabs has a higher `mtimeMs`
(e.g. a large file that was modified at 3am), the Follow button jumps there instead.
The badge showed `1 new edit` but the jump target is wrong.

`lastEditedTabId` (set in `openOrUpdateTab` on every incoming edit) is the correct
jump target for the Follow button: "the most recently *arrived* edit since we started
tracking." `jumpToMostRecent` should use `lastEditedTabId` as primary target and only
fall back to mtimeMs comparison if `lastEditedTabId` is null or closed.

---

## [IMPORTANT] `initFromPersistence` comment contradicts "no auto-activate" rule

**File:** `docs/file-edits-v3.2.md` §"Initial load", comment on line ~400:
`"Pane stays empty / shows the first tab as active per the 'no auto-activate' rule."`

The second clause ("shows the first tab as active") directly contradicts the rule
it cites. No tab should be auto-active at load. The comment should read:
`"Pane stays empty — no tab is auto-activated (followEdits=true; first incoming
edit or user click will activate)."` Minor but creates confusion for implementers.

---

## [NICE] `evictOldestNonActive()` not specified for defensive edge case

**File:** `docs/file-edits-v3.2.md` §"Preserved invariants" + §"Edge cases" (cap eviction)

With `TAB_CAP=50`, `evictOldestNonActive()` always has ≥49 non-active tabs when
called (only one can be active). So the "all tabs active" case is truly impossible.
But the function should silently no-op if it somehow finds no non-active tab — rather
than removing the active tab or crashing. Spec doesn't state this defensive behavior.
One line: "If no non-active tab exists (impossible at TAB_CAP=50), no-op."

---

## [NICE] Stale rAF scroll event can corrupt new tab's saved `scrollTop`

**File:** `docs/file-edits-v3.2.md` §"Pane scroll listener" (lines ~347–356)

Sequence during tab switch (A → B):
1. Click B: `followEdits = false`, then `setActiveTab('B')`.
2. `setActiveTab`: `A.deactivate(paneEl)` saves A's scroll; `activeTabId = 'B'`; `B.activate(paneEl)`.
3. `activate`: `innerHTML = ''` may fire scroll event. At this point `activeTabId` is
   already `'B'`. If `programmaticScroll` was already consumed by a prior event,
   this unfiltered scroll event runs: `tabs.get(activeTabId)` = B, so
   `B.scrollTop = paneEl.scrollTop` = 0 (pane was just cleared). B's saved scroll
   is overwritten with 0 before the rAF can restore it.
4. rAF: `paneContainer.scrollTop = B.scrollTop` = 0 (already corrupted).

B's saved scroll is lost. This is the downstream consequence of the single-shot
boolean issue ([BLOCKER] #1) — fixing #1 also fixes this.

---

## [NICE] "Not a git repo" UI state not described in V3.2 HTML/JS

**File:** `docs/file-edits-v3.2.md` §HTML (lines ~522–539)

V3.1/V2 uses `<div id="feNotGit">` to show an error when the session's cwd is not a
git repo. V3.2's HTML spec removes `feNotGit`. The spec says "The 'not a git repo'
message moves into the empty pane area" (line ~541) but doesn't show the code for
detecting this condition or populating the empty pane message with it. The current
`fetchSnapshot` path at `script.js:1555–1560` checks `res.status === 404` and shows
`emptyEl` — the analogous V3.2 behavior is unspecified.

---

## [NICE] Scroll save in listener is redundant with `deactivate()` — defense-in-depth is fine but should be noted

**File:** `docs/file-edits-v3.2.md` §"Pane scroll listener" (line ~355):
`if (active) active.scrollTop = paneEl.scrollTop;` vs `deactivate()` saving the same.

Both paths save the scroll. `deactivate()` is the authoritative save (called on every
tab switch). The listener save is defense-in-depth for cases where `deactivate()` is
missed (shouldn't happen but guard is cheap). Add a brief comment in the spec noting
this is intentional redundancy, not a bug.

---

## [QUESTION] X on active tab — recommendation not promoted to normative

**File:** `docs/file-edits-v3.2.md` §"Edge cases" (lines ~559–561) and §"Open questions" Q2 (lines ~638–640)

The edge cases section says "Choose: the previous tab in strip order (left neighbor),
or null if the closed tab was the leftmost." Open Question Q2 says "Recommend left
neighbor; null if no neighbor." But neither section promotes this to normative text
in the state machine. The implementer has two places to look and they conflict in
register (one is a choice, the other a recommendation). Promote to normative:
"X on active tab activates the left neighbor, or sets `activeTabId = null` (empty
pane) if the closed tab has no left neighbor."

---

## [QUESTION] Does a manual tab click decrement `badgeCounter`?

**File:** `docs/file-edits-v3.2.md` §State machine, transition table (lines ~248–257)

The transition table says "User clicks a tab in the strip → `followEdits = false`."
The badge label reads "N new edits." If the user manually clicks the tab that caused
the `N=1` badge (rather than clicking Follow), should the badge count drop? The spec
doesn't say. If it doesn't drop, the badge is misleading (it says `1 new edit` even
after the user just read it). If it does, we need `badgeCounter.delete(id)` in the
tab click handler.

---

## [QUESTION] Active-tab persistence rationale is inaccurate — server already accepts unknown fields

**File:** `docs/file-edits-v3.2.md` §"Open questions" Q5 (lines ~644–646):
"Would require bumping `schemaVersion` to 2 server-side (otherwise the existing
validator rejects unknown fields)."

Verified: `src/routes/file-edits.ts:144–158` only validates `schemaVersion`,
`cards`, and `dismissed`. Unknown fields in the PUT body are silently ignored — no
400 is returned. Separately, `src/file-edits-store.ts:75–80` passes only `cards` and
`dismissed` to `setSessionData`, so an extra `activeTabId` field in the PUT body
would be accepted by the server but **dropped on disk** (not persisted).

The correct statement: "Storing the active tab requires extending `setCardList`'s
`body` parameter and the `CardList` type — a server change. A schema bump is
optional (old clients will encounter the new field on GET and ignore it since they
don't read `activeTabId`). The server validator does not need to be changed."

## Summary

| Severity | Count | Topics |
|---|---|---|
| [BLOCKER] | 2 | programmaticScroll single-shot (#1), eager/lazy contradiction (#2) |
| [IMPORTANT] | 5 | badgeCounter undeclared (#3), fetchSnapshot missing (#4), setActiveTab caller contract (#5), jumpToMostRecent semantics (#6), comment typo (#7) |
| [NICE] | 4 | evictOldestNonActive edge case (#8), stale scroll corruption (#9), not-git-repo UX gap (#10), scroll-save redundancy note (#11) |
| [QUESTION] | 3 | X normative (#12), badge decrement on click (#13), active-tab persistence rationale (#14) |

**Total: 14 findings.**

The client-only constraint is verified achievable: the server PUT validator
(`src/routes/file-edits.ts:148–155`) accepts `{ schemaVersion: 1, cards: [{relativePath, collapsed: false}, ...], dismissed: [] }` without changes.
