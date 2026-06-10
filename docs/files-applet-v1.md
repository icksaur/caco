# Files applet — V1 spec

Status: draft (V1 ready to implement; V2-V4 stubbed).
Predecessor: `file-edits` applet at slug `file-edits`. This spec
generalizes that applet from "tabs are always diffs" to "tabs are
typed views over file paths" and renames it (eventually) to `files`.

V1 ships **two** tab types (`diff`, `markdown`) so the type-dispatch
architecture is exercised end-to-end before we add a third. The
existing file-edits diff path becomes one of N tab types under the
same chrome.

---

## 1. Goal

Replace the current ad-hoc collection of single-purpose file
applets (`markdown-viewer`, `image-viewer`, `html-viewer`,
`text-editor`) with a single tabbed `files` applet whose tabs can
each be one of several **typed views** over a file path. The first
two types are the existing file-edits diff card and a new markdown
viewer.

The applet's chrome (header, tab strip, follow indicator, +
button) is type-agnostic. Each tab type plugs into a fixed contract
and owns its own DOM, lifecycle, file-watch subscription, and
optional state echo to `setAppletState`.

The applet stays slug `file-edits` for V1 to avoid breaking agent
usage and saved applets; rename to `files` lands in V4 as part of a
deprecation pass.

---

## 2. Use cases

| # | Story | Tab type |
|---|---|---|
| U1 | "Show me the diff for src/foo.ts" — agent or user opens a file with pending changes. | `diff` |
| U2 | "Open this changelog as rendered markdown" — user clicks + and picks `CHANGELOG.md`. | `markdown` |
| U3 | While viewing rendered markdown, an external edit (agent run, editor save) re-renders the tab automatically. | `markdown` (via watchPath) |
| U4 | While viewing a diff, the agent saves the file. Tab updates from the next `caco.edit` poll. | `diff` (existing V3.5 behavior) |
| U5 | User has 6 tabs open across both types; closing one keeps the rest stable and active-tab focused. | both |
| U6 | Switching session: tabs from the prior session unmount, tabs for the new session re-hydrate from server card list. | both |

---

## 3. Non-goals (V1)

- No write surface (no editor, no save). Markdown tab is read-only.
- No image / html / text-edit tab types yet — they're stubbed in §10.
- No tab reordering by drag (the existing applet doesn't support
  it either; out of scope).
- No tab persistence across browser reloads beyond what the existing
  cards API already provides — diff tabs are persisted via
  `/file-edits/cards` and will remain so; markdown tabs are
  per-session memory only in V1 (persistence in V2 alongside the
  schema bump).
- No replacement of the existing standalone applets yet. They
  continue to load until V4's deprecation pass. The new tab types
  call the same backend endpoints as the standalone applets so
  there is no parallel implementation burden.

---

## 4. Design

### 4.0 Class-level design — modules, ownership, lifecycle

This section is the authoritative source for who-owns-what,
collaboration rules, and lifecycle ordering. Prose + tables only
(no diagrams). Implementers MUST read this section before
writing code; reviewers MUST verify changes don't violate
invariants here.

#### 4.0.1 Modules

There are exactly three JS files involved in V1, plus the
existing `content.html` and `style.css`:

| Module | File | Loaded by | Exposes |
|---|---|---|---|
| Shell | `applets/file-edits/script.js` | `<script>` in content.html (last) | nothing — IIFE; uses `window.__filesApplet` to read tab classes |
| DiffTab class | `applets/file-edits/diff-tab.js` | `<script>` in content.html (before shell) | `window.__filesApplet.DiffTab` |
| MarkdownTab class | `applets/file-edits/markdown-tab.js` | `<script>` in content.html (before shell) | `window.__filesApplet.MarkdownTab` |

Applets are not bundled. The `window.__filesApplet` namespace is
the load-order workaround for the lack of a module loader; it is
read-only after the shell starts and never modified by tab
classes themselves.

#### 4.0.2 Object instances and ownership

`TabConstructor` below is the **synchronous** constructor of a tab
class (DiffTab, MarkdownTab). It allocates DOM but does NOT attach
it to `shell.paneEl` / `shell.tabStripEl`. Attachment happens in
the `open()` factory after all awaits succeed (see §4.0.5
mounted-detached → mounted-inactive transition; this resolves
the "factory-rejection leaves orphan DOM" hazard).

| Instance | Lifetime | Owner (creates + destroys) | Visibility |
|---|---|---|---|
| The `shell` object (plain JS object) | One per applet load | Shell IIFE | passed by reference to every tab constructor; tabs hold a reference |
| `tabs: Map<string, TabInstance>` | One per applet load | Shell IIFE | private to shell — tab classes MUST NOT read or write the map |
| `activeTabId: string \| null` | One per applet load | Shell IIFE | private to shell — tabs learn they are active via the `activate()` callback, not by reading this field |
| `tabTypes: TabTypeDescriptor[]` | One per applet load | Shell IIFE | append-only, populated at init by the shell; never mutated thereafter |
| `TAB_CAP = 50` (constant) | Module-level | Shell IIFE | drives `evictOldestNonActive` when `tabs.size > TAB_CAP` |
| `lastEditedTabId: string \| null` | One per applet load | Shell IIFE | drives `jumpToMostRecent`; updated on `caco.edit` arrival; cleared on session-switch |
| The `echoState` coalesce flag (`echoPending: boolean`) | One per applet load | Shell IIFE | guards a single `queueMicrotask`-batched `setAppletState` call per tick (see A2) |
| A `DiffTab` instance | From `openDiffTab()` resolution until `closeTab(id)` OR session-switch destroy | Shell (via `routeOpen` / cards rehydrate) | held by the shell only |
| A `MarkdownTab` instance | From `MarkdownTab.open()` resolution until `closeTab(id)` OR session-switch destroy | Shell (via `routeOpen`) | held by the shell only |
| A tab's `contentEl` (subtree) | Same as its owning tab | The tab class — created in constructor (detached), attached by factory after awaits succeed, detached in `destroy()` | mounted in `shell.paneEl` once attached |
| A tab's `tabEl` (the tab-strip button) | Same as its owning tab | The tab class — same lifecycle as `contentEl` | mounted in `shell.tabStripEl` once attached |
| A `WatchHandle` (markdown) | From acquire in `MarkdownTab.open()` until `MarkdownTab.destroy()` | MarkdownTab | private |
| An `AbortController` for in-flight `fetch('/api/file')` (markdown) | Recreated on each `load()` call | MarkdownTab | private |
| The card-persist debounce timer | One per applet load | Shell | private |
| `pickerOpenAbort: AbortController \| null` | Replaced on each picker open | Shell | private |
| The `caco.edit` listener registration | One per applet load | Shell | the registration is held until the applet's iframe is detached (see §4.0.7 Flow F); explicit unsubscribe is not required |

Rule: **each row's "Owner" cell is the only code that may delete or
replace the instance.** Cross-owner references are read-only.

#### 4.0.3 Shell-side API tabs may call

The `shell` object is the entire collaboration surface tab
classes may use. Tab classes MUST NOT reach into shell-private
state by other means (no closure access, no window-globals).

| Method | When tab may call | Effect |
|---|---|---|
| `shell.closeTab(id: string)` | From tab's own UI gestures (X click, middle-click); MUST NOT call from inside `destroy()` or from `update()` | Shell removes the tab from the map (BEFORE destroy), then calls `tab.destroy()`, picks a new active tab. See §4.0.7 Flow E for the exact sequence. |
| `shell.setActiveTab(id: string)` | From tab's own UI gestures (tab button click) | Shell synchronously deactivates current tab (if any), then activates the named tab. |
| `shell.echoState()` | After any state change worth echoing (e.g. markdown `load()` success, diff selection change). Must NOT call from `destroy()` or from the constructor | Shell composes the legacy + new envelopes and pushes via `setAppletState`. **Coalesced** via `queueMicrotask`: many calls per tick collapse into one push (see §4.0.5 rule 7 and A2). Tabs may call freely. |
| `shell.api` | At any time | Read-only handle to `window.appletAPI`. |
| `shell.sessionId: string` | At any time during the tab's life | Current session. Tabs may NOT cache this across awaits — it is invalidated on session-switch teardown (the tab is destroyed before that field is read meaningfully). |
| `shell.paneEl: HTMLElement` | At construction (to ALLOCATE contentEl referencing parent) and at the factory's mount step | Parent for `contentEl`. The tab class attaches in the factory (after awaits) and detaches in `destroy()`. |
| `shell.tabStripEl: HTMLElement` | Same as `paneEl` | Parent for `tabEl`. |
| `shell.getFollowEdits(): boolean` / `shell.setFollowEdits(v: boolean)` | DiffTab only — follow-edits is a diff-specific concept | Read/mutate the shell-owned `followEdits` flag. MarkdownTab MUST NOT touch follow state. |
| `shell.programmaticScrollTo(target)`, `shell.updateFollowButton()`, `shell.renderBody(paneEl, edit)`, `shell.basename(p)`, `shell.badgeCounter: Set<string>` | DiffTab only | Shell helpers that exist solely to support diff cards. Future tab types MUST NOT use them. Exposed on `shell` rather than duplicated into `diff-tab.js` to preserve file-edits-v3.5's deduplication. |

Note: `shell.getActiveTabId()` is intentionally NOT provided. Tabs
learn they are active via `activate()`, not by polling. If a tab
needs to know "am I active?" it can track its own
`activated`-flag toggled by `activate`/`deactivate`.

#### 4.0.4 TabInstance contract tabs MUST implement

(Detailed signatures in §4.2.) The contract distinguishes the
**synchronous constructor** from the **async `static open()` factory**
— they have different rules.

| Method | Called by shell when | MUST | MUST NOT |
|---|---|---|---|
| **constructor `(shell, ...)`** (synchronous) | Once per tab, from `open()` factory | Set `this.id`, `this.type`, `this.label`, `this.title`; allocate `tabEl` and `contentEl`; set `contentEl.style.display = 'none'` (per §4.0.6); allocate own fields (watchers null, destroyed=false) | Throw asynchronously; touch the network; attach DOM to `shell.paneEl` / `shell.tabStripEl` (factory does that); call `shell.echoState`; assume `shell.sessionId` won't change later |
| **`static open(shell, abs, rel): Promise<TabInstance>`** (async) | Called by shell's `routeOpen` | Construct the tab; perform all needed network awaits (acquire watcher, fetch initial content); on success, attach `tabEl` and `contentEl` to `shell.tabStripEl` / `shell.paneEl`; return the mounted-inactive instance. On any await rejection: call `inst.destroy()` (which is safe because no DOM was attached and no watcher was kept), then re-throw | Throw without cleaning up partial state |
| **`activate()`** (synchronous) | When this tab becomes the active tab (after another tab's `deactivate()`) | Set `contentEl.style.display = ''`; restore scroll/focus as needed | Touch sibling tabs or `tabs` map; call `shell.setActiveTab`; do async work |
| **`deactivate()`** (synchronous) | When this tab is about to stop being active (NOT called before `destroy()`) | Set `contentEl.style.display = 'none'`; save scroll/focus as needed | Touch sibling tabs; do destructive work (instance may be reactivated) |
| **`destroy()`** (synchronous) | Exactly once, when the tab is removed (close, session-switch) | Set `this.destroyed = true` FIRST; abort own in-flight fetches; close own watchers; detach `tabEl` and `contentEl` from the DOM; null out heavy refs (edit, selection). Idempotent: if `this.destroyed` was already true, return | Call `shell.closeTab` (would recurse); call `shell.echoState` (shell will echo after destroy completes); throw |
| **`update(edit)`** (DiffTab only; optional for others) | When a `caco.edit` event matches this tab's path | Update internal state and re-render body | Call `shell.closeTab(this.id)`; touch sibling tabs; throw (shell iterates many tabs per event; a throw aborts the loop) |
| **`echoState(): Record<string, unknown> \| null`** (optional) | When shell composes `setAppletState` | Return a small JSON-serializable fragment; return null to opt out | Mutate the tab's own state; do I/O |

#### 4.0.5 Lifecycle states and transitions

Each tab instance moves through these states in order, with
exactly these allowed transitions:

| State | Entered when | Exited when | Allowed shell operations | Allowed tab operations |
|---|---|---|---|---|
| **constructed (detached)** | Tab constructor returns inside the factory | Factory's await chain completes AND factory attaches `tabEl` + `contentEl` to the DOM → mounted-inactive; OR any await rejects → destroyed (factory calls `destroy()` on the partial instance, which is safe because nothing is attached) | none (shell does not yet hold the instance) | inside the factory: await network operations; on success, attach DOM and return |
| **mounted (inactive)** | Factory returns the attached instance AND shell does `tabs.set(tab.id, tab)` | `activate()` → active; `destroy()` → destroyed | `setActiveTab(id)` → triggers `activate`; `closeTab(id)` → triggers `destroy` | render updates from background events (markdown watcher); `shell.echoState()` |
| **active** | `activate()` returns | `deactivate()` → mounted-inactive; `destroy()` → destroyed (no `deactivate` first; `destroy` MUST handle both transitions) | `setActiveTab(otherId)` → triggers `deactivate` here; `closeTab(id)` → triggers `destroy` here directly | render updates; `shell.echoState()`; `shell.closeTab(this.id)` only from user-initiated UI events |
| **destroyed** | `destroy()` returns | (terminal) | tab no longer in `tabs` map | tab is unreachable — pending async callbacks MUST check `this.destroyed` and bail |

Critical ordering rules:

1. `destroy()` is called **exactly once** per tab. The shell
   enforces this: `closeTab(id)` is a no-op if `tabs.get(id)` is
   undefined. The tab's own `destroyed` flag provides a second
   layer of idempotency for async re-entry.
2. **The shell removes the tab from `tabs` BEFORE calling
   `destroy()`.** In-flight async callbacks that re-enter the
   shell (a watcher event firing during teardown) cannot find the
   tab again. This is the canonical sequence; see Flow E.
3. `MarkdownTab.load()` (which awaits `fetch`) MUST check
   `this.destroyed` after every `await` and bail. The flag is set
   to `true` at the top of `destroy()` before any teardown work.
4. `activate` and `deactivate` are synchronous. No awaits. The
   shell calls them in immediate succession during a switch
   (deactivate-old, then activate-new).
5. `caco.edit` arrival during a `destroy()` in flight is safe
   because the tab is no longer in `tabs` (rule 2).
6. Session-switch destroy: capture `tabs.values()` to an array,
   clear the map, set `activeTabId = null`, THEN call `destroy()`
   on each captured tab. The map is empty before any destroy runs
   (preserves rule 2) and there is no iteration-during-mutation.
7. `shell.echoState()` is coalesced: the first call in a tick sets
   `echoPending = true` and `queueMicrotask(() => { echoPending =
   false; setAppletState(compose()); })`. Subsequent calls in the
   same tick are no-ops. This bounds state-echo cost to one push
   per tick regardless of how many `MarkdownTab.load()` calls fire
   from a single watch burst.
8. **Factory failure cleanup:** if `static open` rejects, the
   factory MUST call `inst.destroy()` on its partially-constructed
   instance before re-throwing. Because the constructor does NOT
   attach DOM and does NOT acquire watchers (those happen in the
   factory body), a `destroy()` on a partial instance is cheap and
   correct: it sets `destroyed = true`, aborts any in-flight fetch,
   closes any watcher that was acquired before the rejection, and
   the unattached `tabEl` / `contentEl` are simply garbage-collected.

#### 4.0.6 Invariants

| Invariant | Why | Where enforced |
|---|---|---|
| At most one tab in `tabs` has `contentEl.style.display !== 'none'` at any given time. | Tab-switch correctness; prevents stacked render. | Constructor sets `display = 'none'`; `setActiveTab` deactivates-old before activating-new. |
| Every newly-constructed `contentEl` has `display: 'none'` BEFORE the factory attaches it to the pane. | Without this, the second tab opened would flash visible for one frame and violate the invariant above. | Constructor sets `style.display = 'none'` as its first DOM op. |
| `activeTabId === null` OR `tabs.has(activeTabId)` is true. | Active id is always a live tab. | Shell's `closeTab` (picks new active id BEFORE destroying old, after map delete); session-switch teardown (sets null). |
| Every tab in `tabs` has its `tabEl` attached to `shell.tabStripEl` AND its `contentEl` attached to `shell.paneEl`. | DOM and model agree (only mounted-inactive / active instances are in `tabs`). | Factory attaches before returning; tab `destroy()` detaches. |
| A tab is destroyed exactly once. | Resource safety (watchers, fetches, listeners). | Shell removes from `tabs` before calling `destroy`; tab's own `destroyed` flag is the second layer. |
| `tabs.size <= TAB_CAP` outside the critical section of `openOrUpdateTab` (where eviction runs immediately after `tabs.set`). | Bounded memory and DOM. | `openOrUpdateTab` calls `evictOldestNonActive` after each `tabs.set` if over cap. |
| `tabTypes` is append-only and frozen-shaped after init. | Routing decisions must be stable across an applet's lifetime. | Shell does not expose `tabTypes` outside the IIFE. |
| The `shell` object reference passed to a tab is the same reference for the tab's entire lifetime. | Tabs may cache `shell.paneEl` etc. across calls. | Shell builds `shell` once at IIFE start; never reassigns. |
| Tab classes never read or mutate `tabs`, `activeTabId`, or other tabs' state. | Locality / no cross-tab bleed (the R3.5 lesson). | Code review; tabs only call the methods enumerated in §4.0.3. |
| Diff-specific shell helpers (`shell.renderBody`, `shell.programmaticScrollTo`, `shell.badgeCounter`, etc.) are never called from `MarkdownTab` or future non-diff types. | Avoids growing the shell-helper surface as types are added. | Code review; §4.0.3 marks each helper "DiffTab only". |
| Markdown card persistence: `buildPersistBody` filters to `t.type === 'diff'` so the cards endpoint never receives markdown entries. | Backend schema is diff-only in V1. | Step 8 audit. |

#### 4.0.7 Critical flows (prose)

**Flow A — User picks a file via the + button:**
1. User clicks `feOpen`. Shell opens the picker.
2. User picks a relative path P. Shell computes
   `absPath = cwd + '/' + P` and `relPath = P`.
3. Shell calls `routeOpen(absPath, relPath)`. Routing checks each
   `tabTypes[i].canOpen(absPath, relPath)`:
   - If any returns `'preferred'`, use the FIRST one (registration
     order; markdown is registered first).
   - Else if any returns `'fallback'`, use the FIRST one (diff is
     fallback for every path).
   - Else log a warning and stop.
4. Shell calls `chosen.open(shell, absPath, relPath)`. The factory:
   - Constructs the tab (allocates `tabEl` + `contentEl`, sets
     `display: none`, but DOES NOT attach to shell's DOM yet).
   - Awaits the type-specific async setup (acquire watcher, fetch
     initial content). On any await rejection: factory catches,
     calls `inst.destroy()`, re-throws (or returns null). Shell's
     `routeOpen` catches and logs.
   - On success: attaches `tabEl` to `shell.tabStripEl` and
     `contentEl` to `shell.paneEl`. Returns the
     **mounted-inactive** instance.
5. Shell `tabs.set(tab.id, tab)`. If `tabs.size > TAB_CAP`,
   `evictOldestNonActive()` runs.
6. If it was the first tab OR the user explicitly clicked the new
   tab, shell calls `setActiveTab(tab.id)` → state moves to
   **active**.
7. Shell calls `shell.echoState()` (coalesced; the actual
   `setAppletState` push happens at the next microtask).

**Flow B — External edit re-renders markdown tab:**
1. File on disk changes. Server file-watcher emits a coalesced
   `caco.fs.changed` event on the lease (150ms server coalesce
   in `src/watch-store.ts`). Note: server coalescing is the only
   coalescing layer — no client debounce.
2. The applet-runtime watch handle's `onChange` callback fires.
3. MarkdownTab calls its own `load()`. Inside:
   - `this._abort?.abort(); this._abort = new AbortController();`
   - `await fetch(..., signal: ...)`. If `this.destroyed`, bail.
   - `mdEl.textContent = text; renderMarkdownElement(mdEl);`
   - `shell.echoState()` (coalesced).
4. If two writes arrive in quick succession past the server
   coalesce window, the first `fetch`'s `AbortController` is
   replaced and aborts — only the latest fetch's result reaches
   the DOM. AbortError is caught silently.

**Flow C — Session switch teardown:**
1. `appletAPI.onSessionChange(handler)` fires.
2. Shell captures `const captured = Array.from(tabs.values());`,
   then clears `tabs`, sets `activeTabId = null`, clears
   `lastEditedTabId`.
3. For each `tab` in `captured`, shell calls `tab.destroy()`. A
   `destroy()` failure is logged but does not abort the loop.
4. Shell re-runs the cards hydrate flow against the new session:
   GET `/file-edits/cards`, build a DiffTab per card via the
   factory pattern (each card calls `openDiffTab(shell, abs, rel)`).
5. Shell calls `shell.echoState()` once at the end (coalesced).

Note: applet hide/show (when the user switches to a different
applet in the stack) does NOT destroy tabs. The runtime hides
the applet's DOM subtree; tabs keep their watchers active, fetches
in flight, etc. Only `onSessionChange` triggers teardown.

**Flow D — `caco.edit` event arrives:**
1. Shell's WS handler receives `{ type: 'caco.edit', data: { edits: [...] } }`.
2. For each edit, shell iterates `tabs.values()` filtered to
   `t.type === 'diff'`:
   - If `t.relPath === edit.relativePath`, call `t.update(edit)`.
   - Update `lastEditedTabId = t.id`.
3. Markdown / future-type tabs are unaffected because the filter
   excludes them.
4. Shell calls `shell.echoState()` once after the loop (coalesced).

**Flow E — `closeTab(id)` (X click, middle-click, or close-all):**
1. Caller (a tab gesture handler) calls `shell.closeTab(id)`.
2. `tab = tabs.get(id); if (!tab) return;` — idempotent.
3. `wasActive = (id === activeTabId);`
4. `neighbour = wasActive ? pickNeighbour(id) : null;` (next tab in
   insertion order, else previous, else null)
5. **`tabs.delete(id);`** (rule 2: remove from map first)
6. If `wasActive`: `activeTabId = null;` then
   `if (neighbour) setActiveTab(neighbour);` — `setActiveTab` will
   see `prev = null` (the closed tab is no longer in `tabs`) and
   only call `neighbour.activate()`. The dying tab's
   `deactivate()` is intentionally skipped; its scroll/selection
   state is about to be discarded by `destroy()`.
7. `tab.destroy();` — sets `destroyed = true`, aborts fetches,
   closes watchers, detaches DOM.
8. `shell.echoState()` (coalesced).

**Flow F — Applet teardown (page navigation away):**
The Caco runtime removes the applet's DOM subtree when the user
navigates away (closes the applet, switches to a different page).
Tab `destroy()` methods are **not** invoked. Outstanding watchers
expire via the server-side lease TTL (5 minutes); outstanding
fetches abort when the iframe is detached. Tabs MUST NOT rely on
`destroy()` for resource safety against this path; the only
guaranteed cleanup is server-side lease expiry. This is acceptable
in V1 because the only client resources are watchers (TTL'd) and
fetches (auto-aborted).

#### 4.0.8 What the spec does NOT specify (and why)

- **CSS class names beyond those already in style.css.** The
  shell does not care about the markdown tab's internal markup.
- **Whether MarkdownTab's `contentEl` uses a single
  `<pre class="markdown-rendered">` or nested divs.** Tab class
  internal.
- **Concurrency of multiple browser tabs viewing the same
  session.** The existing `sourceId` mechanism (kept in §7) handles
  cross-tab echo loops; no new mechanism in V1.

---

### 4.1 Architecture (prose)

The shell owns chrome (header, tab strip, pane), a `tabs` map of
TabInstances, an `activeTabId`, and a `tabTypes` registry. Each
TabInstance owns its own DOM subtree (`tabEl` in the strip,
`contentEl` in the pane) and any per-instance resources
(MarkdownTab owns one `WatchHandle` and one `AbortController`;
DiffTab owns per-card selection state).

Two tab types ship in V1: `diff` (the existing file-edits diff
card extracted into a class) and `markdown` (a new typed view
that fetches the file, renders via `window.renderMarkdownElement`,
and subscribes to `appletAPI.watchPath` for live updates). Future
types (image, html, text-edit, finder) plug in via the same
contract.

### 4.2 TabInstance contract

Every tab type implements this contract. The shell owns construction,
mounting, switching, and destruction; the tab type owns its DOM
and its lifecycle.

```ts
interface TabInstance {
  /** Stable identifier within the applet. For diff tabs this is
   *  the relative path (today's behavior). For markdown tabs this
   *  is `markdown:${absolutePath}`. Used as the Map key. */
  readonly id: string;

  /** The tab type. Drives icon, label rendering, and (in V2+)
   *  per-type chrome decoration like the view/edit flip button. */
  readonly type: 'diff' | 'markdown';

  /** Short label shown on the tab button (e.g. basename). */
  readonly label: string;

  /** Tooltip text. Usually the full path. */
  readonly title: string;

  /** The DOM node for this tab's content. Mounted into the
   *  shared pane on activate(). Each tab keeps its own subtree
   *  alive across deactivate/activate so scroll position and
   *  selection survive. */
  readonly contentEl: HTMLElement;

  /** Called when the user switches TO this tab. The contentEl
   *  is already in the pane; this is the place to restore focus,
   *  scroll-to-line, etc. */
  activate(): void;

  /** Called when the user switches AWAY from this tab. The
   *  contentEl is about to be detached from the pane. */
  deactivate(): void;

  /** Called when the tab is closed (X, middle-click, session
   *  switch). MUST release watchers, abort fetches, remove
   *  listeners. After destroy() the instance is unreachable. */
  destroy(): void;

  /** Optional: produce the per-tab fragment of agent-visible
   *  state. The shell composes these into a single
   *  setAppletState payload keyed by tab id. */
  echoState?(): Record<string, unknown> | null;
}
```

The shell tracks `tabs: Map<string, TabInstance>` and `activeTabId:
string | null`. Activation, close, and persistence flow through the
shell; tab types never touch sibling tabs.

### 4.3 Tab strip and pane

The DOM stays as `applets/file-edits/content.html` (header / tabs /
pane). The only structural change: the pane holds **N detached
content elements** (one per tab) with `display:none` for inactive
ones. Today's applet has a single `feDiffCard` div per active edit;
moving to N persistent subtrees costs nothing (the DOM was already
per-tab in `FileTab.prototype.render`) and lets tab types own their
DOM without re-rendering on switch.

Visual style is unchanged. The tab button's content is rendered by
the shell from `tab.label` and a type-specific class (`fe-tab-diff`
| `fe-tab-md`). The type-specific class is only used
for an icon-bearing pseudo-element (small ◇/¶ glyph) so tab types
are visually distinguishable but not visually heavy.

### 4.4 The + button and picker

The existing `+` button opens a file picker (`pickFile`, line 1240
of `applets/file-edits/script.js`). The picker returns a relative
path; today that path is unconditionally passed to
`POST /file-edits/open` which fetches a diff and creates a diff tab.

V1 adds a **type-routing step** after picker selection:

1. The shell asks the registered tab types, in declaration order,
   whether they want to handle this path: `canOpen(absPath,
   relPath): { confidence: 'preferred'|'fallback'|'no' }`.
2. If exactly one type returns `preferred`, that type opens the
   tab. If multiple return `preferred`, the first wins (we don't
   need a disambiguation menu in V1).
3. If none return `preferred`, the first `fallback` wins (diff is
   the fallback for V1: it always works on tracked files).
4. The chosen tab type's static `open(shell, absPath, relPath):
   Promise<TabInstance>` factory creates the tab.

Routing rules in V1:
- `MarkdownTab.canOpen` returns `preferred` when the extension is
  `.md` / `.markdown` / `.mdx`.
- `DiffTab.canOpen` returns `fallback` for everything else (and for
  `.md` when the file has uncommitted changes — but markdown wins
  in that case per ordering, so the user sees the rendered view).

Open question (resolved): "What if the user wants to see the diff
of a .md file?" → V1 ships a small **per-tab type dropdown** on the
+ button: clicking the chevron next to + opens a menu listing
available types ("Diff", "Markdown"); clicking the + button itself
uses the routing rules. Implementation cost is one extra menu; pays
off in V2 when more types arrive.

### 4.5 MarkdownTab

```ts
class MarkdownTab implements TabInstance {
  readonly id: string;           // `markdown:${absPath}`
  readonly type = 'markdown';
  readonly label: string;        // basename
  readonly title: string;        // absPath
  readonly tabEl: HTMLElement;      // unattached at construction
  readonly contentEl: HTMLElement;  // .files-md-content, display:none at construction
  private shell: ShellAPI;
  private absPath: string;
  private watcher: WatchHandle | null = null;
  private _abort: AbortController | null = null;
  private destroyed = false;
  private bytes = 0;

  // Constructor (synchronous, no network, does NOT attach DOM):
  constructor(shell, absPath) {
    this.shell = shell;
    this.absPath = absPath;
    this.id = 'markdown:' + absPath;
    this.label = basename(absPath);
    this.title = absPath;
    this.tabEl = buildTabButton(this);            // detached
    this.contentEl = buildContentEl();            // detached
    this.contentEl.style.display = 'none';        // invariant
  }

  // Factory: acquire watcher FIRST so a write during the initial
  // fetch is not silently dropped. On any rejection, destroy()
  // cleans up partial state and the factory re-throws.
  static async open(shell, absPath, relPath) {
    const inst = new MarkdownTab(shell, absPath);
    try {
      inst.watcher = await shell.api.watchPath(absPath, { scope: 'file' });
      inst.watcher.onChange(() => { void inst.load(); });
      await inst.load();
    } catch (err) {
      inst.destroy();
      throw err;
    }
    // All awaits succeeded — attach DOM.
    shell.tabStripEl.appendChild(inst.tabEl);
    shell.paneEl.appendChild(inst.contentEl);
    return inst;
  }

  async load() {
    if (this.destroyed) return;
    this._abort?.abort();
    this._abort = new AbortController();
    try {
      const res = await fetch(
        `/api/file?path=${encodeURIComponent(this.absPath)}`,
        { signal: this._abort.signal },
      );
      if (this.destroyed) return;
      if (!res.ok) { this.renderError(`HTTP ${res.status}`); return; }
      const text = await res.text();
      if (this.destroyed) return;
      this.contentEl.textContent = text;
      window.renderMarkdownElement(this.contentEl);
      this.bytes = text.length;
      this.shell.echoState();
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (this.destroyed) return;
      this.renderError(err.message);
    }
  }

  echoState() { return { kind: 'markdown', path: this.absPath, loaded: this.bytes > 0, size: this.bytes }; }

  activate() { this.contentEl.style.display = ''; }
  deactivate() { this.contentEl.style.display = 'none'; }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._abort?.abort();
    void this.watcher?.close();
    this.tabEl.parentNode?.removeChild(this.tabEl);
    this.contentEl.parentNode?.removeChild(this.contentEl);
  }
}
```

The MarkdownTab is a near-direct port of `applets/markdown-viewer/
script.js` into a class with the V1 lifecycle. The
`renderMarkdownElement` global is reused (loaded by the Caco core,
not by the standalone markdown applet).

Ordering note: **acquire watcher BEFORE first load.** If we
load-then-watch, a write occurring between the fetch's response
and the watcher's first event would not trigger a re-render. The
watcher-first order means the first event might fire before
`load()` finishes, but `load()`'s AbortController-on-each-call
pattern collapses the redundant fetches correctly.

### 4.6 DiffTab

The existing `FileTab` constructor in `applets/file-edits/script.js`
(line 60) IS the diff tab type. V1 splits it into:

- `class DiffTab implements TabInstance` — the existing FileTab
  body, renamed and exposed with `static open(shell, absPath,
  relPath) → DiffTab` that wraps the existing `pickFile` POST flow.
  DiffTab already exposes `update(edit)` (today's
  `FileTab.prototype.update` at line 130) which IS the
  TabInstance update method — no rename is needed. The internal
  `render()` helper at line 121 stays as a private repaint hook
  used by `activate()` and `update()`.
- The shell loses its current "I assume every tab is a diff"
  assumption: where it calls `tab.update(edit)` on a `caco.edit`
  arrival, it first filters `tabs.values()` by `t.type === 'diff'`.
  `MarkdownTab` has no `update(edit)` method (it owns its own
  watcher) and the shell never calls into a non-diff tab from the
  diff event handler.

The existing `caco.edit` event handler stays in the shell. On
event arrival it iterates `tabs.values()`, filters by `t.type ===
'diff'`, and calls `t.update(edit)` if the edit's relativePath
matches. MarkdownTab and future types are unaffected.

### 4.7 Tab-type registry

```ts
// In the shell:
const tabTypes: TabTypeDescriptor[] = [
  MarkdownTabType,   // preferred for .md/.markdown/.mdx
  DiffTabType,       // fallback for anything else
];

interface TabTypeDescriptor {
  type: 'diff' | 'markdown';
  label: string;     // "Markdown" — used in the + chevron menu
  canOpen(absPath: string, relPath: string): 'preferred'|'fallback'|'no';
  open(shell: ShellAPI, absPath: string, relPath: string): Promise<TabInstance>;
}
```

Registry is a const array in the shell — no extension API in V1.
Adding a type means appending a descriptor. V3+ may promote this
to a public registration API for extensions; V1 keeps it private.

### 4.8 Shell API surface

The shell exposes a small `ShellAPI` to tab instances:

```ts
interface ShellAPI {
  readonly sessionId: string;          // current session, never null after init
  readonly api: typeof window.appletAPI;
  echoState(): void;                   // request a composite setAppletState
  closeTab(id: string): void;          // tab requests its own close
}
```

Tabs never reach into the shell's tab map directly. The shell
calls into tabs via the `TabInstance` contract.

### 4.9 Persistence and rehydration

V1 persists **only diff tabs** through the existing `/file-edits/
cards` endpoint. The cards payload schema stays unchanged. Markdown
tabs are session-scoped in memory only: closing the applet drops
them; reopening doesn't restore them. This is a deliberate V1 cut
— making markdown tabs server-side persistent requires a schema
change (card now has a type field) and we want the V1 architecture
proven first.

V2 will:
- Add `type: 'diff' | 'markdown' | ...` to the card schema.
- Migrate diff-only readers to default missing type to `'diff'`.
- Persist markdown tabs alongside diff tabs.

### 4.10 Session switching

Existing behavior — on session change (`appletAPI.onSessionChange`),
the applet:
1. Calls `destroy()` on every tab.
2. Clears the tabs map.
3. Re-runs the hydrate flow against the new session: GET
   `/file-edits/cards`, rebuild diff tabs from the payload.

V1 markdown tabs do not survive a session change (they're not in
cards). This is acceptable; users who want a markdown view per
session can re-pick the file from the picker.

---

## 5. Backend changes

**None for V1.** All tab types reuse existing endpoints:

| Tab type | Endpoint |
|---|---|
| diff | `POST /api/sessions/:id/file-edits/open`, `GET /file-edits/cards`, WS `caco.edit` |
| markdown | `GET /api/file?path=`, `appletAPI.watchPath` (existing) |

V2+ will require backend changes (card schema bump for typed
persistence; image-viewer migration may need a thumbnail endpoint).

---

## 6. Considerations

### 6.1 Why two tab types in V1 (not one, not three)?

- One type is the baseline (no architecture proof).
- Three types adds breadth (image is binary, html is iframed) but
  obscures whether the abstraction holds for text content. Two
  text types — one read-only generic (markdown) and one
  domain-specific (diff with its existing complex selection
  model) — exercise the contract end-to-end without binary or
  sandbox concerns.

### 6.2 Why not extract the shell into a generic framework?

We'd be designing the abstraction with one client. The current
file-edits shell has 2000 lines mostly devoted to diff card
selection, follow-edits, picker, agent-state echo, and persistence
— these stay even with two tab types. The shell becomes generic by
deletion (removing diff-specific assumptions in tab construction
and event handling), not by adding indirection.

### 6.3 Generic change-listening API for tabs

The spec calls for "Markdown tab content MUST respond to
modifications by re-rendering the file using generic API for
changes listening." The generic API is the existing
`appletAPI.watchPath(absPath, { scope: 'file' })` which already
returns a `WatchHandle` with `onChange()` and `close()`. The shell
does not need to wrap it — MarkdownTab owns its watcher directly
and releases it in `destroy()`.

DiffTab uses the `caco.edit` WS event instead because diff cards
need server-computed diff content (line numbers, hunks, blame), not
just file bytes. The watchPath API would not give us that. The two
mechanisms coexist correctly: watchPath fires on byte-level change;
caco.edit fires on git-poll diff change. Each tab type picks the
right one.

### 6.4 + button: type-routing UX

Three options were considered:
- **A:** Single + opens picker; type chosen by file extension. Fast
  but inflexible (no way to view diff of a .md).
- **B:** + with chevron sub-menu listing all types. Used by VS
  Code's "split editor right" chevron. Spec adopts this.
- **C:** Picker exposes type radios at the top. Cluttered.

Adopted: B. The chevron is a small UI cost; it scales to V3+ types.

### 6.5 Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Markdown re-render on every file write thrashes the DOM for large files. | medium | watchPath events are coalesced server-side per lease; cap re-render at 1 per 100ms client-side debounce. |
| MarkdownTab + DiffTab share the same id namespace; collision if user opens `markdown:/path/to/foo.md` and also has a diff of `foo.md`. | low | Use `${type}:${path}` ids universally for non-diff types; keep diff tabs at bare relPath for cards-backend compatibility. |
| The chevron menu is yet-another-UI-element that may clutter the toolbar. | low | Only show chevron when 2+ types could handle the current picker selection. With one type registered, chevron hides. |
| External applets (image-viewer, etc.) keep working in V1 — but if a user opens a saved applet URL pointing to `markdown-viewer`, they get the old single-purpose applet. Confusing dual UI. | medium | Document in release notes; V4 deprecation pass adds a redirect from `markdown-viewer?path=X` → `file-edits?openMd=X`. |
| The 2000-line script.js becomes harder to navigate when split into types. | medium | Split into `applets/file-edits/script.js` (shell), `applets/file-edits/diff-tab.js`, `applets/file-edits/markdown-tab.js`. Loaded via `<script>` tags in `content.html`. No bundler. |

### 6.6 Open questions (with chosen answers)

1. **Should MarkdownTab persist across session-switches?** No in V1
   (per §4.9). V2 if useful.
2. **Should the chevron menu list types the file's extension does
   NOT match?** Yes — all registered types, sorted with `preferred`
   first. V1 picker selection can override extension-based routing.
3. **Where does `renderMarkdownElement` come from?** It's already a
   window-global injected by Caco core (used by both chat rendering
   and markdown-viewer). MarkdownTab calls it directly.
4. **What happens if MarkdownTab.load() races MarkdownTab.destroy()
   (user closes mid-load)?** Track a `destroyed` flag; load() bails
   on the destroyed check after each `await`.
5. **Should the tab strip wrap or scroll horizontally when too
   many tabs?** Existing applet already scrolls; no change.
6. **Should we keep slug `file-edits` for V1?** Yes — renaming now
   would invalidate every saved applet URL and the agentUsage
   pointer. Rename in V4 alongside the redirect from old applet
   slugs.

---

## 7. Code analysis

Files affected in V1:

| File | Change |
|---|---|
| `applets/file-edits/script.js` | Refactor FileTab → DiffTab class; introduce TabInstance contract; add tab-type registry; route + button via registry; add MarkdownTab type. Estimated ~150 lines of net add after extraction. |
| `applets/file-edits/diff-tab.js` | NEW. Extracted FileTab/DiffTab class. ~400 lines moved out of script.js. |
| `applets/file-edits/markdown-tab.js` | NEW. ~80 lines (mostly the markdown-viewer/script.js port). |
| `applets/file-edits/content.html` | Add chevron next to + button (`<button id="feOpenMenu">▾</button>` hidden until ≥2 types registered). |
| `applets/file-edits/style.css` | Small additions for chevron + tab-type icon classes. |
| `applets/file-edits/meta.json` | `description` updated to mention multiple tab types. |
| `docs/files-applet-v1.md` | THIS SPEC. |
| `docs/file-edits-v3.6.md` (optional) | The diff-side incremental version of this change, if desired. |

Files NOT affected in V1:
- All backend code under `src/` (no schema or API change).
- `applets/markdown-viewer/` and the other to-be-replaced applets
  (they continue to load standalone).

### 7.1 Compatibility with file-edits v3.5

The existing follow-edits, picker, cards persistence, selection
echo, and badge logic are all DiffTab-specific behaviors. They
become DiffTab methods or remain in the shell guarded by `if (tab
&& tab.type === 'diff')`. No removed feature, no behavior change
for users who only ever open diff tabs.

---

## 8. Acceptance

V1 ships when **all** of the following hold:

- [ ] Existing diff-tab smoke test (open a file with changes, see
      the diff card, agent edit triggers update, X closes) passes
      unchanged.
- [ ] Clicking + then picking a `.md` file opens a MarkdownTab,
      not a DiffTab. The tab shows the rendered markdown.
- [ ] Clicking the chevron next to + shows a menu listing
      "Markdown" and "Diff". Selecting "Diff" and picking a `.md`
      file opens a DiffTab of that file.
- [ ] Editing the markdown file externally (write via shell) causes
      the open MarkdownTab to re-render within 1s. The re-render
      preserves the user's current scroll position.
- [ ] Opening 5 tabs of mixed types and switching between them
      shows each tab's content correctly with no leak (no
      MarkdownTab DOM visible while DiffTab is active and vice
      versa).
- [ ] Closing a tab releases its watcher (verified via the watch
      lease being absent from `/api/sessions/:id/watch/leases`
      within 60s).
- [ ] Switching sessions tears down all tabs cleanly; the new
      session's diff cards rehydrate; markdown tabs are dropped.
- [ ] `appletAPI.setAppletState` payload retains the existing
      `fileEdits` envelope byte-identical (including
      `sourceId`, see script.js lines 213-237) so agents reading
      `tabs.fileEdits.selection` continue to work. A new
      sibling key `files: { tabs: [{ id, type, ... }],
      activeTabId }` is added alongside. Verify both keys are
      present in `appletAPI.getAppletState()` output during smoke.
- [ ] `npm run build` passes (no TS in applets but lint + tests).

---

## 9. Roll-back

The change is additive within `applets/file-edits/`. To roll back:
- Revert the V1 commit(s).
- The standalone `markdown-viewer`, `image-viewer`, `html-viewer`
  applets are untouched and continue to work.
- No data migration; no backend schema change.

---

## 10. V2+ stubs

### V2 — preview/edit flip + image tab + persistence

- **Per-type chrome decoration:** A tab type may declare a
  `chromeButton()` that the shell renders into the tab strip near
  the active tab's X. MarkdownTab uses this to show a "✎ Edit"
  button that flips it to an editor view (text edit; not the full
  IDE).
- **Mode model:** Tab types may carry an internal `mode: 'view' |
  'edit'`. The flip is per-instance; closing+reopening starts in
  the default mode.
- **ImageTab:** Port `applets/image-viewer/script.js` into an
  `ImageTab implements TabInstance`. The contract handles binary
  content fine (the tab owns its DOM).
- **Card schema bump:** add `type` field, persist all tab types in
  cards.
- **Open from chat:** clicking a markdown link in chat output
  routes to a MarkdownTab in the files applet instead of opening
  the standalone markdown-viewer.

### V3 — html + enhanced finder

- **HtmlTab:** port `applets/html-viewer/script.js`. Sandboxed
  iframe stays sandboxed.
- **Finder enhancements:** the picker becomes a first-class tab
  type `finder`. Ctrl+P opens it. Recent files, fuzzy match,
  preview-on-hover (renders the file's would-be tab type in a
  side preview).
- **Type-specific search:** the finder filters by tab-type
  (e.g. "only show images").

### V4 — rename + deprecation

- Slug `file-edits` → `files`. Old slug kept as a redirect for one
  release.
- Standalone applets `markdown-viewer`, `image-viewer`, `html-viewer`
  marked deprecated; their entries in `applets/` keep a stub that
  redirects to `files?openType=markdown&path=...`.
- Ctrl+P globally opens the files applet finder tab.
- Refresh of all the per-type icons / chrome to be consistent with
  Caco's broader visual style at V4.

---

## 11. Test plan

V1 tests live with the existing file-edits test surface (which is
manual today — no unit tests for applet JS). We add:

- **Manual smoke** (acceptance §8 items 1-7).
- **Type-routing unit-ish:** a small `tests/unit/files-applet-
  routing.test.ts` exercising `canOpen` for a fixture of paths.
  This is the only piece of new logic that's testable without DOM
  (the routing decision table).

No vitest coverage for the DOM/tab lifecycle in V1 (consistent
with existing applet practice).
