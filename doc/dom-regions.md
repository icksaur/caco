# DOM Region Ownership: Preventing Frontend Regressions

**Status:** Implemented  
**Analysis:** [doc/dom-modification.md](dom-modification.md)  
**Principles:** [doc/code-quality.md](code-quality.md)

## Problem

Three regressions appeared together around commits `3ec9812` (thinking feedback) and `7a30fdd` (ID collision fix):

1. **Activity div disappears** — thinking indicator removal destroys sibling tool/intent content
2. **Context footer disappears** — content rendered into wrong element or element not found
3. **Applet panel breaks** — same ID collision mechanism as footer

All three share a root cause: **no enforced boundary between DOM regions.** Code in one region does `document.querySelector()` or `document.getElementById()` and finds elements in a different region. Mutations intended for chat content destroy or overwrite footer and applet elements.

### Why this keeps regressing

Each fix has been point-specific — patch the selector, add a data attribute, strip an ID. These work until the next feature adds another unscoped query. The project has no structural mechanism that **prevents** cross-region DOM access. Without one, every new feature is a regression risk.

From `doc/code-quality.md`:
- **Coupling — source of complexity.** Three modules share the `#chat` DOM tree with no coordination.
- **Relying on side effects.** `hideThinkingIndicator()` does a global query and removes a parent div as a side effect, destroying siblings.
- **Only one way to do one thing.** There are currently five different element lookup strategies (see analysis doc §Element Lookup Strategies).

### Problem 1: Split lifecycle in `#chat`

The `#chat` element tree is modified by **three independent modules** with no coordination:

| Module | Creates | Content | Removes | State changes |
|--------|---------|---------|---------|---------------|
| `element-inserter.ts` | ✅ outer/inner divs | — | — | — |
| `event-inserter.ts` | — | ✅ textContent, dataset | — | — |
| `message-streaming.ts` | ✅ reasoning header | — | ✅ thinking div, cursors | ✅ collapsed class |

The element lifecycle is split across three files. Creation happens in one, content in another, and destruction/state-changes in a third. All three must agree on the DOM structure, but nothing enforces that agreement.

This caused the thinking feedback regression: `element-inserter.ts` puts `.thinking-text` inside a shared `.assistant-activity` div. `message-streaming.ts` then removes the entire `.assistant-activity` parent, destroying sibling tool/intent elements that were also inside it.

### Problem 2: Chat content pollutes other DOM regions

When the assistant renders chat content containing HTML (e.g., it shows `index.html` source code, or an agent session views the page), the rendered output can create **duplicate IDs** that collide with real UI elements:

| Real element | Risk |
|-------------|------|
| `#contextFooter` | `getElementById('contextFooter')` returns the rendered duplicate instead of the real footer |
| `#appletView` | `getElementById('appletView')` returns the rendered duplicate instead of the real panel |
| `#chat` | Same pattern for any ID in `index.html` |

This was the root cause of the context footer and applet panel disappearing: `getElementById` found the **wrong element** — a rendered copy inside `#chat` — and wrote content into it. The real footer/panel remained empty.

**Commit 7a30fdd** mitigated this with two defenses:
1. DOMPurify strips `id` attributes from all rendered markdown (`FORBIDDEN_ATTRS: ['id', ...]`)
2. `context-footer.ts` and `applet-runtime.ts` switched to `querySelector('[data-context-footer="true"]')` / `querySelector('[data-applet-view="true"]')` instead of `getElementById`

These defenses work **for markdown-rendered content** because DOMPurify processes it. But they don't protect against:
- `textContent` set by `EVENT_INSERTERS` that later gets interpreted as HTML (currently safe, but fragile)
- Embed iframes that inject content outside the sanitizer
- Future inserter types that bypass DOMPurify

The real fix is ensuring chat content **cannot escape `#chat`** at the DOM manipulation level — every query is scoped, every mutation is on a known element reference, never a global lookup.

### Specific ad-hoc DOM operations in `message-streaming.ts`

These are the five operations that bypass the inserter system:

| Function/site | Operation | What it does | Risk |
|--------------|-----------|-------------|------|
| `hideThinkingIndicator()` | thinking removal | Global `document.querySelector('.thinking-text')` → `.closest('.assistant-activity')` → `.remove()` | **Destroys sibling content.** Uses unscoped global query. Removes outer div the inserter created. |
| `handleEvent()` terminal branch | cursor cleanup | `chat.querySelectorAll('.streaming-cursor')` → `classList.remove` | Modifies elements created by streaming-markdown, not the inserter. |
| `handleEvent()` reasoning branch | reasoning header | `createElement('p')` → `insertBefore` into keyed element | Creates DOM structure the inserter doesn't know about. |
| `handleEvent()` reasoning branch | collapse reasoning | `classList.add('collapsed')` on inner element | Modifies state on inserter-managed elements. |
| `setupFormHandler()` click listener | click collapse | Traverses activity box children, toggles `.collapsed` | Modifies state on inserter-managed elements. |

All five would not exist if the inserter owned the full lifecycle.

### How the two problems compound

The thinking feedback feature (commit 3ec9812) and the ID collision fix (commit 7a30fdd) were developed together. Their fixes are tangled:

1. Reverting thinking code may revert the ID collision defenses (DOMPurify `FORBIDDEN_ATTRS`, data-attribute selectors)
2. The thinking code uses a **global** `document.querySelector('.thinking-text')` — if rendered chat content ever contains an element with class `thinking-text`, it finds the wrong one and removes the wrong parent
3. Both bugs stem from the same root cause: **unscoped DOM queries** that can match elements in any region of the page

ChatRegion fixes both by ensuring all `#chat` queries are scoped to `this.root`, and by keeping the ID-stripping defense in place for rendered content.

## Goal

Prevent the class of bugs where DOM code in one page region affects another region. Establish a **structural** mechanism — not conventions or code review — that makes cross-region DOM access impossible.

Fix all three current regressions. Prevent future regressions of the same class.

| Regression | How this fixes it |
|-----------|-------------------|
| Activity div disappears | `ChatRegion.removeThinking()` removes only the thinking element; removes parent only if empty. Queries scoped to `this.root`, not `document`. |
| Context footer disappears | Chat code can no longer reach `#contextFooter` — all queries scoped to `#chat` subtree. DOMPurify `id`-stripping stays as defense in depth. |
| Applet panel breaks | Same — chat queries scoped to `this.root`, can't reach `#appletView`. Data-attribute selectors in `applet-runtime.ts` stay as defense in depth. |
| **Future regressions** | New DOM code uses `scopedRoot` — physically cannot do `document.querySelector`. The pattern is enforced by the API, not by developer discipline. |

## Design

### The `scopedRoot` helper

A `ScopedRoot` is a scoped query object for a DOM subtree. All queries and mutations on that subtree go through it. The root element is the boundary — nothing inside the scope can see or modify anything outside it.

```typescript
/**
 * Scoped DOM access — prevents cross-region queries.
 *
 * No method on this object calls document.querySelector,
 * document.getElementById, or any other global DOM lookup.
 *
 * The invariant is: no global DOM *queries*. document.createElement
 * is allowed — creating a detached element doesn't affect any region.
 */
export type ScopedRoot = {
  readonly el: HTMLElement;
  query(sel: string): HTMLElement | null;
  queryAll(sel: string): NodeListOf<Element>;
  clear(): void;
};

export function scopedRoot(el: HTMLElement): ScopedRoot {
  return {
    el,
    query: (sel) => el.querySelector(sel),
    queryAll: (sel) => el.querySelectorAll(sel),
    clear: () => { el.innerHTML = ''; },
  };
}
```

This is small by design. It's not a framework — it's a scoping constraint. The value is the **rule it enforces**: if your DOM code uses a `ScopedRoot`, you physically cannot do `document.querySelector()` because you don't have `document` — you have `root.el`.

Composition over inheritance: `ChatRegion` composes a `ScopedRoot`, it doesn't extend a base class. This avoids the "wrong abstraction — expensive forever" risk from `code-quality.md`, since a base class with only one subclass is speculative.

### Region registry

All four page regions are registered once at startup in a single place:

```typescript
// dom-regions.ts — single source of truth for all DOM region roots
export const regions = {
  chat:    scopedRoot(document.getElementById('chat')!),
  footer:  scopedRoot(document.querySelector('[data-context-footer]')! as HTMLElement),
  applet:  scopedRoot(document.querySelector('[data-applet-view]')! as HTMLElement),
  layout:  scopedRoot(document.getElementById('chatScroll')!),
} as const;
```

Every module imports the region it needs — `regions.chat`, `regions.footer`, etc. No module calls `document.getElementById` or `document.querySelector` for region roots; they all go through `regions`. This:

- Eliminates the base class entirely — no type hierarchy
- Extends scoping protection to footer and applet without forcing them into a class
- Is trivially testable: mock `scopedRoot` with a detached `div`
- Is a single line to adopt in any module: `const root = regions.chat`

### Page regions

| Region | Root element | Owner module | Registry key | Status |
|--------|-------------|-------------|-------------|--------|
| Chat messages | `#chat` | `ChatRegion` (new) | `regions.chat` | **Broken** — three modules, unscoped queries |
| Context footer | `[data-context-footer]` | `context-footer.ts` | `regions.footer` | Clean — adopt `regions.footer` for consistency |
| Applet panel | `[data-applet-view]` | `applet-runtime.ts` | `regions.applet` | Clean — adopt `regions.applet` for consistency |
| View layout | `#chatScroll` | `view-controller.ts` | `regions.layout` | Clean — already caches references |

The chat region is the only broken one. That's where this spec focuses implementation effort. The other three already follow the pattern implicitly — after this refactor, they can optionally adopt their `regions.*` entry to eliminate their own `document.querySelector` calls, making all four regions consistent.

### `ChatRegion`

The chat message area gets a dedicated class that composes `regions.chat`:

```typescript
/**
 * ChatRegion — owns all mutations to #chat children.
 *
 * No other module calls querySelector, remove(), classList, createElement,
 * or insertBefore on elements inside #chat.
 *
 * Invariant: no global DOM *queries*. document.createElement is allowed
 * (creating a detached element doesn't query or modify any region).
 *
 * Lifecycle: create → content → state change → remove
 * All four phases are methods on this class.
 */
export class ChatRegion {
  private root: ScopedRoot;
  private outerInserter: ElementInserter;
  private innerInserter: ElementInserter;

  constructor(root: ScopedRoot) {
    this.root = root;
    // ... initialize inserters
  }

  // ── Render an event (create structure + set content) ──────────
  renderEvent(event: SessionEvent): void;

  // ── Thinking lifecycle ────────────────────────────────────────
  removeThinking(): void;

  // ── Reasoning finalization ────────────────────────────────────
  finalizeReasoning(event: SessionEvent): boolean;

  // ── Terminal cleanup ──────────────────────────────────────────
  removeStreamingCursors(): void;

  // ── Interaction ───────────────────────────────────────────────
  setupClickHandler(): void;
}
```

### What each method absorbs

#### `renderEvent(event)`

Absorbs the core render pipeline from `handleEvent()` in `message-streaming.ts` and the full `insertEvent` + `getElement` chain:

```typescript
renderEvent(event: SessionEvent): void {
  const outer = this.outerInserter.getElement(eventType, this.root.el);
  if (!outer) return;

  const inner = this.innerInserter.getElement(eventType, outer, data);
  if (!inner) return;

  this.insertContent(event, inner);

  // Post-insert state changes
  if (eventType === 'assistant.reasoning') {
    inner.classList.add('collapsed');
  }

  // Note: caller (message-streaming.ts) handles scrollToBottom()
  // — it's a cross-region effect on #chatScroll, not a #chat mutation.
}
```

The `insertContent` method is the old `insertEvent()` — the `EVENT_INSERTERS` dispatch table and all its handler functions.

#### `removeThinking()`

Absorbs `hideThinkingIndicator()` from `message-streaming.ts`. Fixed to be scoped and sibling-safe:

```typescript
removeThinking(): void {
  const thinking = this.root.query('.thinking-text');
  if (!thinking) return;

  const parent = thinking.parentElement;
  thinking.remove();

  // Remove parent ONLY if now empty
  if (parent && parent !== this.root.el && parent.children.length === 0) {
    parent.remove();
  }
}
```

This fixes the root cause: `.thinking-text` is removed, and its parent `.assistant-activity` is only removed if it has no other children. Intent and tool elements that share the same parent survive.

#### `finalizeReasoning(event)`

Absorbs the reasoning special-case branch from `handleEvent()` in `message-streaming.ts`:

```typescript
finalizeReasoning(event: SessionEvent): boolean {
  const data = event.data || {};
  if (!data.reasoningId) return false;

  const existing = this.root.query(
    `[data-key="${data.reasoningId}"]`
  ) as HTMLElement | null;
  if (!existing) return false;

  // Update content
  this.insertContent(event, existing);

  // Add header (document.createElement is allowed — creates a detached
  // element, doesn't query or modify any region)
  const header = document.createElement('p');
  header.className = 'reasoning-header';
  header.textContent = 'reasoning';
  existing.insertBefore(header, existing.firstChild);
  existing.classList.add('collapsed');

  return true;  // handled, caller should not fall through
}
```

#### `removeStreamingCursors()`

Absorbs cursor cleanup from `handleEvent()` terminal branch in `message-streaming.ts`:

```typescript
removeStreamingCursors(): void {
  const cursors = this.root.queryAll('.streaming-cursor');
  for (const el of cursors) {
    el.classList.remove('streaming-cursor');
  }
}
```

#### `setupClickHandler()`

Absorbs the click delegation listener from `setupFormHandler()` in `message-streaming.ts`:

```typescript
setupClickHandler(): void {
  this.root.el.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const activity = target.closest('.assistant-activity');
    if (!activity) return;

    let innerItem = target;
    while (innerItem.parentElement && innerItem.parentElement !== activity) {
      innerItem = innerItem.parentElement;
    }

    if (innerItem && innerItem.parentElement === activity) {
      innerItem.classList.toggle('collapsed');
    }
  });
}
```

### Internal structure of `dom-regions.ts`

```
dom-regions.ts
├── ScopedRoot type          (public — the scoping primitive)
├── scopedRoot() function    (public — creates a ScopedRoot)
├── regions registry         (public — single source of truth for all DOM roots)
├── EVENT_TO_OUTER          (const Record — unchanged from element-inserter.ts)
├── EVENT_TO_INNER          (const Record — unchanged from element-inserter.ts)
├── EVENT_KEY_PROPERTY      (const Record — unchanged from element-inserter.ts)
├── PRE_COLLAPSED_EVENTS    (const Set — unchanged from element-inserter.ts)
├── EVENT_INSERTERS         (const Record — unchanged from event-inserter.ts)
├── CONTENT_EVENTS          (const Set — moved from message-streaming.ts)
├── ElementInserter class   (private — unchanged logic, not exported)
├── Helper functions        (getByPath, setPath, appendPath, fetchAndRenderEmbed — unchanged)
└── ChatRegion class        (public — composes ScopedRoot, chat-specific methods)
```

Exports from `dom-regions.ts`:
```typescript
export type { ScopedRoot };
export { scopedRoot, regions };
export class ChatRegion { ... }

// Config tables — exported for behavioral tests that validate
// "every event type has a mapping" invariants
export { EVENT_TO_OUTER, EVENT_TO_INNER, EVENT_KEY_PROPERTY, EVENT_INSERTERS };
```

Note on config table exports: these are exported for tests that validate structural invariants (e.g., "every key in `EVENT_INSERTERS` also has an `EVENT_TO_INNER` mapping"). If behavioral tests on `ChatRegion` methods prove sufficient, these exports can be dropped.

### What `message-streaming.ts` becomes

After the refactor, `message-streaming.ts` is a **pure event router** with no DOM queries or mutations on `#chat` children. Cross-region effects like `scrollToBottom()` stay here — the caller orchestrates effects outside `#chat`, while `ChatRegion` owns mutations inside it.

```typescript
import { ChatRegion, regions, CONTENT_EVENTS } from './dom-regions.js';

let chatRegion: ChatRegion;

function handleEvent(event: SessionEvent): void {
  hideToast();
  let eventType = event.type;
  const data = event.data || {};

  // Transform source-typed user messages
  if (eventType === 'user.message' && data.source && data.source !== 'user') {
    eventType = `caco.${data.source}`;
  }

  // Hide thinking indicator when content arrives
  if (CONTENT_EVENTS.has(eventType)) {
    chatRegion.removeThinking();
  }

  // Context footer (not chat content)
  if (eventType === 'caco.context') {
    handleContextEvent(data);
    return;
  }

  // Terminal events
  if (isTerminalEvent(eventType)) {
    setFormEnabled(true);
    chatRegion.removeStreamingCursors();

    if (eventType === 'session.idle') {
      const sessionId = getActiveSessionId();
      if (sessionId) {
        void markSessionObserved(sessionId);
        void sendAppletContext(sessionId);
      }
    }
  }

  // Reasoning finalization (special case)
  if (eventType === 'assistant.reasoning') {
    if (chatRegion.finalizeReasoning(event)) {
      scrollToBottom();  // cross-region effect stays in caller
      return;
    }
  }

  // Render event (create/find elements + set content)
  chatRegion.renderEvent(event);
  scrollToBottom();  // cross-region effect stays in caller
}

export function setupFormHandler(): void {
  chatRegion = new ChatRegion(regions.chat);
  chatRegion.setupClickHandler();

  registerWsHandlers();
  // ... form submission handler (unchanged — operates on #chatForm, not #chat)
}
```

### Callers that clear chat

Four places currently do `chat.innerHTML = ''`:

| Location | Current code | After refactor |
|----------|-------------|----------------|
| `message-streaming.ts` `switchSession()` | `document.getElementById('chat')!.innerHTML = ''` | `regions.chat.clear()` |
| `router.ts` `newSessionClick()` | `document.getElementById('chat')!.innerHTML = ''` | `regions.chat.clear()` |
| `router.ts` `activateSession()` | `document.getElementById('chat')!.innerHTML = ''` | `regions.chat.clear()` |
| `history.ts` `waitForHistoryComplete()` | `document.getElementById('chat')!.innerHTML = ''` | `regions.chat.clear()` |

All four import `regions` from `dom-regions.ts` and call `regions.chat.clear()`. No wrapper function needed — `regions` is the public API.

## Files Changed

### Deleted (absorbed into `dom-regions.ts`)

| File | Lines | Absorbed by |
|------|-------|-------------|
| `public/ts/element-inserter.ts` | 220 | `dom-regions.ts` — `ElementInserter` class + config tables |
| `public/ts/event-inserter.ts` | 299 | `dom-regions.ts` — `EVENT_INSERTERS` table + `insertContent` method |

### Created

| File | Est. lines | Contents |
|------|-----------|----------|
| `public/ts/dom-regions.ts` | ~550 | `scopedRoot()` helper, `regions` registry, `ChatRegion` class, `ElementInserter` (private), all config tables, all inserter functions. Source is 220 + 299 = 519 lines from `element-inserter.ts` + `event-inserter.ts`, plus ~30 lines for `scopedRoot`/`regions`/`ChatRegion` wrapper. |

### Modified

| File | Change |
|------|--------|
| `public/ts/message-streaming.ts` | Remove all ad-hoc DOM code (`hideThinkingIndicator`, cursor cleanup, reasoning header/collapse, click listener). Replace with `ChatRegion` method calls. Remove imports from `element-inserter.ts` and `event-inserter.ts`. Add import from `dom-regions.ts`. Move `scrollToBottom()` calls from `ChatRegion` methods to caller. |
| `public/ts/router.ts` | Replace both `chat.innerHTML = ''` sites (`newSessionClick`, `activateSession`) with `regions.chat.clear()`. Import `regions` from `dom-regions.ts`. |
| `public/ts/history.ts` | Replace `chat.innerHTML = ''` in `waitForHistoryComplete()` with `regions.chat.clear()`. Import `regions` from `dom-regions.ts`. |
| `public/ts/context-footer.ts` | *(Optional, consistency)* Replace `document.querySelector('[data-context-footer="true"]')` with `regions.footer.el`. |
| `public/ts/applet-runtime.ts` | *(Optional, consistency)* Replace `document.querySelector('[data-applet-view="true"]')` with `regions.applet.el`. |

### Test files

| File | Change |
|------|--------|
| `tests/unit/element-inserter.test.ts` | Rename to `tests/unit/dom-regions.test.ts`. Update imports. Tests for `ElementInserter` stay as-is but import from `dom-regions.ts`. |
| `tests/unit/event-inserter.test.ts` | Merge into `tests/unit/dom-regions.test.ts`. Tests for `insertEvent`/`hasInserter` become tests on `ChatRegion` methods or remain on exported config tables. |
| `tests/unit/streaming-markdown.test.ts` | No changes — `streaming-markdown.ts` is unchanged. |
| NEW: `tests/unit/dom-regions-lifecycle.test.ts` | **New tests for lifecycle operations** — the operations that previously had no tests. |

### New tests required

The ad-hoc DOM operations in `message-streaming.ts` currently have **zero test coverage**. The refactor makes them testable:

```typescript
describe('ChatRegion.removeThinking', () => {
  it('removes thinking-text element', () => { ... });
  
  it('removes empty parent activity div', () => { ... });
  
  it('preserves parent activity div when siblings exist', () => {
    // THE BUG — this test would have caught the regression
    // Setup: activity div with thinking-text AND intent-text
    // Act: removeThinking()
    // Assert: intent-text still exists, activity div still exists
  });
  
  it('is scoped to chat element, not global document', () => { ... });
  
  it('is no-op when no thinking element exists', () => { ... });
});

describe('ChatRegion.removeStreamingCursors', () => {
  it('removes streaming-cursor class from all elements', () => { ... });
  
  it('is no-op when no cursors exist', () => { ... });
});

describe('ChatRegion.finalizeReasoning', () => {
  it('finds existing reasoning element by data-key', () => { ... });
  
  it('adds reasoning header as first child', () => { ... });
  
  it('adds collapsed class', () => { ... });
  
  it('returns false when no matching element exists', () => { ... });
});

describe('ChatRegion.clear', () => {
  it('removes all children from chat element', () => { ... });
});
```

## Implementation Plan

### Phase 1: Create `dom-regions.ts` with all logic (one commit)

1. Create `public/ts/dom-regions.ts`
2. Implement `ScopedRoot` type and `scopedRoot()` helper
3. Implement `regions` registry (chat, footer, applet, layout)
4. Copy `ElementInserter` class and config tables from `element-inserter.ts`
5. Copy `EVENT_INSERTERS`, `insertEvent`, helper functions from `event-inserter.ts`
6. Make `ElementInserter` non-exported (private implementation detail)
7. Implement `ChatRegion` composing `ScopedRoot`
8. Implement `removeThinking()` with the sibling-safe fix
9. Implement `finalizeReasoning()`, `removeStreamingCursors()`, `setupClickHandler()`
10. Export `ScopedRoot`, `scopedRoot`, `regions`, `ChatRegion`, and config tables

### Phase 2: Migrate `message-streaming.ts` (one commit)

1. Replace imports of `element-inserter.ts` and `event-inserter.ts` with `dom-regions.ts`
2. Create `ChatRegion` instance from `regions.chat` in `setupFormHandler()`
3. Replace all ad-hoc DOM code with `ChatRegion` method calls
4. Move `scrollToBottom()` calls from inside methods to caller sites
5. Import `CONTENT_EVENTS` from `dom-regions.ts`, remove local copy
6. Remove dead re-exports (`getOuterClass`, `getInnerClass` — no external users)

### Phase 3: Update external callers (one commit)

1. `router.ts`: Import `regions` from `dom-regions.ts`, replace both `chat.innerHTML = ''` sites with `regions.chat.clear()`
2. `history.ts`: Import `regions` from `dom-regions.ts`, replace `chat.innerHTML = ''` with `regions.chat.clear()`
3. *(Optional)* `context-footer.ts`: Replace `document.querySelector('[data-context-footer="true"]')` with `regions.footer.el`
4. *(Optional)* `applet-runtime.ts`: Replace `document.querySelector('[data-applet-view="true"]')` with `regions.applet.el`

### Phase 4: Migrate and add tests (one commit)

1. Create `tests/unit/dom-regions.test.ts` by merging `element-inserter.test.ts` and `event-inserter.test.ts`
2. Update imports to point to `dom-regions.ts`
3. Add `scopedRoot` tests (query scoping, clear)
4. Add lifecycle tests (`removeThinking` sibling safety, `removeStreamingCursors`, `finalizeReasoning`)
5. Delete `tests/unit/element-inserter.test.ts` and `tests/unit/event-inserter.test.ts`

### Phase 5: Delete old files (one commit)

1. Delete `public/ts/element-inserter.ts`
2. Delete `public/ts/event-inserter.ts`
3. Verify build + tests pass

### Phase 6: Scope batch `renderMarkdown()` (follow-up commit)

1. In `markdown-renderer.ts`, change `document.querySelectorAll('[data-markdown]')` to `regions.chat.queryAll('[data-markdown]')`
2. Import `regions` from `dom-regions.ts`
3. This eliminates the last global DOM query in the chat rendering pipeline

## Risks

| Risk | Mitigation |
|------|------------|
| Large refactor could introduce new bugs | Phase 1 creates the new file WITHOUT deleting old ones. Both can coexist during development. Tests run at each phase. |
| `streaming-markdown.ts` calls `window.renderMarkdownElement` which modifies `innerHTML` of elements `ChatRegion` created | Acceptable — `streaming-markdown.ts` operates on a single element reference it received. It doesn't query the DOM. The ownership boundary is the element reference, not the code path. |
| `markdown-renderer.ts` `renderMarkdownElement()` is called from within `EVENT_INSERTERS` | Acceptable — these calls are now inside `ChatRegion.insertContent()`. The rendering modifies only the element passed to it. |
| External callers might still do `document.getElementById('chat')` | Grep the codebase after refactor. Only `dom-regions.ts` (in the `regions` registry) should reference `#chat` by ID. |
| Batch `renderMarkdown()` uses global `document.querySelectorAll('[data-markdown]')` | Addressed in Phase 6 — scoped to `regions.chat.queryAll()`. |
| Context footer / applet panel could regress if DOMPurify `FORBIDDEN_ATTRS` list is modified | Independent of ChatRegion. The `id`-stripping defense in `markdown-renderer.ts` must stay. Scoped queries add a second defense layer — belt and suspenders. |
| Module-level `let chatRegion` initialized in `setupFormHandler()` | Calls before initialization would throw. This matches the existing pattern (`outerInserter`/`innerInserter` have the same timing). The `regions` registry itself is initialized at module load (top-level `const`), so `regions.chat.clear()` is safe from any caller at any time. Only `ChatRegion` construction is deferred. |

## Code quality principles applied

From `doc/code-quality.md`:

| Principle | How this applies |
|-----------|-----------------|
| **Coupling — source of complexity** | `scopedRoot` eliminates coupling between page regions. `message-streaming.ts` no longer needs to know DOM structure of activity boxes. |
| **Only one way to do one thing** | `ScopedRoot.query()` is the one way to find elements. All `#chat` mutations go through `ChatRegion` methods. |
| **Correct by design** | Cross-region pollution is structurally impossible — `ScopedRoot` has no access to `document`. Not enforced by convention or review. |
| **Wrong abstraction — expensive forever** | Avoided — `scopedRoot` is a helper function, not a base class. No type hierarchy to maintain. |
| **Encapsulation over inheritance** | `ElementInserter` is private to `ChatRegion`, not exported. Composition via `ScopedRoot`, not inheritance. |
| **Relying on side effects** | Eliminated — `removeThinking()` is an explicit scoped method, not an implicit global query hidden in `handleEvent()`. |
| **Unit tests prevent regressions** | The sibling-safety test would have caught the thinking feedback regression before it shipped. |
| **Simple is best** | `scopedRoot()` is 8 lines. Not a framework — just a scoping constraint. |
