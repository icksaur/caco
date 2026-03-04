# Chat DOM Management

**Status: Analysis**

Understanding and improving the DOM manipulation patterns in chat rendering.

## Problem Statement

Changes to `hideThinkingIndicator()` mysteriously break applet panel and context footer rendering, despite the function only operating on `.thinking-text` elements inside `#chat`. This indicates fragile coupling between DOM manipulation and other UI components.

## Current Architecture

### Element Hierarchy

```
#chat
├── .user-message
│   └── .user-text
├── .assistant-activity
│   ├── .thinking-text          ← Created by turn_start, removed by hideThinkingIndicator
│   ├── .intent-text            ← Created by assistant.intent
│   ├── .reasoning-text         ← Created by assistant.reasoning
│   └── .tool-item[data-key]    ← Created by tool.execution_*
└── .assistant-message
    └── .assistant-text         ← Created by assistant.message
```

### Key Components

| File | Responsibility |
|------|----------------|
| `element-inserter.ts` | Creates/reuses outer and inner DOM elements |
| `event-inserter.ts` | Populates content into inner elements |
| `message-streaming.ts` | Routes events, manages state, calls inserters |
| `streaming-markdown.ts` | Handles incremental markdown rendering |

### ElementInserter Strategy

1. **Outer elements**: Container divs (`.assistant-activity`, `.user-message`, etc.)
   - Reused if last child of `#chat` matches target class
   - Created new if different type needed

2. **Inner elements**: Content divs inside outer containers
   - Keyed by `data-key` attribute for tool calls, reasoning
   - Non-keyed for singleton content (thinking, intent, message)

3. **Event mapping**:
   - `EVENT_TO_OUTER`: event type → outer class
   - `EVENT_TO_INNER`: event type → inner class (or null)
   - `EVENT_KEY_PROPERTY`: event type → data field for keying

### hideThinkingIndicator() Behavior

```typescript
function hideThinkingIndicator(): void {
  const thinking = document.querySelector('.thinking-text');
  if (thinking) {
    const outer = thinking.closest('.assistant-activity');
    if (outer) {
      outer.remove();
    }
  }
}
```

**Called when**: `CONTENT_EVENTS` arrive (intent, message, message_delta, tool.execution_start, session.idle, session.error)

**Purpose**: Remove ephemeral "Thinking..." indicator when real content arrives

## Identified Issues

### 1. Global querySelector Scope

```typescript
document.querySelector('.thinking-text')  // Finds FIRST match in ENTIRE document
```

**Risk**: If rendered chat content or other UI components contain `.thinking-text` class, wrong element is found.

**Observed behavior**: Found 147 `.thinking-text` elements in long conversation - many from history replay.

### 2. Parent Container Removal

```typescript
outer.remove()  // Removes entire .assistant-activity
```

**Risk**: If other content (intent, tools) was already inserted into the same `.assistant-activity` container before hideThinkingIndicator runs, it gets removed too.

**Sequence issue**: During history replay, events arrive rapidly. By the time hideThinkingIndicator runs, the `.assistant-activity` may already contain siblings.

### 3. Mysterious Side Effects

**Observation**: Making `hideThinkingIndicator()` a no-op or removing its call breaks applets and context footer - components that should be completely independent.

**Hypothesis**: The function's DOM manipulation has unintended timing effects on the event loop or bundler output that affects other initialization.

### 4. Shared Outer Container

Multiple event types share the same outer class:

```typescript
'assistant.turn_start': 'assistant-activity',
'assistant.intent': 'assistant-activity',
'assistant.reasoning': 'assistant-activity',
'tool.execution_start': 'assistant-activity',
```

This means thinking-text, intent-text, and tool-items are siblings in the same container. Removing the outer to clean up thinking removes everything.

## DOM Query Patterns (All Files)

### High-Risk Global Queries

| File | Line | Query | Risk |
|------|------|-------|------|
| message-streaming.ts | 66 | `document.querySelector('.thinking-text')` | Matches any in document |
| streaming-markdown.ts | 39 | `element.querySelector('.streaming-tail')` | Scoped but class-based |

### Safe Data-Attribute Queries

| File | Pattern | Safety |
|------|---------|--------|
| element-inserter.ts | `[data-key="${keyValue}"]` | Unique by event ID |
| context-footer.ts | `[data-context-footer="true"]` | Explicit marker |
| applet-runtime.ts | `[data-applet-view="true"]` | Explicit marker |

### .remove() Calls

| File | Target | Notes |
|------|--------|-------|
| message-streaming.ts | `.assistant-activity` | Via hideThinkingIndicator |
| streaming-markdown.ts | `.streaming-tail` | Cleanup after render |
| applet-runtime.ts | applet instance elements | Scoped to instance |

## Proposed Solutions

### Option A: Remove thinking-text Only, Keep Container

```typescript
function hideThinkingIndicator(): void {
  const chat = document.getElementById('chat');
  if (!chat) return;
  
  const thinking = chat.querySelector('.thinking-text');
  if (thinking) {
    thinking.remove();  // Only remove thinking, preserve siblings
  }
}
```

**Issue**: This was tried and broke applets/context. Root cause unknown.

### Option B: Don't Hide Thinking Indicators

Let thinking indicators persist as muted text. They'll be visually separated from actual activity.

```css
.thinking-text { 
  color: var(--color-text-muted);
  font-style: italic;
}
```

**Issue**: This was tried (no-op function) and also broke applets/context.

### Option C: Use Data Attributes for Thinking

Add explicit marker to thinking elements:

```typescript
// In event-inserter.ts
'assistant.turn_start': (element) => {
  element.textContent = 'thinking...';
  element.dataset.thinkingIndicator = 'true';
}

// In message-streaming.ts
function hideThinkingIndicator(): void {
  const thinking = document.querySelector('[data-thinking-indicator="true"]');
  if (thinking) {
    thinking.remove();
  }
}
```

### Option D: Investigate Bundler/Minifier Effects

The mysterious regression where ANY change to hideThinkingIndicator breaks unrelated components suggests:

1. **Dead code elimination**: Removing unused code may shift module boundaries
2. **Source map issues**: Changed line numbers affect debugging
3. **Side effect ordering**: Function definitions may affect initialization order

**Test**: Build without minification to isolate bundler effects.

### Option E: Separate Thinking Container

Give thinking its own outer container that doesn't share with activity:

```typescript
// element-inserter.ts
'assistant.turn_start': 'thinking-container',  // Not 'assistant-activity'
```

Then removal is safe - it won't affect tool/intent content.

## Next Steps

1. [ ] Investigate bundler effects by building without minification
2. [ ] Test Option E (separate thinking container) 
3. [ ] Add comprehensive logging to understand initialization order
4. [ ] Consider if thinking indicator provides enough value to keep

## Related Docs

- `doc/chat-ux.md` - Message rendering architecture
- `doc/thinking-feedback.md` - Original thinking indicator spec
- `doc/streaming.md` - Streaming and event handling

## Code Quality Assessment

Per `doc/code-quality.md`:

**Worst patterns present**:
- **Coupling**: hideThinkingIndicator affects unrelated components
- **Side effects**: DOM manipulation with undocumented effects
- **Global state**: `document.querySelector` searches entire DOM

**Improvements needed**:
- Scoped queries (search within container, not document)
- Explicit data attributes instead of class matching
- Clear ownership of DOM regions
