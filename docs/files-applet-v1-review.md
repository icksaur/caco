# Files applet V1 — spec + plan review

Reviewer pass against `docs/files-applet-v1.md` and `plan.md`, with
`code-quality.md` as the maintainability rubric. Focus areas: TabInstance
contract completeness, plan executability for a fresh Sonnet session,
two-type abstraction soundness, risk coverage, and a checklist of
specific concerns called out in the review brief.

Severity tiers:

- **BLOCKER** — fix before implementation starts; the plan/spec is wrong
  or will produce a non-working result.
- **IMPORTANT** — fix before merge; ambiguity or design gap that an
  implementer will resolve incorrectly without guidance.
- **NICE-TO-HAVE** — clarification or polish; doesn't block correctness.

---

## Summary

The spec is in good shape — the TabInstance contract is small, the V2+
stubs are concrete enough, and the two-type choice is well justified
(§6.1). The plan, however, has **three correctness bugs** that will
cause the implementer to either break existing behavior or fail to
compile/run:

1. Step 2.2 renames a method that conflicts with an existing method of
   the same name (BLOCKER).
2. Step 7.1's `buildFileEditsState` rewrite silently drops the
   `sourceId` field and moves the payload off the `fileEdits` namespace,
   breaking the cross-tab echo-loop guard and every agent that reads
   `tabs.fileEdits.selection` (BLOCKER).
3. Step 1 underestimates the FileTab extraction: FileTab's methods call
   ~7 shell-local helpers (`closeTab`, `setActiveTab`, `paneEl`,
   `renderBody`, `programmaticScrollTo`, `updateFollowButton`,
   `badgeCounter`, `followEdits`). A blind cut-paste produces a
   `ReferenceError` on first activation (BLOCKER).

A handful of IMPORTANT items (ShellAPI never constructed, watcher race
on first load, redundant client-side debounce, persistence filter
missing line citation) and a few NICE-TO-HAVEs round it out.

---

## BLOCKERS

### B1. Plan §2.2 — `render` → `update` rename collides with existing `update`

The plan says:

> Rename `DiffTab.prototype.render` → `update`. Existing callers in
> script.js: rename their calls too.

But `FileTab.prototype.update(newEdit)` **already exists** at line 130 of
today's `script.js` and is what the shell calls on `caco.edit` arrival
(see `openOrUpdateTab` line 841: `contentChanged = tab.update(edit);`).
`render()` is an internal helper invoked by `activate()` and `update()`
that re-runs `renderBody(this.paneEl, this.edit)`.

The existing `update(edit)` already matches the TabInstance contract
shape from the spec (§4.6 says "where it calls `tab.render(edit)`, it
now calls `tab.update(edit)`"). The existing `render()` should stay as
an internal method, perhaps renamed to `renderBody` or `repaint` to
avoid confusion — **but not to `update`**.

**Fix:** Drop step 2.2's rename. Leave `update(edit)` unchanged (it
already satisfies the contract); leave the internal `render()` alone or
rename to `repaint()`. Update §4.6 of the spec to clarify that DiffTab
already implements `update(edit)` and no rename is needed.

### B2. Plan §7.1 — composite `setAppletState` drops `sourceId` and the `fileEdits` envelope

The proposed body:

```js
return {
  tabs: arr,
  activeTabId: activeTabId,
  file: diffActive ? diffActive.relPath : null,
  selection: diffActive ? diffActive.selection : null,
};
```

Two problems compared to today's `buildFileEditsState` (script.js
lines 229-237, called by `echoState()` at line 244):

1. **`sourceId` is dropped.** Today's payload includes a per-page-load
   UUID that is the **only mechanism** preventing cross-tab agent-echo
   loops (see the comment at lines 213-222). Without it, two browser
   tabs of the same applet will ping-pong selection state forever once
   either receives an agent-pushed selection.

2. **The shape moves from `{ fileEdits: { activeTab, selection,
   sourceId } }` to top-level `{ tabs, activeTabId, file, selection }`.**
   The spec §8 acceptance criterion explicitly says "the existing
   diff-side `tabs.fileEdits` shape stays accessible to agents via a
   compat fragment", but the plan's code does not preserve that
   envelope. Any agent reading `tabs.fileEdits.selection` will see
   `undefined`.

   Note also that the current code calls
   `appletAPI.setAppletState({ fileEdits: buildFileEditsState() })`
   (line 244) — the wrapping happens at the call site, not inside
   `buildFileEditsState`. The plan rewrite muddles the two layers.

**Fix:** Plan §7.1's composite shape must wrap the new fields under a
new top-level key (e.g. `files`) **and** keep the legacy `fileEdits`
fragment unchanged when the active tab is a diff. Concretely:

```js
function buildAppletState() {
  return {
    fileEdits: buildFileEditsLegacyState(),   // unchanged shape + sourceId
    files: {                                  // new composite
      tabs: arr,
      activeTabId,
    },
  };
}
```

Keep `buildFileEditsLegacyState` byte-identical to today's
`buildFileEditsState` (including `sourceId`). Add a unit-test-grade
assertion in the smoke checklist that the legacy keys still appear.

### B3. Plan §1.1 — moving `FileTab` lines 60–196 won't compile in isolation

The plan says to move "the `FileTab` constructor and prototype methods
(lines 59-196 of today's `script.js`) into the new file" with no other
changes. But those 137 lines reference these shell-scope names:

| Name | Where used in FileTab | Defined in shell |
|---|---|---|
| `closeTab` | `buildTabEl` click + auxclick handlers | line 866 |
| `setActiveTab` | `buildTabEl` click handler | line 777 |
| `followEdits` (let-var) | `buildTabEl` click handler | line 27 |
| `badgeCounter` (Set) | `buildTabEl` click handler | line 37 |
| `updateFollowButton` | `buildTabEl` click handler | (elsewhere) |
| `renderBody` | `FileTab.prototype.render` | (elsewhere) |
| `paneEl` (DOM ref) | `activate`, `deactivate` | line 21 |
| `programmaticScrollTo` | `activate` | line 49 |
| `basename` | `buildTabEl` | line 197 |

After a blind extraction, `diff-tab.js` will throw `ReferenceError:
closeTab is not defined` the first time the user clicks a tab. The
`window.__filesApplet.DiffTab` namespace alone does **not** carry these
deps.

**Fix options** (the plan must pick one and document it):

- **Option A (least invasive):** Pass a `shell` object to the
  `DiffTab` constructor that exposes `closeTab`, `setActiveTab`,
  `paneEl`, `programmaticScrollTo`, `updateFollowButton`,
  `renderBody`, and getters for `followEdits` / `badgeCounter`. This
  is essentially the `ShellAPI` already mentioned in spec §4.8 but
  expanded for diff-only internals. Wire it in step 1, not in step 4.
- **Option B (export shell helpers globally):** Move `renderBody`,
  `basename`, `programmaticScrollTo` onto `window.__filesApplet` and
  rewrite FileTab handlers to dispatch user gestures via a small
  event-bus the shell subscribes to. More work, looser coupling.
- **Option C (move helpers too):** Cut `renderBody` and everything
  diff-rendering-related into `diff-tab.js` as well. The boundary
  becomes "anything that knows the diff card DOM" lives in
  `diff-tab.js"; this is probably the cleanest split but is much more
  than 137 lines.

**The plan as written compiles to a broken applet at step 1.4 smoke.**
Pick an option and rewrite step 1 to enumerate the helpers moved or
passed. Add file:line citations for each (most of the missing ones are
single-line lookups).

---

## IMPORTANT

### I1. `ShellAPI` is declared in the spec but never constructed in the plan

Spec §4.8 defines a `ShellAPI` interface and the registry's `open()` is
typed as `open(shell, absPath, relPath)` (§4.7). MarkdownTab.load() in
the spec calls `shell.echoState()` (§4.5, end of `load`). Plan §5.1
also references `shell.api.watchPath`.

But **no step in the plan creates the shell object or wires its
methods.** A fresh implementer will either fabricate it ad-hoc inside
the registry block or skip it and let MarkdownTab reach into module
scope directly (re-introducing the same coupling that necessitated the
abstraction).

**Fix:** Add an explicit step (e.g. Step 4.0) that constructs the
shell object once, before the registry is populated:

```js
var shell = {
  get sessionId() { return sessionId; },
  api: window.appletAPI,
  echoState: echoState,
  closeTab: closeTab,
};
```

Pass `shell` as the first arg to every `tabType.open(...)` call. State
in the plan that tab types **must not** reach outside this shell —
that's the entire point of the abstraction per §4.8.

### I2. MarkdownTab — 100ms client debounce is redundant with server's 150ms coalesce

`src/watch-store.ts` line 83: `const COALESCE_MS = 150;`. The server
guarantees only one `caco.fs.changed` event per lease per 150ms (see
also `docs/file-watch-leases.md` line 184: "Multiple changes to the
same path within the coalesce window are combined into one `onChange`
invocation"). A 100ms client-side debounce on top of that is **always**
dominated by the server window and contributes nothing except an extra
trailing-edge delay on the rendered output.

Either:

- **Remove the client debounce** (preferred — `onChange` is already
  appropriately rate-limited; trust the lease abstraction).
- **Or set it to a value that does something** — e.g. 300ms if we
  observe that on macOS FSEvents bursts produce multiple coalesced
  events for one logical save. Cite the measurement.

The spec's risk table (§6.5 row 1) cites "1 per 100ms client-side
debounce" as the mitigation for large-file DOM thrash. That's the wrong
mitigation: the real mitigation is the server coalesce (already in
place) plus, if needed, a render-cost guard inside MarkdownTab (skip
re-render if content hash unchanged). Update the risk + plan to match.

### I3. MarkdownTab — watcher acquired AFTER first `load()` creates a missed-edit race

Spec §4.5 and plan §5.2:

```js
static async open(shell, absPath) {
  const inst = new MarkdownTab(absPath);
  await inst.load();                                        // step A
  inst.watcher = await shell.api.watchPath(absPath, ...);   // step B
  inst.watcher.onChange(() => void inst.load());
  return inst;
}
```

If the file is rewritten between step A and step B, the watcher never
fires for that edit and the tab is stuck on the pre-edit content until
the next change. Two `await`s plus an HTTP round-trip is a long enough
window to hit this on a busy agent run.

**Fix:** Acquire the watcher **first**, install the `onChange` handler
that calls `load()`, then call `load()` once unconditionally. Any
intervening write fires the handler and the trailing load wins.

### I4. Plan §6.3 — chevron menu DOM lifecycle unspecified

The review brief flagged this explicitly. The plan only says "Clicking
chevron opens a small popover menu listing each tab type's label" —
not whether the `<ul>` is created once at init and shown/hidden, or
built on each click. Both are workable; pick one. Recommendation:
build-once on init (the type list is fixed for V1), toggle via
`hidden` attribute. Cite the existing `feOpen` picker's pattern for
consistency (`openPicker` / `closePicker` near line 1155).

### I5. Plan §8.3 — persistence filter needs a citation

> When PUTting cards back to server, FILTER to diff tabs only.

The function that builds the payload is `buildPersistBody` at line
1024 of `script.js`:

```js
tabs.forEach(function(_t, path) {
  list.push({ relativePath: path, collapsed: false });
});
```

The implementer needs to know to change this to:

```js
tabs.forEach(function(t, path) {
  if (t.type !== 'diff') return;
  list.push({ relativePath: path, collapsed: false });
});
```

Plan §8.3 should cite `script.js:1024-1031` so it's not a hunt. Same
applies to `flushPersistBeacon` near line 1073 (same payload shape).

### I6. Plan §9.1 — routing test duplicates the registry's logic

`code-quality.md` lists "code must be kept in sync" under "bad". The
plan's test:

> the test imports nothing from applet JS (applets aren't built);
> instead it inlines the routing decision table ... And implements
> `route(rel): string` matching the registry's canOpen logic.

This **is exactly** the "two implementations of the same rule that
must be kept in sync" antipattern. A future change to the markdown
extension list (adding `.mdown`, say) will pass the test while
breaking the applet.

Either:

- Extract the extension list to a JSON file that both the applet and
  the test load, **or**
- Skip the unit test entirely (the routing table is six lines of
  trivial extension matching; manual smoke covers it), **or**
- Wire applet JS through a minimal Node-side eval so the test imports
  the actual registry. (Probably overkill for V1.)

Recommendation: skip the test. Document the routing table once in the
spec and rely on smoke for V1.

---

## NICE-TO-HAVE

### N1. Id namespace asymmetry between diff (`relPath`) and markdown (`markdown:absPath`)

The review brief asked specifically about this. The risk table (§6.5
row 2) already covers it: bare-relPath for diff keeps the cards
backend happy; prefix for everything else avoids collisions. This is
fine, but the plan should spell out **once, in step 4** that the
`tab.id` value passed to `tabs.set(id, tab)` and used by `closeTab(id)`
/ `setActiveTab(id)` is whatever the tab type chose — the shell does
not interpret it. Today's shell uses `relativePath` as the id; the
new world uses `tab.id`. One-line audit of every `tabs.get(...)` /
`tabs.set(...)` / `tabs.delete(...)` / `tabs.has(...)` call site would
catch any place still assuming "id == relPath".

### N2. `pickFile` flow refactor — short-circuit-on-already-open lives where?

`pickFile` (line 1240) does three things: short-circuit if already
open, abort prior in-flight POST, then POST and open. After the
extraction:

- "Already open" check belongs in the **shell** (it's a Map lookup by
  whatever id the chosen tab type would have produced — but the type
  hasn't been chosen yet, so we need a tentative id). Easiest:
  shell asks the chosen tab type for the would-be id via a static
  method, then checks `tabs.has(id)`. **Not specified in plan.**
- AbortController belongs in DiffTab.open (it's diff-specific —
  markdown's fetch is short and idempotent; reissuing is fine).
- The `if (sid !== sessionId) return` post-await guard belongs in
  the shell (cross-cutting).

Plan §4.2 should spell out this split. Otherwise the implementer
either keeps `pickFile` largely intact (and step 4 doesn't actually
extract anything) or breaks the abort semantics.

### N3. Selection echo / follow-edits — verify nothing in the shell breaks for MarkdownTab

Review brief Q7. Inspection of the shell:

- `setActiveTab` calls `prev.deactivate()` and `next.activate()` —
  MarkdownTab implements both as no-ops per spec §4.5. Fine.
- `setActiveTab` calls `echoState()` which calls
  `buildFileEditsState()` which reads `activeTab.selection`. If the
  active tab is a MarkdownTab without a `.selection` property, today's
  code returns `{ activeTab, selection: null, sourceId }` which is
  benign. Fine — but only if the active-tab guard `!tab || !tab.selection`
  stays in place. (Plan §7.1 removes that guard structure; see B2.)
- `caco.edit` handler at line 1927-1928: iterates and calls
  `tab.update(edit)`. MarkdownTab doesn't implement `update`. The
  plan §4.6 of the spec says the shell will filter "by `t.type ===
  'diff'`" — make sure the plan actually adds this filter (it's
  implied in step 2.2/4.x but not explicit). Cite `script.js:1927`.
- `jumpToMostRecent` (line 900) reads `tab.edit.status` — would crash
  on a MarkdownTab. Same fix: filter to diffs.
- `evictOldestNonActive` (line 811): destroys oldest non-active. Fine
  — generic.
- `closeTab` (line 866): generic.

**Action:** Add a step (after step 2) that audits every `tabs.forEach`
/ `tabs.values()` iteration in the shell and adds a `t.type === 'diff'`
filter where the loop body assumes diff fields (`edit`, `selection`,
`scrollTop`). Estimated 4-6 sites.

### N4. `MarkdownTab.load` — no AbortController on the in-flight fetch

Spec §6.6 #4 resolves the race via a `destroyed` flag checked after
each `await`. This prevents DOM writes after destroy but doesn't
cancel the fetch — the browser still pulls bytes. For a 10MB markdown
file on a slow link, this matters. Tracking an AbortController and
calling `controller.abort()` in `destroy()` is two lines and resolves
both concerns cleanly. NICE-TO-HAVE because the destroyed-flag
approach is correct; the fetch is just wasteful.

### N5. Spec §4.2 — `subLabel` declared, never used in V1

The TabInstance contract declares `readonly subLabel?: string`
("+10/-3" for diffs). Neither DiffTab nor MarkdownTab uses it in V1
(today's diff tab label is just the basename; see `buildTabEl` at
line 75). Either implement the diff +/- in the V1 cut or remove
`subLabel` from the V1 contract and add it back in V2 when something
actually consumes it. Speculative interface fields age badly.

### N6. Spec §4.3 — type-specific icon classes (`fe-tab-diff`, `fe-tab-md`) declared but no style change planned

Plan §1-§5 don't add CSS for these classes. Plan §7 mentions
`applets/file-edits/style.css` "Small additions for chevron + tab-type
icon classes" but no step actually edits that file. Add a Step 6.5
or 8.5 that writes the CSS, or drop the icon promise from the spec.

### N7. Spec §10 V2 stub: `chromeButton()` shape

`Per-type chrome decoration: A tab type may declare a chromeButton()
that the shell renders into the tab strip near the active tab's X.`
This is the V2+ extension point most likely to constrain V1's design
— specifically, the contract today does not expose any per-tab DOM
slot in the tab strip beyond the label/X built by the shell. If V2's
chromeButton has to live in the tab-strip area, the shell's
`buildTabEl` (currently inside FileTab) needs to move to the shell in
V1 so V2 can decorate it without touching every tab type.

**Recommendation:** In V1, move `buildTabEl` from DiffTab into the
shell and have it read `tab.label` / `tab.type`. DiffTab is left with
just the contentEl + lifecycle methods. This matches spec §4.3 ("The
tab button's content is rendered by the shell from `tab.label` +
`tab.subLabel` + a type-specific class") and prevents a V1→V2
refactor of every tab type. Not a blocker but a strong nudge.

---

## Answers to the review brief's specific questions

**1. Spec quality.** Solid. TabInstance contract is small and covers
construction, mount, lifecycle, persistence-fragment. Open questions
in §6.6 have defaults. V2+ stubs are concrete except for chromeButton
(see N7). Missing: explicit construction site for `ShellAPI` (I1) and
clearer split of who-owns-what for `pickFile` (N2).

**2. Plan executability.** **No** — a fresh Sonnet session would hit
the rename collision (B1) at step 2.2, the reference errors at step
1.4 smoke (B3), and produce a broken setAppletState payload (B2)
without recognizing it broke anything. After B1-B3 are fixed and the
file:line citations added (I5, N3), executability is fine.

**3. Architectural soundness.** Two types is the right call (§6.1 is
convincing). The contract hides enough (shell never touches sibling
tab state) and exposes enough (`type` discriminator gates the diff-
specific iteration). One latent issue: today FileTab owns its
tab-strip button (`buildTabEl`); for V1 portability + V2 chrome
decoration (N7), the tab button should belong to the shell.

**4. Risk coverage.** The 5 listed risks are real and mitigated. Two
additional risks the spec doesn't call out:

- **R6: setAppletState shape change breaks agents.** Anyone reading
  `tabs.fileEdits.selection` today. Mitigation: keep the
  `fileEdits` envelope unchanged (B2).
- **R7: Watcher acquired after first load misses concurrent edits.**
  See I3.

The 100ms-debounce mitigation in R1 is wrong — see I2.

**5. code-quality.md violations the plan invites.**

- "code must be kept in sync" — routing-test duplication (I6).
- "wrong abstraction" — `update` rename (B1) signals the abstraction
  isn't being thought through end-to-end.
- "global state" — FileTab reaching into `followEdits`,
  `badgeCounter`, `paneEl` after extraction (B3) is the same global
  coupling we have today, just split across files (worse: now it's
  cross-file global access). Forces I1's shell-injection.

**6. Specific concerns:**

- Watcher debounce (100ms client, 150ms server): see I2 — redundant.
- `${type}:${path}` vs bare relPath id namespace: see N1 — fine as
  long as the shell stops assuming "id == relPath".
- Chevron only when 2+ types — DOM lifecycle: see I4 — unspecified.
- `pickFile` factorability into `openDiffTab`: see N2 — incomplete.

**7. Manual smoke surface — anything in the shell that breaks for
MarkdownTab?** Yes, see N3: `caco.edit` handler, `jumpToMostRecent`,
and `buildFileEditsState` (today's, not the plan's) all assume `tab.edit`
or `tab.selection` exist. Need an explicit "filter to diff tabs" pass
in the shell. The plan implies this but never says it.

---

## Suggested plan revisions (concise)

Smallest diff that addresses BLOCKERs and IMPORTANTs:

- **Step 1**: Pick option A (inject shell), enumerate the 7 helpers
  passed, cite line numbers. Smoke at 1.4 must include a tab-click
  test that exercises `closeTab` and `setActiveTab` through DiffTab.
- **Step 2.2**: Delete this substep. Existing `update(edit)` already
  satisfies the contract. Rename internal `render()` to `repaint()`
  if disambiguation is desired.
- **Step 2.7 (new)**: Audit the shell for `tabs.forEach` /
  `tabs.values()` callers that assume diff fields; add `t.type ===
  'diff'` filters at lines 900 (jumpToMostRecent), 1024
  (buildPersistBody), 1073 (flushPersistBeacon), 1927-1928
  (caco.edit handler). Cite each.
- **Step 4.0 (new)**: Construct and document the `shell` object;
  thread it through every `tabType.open(shell, ...)` call.
- **Step 5.2**: Reorder: acquire watcher first, install handler,
  then call `load()` once. Add AbortController in `destroy()`.
- **Step 6.x**: Specify chevron menu DOM is built once at init,
  toggled via `hidden`.
- **Step 7.1**: Keep `fileEdits` envelope byte-identical (including
  `sourceId`). Add new `files` envelope alongside. Smoke must verify
  both keys present in `appletAPI.getAppletState()` output.
- **Step 8.3**: Cite `script.js:1024` and `:1073`.
- **Step 9.1**: Drop the routing unit test, or commit to a shared
  routing-table JSON file. Don't ship duplicated decision logic.

Optional (NICE-TO-HAVE):

- Move `buildTabEl` into the shell to set up V2's chromeButton
  cleanly (N7).
- Remove `subLabel` from the V1 contract until something uses it (N5).
- Add the CSS edit step the §7 file table promises (N6).
