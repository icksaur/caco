# File Edits V3.4 — Active tab + selected lines via applet-state

Builds on V3.3 (`docs/file-edits-v3.3.md`, shipped on `file-edits-v3`).
Small client-only addition that lets the agent and the user exchange
file-pane focus through Caco's generic applet-state mechanism.

## Goal

Two flows, one mechanism:

1. **Agent → applet** (`set_applet_state`): agent picks a file and a
   line range; the applet activates that tab and highlights the lines.
   Use case: "Look at lines 42–60 of `src/foo.ts`."
2. **Applet → agent** (`get_applet_state`): user clicks/drags a line
   range in the active tab; the agent reads `{activeTab, selection}`
   on its next turn. Use case: user highlights code and asks the
   agent a question; the agent already knows what they meant.

Both share **one** state shape so the agent doesn't need to reason
about two APIs.

## Why now

V3.3 closed the V3 "polling and responsiveness" theme. This is the
first V3 item from the **collaboration with the agent** theme:
file-edits stops being read-only and becomes a two-way surface for
"point at this code" interactions. Implementation is small (one new
state key, one selection UI mode, two transport hooks); UX impact
is large.

## Scope (locked)

- One applet-state key: `fileEdits` with shape
  `{ activeTab: string | null, selection: { start: number, end: number } | null }`.
  `activeTab` is a relativePath; `selection` is 1-indexed inclusive
  working-tree line numbers (`null` when no selection).
- **Agent → applet:** `set_applet_state({ fileEdits: {...} })` →
  applet's `onStateUpdate` callback activates the tab + paints the
  selection.
- **Applet → agent:** the user's click/drag on rendered lines updates
  the same `fileEdits` key via `appletAPI.setAppletState(...)`.
- Single-pane selection only (not multi-tab). Selecting in tab A then
  switching to tab B clears the selection.
- Line-range selection only (not character ranges, not column
  selections). Click a line = single-line selection. Click + shift-click
  = multi-line range.
- Click-to-clear: clicking outside any line clears the selection.

## Non-goals (V3.4)

- Multi-line selection in the same tab via drag (separate input
  pattern; deferred).
- Copy/paste of selected text. (Native selection is unaffected; the
  user can still drag-select text with the mouse.)
- Persisting selection across applet open/close. Selection is
  session-volatile.
- Persisting selection across session switches. Each session has its
  own `fileEdits` state value.
- Selection on a tab that doesn't exist. If the agent
  `set_applet_state` references a path with no open tab, the applet
  **silently opens it via the existing pick-or-edit path** and then
  applies the selection.
- Cross-tab selection (e.g. select lines in 3 different files).

## Preserved invariants

- Tab strip, Follow-edits button, picker, persistence — all unchanged.
- The `cards.json` persistence file is NOT touched. Selection is
  ephemeral; the applet-state mechanism handles transport.
- No new HTTP routes. The `set_applet_state` tool already exists
  (`src/applet-tools.ts:449`) and pushes via WebSocket. `get_applet_state`
  (`:320`) already reads from `applet-state`'s in-memory store.
- followEdits semantics: an agent `set_applet_state` is NOT a user
  gesture — it should NOT turn followEdits off. The applet is being
  scripted, not navigated. The display change is the agent's, not the
  user's.

---

## Data model

The applet-state key is `fileEdits`. Both sides read/write the same
shape:

```ts
interface FileEditsState {
  activeTab: string | null;       // relativePath of the active tab
  selection: {
    start: number;                // 1-indexed working-tree line, inclusive
    end: number;                  // 1-indexed working-tree line, inclusive
  } | null;
}
```

Semantics:

- `activeTab === null` means "no tab active" (empty pane).
- `selection === null` means "no selection."
- `start === end` is a single-line selection.
- `start <= end` always. The applet normalizes if the agent sends
  `start > end`.
- Line numbers refer to the **working-tree** column (the right gutter
  for diff cards, the only gutter for clean cards). Diff `del`/HEAD
  lines are addressed by their work-side row index where applicable;
  for pure-deletion lines (no work counterpart), they cannot be the
  target of a selection — the applet clamps to the nearest add or ctx
  row.

## Agent → applet flow

The agent invokes `set_applet_state` with the `fileEdits` key:

```json
{
  "fileEdits": {
    "activeTab": "src/foo.ts",
    "selection": { "start": 42, "end": 60 }
  }
}
```

Pipeline:

1. `set_applet_state` tool calls `pushStateToApplet(sessionId, data)`
   which writes to the websocket.
2. Client's `onStateUpdate(cb)` fires with the merged state.
3. The applet's handler:
   a. Reads `data.fileEdits`. Skips if absent.
   b. If `activeTab` differs from current `activeTabId`:
      - If a tab exists for that path: `setActiveTab(path)` (the
        same call user click uses, except followEdits is NOT
        flipped off — agent setState bypasses the user-gesture rule).
      - If no tab exists: call `openOrUpdateTab` with a synthetic
        placeholder edit (the snapshot/poll path will fill in the
        real content shortly), then activate.
   c. Apply the selection (paint the marker overlay or row class —
      see Selection rendering below).
   d. Scroll the selection's first line into view.
   e. Echo the resulting state back via
      `appletAPI.setAppletState({fileEdits: ...})`. This is the
      "applet is source of truth" pattern the existing tools use —
      ensures `get_applet_state` returns the actual rendered state,
      not what the agent asked for.

The agent-initiated activation does NOT update `lastEditedTabId`
(this is a navigation, not an edit) and does NOT bump `badgeCounter`
(no edit happened).

## Applet → agent flow

User interaction:

- **Click a line:** sets `selection = {start: N, end: N}`.
- **Shift-click a line:** extends current selection's end to the
  clicked line (or sets `{start: existing_start, end: N}` normalized
  so start <= end).
- **Click on the pane background (not a line):** clears
  `selection = null`.
- **Switch tabs:** clears `selection = null` for the outgoing tab.
  The new active tab's selection is whatever it was last set to (or
  null on first activation).

After each change, the applet:
1. Updates the in-memory selection state for the active tab.
2. Repaints the selection visuals.
3. Calls `appletAPI.setAppletState({fileEdits: {activeTab,
   selection}})` so the agent can read it on its next turn.

### Selection state storage

Each `FileTab` instance gains a `selection` field
(`{start, end} | null`). Switching tabs displays that tab's
selection (whatever it was) and updates the broadcast `fileEdits.selection`
accordingly. Closing a tab discards its selection.

The applet's **transmitted** `fileEdits` always reflects the active
tab. If `activeTabId` is null, transmitted shape is
`{activeTab: null, selection: null}`.

## Selection rendering

The full-file renderer (`renderFullFile`) already produces one
`.fe-row` per line. Add a `data-work-line` attribute on each row
that has a working-tree line number (the `row.work` value), so the
selection painter can locate rows by line number in O(1) via
`querySelector('.fe-row[data-work-line="N"]')` rather than walking.

CSS (V3.4 addition):

```css
.fe-diff .fe-row.fe-row-selected .fe-line {
  background: color-mix(in oklab, var(--color-accent) 30%, transparent);
}
.fe-diff .fe-row.fe-row-selected .fe-gutter {
  background: color-mix(in oklab, var(--color-accent) 50%, transparent);
  color: var(--color-text-bright);
}
```

Selection class is toggled imperatively when the selection changes,
not via DOM rebuild — fast even on large files.

For clean files (single-gutter mode), the selection bar appears on
the line-number column.

### Pure-deletion / HEAD-only rows

Diff rows that exist only in HEAD (status='del' rows with no
working-tree counterpart) carry no `data-work-line`. They are
**not selectable** in V3.4. Clicking one is a no-op; the selection
painter ignores them. This avoids agonizing over "which line do I
mean: 12 in HEAD or 12 in working tree?"

Future V4: support selection on HEAD lines by using a discriminated
shape `selection: { side: 'work' | 'head', start, end }`. Out of
scope for V3.4.

## Interaction with followEdits

Today, any user click on a tab turns `followEdits = false`. V3.4
adds line clicks within the active pane. Question: do line clicks
also turn followEdits off?

**Resolved: yes.** Selecting code is a "I'm reading this" gesture
matching the existing "scroll the pane" trigger. Even if the user
selects without scrolling, the intent is the same. Otherwise an
agent edit to a different file would yank the pane out from under
the user's selection.

Setting selection via the picker / programmatic flows does NOT turn
followEdits off (same rule as `set_applet_state`).

## Edge cases

- **Agent sets selection for a tab that doesn't exist.** Open it
  silently (via existing openOrUpdateTab path with `forceFocus:true`),
  apply selection. If the file doesn't exist on disk either, the
  open path returns a 404 from `/file-edits/open`; the applet logs
  + clears the selection.
- **Agent sets selection beyond the file's line count.** Clamp to
  `[1, workLines.length]`. If `start` exceeds the file length, drop
  the selection entirely.
- **User has a multi-line selection, then the file is edited and
  re-rendered.** Selection state is by line number, so a new add
  above the selection range shifts the rendered selection to a
  different visual position. Acceptable — line numbers are the
  agreed contract.
- **User closes the active tab with a selection.** Selection clears
  with the tab (tab destroy). The next applet→agent broadcast sends
  `{activeTab: <new>, selection: null}`.
- **Two agent set_applet_state calls in quick succession.** Each is
  applied in order; the last one wins. The applet's echo-back
  ensures the agent's `get_applet_state` sees the final state.
- **Session change with selection.** State resets: the new session
  starts with `{activeTab: null, selection: null}`. The outgoing
  session's selection is NOT persisted (intentional, per Non-goals).

## Server-side considerations

Mostly none. The existing `set_applet_state` and `get_applet_state`
tools, `applet-state.ts` store, and the websocket push channel all
work as-is.

One small concern: `applet-state.ts` stores arbitrary `Record<string,
unknown>` per session. The `fileEdits` key is one of potentially many
applet-state keys (other applets use the same store). V3.4 doesn't
conflict because the file-edits applet only reads/writes its own
`fileEdits` key, leaving other keys (used by other applets) intact.

No new HTTP routes, no schema migrations, no new dependencies.

---

## Acceptance

1. Agent calls `set_applet_state({fileEdits: {activeTab:
   'src/foo.ts', selection: {start: 10, end: 12}}})` on a session
   with foo.ts as an open tab → tab activates, lines 10–12 are
   highlighted with the accent color, viewport scrolls to show
   line 10.
2. Agent calls the same with a path that has no open tab → tab
   opens silently with selection applied.
3. User clicks line 5 → `get_applet_state` returns
   `{fileEdits: {activeTab: <current>, selection: {start:5, end:5}}}`.
4. User shift-clicks line 12 (after clicking 5) → selection becomes
   `{start: 5, end: 12}`.
5. User clicks on the pane background → selection clears;
   `get_applet_state` returns `{..., selection: null}`.
6. User switches tabs → broadcast shows the new tab id + the new
   tab's stored selection (or null).
7. Agent edit arrives for a different file while user has a
   selection in the current active tab → followEdits is off (user
   gesture), no auto-switch.
8. Close active tab → selection clears with it; broadcast sends
   `{activeTab: <neighbor>, selection: null}`.

## Risks

- **Selection visuals fight diff coloring.** Accent at 30% mixed
  with the existing 18% red/green row tint may produce muddy
  combinations. Acceptable for V3.4; revisit if operator dislikes.
- **Echo-back loop.** Agent set_applet_state → applet applies → echo
  back via setAppletState → applet's own onStateUpdate fires →
  applet applies again. Prevent by guarding the onStateUpdate
  handler against echoes (compare incoming state to last-sent
  state; bail if equal). Standard applet-tools pattern.
- **Selection-loss on file reload.** If the user has a selection
  and the file is re-rendered (new edit arrives), the row DOM is
  rebuilt and the selection class is dropped. Mitigation: after
  every re-render of the active tab, the applet re-applies the
  current selection via `data-work-line` lookups. Documented in
  Selection rendering above.

## Open questions

1. **Should the selection scroll-into-view always use the "30% from
   top" recipe from V3.2 jumpToMostRecent, or center the selection
   in the viewport?** Recommend: 30% from top, consistent with
   Follow-edits jumps.
2. **Should clearing happen on Escape key while the pane has
   focus?** Useful but adds a keyboard handler. Recommend yes — one
   line, expected behavior.
3. **What happens if the agent sends `selection.start > workLines.length`
   AND `selection.end` is valid?** Clamp `start` to 1 (best guess)
   or drop the selection entirely? Recommend drop — sending
   nonsense should not silently snap to file start.

## Document layout

- `docs/file-edits.md` — V1 + V3 backlog (update to note V3.4 ships
  agent↔user selection).
- `docs/file-edits-v3.4.md` — this doc.
- `docs/file-edits-v3.4-review.md` — review log (post-review).
