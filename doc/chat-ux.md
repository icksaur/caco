# Chat UX

User experience for messages, streaming, markdown, and input.

## Message Sources

Messages can originate from four sources, each with distinct visual styling and agent context.

### Source Types

| Source | Origin | Color | Agent Context |
|--------|--------|-------|---------------|
| `user` | Chat input UI | Blue | Human user typing |
| `applet` | Applet `sendAgentMessage()` | Orange | Applet-triggered automation |
| `agent` | `send_agent_message` tool | Purple | Agent-to-agent communication |
| `scheduler` | Scheduled job execution | Teal | Scheduled automation |

### Visual Differentiation

CSS classes apply distinct backgrounds:
- `.user-message` → `var(--color-user-bg)` (blue tint)
- `.applet-message` → `var(--color-applet-bg)` (orange tint)  
- `.agent-message` → `var(--color-agent-bg)` (purple tint)
- `.scheduler-message` → `var(--color-scheduler-bg)` (teal tint)

### Current State: FIXED ✅

Message sources are now correctly differentiated:
- **Live streaming**: Client transforms `user.message` with `source` to `caco.*` synthetic types
- **History replay**: Server parses `[source:id]` prefix and enriches event with `source` metadata
- **Agent context**: Copilot SDK sees prefixed prompts like `[scheduler:daily-standup]`

### Implementation Details

**Chat bubble rendering** requires entries in THREE files:
1. `element-inserter.ts` → `EVENT_TO_OUTER` (outer div class, e.g., `scheduler-message`)
2. `element-inserter.ts` → `EVENT_TO_INNER` (inner div class, e.g., `scheduler-text`)  
3. `event-inserter.ts` → `EVENT_INSERTERS` (content rendering function)

Missing any of these = broken rendering!

**Current flow** (unified for live and history):

```
Applet → POST /api/sessions/:id/messages { source: 'applet', appletSlug: 'file-browser' }
         ↓
Server → Prefixes prompt: "[applet:file-browser] original prompt"
         ↓
SDK → Stores prefixed string, echoes user.message with prefixed content
         ↓
broadcastEvent() → enrichUserMessageWithSource() parses prefix, adds source metadata
         ↓
WebSocket → Broadcasts: { type: 'user.message', data: { content: 'original prompt', source: 'applet', appletSlug } }
         ↓
Client → Transforms to caco.applet, renders with applet-message class
```

**Key design principle**: ONE code path for enrichment. Both live streaming and history 
replay use `enrichUserMessageWithSource()` to parse the prefix and add source metadata.

**Files involved**:
- `src/routes/session-messages.ts` - Prefixes prompt with `[applet:slug]`, `[agent:id]`, or `[scheduler:slug]`
- `src/routes/websocket.ts` - `enrichUserMessageWithSource()` parses prefix, enriches all user.message events
- `src/message-source.ts` - `parseMessageSource()` pure function for prefix parsing
- `public/ts/message-streaming.ts` - Transforms `user.message` with source to `caco.*` synthetic types
- `public/ts/element-inserter.ts` - Maps `caco.agent`/`caco.applet`/`caco.scheduler` to outer div classes
- `public/ts/event-inserter.ts` - Content inserters for synthetic types

## Message Metadata Storage

### SDK Limitations

The Copilot SDK's `session.send()` accepts:
```typescript
interface SendOptions {
  prompt: string;
  attachments?: Attachment[];
  mode?: string;
}
```

No native support for:
- Message tags/labels
- Source metadata
- Custom properties

### Current Workaround: Prompt Prefixing

Encode source in prompt text:
```
[applet:file-browser] Show files in /src
[agent:abc-123] Process results from parent session
[scheduler:daily-standup] Generate standup summary
```

**Pros**: Persists in SDK history, survives restarts
**Cons**: Agent sees prefix (may confuse), parsing needed on replay

### Alternative: Caco Metadata Layer

Store message metadata separately in `~/.caco/sessions/<id>/messages/`:

```json
// <messageId>.json
{
  "messageId": "msg-123",
  "source": "applet",
  "appletSlug": "file-browser",
  "timestamp": "2026-02-06T...",
  "correlationId": "abc-123"
}
```

**Pros**: Clean separation, no prompt pollution
**Cons**: Extra storage layer, orphan risk if SDK message deleted

### Recommendation

**Hybrid approach**:
1. Keep prompt prefixing for SDK context (agent knows source)
2. Add optional Caco metadata for rich UI rendering
3. Consolidate with embed/output storage pattern

## Applet-to-Agent Messages

### Flow

```
Applet iframe → window.parent.postMessage({ type: 'caco:sendAgentMessage', prompt })
              ↓
applet-runtime.ts → POST /api/sessions/:id/messages { prompt, source: 'applet', appletSlug }
              ↓
session-messages.ts → Prefix prompt, dispatch to SDK
              ↓
SDK → Processes as "user" message, streams response
              ↓
WebSocket → Broadcasts events to all clients
              ↓
Applet iframe → Receives response (if listening)
```

### Key Files

- `public/ts/applet-runtime.ts:210-244` - `sendAgentMessage()` function
- `src/routes/session-messages.ts:124-127` - Applet prefix injection
- `src/routes/websocket.ts:265-278` - Broadcast with source metadata

### Applet State Push

Applets can also receive pushed state from agent tools:

```
Agent tool → pushStateToApplet(slug, state)
           ↓
server.ts → WebSocket broadcast: { type: 'applet.stateUpdate', data: { slug, state } }
           ↓
applet-runtime.ts → window.postMessage to iframe: { type: 'caco:stateUpdate', state }
           ↓
Applet → Receives state update
```

## Embedded Media Storage

### Output Storage Pattern

Display tools store outputs to disk:

```
~/.caco/sessions/<sessionId>/outputs/
├── <outputId>.json    # Content (for embeds)
├── <outputId>.b64     # Content (for images)
├── <outputId>.meta.json  # Metadata
```

### Metadata Schema

```typescript
interface OutputMetadata {
  type: 'embed' | 'image' | 'html' | 'text';
  provider?: string;    // For embeds: 'youtube', 'twitter', etc.
  title?: string;       // Display title
  sessionCwd: string;
  createdAt: string;
}
```

### Event Flow

```
embed_media tool → storeOutput(html, { type: 'embed', provider, title })
                 ↓
Returns outputId → Tool returns "[output:xxx]" marker in result
                 ↓
session.idle → Queue flush → caco.embed event broadcast
                 ↓
Client → Fetches /api/outputs/:id, renders inline
```

### Consolidation Opportunity

Message source metadata could follow the same pattern:

```
~/.caco/sessions/<sessionId>/messages/
├── <messageIndex>.meta.json  # { source, appletSlug, timestamp, ... }
```

This would:
- Align with output storage pattern
- Persist source metadata separately from SDK
- Enable rich history rendering without prompt parsing

## Message Types

| Type | Styling | Content |
|------|---------|---------|
| User message | Right-aligned, blue | User input text |
| Applet message | Right-aligned, orange | Applet-triggered message |
| Agent message | Right-aligned, purple | Agent-to-agent message |
| Assistant message | Left-aligned, gray | AI response with markdown |
| Tool execution | Collapsed by default | Tool name + result |
| System message | Muted, centered | Status updates |

## Streaming Display

### Jitter Issue Analysis

**Problem:** During streaming, the chat view bounces up and down as content height changes rapidly.

**Root cause sequence:**
1. Delta arrives → appended to raw content buffer
2. `showTail()` adds unrendered text to `.streaming-tail` span → height increases
3. When threshold reached → `render()` calls `renderMarkdownElement()` 
4. Markdown rendering changes structure (e.g., raw text becomes `<p>`, `<pre>`, etc.)
5. Height calculation changes → scroll position jumps
6. Process repeats with each batch of deltas

**Visual effect:** Text appears to shake/jitter because:
- Tail text takes up N pixels
- Rendered markdown occupies different height (often smaller due to compact formatting)
- The difference causes content to shift up/down

**Current mitigations (insufficient):**
- `MIN_CHARS_BEFORE_RENDER = 50` - batches deltas
- `BATCH_DELAY_MS = 50` - debounces rapid renders
- `RENDER_INTERVAL_MS = 200` - fallback render timeout

### Proposed Solution: Height-Stabilized Tail

**Goal:** Keep content height stable during streaming by reserving space.

**Approach:**
1. Use `min-height` on the streaming element that grows but never shrinks during streaming
2. Track max height seen during streaming
3. Only release min-height constraint on finalize

**Implementation:**
```typescript
function showTail(state: StreamingState): void {
  const { element, rawContent, lastRenderedLength } = state;
  
  // Capture current height before any changes
  const currentHeight = element.offsetHeight;
  if (currentHeight > state.maxHeight) {
    state.maxHeight = currentHeight;
    element.style.minHeight = `${currentHeight}px`;
  }
  
  // ... rest of tail logic
}

function finalize(...): void {
  // ... cleanup
  element.style.minHeight = '';  // Release height constraint
}
```

**Alternative: CSS-only approach**
Use `contain: size` or `contain: layout` on streaming elements. However this may cause overflow issues.

**Alternative: Placeholder buffer**
Keep a 1-line invisible buffer after content that absorbs height changes. Complex to implement correctly.

**Recommendation:** Height-stabilized tail is simplest and most reliable.

### Incremental Markdown Rendering

- **Raw deltas**: Accumulated in memory buffer
- **Render interval**: Every 50+ chars or 200ms timeout
- **Tail display**: Unrendered text shown after rendered HTML
- **Final render**: Complete message on `assistant.message` event

### Activity Box

- **Purpose**: Shows tool calls and progress during streaming
- **Position**: Above message content
- **State**: Expanded during streaming, collapsed after

### Cursor

- **Element**: `#workingCursor` shows blinking cursor during streaming
- **Visibility**: Hidden when streaming complete

## Markdown Rendering

| Feature | Implementation |
|---------|----------------|
| Parsing | marked.js |
| Sanitization | DOMPurify |
| Syntax highlighting | highlight.js |
| Diagrams | Mermaid |

### Supported Elements

- Headings, lists, tables
- Code blocks with syntax highlighting
- Inline code, bold, italic
- Links (open in new tab)
- Mermaid diagrams (```mermaid blocks)

## Input Area

### Layout

- **Position**: Fixed footer at bottom of chat panel
- **Elements**: Textarea, submit button, image preview (when attached)

### Image Attachment

- **Trigger**: Paste image or use file picker
- **Preview**: Thumbnail with "× Remove" button
- **Submit**: Image included in message POST

### Keyboard

| Key | Action |
|-----|--------|
| Enter | Submit message |
| Shift+Enter | New line |
| Escape | Clear input / cancel |

## Embedded Media

- **oEmbed**: Supported providers render inline (YouTube, etc.)
- **Images**: Displayed inline with lightbox
- **Output markers**: `[output:xxx]` replaced with rendered content

## Scroll Behavior

- **Auto-scroll**: Enabled during streaming
- **User scroll**: Disables auto-scroll if user scrolls up
- **Scroll to bottom**: Button appears when not at bottom

## WebSocket Connection

- **Reconnection**: Auto-reconnect with exponential backoff
- **Session filter**: Only show events for active session
- **Status indicator**: Toast notification on disconnect/reconnect

## Mobile Behavior

- Chat fills viewport when applet hidden
- Keyboard pushes content up (no overlap)
- Safe area insets for iOS home indicator
