# File Edits V3.4 — Spec Review

Reviewed against: `docs/file-edits-v3.4.md`
Context verified: `src/applet-state.ts`, `src/applet-tools.ts:320,449`,
`src/routes/websocket.ts:157–163,228–265`, `public/ts/applet-runtime.ts:388–398`,
`applets/file-edits/script.js` (FileTab, buildRowEl, openOrUpdateTab,
jumpToMostRecent, pickFile)

**Finding counts: 2 BLOCKER · 5 IMPORTANT · 3 NICE · 1 QUESTION**

---

## [BLOCKER] Echo-back loop risk is misstated — guard is a no-op for single-tab

**Spec (§Risks):** "Prevent by guarding the onStateUpdate handler against echoes
(compare incoming state to last-sent state; bail if equal). Standard applet-tools
pattern."

`src/routes/websocket.ts:157–163` — the `setState` message handler:
```ts
case 'setState':
  setAppletUserState(msg.sessionId, msg.data);
  broadcastToAll({ type: 'stateUpdate', data: msg.data }, ws);  // sender excluded
```

`broadcastToAll` at `websocket.ts:228–235` skips the connection that sent the
message (`ws !== exclude`). When the applet calls `appletAPI.setAppletState(...)`,
the server stores state and broadcasts `stateUpdate` to all connections **except
the sender**. The applet's own `onStateUpdate` does not fire. The loop physically
cannot happen in a single-tab session.

The spec says the guard is "essential" and calls it a "Standard applet-tools
pattern." It is neither — it adds dead code and misleads the implementer into
thinking there's a real threat to mitigate.

**Actual risk (unaddressed):** Two browser tabs open with the same applet. Agent
push → both tabs receive stateUpdate → both echo back → each echo broadcasts to
the other tab → ping-pong. This multi-tab cross-echo is the real loop, and the
spec doesn't mention it.

**Fix:** Remove the single-tab echo guard recommendation. Add: "Multi-tab cross-echo
is possible (Tab A's echo-back triggers Tab B's onStateUpdate). Guard by including
a local `sourceId` (random UUID per page load) in the broadcast and bailing in
onStateUpdate if `data.fileEdits.sourceId === myId`."

---

## [BLOCKER] "Silently open" placeholder path fails for clean files

**Spec (§Agent→applet flow, step 3b):** "If no tab exists: call `openOrUpdateTab`
with a synthetic placeholder edit (the snapshot/poll path will fill in the real
content shortly), then activate."

The snapshot / `caco.edit` poll only returns **dirty files**. A clean file (no
working-tree changes) never appears in a poll. A placeholder tab created for
`src/util.ts` (clean) will stay content-free indefinitely. The subsequent
`querySelector('.fe-row[data-work-line="50"]')` finds nothing; scroll and
highlight silently fail.

The working path for clean files already exists: `pickFile()` at
`applets/file-edits/script.js:634–673` calls `POST /file-edits/open` to fetch
real content, then `openOrUpdateTab(edit, {forceFocus: true})`.

**Also:** even for dirty files, the placeholder has no rows when the agent's
selection first arrives. Selection application silently no-ops until the next
poll re-renders. The spec's §Risks mentions "re-apply after every re-render" but
only as a risk mitigation — it needs to be a normative implementation requirement.

**Fix:** Replace step 3b with: call `POST /file-edits/open` (same as `pickFile`)
to fetch content. Apply selection after the fetch resolves. While the fetch is in
flight, hold the pending `{selection}` and apply on render completion. If
`/open` returns 404, log and clear selection.

---

## [IMPORTANT] `buildRowEl` confirmed missing `data-work-line` — fold expansion also unaddressed

**Spec (§Selection rendering):** "Add a `data-work-line` attribute on each row
that has a working-tree line number."

`applets/file-edits/script.js:1090–1116` — `buildRowEl` sets className, appends
gutter spans and a code element. No `data-work-line` or `dataset.workLine`
anywhere. Confirmed absent.

Gap the spec doesn't mention: `expandFold` at `script.js:1141–1183` calls
`buildRowEl` for each hidden row when a fold is expanded. Those rows also need
`data-work-line` or `querySelector('.fe-row[data-work-line="N"]')` will miss
lines that were folded at render time.

**Fix:** Add `if (row.work != null) div.dataset.workLine = String(row.work);`
in `buildRowEl` after line 1092. Call out the fold-expansion path explicitly.

---

## [IMPORTANT] AC #7 wording: "user has a selection" doesn't imply followEdits is off

**Spec (§Acceptance, #7):** "Agent edit arrives for a different file while user
has a selection in the current active tab → followEdits is off (user gesture),
no auto-switch."

The agent can set a selection via `set_applet_state` — this explicitly does NOT
turn `followEdits` off (§Preserved invariants). If the agent set the selection,
followEdits is still on. An agent edit for a different file triggers
`openOrUpdateTab` → `setActiveTab` and yanks focus, even though the user has a
visible selection.

AC #7 silently assumes the selection was created by a user click.

**Fix:** Rewrite AC #7: "User has clicked a line (followEdits is now false).
Agent edit arrives for a different file → no auto-switch, no badge clear."
Alternatively, if the intent is "any active selection blocks agent-driven tab
switches," state that rule explicitly and enforce it.

---

## [IMPORTANT] Pure-deletion clamping direction is unspecified

**Spec (§Data model):** "The applet clamps to the nearest add or ctx row."

"Nearest" is ambiguous when a block of `del` rows spans many lines. For agent
`selection: {start: 12, end: 18}` where rows 10–20 are all `del`:
- Nearest work-line below: first add/ctx row at or after 12
- Nearest work-line above: last add/ctx row at or before 12

Neither direction is specified. Worse: clamping start up and end down may
produce `start > end` after clamping. This secondary rule ("drop if clamped
range collapses") is absent.

**Fix:** Specify: "Clamp start up to the nearest work-line ≥ start; clamp end
down to the nearest work-line ≤ end. If the clamped start > clamped end, drop
the selection."

---

## [IMPORTANT] Normalization × bounds-check interaction creates unintended valid selections

**Spec (§Data model):** "`start <= end` always. The applet normalizes if the
agent sends `start > end`."
**Spec (§Edge cases):** "If `start` exceeds the file length, drop the selection
entirely."

Interaction: agent sends `{start: 200, end: 50}` where the file has 100 lines.
After normalization (swap): `{start: 50, end: 200}`. Now start=50 is valid;
end=200 is clamped to 100. Result: `{50, 100}` — a wide selection the agent
probably didn't intend. The bogus out-of-bounds value on the original `start`
field is masked by the swap.

**Fix:** Apply bounds validation **before** normalization. If `max(start, end)
> workLines.length` AND `min(start, end) > workLines.length`, drop. If only one
value is out of bounds, clamp before swapping.

---

## [IMPORTANT] Echo-back (step 3e) is a correctness requirement, not a pattern

**Spec (§Agent→applet flow, step 3e):** "Echo the resulting state back via
`appletAPI.setAppletState({fileEdits: ...})`. This is the 'applet is source of
truth' pattern."

`set_applet_state` tool at `src/applet-tools.ts:449–476` calls only
`pushStateToApplet` — it does NOT call `setAppletUserState`. The
`appletUserStates` map (read by `get_applet_state`) is only updated when the
applet calls `wsSetState`, triggering the `setState` case which calls
`setAppletUserState`.

Without the echo-back, `get_applet_state` returns stale or empty data. If the
applet is unloaded, crashes, or the tab is closed between the agent push and
the echo, the agent's next `get_applet_state` sees the pre-push state.

**Fix:** Promote step 3e from recommendation to MUST. Add to §Risks: "If the
echo-back fails (applet disconnected), `get_applet_state` returns the pre-push
state. Agents should treat a missing or stale `fileEdits` key as 'applet not
ready' and retry."

---

## [NICE] Finding confirmed: setAppletUserState merge is safe

`src/applet-state.ts:20–24`:
```ts
const prev = appletUserStates.get(key) || {};
appletUserStates.set(key, { ...prev, ...state });
```
Shallow merge at the top level. Writing `{fileEdits: {...}}` only touches the
`fileEdits` key; other applets' keys survive. The spec's assertion on this
point is correct and confirmed.

---

## [NICE] "Agent vs. self" discrimination concern is moot for single-tab

**Spec (§Preserved invariants):** "an agent set_applet_state is NOT a user
gesture — it should NOT turn followEdits off."

Since `broadcastToAll` excludes the sender, the applet's own `setAppletState`
call never triggers its own `onStateUpdate`. The applet never needs to
distinguish "agent set this" from "I set this myself." The spec's implementation
concern about source discrimination is moot.

---

## [NICE] jumpToMostRecent selection preservation is correct by construction

`applets/file-edits/script.js:305–333`: `jumpToMostRecent` calls
`setActiveTab(targetId)`, then `scrollPaneToFirstDiffRow`. It does not touch
any selection state. When V3.4 adds `FileTab.selection`, the jump will display
whatever selection the target tab had last — consistent with the spec's "no
auto-clear on tab switch" rule. No extra code needed; it follows from per-tab
selection storage.

---

## [QUESTION] Scope section wording on tab-switch ambiguously describes both tabs

**Spec (§Scope):** "Selecting in tab A then switching to tab B clears the
selection."

This reads as if tab B ends up with null selection. But §Applet→agent flow
clarifies: "Switch tabs: clears `selection = null` for the **outgoing** tab."
Tab B retains its own last-set selection. The Scope line's phrasing omits
which tab's selection is cleared.

**Fix:** "Switching away from tab A clears tab A's selection; tab B retains
whatever selection it had (null on first activation)."

---

## Summary

The spec is clear on the happy path and correctly identifies the two-way state
shape, the followEdits invariant, and the per-tab selection storage model. The
data model interface is clean and implementable. Two structural problems:

1. The clean-file open path is broken — "placeholder + wait for poll" only
   covers dirty files. Needs `POST /file-edits/open`.
2. The echo-back loop risk analysis is wrong and will produce dead guard code;
   the real multi-tab risk is unaddressed.

Both blockers need resolution before implementation starts.
