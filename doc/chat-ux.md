# Chat UX

User experience for messages, streaming, markdown, and input.

## Message Types

| Type | Styling | Content |
|------|---------|---------|
| User message | Right-aligned, blue | User input text |
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
