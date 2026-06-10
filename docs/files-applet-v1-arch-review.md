# Files applet V1 — §4.0 architecture-section review

Scope: `docs/files-applet-v1.md` §4.0 (class-level design) cross-checked
against the rest of the spec, `plan.md`, the prior review
(`docs/files-applet-v1-review.md`), today's
`applets/file-edits/script.js`, and the `watchPath` runtime surface in
`public/ts/applet-runtime.ts`.

The user's directive ("no diagrams; prose + tables; ownership and
relationships matter; LLM agents have to consume this") is followed
faithfully — every claim in §4.0 is a row or sentence, never a picture.
That part is solid.

Severity tiers (same as prior review):

- **BLOCKER** — fix before code starts; spec/plan will produce a wrong
  result, or §4.0 contradicts a step the plan does not change.
- **IMPORTANT** — fix before merge; a hasty implementer will misread.
- **NICE-TO-HAVE** — polish.

---

## Summary

§4.0 is a strong addition. The ownership table (§4.0.2), the
shell-API table (§4.0.3), and the lifecycle states (§4.0.5) are exactly
the right shape for a fresh Sonnet/Haiku session to internalise without
needing conversation context.

But there are **three places where §4.0 introduces invariants the plan
never implements** — the spec describes a teardown ordering and a
coalesced `echoState` that don't exist today and that no plan step
introduces. Plus a handful of internal contradictions (§4.0 vs §4.5,
§4.0.4 vs §4.0.7 Flow A, §4.0.2 vs §4.0.3).

| # | Severity | Topic |
|---|---|---|
| A1 | BLOCKER | §4.0.5 rule 2 ("remove from `tabs` BEFORE `destroy()`") is violated by today's `closeTab` (script.js line 879 destroys before line 880 deletes) and by `onSessionChange` teardown (script.js line 1955 destroys before line 1956 clears). No plan step reorders these. |
| A2 | BLOCKER | §4.0.3 claims `shell.echoState()` is "coalesced internally"; today's `echoState()` is synchronous (script.js line 806/897), and no plan step adds a coalescer. Spec asserts a behaviour the code won't have. |
| A3 | BLOCKER | §4.0.7 Flow E step 4 ("setActiveTab on new before destroying the old") contradicts §4.0.5 rule 2 and would call `setActiveTab` while the closed tab is still the active id with an empty map slot. See A1 — the two need to be reconciled together. |
| B1 | IMPORTANT | §4.0.4 row "constructor MUST NOT touch the network" vs Flow A step 4 "factory returns a TabInstance already in mounted-inactive state (constructor already mounted tabEl and contentEl)" and §4.5 `MarkdownTab.open` doing `await inst.load()`. The constructor / factory distinction needs to be spelled out — implementers will not consistently know which rule applies where. |
| B2 | IMPORTANT | §4.5 spec shows `MarkdownTab.open` doing `await load(); then acquire watcher`. `plan.md` step 5.3 explicitly inverts this ("Acquire watcher FIRST (resolves I3)"). §4.0.7 Flow A doesn't pick a side. Spec and plan disagree. |
| B3 | IMPORTANT | §4.0.2 row says tabs reach the active id via `shell.getActiveTabId()`. §4.0.3 does not list `getActiveTabId` anywhere. The two tables disagree. |
| B4 | IMPORTANT | §4.0.6 invariant "at most one tab has `display !== 'none'`" requires that tabs be constructed with `contentEl.style.display = 'none'` *before* the shell decides whether to activate. Neither §4.0.2 nor the plan (step 5.1, step 3.1) spells out the initial display value. A constructor that defaults to visible breaks the invariant for the second tab opened. |
| B5 | IMPORTANT | Error semantics for `MarkdownTab.open` are unspecified. If `shell.api.watchPath` rejects (lease cap, ENOENT, permission), the tab has already constructed `tabEl` + `contentEl` and mounted them. Who unmounts? Nothing in §4.0 or the plan says the routing code must `destroy()` a partially-constructed tab on factory rejection. |
| B6 | IMPORTANT | §4.0.5 row "constructed" exit condition is internally inconsistent: it says "shell mounts tabEl + contentEl AND first activate()", but §4.0.2 + plan have the **tab class** mount its own DOM in the constructor. Per §4.0.2 the tab is already in mounted-inactive the moment the constructor returns. |
| C1 | NICE-TO-HAVE | §4.0.2 omits `TAB_CAP = 50` (script.js line 57) and `lastEditedTabId` (line 34). Both are shell-owned state that survive V1. |
| C2 | NICE-TO-HAVE | Nothing in §4.0 addresses the applet visibility lifecycle (`appletAPI` exposes `onSessionChange` but the runtime's `showInstance` / `_hideInstance` at `public/ts/applet-runtime.ts:808` are private). Recommend an explicit "hide/show is invisible to tabs; only session-change destroys" note. |
| C3 | NICE-TO-HAVE | §4.0.4 contract row for `update` has no MUST-NOT entries — easy place to call out "MUST NOT call `shell.closeTab(this.id)`" and "MUST NOT mutate sibling tabs". |
| C4 | NICE-TO-HAVE | "Applet teardown" is mentioned once (§4.0.2 last row) but never given a flow. The DOM gets ripped out by `applet-runtime`; tabs' `destroy()` is **not** called in that path today. Either add a Flow F or note explicitly that applet-teardown ≠ session-switch and the runtime drops the DOM without ceremony. |

---

## BLOCKERS

### A1. §4.0.5 rule 2 vs today's teardown ordering — no plan step bridges the gap

§4.0.5, "Critical ordering rules", rule 2:

> The shell removes the tab from `tabs` BEFORE calling `destroy()`.
> This means in-flight async callbacks that re-enter the shell ...
> cannot find the tab again.

And rule 6:

> Session-switch destroy ... captures the array first, then clears the
> map, THEN calls `destroy()` on each captured tab.

Today's `closeTab` (script.js):

```
879:    tab.destroy();
880:    tabs.delete(id);
```

Today's session-switch teardown (script.js):

```
1955:      tabs.forEach(function(t) { t.destroy(); });
1956:      tabs.clear();
```

Both are **destroy-before-remove**, the opposite of what §4.0.5 mandates.

`plan.md` Step 2.4 adds `DiffTab.prototype.destroy` (a no-op refactor)
and Step 5.4 adds `MarkdownTab.destroy`, but no step touches the
ordering in `closeTab` or in the session-switch handler. After the plan
is fully executed, the runtime will still be in violation of §4.0.5
rules 2 and 6.

The asymmetry matters for `MarkdownTab`: its watcher fires
asynchronously. If a watch event arrives between `tab.destroy()` and
`tabs.delete(id)` (or, more realistically, the watcher's `onChange`
callback runs against an aborted-but-not-yet-deleted tab) the shell's
old assumption "tabs in the map are alive" silently breaks. The
`this.destroyed` flag in §4.0.5 rule 3 / plan step 5.4 catches *part*
of this, but rule 2 was meant to make that flag redundant for shell
re-entry — not just for tab re-entry.

**Fix options** (pick one and either way add a plan step):

- (preferred) Add an explicit "Step 1.7 — refactor `closeTab` and
  session-switch teardown to delete-before-destroy" before any new tab
  type lands. Update §4.0.5 to keep its current wording (it is correct).
- Or, soften §4.0.5 rules 2 and 6 to say "MAY remove before destroy if
  the runtime needs hard re-entry safety; today's code removes after
  destroy and relies on the `destroyed` flag". This is weaker; A2 and A3
  also depend on the stronger ordering, so the refactor is cleaner.

### A2. §4.0.3 says `echoState()` is coalesced; today's `echoState()` is synchronous and no plan step adds coalescing

§4.0.3 row for `shell.echoState`:

> Coalesced internally; tabs may call freely.

Today's `echoState()` (script.js around line 244, called at lines 771,
806, 897, etc.) directly invokes `appletAPI.setAppletState(...)` on
every call. No microtask batching, no rAF coalescing.

Plan Step 7 reworks `buildFileEditsState` → `buildFilesState` but
**still calls `setAppletState` synchronously** from `echoState()` — it
preserves the current call sites verbatim.

The "tabs may call freely" line in §4.0.3 is load-bearing for
`MarkdownTab.load()`: every external-edit re-render calls
`shell.echoState()` (Flow B step 3). A watcher firing 5× in a 200ms
burst (the server's 150ms coalesce window catches some, not all) will
cause 5× full `setAppletState` writes back-to-back. The previous review
note about "renders thrashing for large files" (§6.5 risk row 1) talks
about DOM cost, but the state-echo cost is not separately mitigated.

**Fix:** either add a plan step that wraps `echoState()` in a
`queueMicrotask` / `requestAnimationFrame` coalescer (1-call-per-frame
is plenty for agent state), or remove the "coalesced internally" claim
from §4.0.3 and replace with "synchronous; callers should avoid
high-frequency calls". The first option is preferable because it makes
the contract less foot-gunny.

### A3. Flow E step 4 vs §4.0.5 rule 2 — ordering paradox

§4.0.7 Flow E step 4:

> If `id === activeTabId`, shell picks a new active id (next tab in
> insertion order, or null if empty) and calls `setActiveTab` on it
> **before destroying the old one**.

§4.0.5 rule 2 (above) says the closed tab is removed from `tabs`
BEFORE `destroy()`. Step 4 leaves the old tab in the map until after
`setActiveTab(newActive)` runs, contradicting rule 2.

Worse: `setActiveTab` reads `tabs.get(activeTabId)` for the previous
tab (script.js line 786). At Flow E step 4, `activeTabId` still equals
the to-be-closed id, so `setActiveTab(newActive)` will call
`deactivate()` on the dying tab. If §4.0.5 rule 2 had already removed
it from the map, `setActiveTab` would see `prev = null` and skip
`deactivate` — which is *also* fine because closing a tab doesn't need
its scroll position saved, but the two interpretations need to agree.

**Fix:** rewrite Flow E to match the actual intended sequence after
A1's refactor:

```
1. tab = tabs.get(id); if (!tab) return;
2. wasActive = (id === activeTabId);
3. neighbour = (wasActive ? pickNeighbour(id) : null);
4. tabs.delete(id);  // rule 2: remove from map first
5. if (wasActive) {
     activeTabId = null;
     if (neighbour) setActiveTab(neighbour);  // deactivate(prev=null), activate(neighbour)
   }
6. tab.destroy();    // detach DOM, abort fetches, close watcher
7. echoState();
```

(Note that `deactivate` on the dying tab is skipped — which is correct;
its scroll/selection state is about to be discarded.)

---

## IMPORTANTs

### B1. §4.0.4 "constructor MUST NOT" rules vs the `open()` static factory

§4.0.4 first row:

| Method | ... | MUST NOT |
| constructor `(shell, ...)` | Once per tab, from the tab-type `open()` factory | Throw asynchronously; touch the network; assume `shell.sessionId` won't change later in this page-load. |

But the `open()` static factory does touch the network — Flow A and
§4.5 both have `MarkdownTab.open` calling `fetch` and `watchPath`
inside it.

A hasty implementer reads "constructor MUST NOT touch the network",
sees that `MarkdownTab.open` is conceptually the constructor, and
either (a) hoists the fetch out into the shell, or (b) inlines it
illegally. Spell out:

- The **constructor** is synchronous, must not throw, must not touch
  the network. It mounts DOM only.
- The **static `open(shell, ...)` factory** is allowed (encouraged) to
  await network calls. It must `destroy()` the constructed tab if any
  await rejects, before re-throwing. See B5.

Add a row to §4.0.4 for `static open(shell, abs, rel): Promise<TabInstance>`
with its own MUST/MUST-NOT cell.

### B2. §4.5 vs plan §5.3 — load-then-watch vs watch-then-load

§4.5 spec (lines 402-408):

```ts
static async open(shell, absPath, relPath) {
  const inst = new MarkdownTab(absPath);
  await inst.load();
  inst.watcher = await shell.api.watchPath(absPath, { scope: 'file' });
  inst.watcher.onChange(() => void inst.load());
  return inst;
}
```

`plan.md` Step 5.3:

> **Acquire watcher FIRST** (resolves I3):
> `tab._watcher = await shell.api.watchPath(absPath, { scope: 'file' });`
> Then `tab._watcher.onChange(() => void tab.load());`
> Call `tab.load()` once.

These are opposite orderings, both claimed authoritative. The prior
review's I3 is on the side of watch-first (so an edit during the
initial fetch can't be missed). Update §4.5's pseudocode to match plan
Step 5.3, and ideally add a brief "why" comment ("first-load racing
with first-edit must not silently drop the edit").

### B3. §4.0.2 references `shell.getActiveTabId()` that §4.0.3 doesn't list

§4.0.2 row for `activeTabId`:

> ... tabs reach the active id via `shell.getActiveTabId()` if needed.

§4.0.3 enumerates the shell-side API: no `getActiveTabId`. Either
- add it to §4.0.3 (then add it to `ShellAPI` in §4.8), or
- remove the mention from §4.0.2 and say "tabs do not learn the active
  id; they learn they are active via the `activate()` callback".

The second is cleaner and matches the rest of the §4.0.4 contract
(activation is push-based). Recommend that.

### B4. Initial `display` of `contentEl` is unspecified

§4.0.6 invariant: "At most one tab in `tabs` has its
`contentEl.style.display !== 'none'` at any given time."

§4.0.2 row for `contentEl`: "mounted by the tab into `shell.paneEl`."

Plan Step 3.1: "Each DiffTab gains a persistent `contentEl` ... mounted
into `paneEl` at construction. ... Inactive tabs' `contentEl` has
`style.display = 'none'`."

Plan Step 5.1 (MarkdownTab constructor): "Creates `contentEl` =
... Mounts into `shell.paneEl`." — no display setting.

If a constructor mounts with default display (`block` for divs), the
invariant is violated for the very first frame after the second tab is
constructed. Add to §4.0.5 mounted-inactive row, or to §4.0.4
constructor row: **the constructor MUST set `contentEl.style.display
= 'none'`; the shell will flip it on the first `activate()`.**

### B5. Error path: factory rejection leaves orphan DOM

If `MarkdownTab.open` (per plan Step 5.3) does `await
shell.api.watchPath(...)` first, and that rejects (lease cap, ENOENT,
acquire HTTP error — see `public/ts/applet-runtime.ts:641-661`), the
constructed tab has already created and mounted `tabEl` + `contentEl`.
Currently nothing in §4.0 or in any plan step says "the routing code
must call `tab.destroy()` on rejected factory promises before
re-throwing".

§4.0.7 Flow A step 4-5 jumps straight from "factory returns" to
"shell `tabs.set(...)`", with no error branch.

Add to §4.0.7 Flow A:

> 4a. If `chosen.open` rejects, log the error, do NOT add to `tabs`,
>     and verify the partially-constructed tab cleaned up its own DOM
>     (factories MUST `await partial.destroy()` before re-throwing, OR
>     MUST defer mounting until all awaits succeed).

The "defer mounting" alternative is simpler — constructors build DOM
but don't attach to `shell.paneEl` / `shell.tabStripEl`; the factory
attaches only after the last `await` succeeds. Recommend that pattern
and add it to §4.0.4 / §4.0.5 (the "constructed" state becomes truly
detached, and "mounted-inactive" is the first state with DOM in the
tree).

### B6. "Constructed" state exit condition is contradictory

§4.0.5 row "constructed":

| Entered when | Exited when |
| Tab constructor returns | `shell` mounts tabEl + contentEl AND first `activate()` call |

But §4.0.2 says the tab class mounts its own DOM in its constructor.
So at the moment the constructor returns, mounting has already
happened — there is no observable "constructed-but-unmounted" state
for the shell.

Reconcile by either:
- adopting the B5 fix (constructor does NOT mount; the factory mounts
  after awaits succeed) — then "constructed" is a real, brief, useful
  state, and the row's exit condition becomes "factory attaches
  `tabEl` + `contentEl`".
- or collapsing "constructed" into "mounted-inactive" — the three real
  states are mounted-inactive, active, destroyed.

The B5 fix is the more useful one because it also fixes the orphan-DOM
problem.

---

## NICE-TO-HAVEs

### C1. §4.0.2 misses two pieces of shell state

- `TAB_CAP = 50` (script.js line 57) — the limit that triggers
  `evictOldestNonActive`. An invariant ("`tabs.size <= TAB_CAP` at all
  times outside `openOrUpdateTab`'s critical section") belongs in
  §4.0.6, and the cap belongs as a row in §4.0.2.
- `lastEditedTabId` (script.js line 34) — drives `jumpToMostRecent`.
  Shell-owned, lives for the applet's life, not touched by tabs.

Neither is fatal, but if the table is meant to be exhaustive (per the
user's "ownership and relationship specifications are important")
they should both appear.

### C2. Applet visibility (vs session change) not mentioned

`appletAPI` exposes only `onSessionChange`. The runtime also has
`showInstance` (public/ts/applet-runtime.ts:808) and `_hideInstance`
(line 815), but they don't notify the applet — the DOM stays in place,
just hidden. So tabs' watchers keep firing while the applet is hidden.
This is correct today, but a §4.0 reader might worry. Add a one-line
note to §4.0.5 or §4.0.7 Flow C:

> Applet hide/show (e.g. when the user switches to a different
> applet) does not destroy tabs. Only `onSessionChange` triggers
> teardown. Hidden applets keep their watchers active.

### C3. §4.0.4 `update` row has no MUST-NOTs

The row reads "(no other restrictions)". Worth calling out:

- MUST NOT call `shell.closeTab(this.id)` from inside `update`.
- MUST NOT touch sibling tabs.
- MUST NOT throw — the shell iterates many tabs per `caco.edit` event
  and a throw aborts the loop.

### C4. "Applet teardown" lifecycle is missing as a flow

§4.0.2 mentions "shell unsubscribes on applet teardown" but there is no
Flow F covering it. The reality: `applet-runtime` rips the applet's
DOM out of the page when the user navigates away; tabs' `destroy()` is
NOT called. Watchers expire via their 5-minute server TTL, fetches die
when the iframe unloads.

This is fine, but spell it out — otherwise an implementer might add
elaborate `beforeunload` plumbing that doesn't help.

Suggested addition:

> **Flow F — Applet teardown (page navigation away):**
> The Caco runtime removes the applet's DOM subtree. Tab `destroy()`
> methods are **not** invoked. Outstanding watchers expire via the
> server-side lease TTL (5 minutes); outstanding fetches abort when the
> iframe is detached. Tabs MUST NOT rely on `destroy()` for resource
> safety against this path; the only guaranteed cleanup is server-side
> lease expiry. This is acceptable in V1 because the only client
> resources are watchers (TTL'd) and fetches (auto-aborted).

---

## Section-by-section answers to the review brief

**1. Completeness of §4.0.2 ownership table** — Near-complete. Misses
`TAB_CAP` and `lastEditedTabId` (C1). All major instances accounted for.

**2. §4.0.3 surface exhaustiveness** — Distinguishes DiffTab-only vs
all-tabs well in the right-hand column. Inconsistent with §4.0.2 on
`getActiveTabId` (B3). Missing initial-display rule for `contentEl`
(B4). Otherwise complete; private vs public is clear.

**3. §4.0.4 TabInstance contract** — Good coverage of common gotchas
(`shell.closeTab` from `destroy`, `shell.echoState` from `destroy`,
sibling access from `activate`). Misses constructor/factory split (B1),
`update` MUST-NOTs (C3), and the constructor's display-none rule (B4).

**4. §4.0.5 lifecycle state machine** — Four states are right.
Transitions are mostly complete. "Destroy without `deactivate` is
legal" is clearly stated in the "active" row. "Remove from map before
destroy" is stated in rule 2 — but the **code doesn't honour it** (A1)
and Flow E step 4 contradicts it (A3). The "constructed" exit
condition is muddled (B6).

**5. §4.0.6 invariants** — Each row is a real property. Two are not
provably maintained: the display-none invariant has no constructor
rule to back it (B4), and the destroy-once invariant relies on rule 2
which the code doesn't honour (A1). Tension with §4.0.7 Flow E (A3).

**6. §4.0.7 critical flows** — Five flows are the right cut (open,
re-render, session switch, edit, close). Each step is mostly accurate.
Flow A is missing the factory-rejection branch (B5). Flow B doesn't
say the watcher exists before `load()` runs (B2). Flow E step 4
contradicts rule 2 (A3).

**7. Is the section actionable by a fresh implementer?** — Mostly yes,
but the contradictions (A1/A3, B1, B2, B6) will produce divergent
implementations across two fresh sessions. After the BLOCKERs and
IMPORTANTs above, yes, this section alone + plan would suffice.

**8. Consistency with earlier sections** —

| §4.0 claim | Conflicts with | Resolution |
|---|---|---|
| §4.0.3 `echoState` coalesced | §4.8 (no coalescer in `ShellAPI` shape) and plan Step 7 (sync rewire) | A2 — add coalescer or drop claim |
| §4.0.5 "remove before destroy" | §4.6 / §4.10 (don't specify ordering) and today's code | A1 — add a plan step |
| §4.0.2 `getActiveTabId` | §4.0.3 (not listed) and §4.8 `ShellAPI` interface (not listed) | B3 — drop the mention |
| §4.5 `MarkdownTab.open` ordering | plan Step 5.3 | B2 — make §4.5 match plan |
| §4.0.4 constructor MUST NOT network | §4.5 / Flow A "factory" steps | B1 — split constructor vs factory |
| Flow E step 4 ordering | §4.0.5 rule 2 | A3 — rewrite Flow E |

§4.0 SHOULD be the source of truth (the whole point of adding it). So
the resolution rule is "§4.0 wins; rewrite §4.5, §4.6, §4.8, and the
plan to match". State this explicitly somewhere in §4.0 — a
one-sentence "When this section disagrees with §4.5 / §4.6 / §4.8 /
plan.md, this section is authoritative" header would do it.

**9. Anything missing for "architecture quality"** —

- Error semantics for `open()` rejection (B5).
- Resource limits: `TAB_CAP` (C1).
- Applet teardown / hide-show vs session change (C2 + C4).
- Initial display state for `contentEl` (B4).
- Coalescing semantics for `echoState` (A2).
- An explicit "this section wins on disagreement" pointer (see §8 above).

---

## Recommended order of fixes

1. A1 (add plan Step 1.7 "delete-before-destroy refactor") — unblocks
   A3 and B5.
2. A3 (rewrite §4.0.7 Flow E to match the refactored ordering).
3. A2 (decide on `echoState` coalescing; if yes, add a plan step; if
   no, soften §4.0.3 wording).
4. B1 + B6 + B5 in one pass: split constructor from factory in §4.0.4
   and §4.0.5; add the "factory rejection ⇒ destroy partial" rule.
5. B2 (rewrite §4.5 pseudocode to match plan Step 5.3).
6. B3 (drop `getActiveTabId` mention).
7. B4 (require `display:none` in constructor).
8. NICE-TO-HAVEs C1-C4 as polish.

After 1-7, §4.0 is internally consistent, consistent with §4.5/4.6/4.8,
consistent with plan.md, and self-sufficient for a fresh implementer.
