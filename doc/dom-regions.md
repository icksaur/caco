# DOM Region Ownership: Preventing Frontend Regressions

**Status:** Implemented  
**Analysis:** [doc/dom-modification.md](dom-modification.md)  
**Principles:** [doc/code-quality.md](code-quality.md)

## Problem

Three regressions appeared together around commits `3ec9812` (thinking feedback) and `7a30fdd` (ID collision fix):

1. **Activity div disappears** — thinking indicator removal destroys sibling tool/intent content
2. **Context footer disappears** — content rendered into wrong element or element not found
3. **Applet panel breaks** — same ID collision mechanism as footer

**Root cause**: No enforced boundary between DOM regions. Code in one region does `document.querySelector()` and finds elements in a different region. The project has no structural mechanism that **prevents** cross-region DOM access.

**Problem 1: Split lifecycle in `#chat`** — Three modules (`element-inserter.ts`, `event-inserter.ts`, `message-streaming.ts`) all modify the `#chat` element tree with no coordination. Creation, content, and destruction happen in different files.

**Problem 2: Chat content pollutes other DOM regions** — Rendered assistant HTML can create duplicate IDs that collide with real UI elements (`#contextFooter`, `#appletView`). DOMPurify strips `id` attributes, but the real fix is scoped queries.

## Goal

Prevent DOM code in one page region from affecting another. Establish a **structural** mechanism — not conventions — that makes cross-region DOM access impossible.

## Design

### The `scopedRoot` helper

A `ScopedRoot` is a scoped query object for a DOM subtree. All queries go through it. No method calls `document.querySelector` or any global DOM lookup.

```typescript
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

### Region registry

All four page regions registered once at startup:

```typescript
export const regions = {
  chat:    scopedRoot(document.getElementById('chat')!),
  footer:  scopedRoot(document.querySelector('[data-context-footer]')! as HTMLElement),
  applet:  scopedRoot(document.querySelector('[data-applet-view]')! as HTMLElement),
  layout:  scopedRoot(document.getElementById('chatScroll')!),
} as const;
```

### Page regions

| Region | Root element | Owner module | Registry key |
|--------|-------------|-------------|-------------|
| Chat messages | `#chat` | `ChatRegion` | `regions.chat` |
| Context footer | `[data-context-footer]` | `context-footer.ts` | `regions.footer` |
| Applet panel | `[data-applet-view]` | `applet-runtime.ts` | `regions.applet` |
| View layout | `#chatScroll` | `view-controller.ts` | `regions.layout` |

### `ChatRegion`

The chat message area gets a dedicated class composing `regions.chat`:

```typescript
export class ChatRegion {
  private root: ScopedRoot;

  constructor(root: ScopedRoot) { ... }

  renderEvent(event: SessionEvent): void;
  removeThinking(): void;           // Scoped, sibling-safe
  finalizeReasoning(event: SessionEvent): boolean;
  removeStreamingCursors(): void;
  setupClickHandler(): void;
}
```

Key fix in `removeThinking()`: removes only the thinking element; removes parent only if empty (fixes the sibling destruction bug).

### What `message-streaming.ts` becomes

After refactor: a **pure event router** with no DOM queries on `#chat` children. Cross-region effects like `scrollToBottom()` stay in the caller. `ChatRegion` owns all mutations inside `#chat`.

### File structure

```
dom-regions.ts
├── ScopedRoot type + scopedRoot()     (public)
├── regions registry                    (public)
├── Config tables (EVENT_TO_OUTER, etc) (public, for tests)
├── EVENT_INSERTERS dispatch table      (from event-inserter.ts)
├── ElementInserter class               (private)
└── ChatRegion class                    (public)
```

Absorbed `element-inserter.ts` and `event-inserter.ts` — both deleted.
