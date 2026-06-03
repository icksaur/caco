# File Edits V3.2 — Tabs + always-on edits

Replaces the stacked-cards layout with a tab strip. Builds on V3.1
(`docs/file-edits-v3.1.md`) — the picker and the persistence machinery
both carry over with minor adjustments.

**This is a client-only refactor.** No server changes. Same
`/snapshot`, same `/open`, same `caco.edit` event shape, same
`/cards` persistence endpoint.

## Goal

Replace stacked cards with a tab strip. Each opened file is one tab;
clicking a tab shows that file's content in a single content pane below
the tab strip. Files come in two ways:

1. **Agent/external edit** → tab auto-opens (no need to click + first).
2. **User pick** → + button opens the V3.1 fuzzy picker; selecting a
   file opens its tab.

A `followEdits` boolean governs whether the applet auto-switches tabs
when an edit arrives. Operator gestures (switching tab manually,
scrolling the content pane, picking a file) turn it off. Clicking the
top-center **"Follow edits"** button turns it back on AND jumps to the
most recent edit.

## Why

After V3.1:
- Cards stack vertically; scanning a 20-card stream is slow.
- The Follow-edits floating bottom-right button is visually
  disconnected from where the action is.
- Each card carries header chrome (chevron, status pill, path, open
  link, X) that's repeated for every file — wasteful for a viewer.
- The "dismissed" set is conceptually weird: an X means "stop showing
  me edits to this file" but the right gesture for a viewer is "close
  this tab" with no permanence.

Tabs collapse all of that to: pick a tab, see its content.

## Scope (locked)

- Tab strip replaces card list. One opened file per tab.
- Single content pane below the strip. Switching tabs swaps the pane
  content.
- Class-per-tab (`FileTab`) instance holds the rendered content and
  the saved scroll position.
- `+` button (V3.1 picker) moves into the toolbar to the right of
  "Follow edits".
- "Follow edits" button is **top-center** of the toolbar (between
  folder name on the left and "+" on the right).
- Always-show: any agent/external edit opens a tab. No "dismissed"
  set.
- X closes a tab. No re-open until the file is touched again or
  picked again.

## Non-goals (V3.2)

- **No dismissed set.** V1's sticky-X is gone. X closes the tab; if
  the file gets edited again, a new tab opens. Persisted card list
  no longer carries a `dismissed[]` field.
- Drag-to-reorder tabs.
- Tab grouping / pinning.
- Multi-pane (split view).
- Per-tab toolbar actions beyond X.
- Server changes.
- New events.

## Preserved invariants

- Cards-don't-reorder becomes "tabs don't reorder." Insertion order =
  creation order.
- Tabs persist across applet open/close and session switch via the
  V2.1 mechanism (the persisted JSON now stores tab order + active
  tab id; see §Persistence below).
- 50-tab cap. Oldest non-active tab evicted first when over cap.
  Active tab never evicted.
- Click-outside semantics on the picker unchanged.
- Server contracts unchanged: `/snapshot`, `/open`, `/cards`,
  `caco.edit`.

---

## Layout

```mermaid
flowchart TB
  subgraph toolbar [".fe-toolbar (top, fixed height)"]
    direction LR
    repo["repo name (left)"]
    follow["Follow edits ⌃ (center; visible only when followEdits=false)"]
    open["+ (right)"]
  end
  subgraph tabs [".fe-tabs (horizontal scrollable strip)"]
    direction LR
    t1["tab1 ×"]
    t2["tab2 ×"]
    t3["tab3-active ×"]
    t4["tab4 ×"]
  end
  pane[".fe-pane (single content area, fills remaining height)"]
  toolbar --> tabs --> pane
```

Three-row flexbox in `.fe-root`:

| Region | Height | Content |
|---|---|---|
| `.fe-toolbar` | auto | repo name · Follow-edits button (centered) · + button |
| `.fe-tabs` | auto, horizontally scrollable | tab pills, newest at right |
| `.fe-pane` | flex: 1 | the active tab's content (or empty state) |

### Toolbar

- **repo name** (left, mono): unchanged from V3.1.
- **Follow-edits button** (center):
  - Reads `↓ Follow edits` plus an N-badge for distinct files edited
    while followEdits was off in the current session.
  - Visible **only when followEdits is false**.
  - Click: enable followEdits, jump to most recent edit
    (`jumpToMostRecent()`).
  - Styled with `--color-accent` (matches Caco's primary).
- **+ button** (right): unchanged from V3.1.

### Tab strip

Horizontal flex row, scrollable when overflow. Each tab is a
`<button class="fe-tab">` with two children: filename + close-X.

- Filename is shown as basename only (e.g. `script.js`). Full relative
  path on hover via `title`.
- Active tab styled like Caco's `.session-item.active` —
  `background: var(--color-success)` with a left/bottom accent edge
  (we'll adapt — see CSS).
- Hover: `--color-selector-hover`.
- Tooltip on hover shows the full relativePath.
- X is a `<span class="fe-tab-x">` inside the button; click stops
  propagation and closes the tab.
- Tabs never reorder. New tabs append to the right.
- When a tab is opened by an edit and `followEdits=true`, the active
  tab switches AND the strip horizontally scrolls so the new active
  tab is visible (rightward end of strip stays in view).

### Content pane

- Single `<div class="fe-pane">`. The active tab's `FileTab` instance
  appends its rendered DOM here on activation.
- Empty state: shown when no tabs exist. Message: "No files open.
  Click + to open one, or wait for edits."
- The pane is the scroll container per tab.

### File picker (+ button)

Unchanged from V3.1, except:
- "(open)" suffix now refers to "has an open tab," not "has a card."
- "(dismissed)" suffix removed. No dismissed set.
- Picking a file opens its tab AND switches to it AND turns
  followEdits off (user action).

---

## `FileTab` class

One instance per opened file. Lives in the applet's IIFE.

```js
class FileTab {
  constructor(edit) {
    this.relativePath = edit.relativePath;
    this.absolutePath = edit.path;
    this.edit = edit;           // current EditEntry; mutated on update
    this.tabEl = this.buildTabEl();
    this.paneEl = null;         // LAZY — built on first activate()
    this.scrollTop = 0;         // saved scroll position
  }

  /** Build the strip pill element. Always built (cheap; just two spans). */
  buildTabEl() { /* basename + X */ }

  /** Build paneEl from this.edit. Called on first activate() and after
   *  any content-changing update() if paneEl exists. */
  render() {
    if (!this.paneEl) this.paneEl = document.createElement('div');
    this.paneEl.innerHTML = '';
    // Mirror v2 renderFullFile / renderDiff dispatch into this.paneEl.
  }

  /** Called when a poll updates the same path. Re-render if content changed. */
  update(newEdit) {
    if (this.contentEqual(newEdit)) return false;
    this.edit = newEdit;
    // Lazy: if paneEl hasn't been built yet (inactive tab never activated),
    // just store the new edit and let activate() render later.
    if (this.paneEl) this.render();
    return true;
  }

  contentEqual(other) {
    // Same fullFileEqual logic from V2.1, folded into the class.
  }

  /** Attach paneEl to the global pane container. Builds paneEl on first
   *  call (lazy). Restores saved scrollTop via rAF after the swap. */
  activate(paneContainer) {
    if (!this.paneEl) this.render();
    // Hide-swap-show pattern avoids the innerHTML scroll-side-effect
    // (clearing children of a scrolled container fires a scroll event
    // when scrollTop snaps to 0). Hiding the container while swapping
    // suppresses that event.
    const wasHidden = paneContainer.style.visibility;
    paneContainer.style.visibility = 'hidden';
    paneContainer.innerHTML = '';
    paneContainer.appendChild(this.paneEl);
    // Restore scroll on next rAF (after layout). Mark the write as
    // programmatic so the scroll handler doesn't flip followEdits.
    requestAnimationFrame(() => {
      programmaticScroll = true;
      paneContainer.scrollTop = this.scrollTop;
      paneContainer.style.visibility = wasHidden || '';
    });
  }

  /** Capture current scroll before deactivation. */
  deactivate(paneContainer) {
    this.scrollTop = paneContainer.scrollTop;
  }

  /** Destroy: drop tab + pane DOM, release references. */
  destroy() {
    if (this.tabEl && this.tabEl.parentNode) this.tabEl.parentNode.removeChild(this.tabEl);
    this.paneEl = null;
  }
}
```

Implementation notes:

- `paneEl` is **lazy** — built on first `activate()`. A persisted-tab
  restore creates 50 `FileTab` instances synchronously but no
  `paneEl` is built until the user clicks the tab or an edit
  auto-activates it. Avoids 50× full-file render on startup.
- `update()` updates `this.edit` always. It only calls `render()` if
  `paneEl` already exists (i.e. the tab has been activated at least
  once). For never-activated tabs, the next `activate()` will render
  with the most-recent edit.
- `scrollTop` is saved on `deactivate` and restored on `activate`.
  The restore happens in `requestAnimationFrame` so layout settles
  before the scroll write.
- **Hide-swap-show in `activate`:** `paneContainer.innerHTML = ''`
  on a scrolled container clamps `scrollTop` to 0 and fires a
  scroll event. We hide the container before the swap and unhide
  after the rAF restore. This eliminates the BLOCKER-1 ambiguity
  (multiple scroll events from one tab switch) without needing the
  V2 `{target,±1px}` value-comparison guard. The
  `programmaticScroll` flag still gates the restore rAF write,
  consumed exactly once.

---

## State machine

Replaces V2/V3's scrollMode (`autoscroll` / `sticky`) with a single
boolean. Same intent, simpler shape.

```js
let followEdits = true;           // default ON
let activeTabId = null;           // relativePath of active tab
let tabs = new Map();             // Map<relativePath, FileTab>
let lastEditedTabId = null;       // most recent tab to receive an edit
let badgeCounter = new Set();     // distinct paths edited while followEdits=false
let programmaticScroll = false;   // single-shot suppression flag for pane scroll
```

### `followEdits` transitions

| Event | followEdits after | Notes |
|---|---|---|
| Tab opened by agent edit AND followEdits was true | `true` | Activate the new tab, jump to it |
| Tab opened by agent edit AND followEdits was false | `false` | Add tab to strip but don't switch; `badgeCounter.add(path)` |
| Tab opened by user pick (+ button) | `false` | User asked for this specific tab; don't auto-follow |
| User clicks a tab in the strip | `false` | Explicit choice. Also: `badgeCounter.delete(clickedPath)` if present (the user has now seen this edit; don't count it). |
| User scrolls the pane | `false` | Reading something specific |
| User clicks "Follow edits" button | `true` | Re-engage; jump to most recent; `badgeCounter.clear()` |
| Session change | `true` | Reset to default; `badgeCounter.clear()`; `lastEditedTabId = null` |
| User dismisses (X) the active tab | `false` | They're not following; they're managing |
| User dismisses (X) any tab | unchanged | X only affects activation if the closed tab was active; followEdits is otherwise untouched |

### `jumpToMostRecent()`

The single jump function called by both the auto-follow path on
incoming edits AND the "Follow edits" button. Algorithm:

1. If `tabs.size === 0`, no-op.
2. **Primary target: `lastEditedTabId`.** This is set by
   `openOrUpdateTab` on every actual content change. It represents
   "the freshest edit we've SEEN since session start." Matches the
   badge semantics ("distinct files edited while followEdits was
   off") — both are driven by the same trigger (a content-changing
   apply).
3. **Fallback:** if `lastEditedTabId` is null (e.g. restored
   persisted tabs with no edits yet this session) or no longer in
   `tabs` (closed/evicted), pick the tab with the highest
   `edit.mtimeMs` across remaining tabs. Final fallback if all
   mtimes are absent: pick the rightmost (newest in strip order).
4. `setActiveTab(targetId)` — no-op if already active.
5. Scroll the active tab's pane to the top (target rAF +
   `programmaticScroll = true` so the scroll handler doesn't flip
   followEdits).

This is intentionally NOT "highest mtimeMs across all tabs." That
would cause the Follow button to jump to a long-untouched-but-
recently-stat'd file with no incoming edit, contradicting the badge.

### `setActiveTab(tabId)`

```js
function setActiveTab(tabId) {
  if (tabId === activeTabId) return;
  const prev = tabs.get(activeTabId);
  if (prev) prev.deactivate(paneEl);
  activeTabId = tabId;
  const next = tabs.get(tabId);
  if (next) {
    next.tabEl.classList.add('active');
    // Strip other active classes
    tabs.forEach((t, id) => {
      if (id !== tabId) t.tabEl.classList.remove('active');
    });
    next.activate(paneEl);
    next.tabEl.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }
  schedulePersist();
  updateFollowButton();
}
```

**Caller contract:** `setActiveTab` does NOT modify `followEdits`.
Callers that represent USER gestures (tab click, X-on-active, picker
selection) must set `followEdits = false` themselves before calling
`setActiveTab`. The auto-follow-on-edit path through
`openOrUpdateTab` does NOT touch `followEdits`, so the existing value
(true) is preserved. This split is what allows `initFromPersistence`
and `fetchSnapshot` to drive `setActiveTab` without flipping the
default state.

### Tab open flow

Called from BOTH the `caco.edit` event handler AND the picker:

```js
function openOrUpdateTab(edit, options = {}) {
  const id = edit.relativePath;
  let tab = tabs.get(id);
  let isNew = false;
  let contentChanged = false;
  if (!tab) {
    if (tabs.size >= TAB_CAP) {
      evictOldestNonActive();
    }
    tab = new FileTab(edit);
    tabs.set(id, tab);
    tabsStripEl.appendChild(tab.tabEl);  // tabs never reorder
    isNew = true;
    contentChanged = true;
  } else {
    contentChanged = tab.update(edit);
    if (!contentChanged && !options.forceFocus) return;
  }
  // Track most-recent for jumpToMostRecent. Only set on actual content
  // changes (not on forceFocus-without-change picks of an open tab —
  // that's a re-focus, not a new edit).
  if (contentChanged) lastEditedTabId = id;
  if (options.forceFocus) {
    // Picker path. Caller MUST also have set followEdits=false.
    setActiveTab(id);
    paneEl.scrollTop = 0;
    tab.scrollTop = 0;
  } else if (followEdits) {
    // Auto-follow path. Activate AND scroll to top.
    setActiveTab(id);
    if (isNew) {
      paneEl.scrollTop = 0;
      tab.scrollTop = 0;
    }
  } else {
    // followEdits is off: just bump the badge.
    badgeCounter.add(id);
    updateFollowButton();
  }
  schedulePersist();
}

/** Remove the oldest non-active tab from the strip + tabs map.
 *  Called by openOrUpdateTab when tabs.size >= TAB_CAP. Insertion order
 *  = Map iteration order; "oldest" = first non-active entry. If no
 *  non-active tab exists (impossible at TAB_CAP=50 with exactly one
 *  active tab), no-op. */
function evictOldestNonActive() {
  for (const [id, tab] of tabs) {
    if (id !== activeTabId) {
      tab.destroy();
      tabs.delete(id);
      return;
    }
  }
}
```

Picker call: caller does `followEdits = false; updateFollowButton();
openOrUpdateTab(edit, { forceFocus: true })`.

`caco.edit` and snapshot call: `openOrUpdateTab(edit)` — follow
respected.

### Pane scroll listener

```js
paneEl.addEventListener('scroll', () => {
  if (programmaticScroll) { programmaticScroll = false; return; }
  if (followEdits) {
    followEdits = false;
    updateFollowButton();
  }
  // Save scroll position for the active tab.
  // (Redundant with deactivate() — kept as defense-in-depth so a
  // scroll event during the tab-switch window doesn't lose the new
  // tab's position. The hide-swap-show pattern in activate() prevents
  // the spurious innerHTML scroll-to-0 event from firing here.)
  const active = tabs.get(activeTabId);
  if (active) active.scrollTop = paneEl.scrollTop;
});
```

The `programmaticScroll` single-shot flag is consumed exactly once.
The hide-swap-show pattern in `FileTab.activate()` (see the FileTab
section) is what makes the single-shot sufficient — it suppresses
the spurious scroll event from `paneContainer.innerHTML = ''` that
would otherwise burn the flag before the rAF restore runs.

---

## Persistence (client-only)

**No server changes.** The existing `/api/sessions/:id/file-edits/cards`
GET/PUT/POST endpoints and the `file-edits-cards.json` file shape are
reused as-is. The server doesn't interpret the field semantics; the
client repurposes:

- **`cards[]`** continues to be `Array<{ relativePath, collapsed }>`
  on disk. V3.2 writes `collapsed: false` for every tab (the field is
  meaningless in tab UI but kept to satisfy the existing
  `schemaVersion: 1` validator).
- **`dismissed[]`** is no longer written. V3.2 always sends an empty
  array. Any pre-existing dismissed entries from V2.1 sessions are
  ignored on read (V3.2 has no "filter these out" concept). Operator
  accepted "no dismiss" — surviving v2.1 dismissed lists are silently
  dropped on the next write.
- **Active tab is NOT persisted** in V3.2 because the existing
  `schemaVersion: 1` shape has no field for it. Acceptable — on
  applet open, no tab is auto-active until either the user clicks
  one OR followEdits=true and an edit arrives. (See open question
  on whether to store active tab via a future schema bump.)
- **Insertion order** is the persisted `cards[]` array order.

Server endpoint and store code untouched. The only "schema" change is
the client's interpretation of the bytes on disk.

### Initial load

```js
async function initFromPersistence(sid) {
  const persisted = await loadPersistedTabs(sid);
  // Pre-create placeholder FileTab instances in persisted order so the
  // strip shows them immediately. No tab is auto-activated; the pane
  // stays empty until either the user clicks a tab OR an incoming
  // edit arrives with followEdits=true (the default).
  for (const { relativePath } of persisted.cards || []) {
    const placeholder = { relativePath, path: '', status: 'clean',
                          timestamp: new Date().toISOString() };
    const tab = new FileTab(placeholder);
    tabs.set(relativePath, tab);
    tabsStripEl.appendChild(tab.tabEl);
  }
  // Then fetchSnapshot to fill in real edit content via tab.update().
  await fetchSnapshot();
}
```

The snapshot fills each placeholder by calling `tab.update(edit)`. The
existing server-side snapshot logic (V2.1) that joins the persisted
list and fetches HEAD blobs continues to work — it sees the same
`cards[]` and treats them as paths to fetch.

### `fetchSnapshot` in V3.2

The V2.1 `fetchSnapshot` joined snapshot edits + a `cleared` set
(paths in DOM not in snapshot) and fed both to `applyEdits`. V3.2
replaces `applyEdits` with `openOrUpdateTab` and there is no
"cleared" concept (tabs don't disappear unless the user X's them or
cap eviction triggers).

```js
async function fetchSnapshot() {
  if (!sessionId) return;
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/file-edits/snapshot`);
  if (!res.ok) return;
  const data = await res.json();
  if (!Array.isArray(data.edits)) return;
  // For each snapshot edit: open-or-update the tab. The mutation
  // arrives via the auto-follow path; if followEdits=true (the default
  // on init) the LAST edit's tab becomes active via the existing
  // openOrUpdateTab + setActiveTab chain.
  for (const edit of data.edits) {
    openOrUpdateTab(edit);  // no forceFocus: respect followEdits
  }
  // Paths in tabs but NOT in the snapshot: silently leave them. They
  // remain in the strip as placeholders. The user can X to remove,
  // or pick them via + to fetch fresh content. (No V2.1-style
  // markClean broadcast — there is no equivalent for tabs because
  // a clean file is still a valid thing to view.)
}
```

`caco.edit` WS event uses the same path: `event.data.edits.forEach(openOrUpdateTab)`.
The `cleared` array from V2.1 is ignored (a path going clean is just
a tab whose status transitions; the tab stays open). The
`cleanedEdits` array IS processed the same way (`openOrUpdateTab`)
because clean entries with `fullFile` payloads should still update
the rendered content.

---

## CSS

Themed off existing Caco tokens. Adapted from `.session-item`:

```css
.fe-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  position: relative;
  font-family: var(--font-sans);
  color: var(--color-text);
}

.fe-toolbar {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: var(--space-md);
  padding: var(--space-sm) var(--space-md);
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.fe-toolbar > .fe-repo { justify-self: start; }
.fe-toolbar > .fe-follow { justify-self: center; }
.fe-toolbar > .fe-actions { justify-self: end; }  /* holds + */

.fe-follow {
  background: var(--color-accent);
  color: white;
  border: 0;
  border-radius: var(--radius-md);
  padding: 4px 12px;
  font-family: var(--font-sans);
  font-size: var(--text-sm);
  font-weight: 600;
  cursor: pointer;
}
.fe-follow:hover { filter: brightness(1.1); }
.fe-follow[hidden] { display: none; }

.fe-tabs {
  display: flex;
  gap: 2px;
  padding: 4px var(--space-md);
  overflow-x: auto;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.fe-tab {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  background: var(--color-selector-bg);
  color: var(--color-text);
  border: 0;
  padding: 4px 10px;
  border-radius: var(--radius-md);
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  white-space: nowrap;
  flex-shrink: 0;
}
.fe-tab:hover { background: var(--color-selector-hover); }
.fe-tab.active {
  background: var(--color-success);
  color: var(--color-text-bright);
}
.fe-tab-x {
  color: var(--color-text-muted);
  font-size: var(--text-base);
  line-height: 1;
  padding: 0 2px;
  border-radius: 3px;
}
.fe-tab-x:hover { color: var(--color-error); background: rgba(0,0,0,0.2); }

.fe-pane {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0;
  overflow-anchor: auto;
}
.fe-pane-empty {
  padding: var(--space-xl);
  color: var(--color-text-muted);
  text-align: center;
}
```

The old `.fe-card`, `.fe-stream`, `.fe-head`, `.fe-status`, etc., are
removed entirely. The diff-row CSS (`.fe-row`, `.fe-gutter`,
`.fe-line`, marks) stays because `FileTab.render()` uses
`renderFullFile` which produces those.

---

## HTML

```html
<div class="fe-root">
  <header class="fe-toolbar">
    <span class="fe-repo" id="feRepo">repo</span>
    <button class="fe-follow" id="feFollow">↓ Follow edits</button>
    <span class="fe-actions">
      <button class="fe-btn" id="feOpen" title="Open file">+</button>
    </span>
  </header>
  <div class="fe-tabs" id="feTabs"></div>
  <div class="fe-pane" id="fePane">
    <div class="fe-pane-empty" id="fePaneEmpty">
      No files open. Click + to open one, or wait for edits.
    </div>
    <div class="fe-pane-empty" id="feNotGit" hidden>
      Not a git repo — file-edits requires git.
    </div>
  </div>
</div>
```

The "not a git repo" message lives in the pane area as a sibling of
the empty-state element. The snapshot endpoint's not-a-git-repo
signal toggles its `hidden` attribute; tabs strip is also hidden in
that state (the `+` button is disabled too).

---

## Edge cases

- **Edit arrives for a path with an open tab while followEdits=false.**
  Tab content updates in place (FileTab.update). If the tab is the
  active tab, the pane re-renders. If not, just the cached pane DOM
  updates. Badge increments.
- **Edit arrives for a path with NO open tab while followEdits=true.**
  New tab opens; active switches to it; pane scrolls to top.
- **Edit arrives for a path with NO open tab while followEdits=false.**
  New tab opens (appended to strip), but stays inactive. Badge
  increments. User can click the tab or Follow.
- **User picks a file that's already open.** No new tab; switch to
  existing; turn off followEdits; pane restores scrollTop.
- **User Xs the active tab.** The **left neighbor** in strip order
  becomes the new active tab. If the closed tab was leftmost, the
  **right neighbor** becomes active. If it was the only tab,
  `activeTabId = null` and the empty-pane message reappears.
- **User Xs an inactive tab.** Tab closes; active unchanged.
- **Session change.** Persist outgoing session's state; clear
  in-memory; load incoming.
- **Cap eviction.** When the 51st distinct file gets edited, the
  oldest tab in the strip (left-to-right insertion order) gets closed
  IFF it's not the active tab. If the oldest IS active, evict the
  second-oldest. If all 50 are active — impossible, there's one active
  tab.
- **followEdits=true, file edited, but the editing arrived to an
  already-active tab.** No tab switch; just re-render the pane. Scroll
  stays at saved position; followEdits stays on.
- **A picked file that's already in the strip but inactive.** Same as
  pick-existing: switch to it; turn off followEdits.

---

## Acceptance

1. Open the applet with no persisted tabs → empty pane message shows.
2. Agent edits `src/foo.ts` → tab `foo.ts` appears in strip, becomes
   active, pane shows the diff. followEdits stays on.
3. Agent edits `src/bar.ts` next → `bar.ts` tab appears, becomes
   active. `foo.ts` tab remains in the strip but inactive.
4. Click the `foo.ts` tab → pane swaps to `foo.ts` content, scroll
   restores. **Follow-edits button becomes visible** (followEdits is
   now off).
5. Agent edits `bar.ts` again → `bar.ts` tab gets a badge or count
   indicator? **Per spec: Follow-edits button badge increments.**
   `bar.ts` content updates in its cached pane (not visible). `foo.ts`
   remains active.
6. Click "Follow edits" → jumps to most recent edit (`bar.ts`), turns
   followEdits on, hides the button.
7. Scroll the pane → Follow-edits button reappears (followEdits off).
   Save scroll position for the active tab.
8. Switch tabs → restored scroll position for the destination tab.
9. Click + → picker; type, pick `README.md` → tab opens, becomes
   active. Follow-edits stays off.
10. X the active tab → previous tab becomes active. (Or empty pane
    if it was the only tab.)
11. Close applet, reopen → all tabs restored in order. No tab is
    auto-active until a user click or an incoming edit (per
    "active-tab not persisted" rule).
12. Restart server, reopen → tabs persist (per V2.1 mechanism +
    snapshot fill).
13. 51st distinct file edited → oldest non-active tab evicted.
14. Switch session → previous session's tabs persist; new session's
    tabs load.

---

## Risks

- **Pre-existing `dismissed[]` lists are dropped on first write.** V2.1
  sessions persisted dismissed paths. V3.2 always writes
  `dismissed: []`, so on the first save those entries are lost.
  Operator accepted "no dismiss" so this is intentional.
- **No active-tab restore.** A user who left the applet on a specific
  file last session won't return to that file. They'll see the strip
  but the pane stays empty until they click a tab or an edit arrives
  (with followEdits=true, which is the default). Future schema bump
  could fix.
- **DOM cost of building 50 detached panes.** Each pane holds a full
  hljs-highlighted file. Mitigated by lazy rendering: each tab's
  `paneEl` is built on first `activate()`, not on construction.
- **Word marks + scroll restore.** Scroll position is saved as raw
  pixels. If the file is re-rendered with significantly different
  content (large hunk added near top), the saved pixel position may
  land in a different logical place. Acceptable for V3.2; future work
  could anchor on line number.

## Open questions

1. ~~Lazy `FileTab.render()` or eager?~~ **Resolved: lazy** (BLOCKER 2
   fix). Constructor builds tabEl only; paneEl is built on first
   `activate()`. `update()` defers render when paneEl is null.
2. ~~What does X on the active tab do?~~ **Resolved: left neighbor;
   right if no left; null if only tab** (normative in Edge cases).
3. **Follow-edits badge: count vs dot?** **Recommend count.** Backed
   by `badgeCounter: Set<string>` (distinct paths). Click on a badged
   tab decrements (set.delete); click on Follow button clears the
   whole set.
4. **Tab close animation?** None for V3.2.
5. **Active-tab persistence.** Would require adding an `activeTabId`
   field to the server's stored shape. Per the spec review:
   `src/file-edits-store.ts` constructs the on-disk object explicitly
   and ignores extra fields, so a v2 bump is optional — but the
   `setSessionData` call only stores what `setCardList` builds, which
   means an extra field on PUT is dropped. Adding `activeTabId`
   therefore requires a server change (extend `setCardList` body
   type). Deferred to a separate increment to keep V3.2 strictly
   client-only.

## Document layout

- `docs/file-edits.md` — V1 + V3 backlog (unchanged structurally).
- `docs/file-edits-v2.md` — V2 spec (frozen).
- `docs/file-edits-v2.1.md` — V2.1 spec (frozen).
- `docs/file-edits-v3.1.md` — V3.1 spec (frozen).
- `docs/file-edits-v3.2.md` — this doc. Supersedes the V2 stacked-card
  UX entirely (V2.1 persistence machinery still relevant).
- `docs/file-edits-v3.2-review.md` — review log (post-review).
