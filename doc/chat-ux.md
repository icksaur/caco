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

### Current State: BROKEN ⚠️

**Problem**: All sources render as `user.message` events with source metadata in `data.source`, but:

1. **Live streaming**: Server broadcasts `user.message` with `source` field, but client doesn't differentiate
2. **History replay**: SDK stores the prefixed prompt `[applet:slug] ...` but client shows raw text
3. **Agent context**: Copilot SDK sees all messages as "user" - doesn't know scheduler/applet/agent context

### Implementation Details

**Current flow** (partially working):

```
Applet → POST /api/sessions/:id/messages { source: 'applet', appletSlug: 'file-browser' }
         ↓
Server → Prefixes prompt: "[applet:file-browser] original prompt"
         ↓
SDK → Stores prefixed string in history (as user message)
         ↓
WebSocket → Broadcasts: { type: 'user.message', data: { content, source: 'applet', appletSlug } }
         ↓
Client → Receives event but renders all as user-message (missing differentiation)
```

**Files involved**:
- `src/routes/session-messages.ts:122-127` - Prefixes prompt with `[applet:slug]` or `[agent:sessionId]`
- `src/routes/websocket.ts:255-278` - `broadcastUserMessageFromPost()` creates `user.message` event
- `public/ts/element-inserter.ts:38-39` - Maps `caco.agent`/`caco.applet` to outer div classes
- `public/ts/event-inserter.ts:271-272` - Content inserters for `caco.agent`/`caco.applet`
- `public/style.css:667-693` - `.message.applet`, `.message.agent` styles
- `tests/unit/message-source.test.ts` - Parser for `[applet:slug]` prefix

### Required Fixes

#### 1. Live Streaming Differentiation

Client should check `user.message` event's `data.source` and apply appropriate styling:

```typescript
// In message-streaming.ts or event handler
if (event.type === 'user.message' && event.data?.source !== 'user') {
  // Render as caco.applet or caco.agent based on source
  const syntheticType = event.data.source === 'applet' ? 'caco.applet' : 'caco.agent';
  // Use syntheticType for element creation
}
```

#### 2. History Replay Parsing

When replaying history, parse `[applet:slug]`, `[agent:sessionId]`, and `[scheduler:slug]` prefixes:

```typescript
function parseMessageSource(content: string): {
  source: 'user' | 'applet' | 'agent' | 'scheduler';
  identifier?: string;
  cleanContent: string;
}
```

Already implemented in `tests/unit/message-source.test.ts` - needs to be extracted and used.

#### 3. SDK Context for Agent

**Problem**: Copilot SDK treats all incoming messages as "user" input. Agent doesn't know it's processing a scheduled job vs a human request.

**Options**:
- **System message injection**: Prepend context to prompt ("This is a scheduled task, not a human request...")
- **SDK metadata API**: If SDK supports message metadata/tags, use that
- **Custom preamble**: Add source info to system message

**Recommendation**: Prepend brief context to prompt:
```
[scheduler:daily-standup] Generate daily standup summary
```

Agent sees this prefix and adjusts behavior (e.g., no "how can I help?" responses).

### Implementation Plan

**Phase 1: Groundwork (no behavior change)**

1. **Extend MessageSource type** - Add `'scheduler'` to `MessageSource` union in:
   - `src/routes/websocket.ts`
   - `public/ts/websocket.ts`

2. **Extract parseMessageSource()** - Create `src/message-source.ts`:
   - Pure function with no I/O
   - Handles all 4 source types: user, applet, agent, scheduler
   - Returns `{ source, identifier?, cleanContent }`

3. **Add CSS variables and classes**:
   - `--color-scheduler-bg: #1a4a4a` (teal tint)
   - `.scheduler-message` class with appropriate styling

4. **Add scheduler prefix** - Update `src/routes/session-messages.ts`:
   - When `source === 'scheduler'`, prefix prompt with `[scheduler:slug]`

**Phase 2: Live streaming differentiation**

5. **Element inserter mapping** - Update `public/ts/element-inserter.ts`:
   - Map `caco.scheduler` event type to `.scheduler-message` class

6. **Event handler differentiation** - Update user.message handler:
   - Check `data.source` field
   - Create appropriate outer div class based on source

**Phase 3: History replay**

7. **Parse prefixes on replay** - Update history streaming:
   - Use `parseMessageSource()` on user message content
   - Apply correct CSS class based on parsed source
   - Display clean content (without prefix)

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
