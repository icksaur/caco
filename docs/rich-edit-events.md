# Rich edit events — V1 spec

**Status:** spec rev 2, not implemented. Targets the chat-view rendering of
edit-tool events (currently displayed as a plain `tool.execution_complete`
text block in the activity stream).

## 1. Goal

When the agent uses an edit tool (`edit`, `create`, `write`), the chat
event for that tool call shows a **rich, compact summary** instead of
the raw stringified result block.

V1 summary format (one event):
- **Header** line: tool name + file basename.
- **Per-hunk stat** line: `+N -M` colored (green/red) per hunk, OR
  total `+N -M` if multiple hunks. **No syntax color** for the diff
  text itself.
- **Body**: the diff text (added/removed lines) styled as red/green
  on neutral background. No syntax highlighting.
- **Auto-collapse** if the diff body exceeds **6 lines**. Header +
  stats remain visible. Click to expand. (Re-uses the existing
  collapse mechanism.)

V1 is read-only display polish. No interaction with the files applet,
no toggle to expand-all, no diff-against-current-disk.

## 2. Use cases

- Agent runs `edit` to change a function: chat shows
  `edit  parser.ts  +3 -1` with the three added lines green and
  one removed line red below. Six-line body → no collapse.
- Agent runs `create` to add a 200-line file: chat shows
  `create  new-feature.ts  +200 -0`, collapsed to header only.
  Click to expand the full diff.
- Agent runs `write` to replace a config file: same as create
  for net-replace, but the diff shows both removed and added
  blocks if the file existed.

## 3. Non-goals

- Syntax highlighting of code lines (V1 is plain colored text).
- Inline word-diff (only line-level red/green).
- Filtering/searching the diff.
- Linking the diff back to the files applet (could be V2).
- "Apply" / "revert" buttons.
- Special handling for non-edit tools (existing rendering stays).
- Collapsing the *outer* activity box differently than today.
- Streaming partial diff updates (the event fires at completion).
- Migrating existing chat history to the new rendering (it
  re-renders on session resume via existing event replay, so
  it's free).

## 4. Existing architecture (what V1 must respect)

### 4.1 Event-rendering pipeline

`public/ts/dom-regions.ts` is the sole owner of event → DOM
translation. The pipeline:

1. `ChatRegion.insertEvent(event)` is called for every event.
2. `outerInserter.getElement(eventType, root)` returns the outer
   container — for all activity events (intent, reasoning, tool,
   session.error, etc.) this is a shared `.assistant-activity`
   box per turn. Defined in `EVENT_TO_OUTER` (~line 100).
3. `innerInserter.getElement(eventType, outer, data)` returns
   the inner content div. Tool events use `tool-text` class and
   are keyed by `toolCallId` (so start + complete + progress all
   land in the same inner div). Defined in `EVENT_TO_INNER` +
   `EVENT_KEY_PROPERTY` (~line 128, 162).
4. **First-time create** for keyed events that appear in
   `PRE_COLLAPSED_EVENTS` starts with `.collapsed` class.
   `tool.execution_start` is in this set today.
5. `insertContent(event, inner)` dispatches to a per-event-type
   handler in `EVENT_INSERTERS` (~line 380) which **mutates the
   inner div's textContent or innerHTML**. Tool handlers build
   a markdown string and call `window.renderMarkdownElement` to
   format it.
6. Click handler at `.assistant-activity` toggles `.collapsed`
   on the clicked inner item (~line 700).

### 4.2 Collapse mechanism

CSS at `public/style.css:925-927`:

```
.assistant-activity > .collapsed > *:not(:first-child) {
  display: none;
}
```

When an inner item has `.collapsed`, only its first child element
is visible. Today this is used for:
- `tool.execution_start`: collapsed from the start
  (`PRE_COLLAPSED_EVENTS`).
- `assistant.reasoning`: collapses on completion via
  `finalizeReasoning` + adding a header child as the visible
  "first child".

The first-child-only rule means **the rich edit event must put
its header as the literal first child element** for collapse to
hide everything else cleanly.

### 4.3 Tool-event lifecycle

Same `tool-text` inner div is reused across `tool.execution_start`
and `tool.execution_complete` (keyed by `toolCallId`):

- `start`: handler sets element.textContent to `${name}  ${basename}`
  (the visible-when-collapsed first child today is implicit — the
  whole text node).
- `complete`: handler **overwrites** textContent with a markdown
  string like `*edit  parser.ts*\n\n\`\`\`edit\n…input…\n…output…\n\`\`\``
  then runs `renderMarkdownElement` on it.

V1 must preserve this lifecycle: the inner div may receive a
`start` event, then a `complete` event with the full result.
The rich render fires on `complete` and replaces what `start`
put there.

### 4.4 Why this is fragile (user's warning)

- `EVENT_TO_OUTER`, `EVENT_TO_INNER`, `EVENT_KEY_PROPERTY`,
  `PRE_COLLAPSED_EVENTS`, and the per-event-type `EVENT_INSERTERS`
  are **four parallel maps** keyed by event type. Adding/changing
  behaviour means touching all four consistently. Implicit
  coupling — exactly the smell in `code-quality.md`.
- The collapse CSS rule depends on the inner div's first child
  being the visible header. Any change to the content structure
  (e.g., wrapping the header in a div) silently breaks collapse
  hiding.
- The same handler runs for `start` and `complete`; the
  `complete` handler reads `element.dataset.toolName` /
  `toolInput` set by `start`. State-machine on element dataset.
- `renderMarkdownElement` rewrites innerHTML. Anything the
  handler builds as DOM gets thrown away if a later
  `progress`/`partial_result` event fires (V1 doesn't touch
  those, but future events on the same `toolCallId` could).

### 4.5 Test seam

`tests/unit/dom-regions.test.ts` (~440 lines) has a mock-DOM
harness (`createMockElement`) and exercises every `EVENT_INSERTERS`
handler in isolation. **This is the test method** the user asked
about — pure data-in / mock-element-out, no jsdom or browser.
V1 must add tests at this seam covering the edit handler's
output shape across diff-size buckets (0-line, 1-line, 6-line,
7-line, large).

## 5. Design

### 5.1 Detection of "edit-like" tool events

V1 introduces a constant in `dom-regions.ts`:

```
export const EDIT_TOOLS = new Set(['edit', 'create', 'write']);
```

(Same membership as `WRITE_TOOLS` in `src/dispatch-events.ts` —
note in the spec that these should converge, but the
client/server split makes a shared module premature for V1.
Document the duplication as a follow-up.)

The `tool.execution_complete` handler branches on
`EDIT_TOOLS.has(toolName)`. If true, run the new rich-render
path. Otherwise, fall through to the existing string-builder.

**Canonical extraction.** Define a single helper used by both
the rich-render and existing paths so tool-name and path
resolution stay consistent:

```
function extractToolMeta(element, data):
  toolName = data.toolName || data.name || element.dataset.toolName || 'tool'
  path     = data.arguments?.path || element.dataset.toolInput || ''
  basename = path-like ? basename(path) : ''
```

This avoids the spec-rev-1 contradiction where §6.2 said
"re-derive" but the existing code reads dataset. The helper
reads both sources with `data.*` preferred (matches
`dispatch-events.ts`'s pattern), falling back to dataset set by
`start`. Tested with both startless completes and normal
start→complete sequences.

### 5.2 Parsing the edit result (fixture-driven)

The edit/create/write tools' `result.content` shape is **not
documented**; V1's parser must be written against real fixtures.
Implementation MUST start by capturing the actual
`tool.execution_complete.data` for `edit`, `create`, and `write`
events from a live session (log via a one-shot
`console.log(JSON.stringify(event.data))` in `dom-regions.ts`,
then revert). Fixtures land in
`tests/fixtures/edit-tool-results/{edit,create,write}.json`.

The parser handles whichever shapes the fixtures show. Likely
candidates (parser must cover any it finds in fixtures):
- Unified diff string (`@@ … @@` + `+/-` lines) in
  `result.content`.
- Before/after pair of strings (compute LCS line-diff
  client-side via §5.3 helper).
- Status-only string ("File updated successfully") with no
  diff data — falls through to current rendering.
- JSON-wrapped `result.content` containing one of the above
  (`session-auto-repair.ts` has precedent for synthetic
  wrappers).

A `parseEditResult(data: Record<string, unknown>): EditDiff | null`
helper owns this. Returns `null` when the result isn't
parseable as an edit (fall back to current rendering). Returns
`{ hunks: Hunk[], stats: { added, removed } }` otherwise.

`Hunk = { added: string[], removed: string[] }`. Hunks are
ordered as they appear in the source diff. Context lines from
unified diffs are **dropped** (V1 §3 non-goal: V1 body shows
only added/removed lines, not context). `+++`, `---`, `@@`
header lines are also dropped from stats and body.

A `0-added/0-removed` parsed diff (parser successfully ran but
the edit was a no-op or only-context changes) renders header-
only with `+0 -0` — no empty `<pre>` body element.

### 5.3 Diff computation when result is before/after

If the tool result is a before/after pair (not a pre-computed
diff), V1 computes a **line-level LCS diff** in a new helper
file `public/ts/edit-diff.ts`:

- Export `lineDiff(before: string, after: string): Hunk[]`.
- Pure function, no DOM, no DOM globals.
- Imported by `public/ts/dom-regions.ts` (matches the existing
  TS module bundle path; tested against
  `tests/unit/edit-diff.test.ts`).
- Implementation: standard LCS over line arrays, group adjacent
  changes into hunks.

The applet-side diff lib in `applets/files/` is bundled into
applet content and not importable from `public/ts/*`. **V1
ships a small standalone differ** — no reuse attempt.

### 5.4 Rendering

The rich render builds a DOM tree directly (not a markdown
string), then **replaces** the inner div's children. Before
appending the new structure, clear the element via
`element.textContent = ''` (drops all prior children and text
in one call, including anything `tool.execution_start` put
there).

The structure (described in prose to satisfy prose-only
preference):

- The inner `tool-text` div gets an additional class
  `edit-event`. The `.collapsed` class is set/cleared per §5.6.
- The **first child** is a `<p class="edit-header">` containing,
  in order, a `<span class="edit-tool-name">edit</span>` (no
  styling beyond default), the basename as text, a
  `<span class="edit-stat-add">+3</span>`, and a
  `<span class="edit-stat-rem">-1</span>`. Spans are inline,
  separated by single spaces (as text nodes). The header being
  the literal first child is what makes the existing collapse
  CSS hide all other children when `.collapsed`.
- The **second child** is a `<pre class="edit-body">` containing
  one inline `<span>` per diff line. Added lines have class
  `edit-line-add`, removed lines `edit-line-rem`. The leading
  `+` or `-` character is part of the span text. Lines are
  joined by `\n` text nodes (or one span per line with
  `display: block` — see §5.8).

For a parsed 0-added/0-removed diff, only the header is
appended. No empty `<pre>`.

`renderMarkdownElement` is **not** called for edit events. The
DOM is built once and finalized.

### 5.5 Auto-collapse rule

The `.collapsed` class is owned by **two layers** today:
1. `ElementInserter.getOrCreateKeyed()` adds `.collapsed` on
   first create for keys in `PRE_COLLAPSED_EVENTS` (tool starts
   today).
2. `ChatRegion.renderEvent()` adds `.collapsed` to reasoning
   on the `assistant.reasoning` post-stream completion (~line
   636).

V1 introduces a **third** collapse-owner inside the
`tool.execution_complete` handler in `EVENT_INSERTERS`. This is
intentional and documented here as the design choice:

- The handler is the only place that knows the diff size.
- Moving the rule into `ChatRegion.renderEvent` would require
  re-parsing the diff there or smuggling the size through the
  element — both worse than letting the handler own it.

The rule:
- If `EDIT_TOOLS.has(toolName)` AND parser returned a diff AND
  `stats.added + stats.removed > 6`: ensure `.collapsed` is set.
- If `EDIT_TOOLS.has(toolName)` AND parser returned a diff AND
  `stats.added + stats.removed <= 6`: ensure `.collapsed` is
  REMOVED. The element entered with `.collapsed` from
  `PRE_COLLAPSED_EVENTS`; the handler explicitly removes it for
  short edits.
- If parser returned null (unparseable): leave `.collapsed`
  state as-is (matches current non-edit behaviour — collapsed
  by pre-collapse).
- If `success === false` (failed edit): see §5.7.

Boundary: 6 visible lines → expanded. 7 → collapsed.

### 5.6 Pre-collapse vs post-collapse interaction

Already covered in §5.5. The behaviour summary:

| Scenario | After start | After complete |
|---|---|---|
| Edit, ≤6 lines | collapsed (pre) | **expanded** (handler removes) |
| Edit, >6 lines | collapsed (pre) | collapsed (handler keeps) |
| Edit, unparseable result | collapsed (pre) | collapsed (handler no-op) |
| Edit, failed | collapsed (pre) | **expanded** (§5.7) |
| Non-edit tool | collapsed (pre) | collapsed (unchanged) |

The user-visible behaviour change: today, all tools stay
collapsed after complete. V1 changes the rule for edits
specifically. This is the documented V1 product intent.

### 5.7 Failed edit events

If `data.success === false`, render an error inline. Extraction
order for the error text:

1. `data.error` if a non-empty string.
2. else `result.content` if a non-empty string (covers
   `session-auto-repair.ts`'s synthetic-cancel injections that
   set `success:false` + `result:{content:'...'}`).
3. else `JSON.stringify(data.error)` if `data.error` is set.
4. else literal `'Unknown edit error'`.

DOM shape:
- First child `<p class="edit-header">` containing
  `<span class="edit-tool-name">edit</span>`, the basename, and
  the literal text ` failed` after the basename. No stats.
- Second child `<pre class="edit-error">` with the extracted
  error text.

`.collapsed` is explicitly removed for failed edits — they stay
visible. `.edit-error` styling is its own class (NOT
`.error-text` which is for `session.error`); use
`color: var(--color-error)`.

### 5.8 Style additions

`public/style.css`:
- `.edit-event` — container styling (subtle background, rounded).
- `.edit-header` — basename + stats line; serves as collapse
  visible-when-collapsed first child.
- `.edit-stat-add` / `.edit-stat-rem` — green/red text only on
  the `+N` / `-M` counts. Use `var(--color-success)` /
  `var(--color-error)` for theme compatibility.
- `.edit-body` — `<pre>` with reduced font size, max-width
  scrolling.
- `.edit-line-add` / `.edit-line-rem` — green/red text on
  neutral background. Use the same color vars.

No new theme overrides — the existing color vars carry through.

## 6. Architecture review (mandated by user)

### 6.1 Class-level ownership map

Classes/modules involved and what each owns after V1:

**`ChatRegion`** (`dom-regions.ts`) — top-level orchestrator.
Owns:
- The `outerInserter` + `innerInserter` instances.
- `insertEvent()` dispatch.
- Post-render collapse for `assistant.reasoning` (~line 636
  today; unchanged in V1).
- Click handler that toggles `.collapsed` on inner items
  (~line 700; unchanged).
- `finalizeReasoning`, `removeThinking`, `removeStreamingCursors`
  — special-case event lifecycle methods.

V1 does **not** add a new lifecycle method here. The new
collapse-on-complete logic for edits lives inside the
`tool.execution_complete` handler in `EVENT_INSERTERS`. This is
documented in §5.5 as a deliberate third collapse-owner.

**`ElementInserter`** (`dom-regions.ts`) — pure get-or-create.
Owns:
- `getElement()` for last-child reuse.
- `getOrCreateKeyed()` for `data-key`-based lookup. **This is
  where `.collapsed` is first applied** for keyed events in
  `PRE_COLLAPSED_EVENTS`.

V1 does not modify `ElementInserter` or `PRE_COLLAPSED_EVENTS`.
The `tool.execution_start` keeps starting collapsed; the
`complete` handler decides to remove `.collapsed` for short
edits.

**`EVENT_INSERTERS`** (module-level table) — per-event-type
handlers, pure data → element mutation.
- V1 modifies the `tool.execution_complete` entry: top-level
  branch on `EDIT_TOOLS.has(toolName)`. New branch calls the
  edit renderer (§6.4); fall-through keeps existing markdown
  string-builder verbatim.

**`InserterElement`** type (`dom-regions.ts:285`) — minimal
interface for testability (`textContent`, `dataset`, optional
`classList`).
- V1 widens this to include the methods the edit renderer
  needs: `appendChild`, `removeChild` (for clearing children
  via `textContent = ''` is sufficient — no `removeChild` per
  V1), `className` setter, and a hook to create child elements.
- Two options for child creation:
  - Pass `document.createElement` through a factory injected
    into the handler (testable but adds a layer).
  - Cast `element as unknown as HTMLElement` inside the
    handler and use real DOM APIs; mock `createMockElement`
    extends to support the calls needed.
- **V1 chooses the second**: extend the mock instead of adding
  injection. Smaller diff, simpler runtime path. The mock
  already supports `appendChild`; V1 adds the missing pieces
  (test-only).

**`parseEditResult` + `lineDiff`** — new pure helpers, no DOM
dependency. Their own files + tests. They return data
structures (`EditDiff`, `Hunk[]`), not elements.

**`renderEditEvent(element, data)`** — new pure renderer in
`dom-regions.ts` (or a sibling file — see §6.4). Takes the
element and event data; builds child DOM; sets/removes
`.collapsed` per §5.5. Called by the `tool.execution_complete`
edit branch. Tests can call it directly with a mock element.

### 6.2 Lifecycle invariants (testable contracts)

V1 must preserve these invariants. Tests in §7 assert them.

1. **Same `toolCallId` → same inner element** across start +
   complete. (`ElementInserter.getOrCreateKeyed` contract,
   pre-existing.)
2. **Edit-tool start sets `.collapsed`** via PRE_COLLAPSED_EVENTS
   (pre-existing).
3. **Edit-tool complete with ≤6-line parsed diff** removes
   `.collapsed`. (New.)
4. **Edit-tool complete with >6-line parsed diff** keeps
   `.collapsed`. (New.)
5. **Edit-tool complete with unparseable result** keeps
   whatever class state was present (no rich render). (New
   fallback contract.)
6. **Edit-tool complete with `success: false`** removes
   `.collapsed` and renders the error header + body. (New.)
7. **Non-edit tool complete** behaves identically to today:
   inner element keeps `.collapsed`, renders markdown via
   `renderMarkdownElement`. (Regression invariant.)
8. **Header is the literal first child** for edit events.
   (Collapse-CSS contract, new for V1.)
9. **`tool.execution_progress` / `partial_result` events**
   continue to append text via existing handlers. If they
   arrive AFTER an edit `complete` (theoretical — `complete`
   is terminal in normal flow), they will append text to the
   rich DOM and may visually conflict. V1 documents this as
   "not expected in practice"; impl tests do NOT cover it.
   Future event lifecycle changes that re-allow progress after
   complete must revisit this.

### 6.3 Why no refactor

The four parallel event maps (`EVENT_TO_OUTER`,
`EVENT_TO_INNER`, `EVENT_KEY_PROPERTY`, `PRE_COLLAPSED_EVENTS`)
are real implicit coupling per `code-quality.md`. V1 explicitly
does NOT refactor them because:

- V1 adds zero new event types — the coupling is not exercised
  by this change.
- The new edit logic is isolated behind `parseEditResult`,
  `lineDiff`, and `renderEditEvent` — `tool.execution_complete`
  gets only a small branch.
- Refactoring would touch all ~20 event-type entries in 4
  maps; high churn for no V1 benefit.

The coupling is **pre-existing and acknowledged**. The follow-
up refactor (collapsing the four maps into one
`EVENT_DESCRIPTORS` table) is logged in §11 parking lot.

### 6.4 Renderer file placement

The new `renderEditEvent(element, data)` function is added
inside `dom-regions.ts` next to `EVENT_INSERTERS`. Rationale:
it's the only caller, it touches `EVENT_INSERTERS` directly,
and pulling it into a separate file would expose the
`InserterElement` type in a public seam unnecessarily.

`parseEditResult` and `lineDiff` go in `public/ts/edit-diff.ts`
because they're pure helpers reusable from tests and (V2)
potentially elsewhere. They have no DOM dependency.

### 6.5 Identified seams + risk (revised from rev 1)

| Seam | Risk | V1 mitigation |
|---|---|---|
| 4 parallel maps keyed by event type | Forgetting to update one → silent breakage. | V1 only modifies `EVENT_INSERTERS`. No map updates. Pre-existing risk. |
| Collapse CSS depends on first-child being visible header | Wrapping/restructuring breaks collapse. | V1 puts `<p class="edit-header">` as literal first child. Lifecycle test asserts (invariant 8). |
| `start` handler dataset state read by `complete` handler | New handler must consume same dataset OR re-derive. | Canonical `extractToolMeta()` helper (§5.1) reads both `data.*` and `element.dataset.*`. Tested both ways. |
| `renderMarkdownElement` rewrites innerHTML | If future event re-runs handler on same element, our DOM is clobbered. | V1 is on `complete` which is terminal. Documented in invariant 9. |
| Auto-collapse behaviour change for edits | Could surprise users who expect all tools collapsed. | Documented in §5.5/§5.6. One-line revert if rejected. |
| Pre-collapse + post-complete-collapse two-owner conflict | Two owners of `.collapsed` could disagree. | Explicit rule (§5.5): `complete` handler is authoritative for edit completions, removes/sets explicitly. Lifecycle tests assert. |
| Mock element widening | Adding `appendChild` etc. could subtly diverge from real DOM | Mock additions are minimal; tests also call `ChatRegion.insertEvent` end-to-end with a more complete mock to catch divergence. |

## 7. Testing strategy

User flagged "huge regression risk and churn possible". V1's
test discipline has **two layers** to catch the two kinds of
risk: pure-handler bugs and start→complete lifecycle bugs.

### 7.1 Layer 1 — Pure renderer / parser unit tests

In `tests/unit/dom-regions.test.ts`, `describe('edit events')`:

Pure renderer (`renderEditEvent` or
`EVENT_INSERTERS['tool.execution_complete']` called with a
fresh mock element + pre-populated dataset):
- 0-line diff (parser ran but stats are {0,0}): header only,
  no `<pre>`, `+0 -0` shown.
- 1-line add → renders, expanded, `+1 -0`.
- 1-line remove → renders, expanded, `+0 -1`.
- 3-line add + 2-line remove → renders, expanded, `+3 -2`.
- Exactly 6 changed lines → expanded (boundary).
- 7 changed lines → collapsed, header visible.
- 100 changed lines → collapsed.
- Failed edit with `data.error` string → error header + body,
  not collapsed.
- Failed edit with `result.content` string only → error
  extracted from there.
- Failed edit with no error text → "Unknown edit error".
- Unparseable result → falls through to existing markdown
  render (handler returns early; existing path runs).
- Non-edit tool (`bash`) → unchanged from today (regression).
- Assert header is `element.children[0]` (invariant 8).
- Assert tool-name extraction works from `data.toolName`,
  `data.name`, and `element.dataset.toolName` separately.

Parser (`parseEditResult` in `tests/unit/edit-diff.test.ts`):
- Each fixture in `tests/fixtures/edit-tool-results/*.json`
  parses successfully.
- Unified diff with 1 hunk: correct hunks + stats.
- Unified diff with multi-hunk: stats are totals.
- Before/after pair: correct LCS diff.
- Status-only string: returns null.
- Mangled input: returns null.
- Context lines from unified diff are dropped.
- `+++`/`---`/`@@` lines not counted in stats.

`lineDiff` (same file):
- Empty before, non-empty after → all adds.
- Equal before/after → empty hunks.
- Single-line change in middle → one hunk with 1 add + 1 remove.
- Multiple separated changes → multiple hunks.

### 7.2 Layer 2 — Lifecycle tests through `ChatRegion`

Pure-handler tests can't catch the start→complete state
transition (e.g., handler-only tests start with a blank mock
element, missing the `.collapsed` class set by `start`).

`describe('edit lifecycle')` calls `ChatRegion.insertEvent`
twice in sequence with shared `toolCallId`:

- **L1**: `start` for `edit` → element exists, has
  `tool-text collapsed`, dataset.toolName === 'edit'.
- **L2**: matching `complete` with 6-line diff → element
  still exists (same `data-key`), `.collapsed` removed, has
  `edit-event` class, first child is header.
- **L3**: matching `complete` with 7-line diff → `.collapsed`
  retained.
- **L4**: matching `complete` with unparseable result →
  `.collapsed` retained, existing markdown text rendered.
- **L5**: matching `complete` with `success: false` →
  `.collapsed` removed, error body rendered.
- **L6**: non-edit `bash` start→complete → element keeps
  `.collapsed`, markdown text rendered. **Regression check**:
  identical to current behaviour.
- **L7**: complete with no preceding start (event re-render
  on session resume; start was missed) → handler reads
  `data.toolName` (not dataset), produces correct output.

### 7.3 Mock element coverage

The current `createMockElement` in `dom-regions.test.ts`
supports `dataset`, `classList` (add/remove/contains/toggle),
`appendChild`, `children`, `lastElementChild`, `firstChild`,
`insertBefore`, `textContent` (read), `className`. V1 needs to
verify or add:
- `textContent = ''` clears `_children` (drops prior content).
- `children[0]` returns first appended child.
- Spans/headers/pres appended via `appendChild` are recorded
  in `_children` and queryable by tag name (add a simple
  `querySelector('p.edit-header')` shim if needed).

Mock additions are test-only and contained in the test file.

### 7.4 Manual smoke (post-impl)

User-driven:
- Edit a small file via agent → diff appears inline, colored,
  expanded.
- Edit a large file (>6 changed lines) → collapsed; click
  expands.
- `create` a new file → `+N -0`, collapsed if >6 lines.
- Failed edit (e.g., file not found / read-only) → error inline.
- Reasoning, bash, read tools → unchanged.
- Session resume → prior edit events re-render correctly.

### 7.5 Regression contract

All existing tests in `tests/unit/dom-regions.test.ts` must
pass unchanged. **No existing test gets modified.** New tests
land in the same file under a new `describe` block plus a new
`tests/unit/edit-diff.test.ts` for the parser/differ.

## 8. Acceptance

1. Edit-tool event with 3 added + 1 removed lines: header
   `edit  parser.ts  +3 -1` with `+3` green, `-1` red. Body
   shows 3 green lines + 1 red line. Expanded.
2. Edit-tool event with 100 added lines: header `edit  big.ts
   +100 -0`. Collapsed by default. Click to expand → full body
   visible. Click again → collapsed.
3. Create-tool event with 50 added: header
   `create  new.ts  +50 -0`. Collapsed.
4. Write-tool event replacing a 5-line file with a 5-line file:
   header shows accurate stats (depends on parser). Expanded if
   ≤6 lines total changed.
5. Failed edit (`success: false`): error text displays inline,
   not collapsed.
6. Bash tool event: rendering unchanged from today.
7. `read_file` / non-write tool event: rendering unchanged from
   today.
8. Auto-collapse threshold: a diff with exactly 6 visible lines
   is expanded; 7 is collapsed.
9. Collapse-expand click: works on edit events same as on
   reasoning today.
10. Session resume / refresh: prior edit events re-render
    correctly with rich format (event replay path is unchanged).
11. No regression in existing `tools.execution_complete`
    rendering for non-edit tools.
12. All existing `dom-regions.test.ts` cases pass unchanged.
13. New unit tests (§7.1 + §7.2) all pass.

## 9. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| `tool.execution_complete` handler is shared; edit branch breaks non-edit fall-through | medium | Branch on `EDIT_TOOLS.has(name)` at top; fall-through is the existing code untouched. Unit tests assert both branches. |
| Parser fails on real edit results (SDK shape unknown until impl) | high | §5.2 says inspect actual results during impl. Parser returns null on unparseable → safe fall-through. |
| Collapse CSS breaks because header isn't the literal first child | low | Test asserts header is `el.children[0]`. |
| Auto-collapse change surprises users (everything used to be collapsed) | low | Document in roadmap; one-line rule to revert. |
| Color vars (`--color-success` / `--color-error`) don't exist in all themes | medium | Verify in impl across the 8+ themes. Add fallbacks `color: var(--color-success, #2a8)`. |
| New `<pre>` body with line spans causes layout reflow in long sessions | low | `<pre>` is one element; spans are inline. Cheap. |
| Diff lib reuse pulls applet code into chat-view bundle | medium | If reuse is non-trivial, ship a tiny standalone differ in `public/ts/edit-diff.ts`. |
| Implicit coupling of 4 event maps: future event type addition forgets one | unchanged from today | V1 doesn't add a new event type. Risk pre-existing. |

## 10. Implementation order (preview — full plan in plan.md)

1. **Fixture capture.** Add temporary `console.log` in
   `dom-regions.ts` to record `edit`, `create`, `write`
   `tool.execution_complete.data`. Run a Caco session, perform
   each tool, copy logs to
   `tests/fixtures/edit-tool-results/{edit,create,write}.json`.
   Revert the log statement.
2. **`public/ts/edit-diff.ts`** — `parseEditResult` +
   `lineDiff`. Implement to satisfy the fixtures.
3. **`tests/unit/edit-diff.test.ts`** — fixture-driven parser
   tests + LCS-differ tests. All pass.
4. **CSS** in `public/style.css`: `.edit-event`,
   `.edit-header`, `.edit-tool-name`, `.edit-stat-add`,
   `.edit-stat-rem`, `.edit-body`, `.edit-line-add`,
   `.edit-line-rem`, `.edit-error`. Use existing color vars.
5. **`EDIT_TOOLS` constant + `renderEditEvent` helper** in
   `dom-regions.ts`. Branch `tool.execution_complete` on
   `EDIT_TOOLS.has(name)`.
6. **Mock element widening** in `dom-regions.test.ts` (test-
   only).
7. **Pure-handler tests (§7.1).** All pass.
8. **Lifecycle tests (§7.2).** All pass.
9. **Manual smoke (§7.4).**
10. **Code review.**

## 11. Out of scope (parking lot)

- Refactor of 4 parallel event maps into one descriptor table
  (§6.3).
- Sharing `EDIT_TOOLS` between client and server (`WRITE_TOOLS`
  in `dispatch-events.ts`).
- Syntax highlighting of diff lines.
- Inline word-diff.
- Click line number → open in files applet.
- "View full file" link from collapsed diff.
- Streaming edit events (V1 fires on `complete` only).
- V2: links into files applet (`?openPath=…`) from header
  basename.
