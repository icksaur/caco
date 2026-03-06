# Ad-Hoc Bar

## Overview

The **ad-hoc bar** is a session-scoped UI region above the chat input that hosts transient, contextual widgets. It replaces the current hard-coded image paste preview and opens the same space to extensions and internal tools.

Think of it as a "status tray" for the active session — it can show image thumbnails, progress bars, quick actions, or any session-specific content that shouldn't live in the chat stream.

## Goals

1. **Formalize** the existing image preview into a managed component
2. **Expose** the bar to extensions via `ClientExtensionAPI`
3. **Session-scoped** — each session owns its own bar state; switching sessions swaps the bar
4. **Correct clearing** — new chat always starts with an empty bar

## Use Cases

### 1. Image paste (existing)
User pastes images → thumbnails appear in the ad-hoc bar → sent with next message → cleared on send.

### 2. Caco swarm progress
Agent dispatches 4 parallel sessions. A progress bar widget appears: `████░░ 2/4 complete`. Updates via WS events. Auto-clears when swarm finishes.

### 3. SQL event progress
Agent runs SQL migrations. The bar shows a step counter: `Step 3/7: Creating indexes...`. Driven by tool telemetry events.

### 4. Extension widgets
Extensions register custom widgets — e.g., a deployment status badge, a timer, a file upload drop zone.

## Design

### Architecture

```
┌─────────────────────────────────────────────────┐
│ chat messages...                                │
│                                                 │
├─────────────────────────────────────────────────┤
│ [ad-hoc bar]                                    │  ← NEW: managed region
│   ┌──────┐ ┌──────┐        ┌────────────────┐   │
│   │ img1 │ │ img2 │        │ ████░░ 2/4     │   │
│   └──────┘ └──────┘        └────────────────┘   │
├─────────────────────────────────────────────────┤
│ [ chat input                                  ] │
│ [context footer]                                │
└─────────────────────────────────────────────────┘
```

### Data Model

```typescript
interface AdHocWidget {
  id: string;              // Unique within session (e.g., 'images', 'swarm-progress')
  sessionId: string;       // Owning session
  priority: number;        // Sort order (lower = left, default 50)
  render: () => HTMLElement;
  dispose?: () => void;    // Cleanup on remove
}
```

### AdHocBarManager (class)

Single instance. Manages widgets per session.

```typescript
class AdHocBarManager {
  private widgetsBySession = new Map<string, Map<string, AdHocWidget>>();
  private activeSessionId: string | null = null;
  private containerEl: HTMLElement;  // #adHocBar

  // Set/add/remove widgets for a session
  addWidget(sessionId: string, widget: AdHocWidget): () => void;  // returns dispose
  removeWidget(sessionId: string, widgetId: string): void;
  clearSession(sessionId: string): void;

  // Called on session switch — swaps visible widgets
  activateSession(sessionId: string): void;
  
  // Called on new chat — clears everything
  deactivate(): void;

  // Re-render visible widgets
  private render(): void;
}
```

### Session Lifecycle

| Event | Ad-hoc bar behavior |
|---|---|
| New chat | `deactivate()` — bar is hidden, no active session |
| Switch to session A | `activateSession('A')` — shows A's widgets |
| Switch to session B | `activateSession('B')` — shows B's widgets (A's preserved in memory) |
| Switch back to A | `activateSession('A')` — A's widgets restored |
| Session goes idle | `clearSession(id)` — widgets disposed; prevents stale/lost bars |
| Session deleted | `clearSession(id)` — widgets disposed and removed |
| Message sent (images) | Image widget cleared for that session |

### Widget Lifecycle

- Widgets are **programmatically managed only** — no user-facing dismiss buttons
- Removal is driven by the code that created the widget (swarm completes → remove, images sent → remove)
- **Session idle clears the bar** — when a session goes idle, its widgets are cleared as a lost-bar precaution. This ensures stale progress bars never linger.
- Multiple widgets from different sources can coexist (e.g., images + swarm progress). They are sorted by `priority` then insertion order.

### Visibility

- Bar container is **hidden** when no widgets exist for the active session (`display: none`)
- Becomes visible when first widget is added
- Same pattern as current `imagePreview.classList.toggle('visible')`

## Extension API

### Client Extension API Addition

```typescript
interface ClientExtensionAPI {
  // ... existing ...

  /** Ad-hoc bar: session-scoped widget region above chat input */
  adHocBar: {
    /**
     * Add a widget to the bar for the current session.
     * Returns a controller to update or remove it.
     */
    add(id: string, opts: {
      render: () => HTMLElement;
      priority?: number;  // default 50, lower = further left
    }): AdHocWidgetHandle;
  };
}

interface AdHocWidgetHandle {
  /** Re-render the widget (call after state changes) */
  update(): void;
  /** Remove the widget from the bar */
  remove(): void;
}
```

### Server → Client updates

For tool-driven widgets (swarm, SQL), the server pushes WS events:

```typescript
// Server tool emits during execution:
broadcastToSession(sessionId, 'adhoc.update', {
  widgetId: 'swarm-progress',
  data: { completed: 2, total: 4, label: 'Swarm' }
});
```

The built-in swarm progress widget listens for these events. Extensions can do the same via `api.on('adhoc.update', ...)`.

### Server Extension API Addition

```typescript
interface ServerExtensionAPI {
  // ... existing ...

  /** Push ad-hoc widget data to a session's bar */
  pushAdHocUpdate(sessionId: string, widgetId: string, data: unknown): void;
}
```

## Implementation Plan

### Phase 1: AdHocBarManager + image migration

1. **Create `public/ts/adhoc-bar.ts`** — `AdHocBarManager` class
2. **Update `index.html`** — rename `#imagePreview` to `#adHocBar`
3. **Refactor `image-paste.ts`** — register images as a widget via the manager instead of directly manipulating DOM
4. **Wire into session lifecycle** — `showNewChat()` calls `deactivate()`, `activateSession()` calls `activateSession(id)`, session idle calls `clearSession(id)`
5. **Verify**: image paste works, clears on new chat, clears on session idle, preserved across session switches

### Phase 2: Built-in swarm progress

1. **Add swarm progress widget** — built-in widget that listens for `adhoc.update` WS events with `widgetId: 'swarm-progress'`
2. **Update `swarm-tool.ts`** — emit progress events during the poll loop (completed count, total, label)
3. **Auto-remove** — widget removes itself when swarm completes (success or error)
4. **Error handling** — swarm timeout/failure removes the widget; session idle clears it as a fallback
5. **Verify**: progress bar appears during swarm, updates live, disappears on completion

### Phase 3: Extension API

1. **Add `adHocBar` to `ClientExtensionAPI`** — `add()` method delegates to `AdHocBarManager`
2. **Add `pushAdHocUpdate` to `ServerExtensionAPI`** — wraps `broadcastToSession`
3. **Document** in `doc/extensibility.md`
4. **Verify**: an extension can add/update/remove a widget; render errors are caught and don't crash the bar

## Code Analysis

### Current image paste coupling

`image-paste.ts` directly:
- Queries `#imagePreview` by ID
- Manipulates `innerHTML`, `classList`
- Manages its own array of base64 strings
- Syncs to a hidden `<input>`

This works but is a singleton that owns the entire region. The refactor wraps it as one widget among potentially many.

### Session switch gap (latent bug)

Currently `showNewChat()` does NOT call `removeImage()`. Images from a previous session could leak into new chat. The ad-hoc bar fixes this by design — `deactivate()` on new chat hides all widgets. The image widget's data is still session-scoped, so switching back would restore it if needed.

### DOM location

The bar sits between the chat scroll area and the form. This is correct — it's contextual to the input, not the messages. The `#chatFooter` element already contains both `#imagePreview` and `#chatForm`, so the bar is structurally sound.

## Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Widget leaks across sessions | Wrong context shown to user | `activateSession()` is the single entry point; manager hides widgets not belonging to active session |
| Lost/stale widgets | Confusing UI | Session idle event clears the bar for that session — automatic cleanup |
| Memory accumulation (many sessions, many widgets) | Slow UI | Widgets have `dispose()` for cleanup; `clearSession()` on delete; max 10 widgets per session |
| Race condition: WS update for session B while viewing A | Flicker | Updates go to session map, not DOM; only rendered if active |
| Breaking image paste | Regression | Phase 1 is pure refactor — same behavior, new structure |
| Extension widgets conflict with built-ins | Layout issues | Priority-based ordering with insertion-order tiebreak; built-in widgets get reserved priority ranges (0-9 images, 10-19 progress) |
| Extension render() throws | Bar crash | Wrap render calls in try/catch; show inline error placeholder for failed widgets |

## Considerations

- **No persistence** — ad-hoc bar state is ephemeral. Reloading the page clears it. This is intentional — it's for transient, in-flight context.
- **No user dismiss** — widgets are programmatically managed. Users don't close them; the creating code removes them when done.
- **Idle clears** — session going idle clears its widgets. This is the safety net against lost bars.
- **Max height** — bar should have a `max-height` with overflow scroll to prevent pushing the input off screen.
- **Widget cap** — max 10 widgets per session. Reject additions beyond the cap.
