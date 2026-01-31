# Chat View Architecture Design

## Current State (Broken)

**Problem:** Activity and chat are nested, causing rendering issues:
```
<div class="message assistant" id="pending-response">
  <div class="activity-wrapper">#1</div>
  <div class="markdown-content">All chat content goes here</div>
  <div class="activity-wrapper">#2</div>
  <!-- All further activity goes into wrapper #2 -->
</div>
```

**Issues:**
- Single response bubble contains multiple activity wrappers
- All chat content streams into first markdown-content div
- All further activity goes into last activity-wrapper
- No proper interleaving - just one chat section with activity bookends
- Complex nesting makes state management fragile

## Target Architecture (Flat Peer Structure)

**Goal:** Activity and chat as peer bubbles in flat list:
```
<div id="chat">
  <div class="message user">User message</div>
  <div class="message activity" id="pending-activity">
    <div class="activity-header">Activity (3)</div>
    <div class="activity-box">
      thinking...
      tool: bash
      tool: grep
    </div>
  </div>
  <div class="message assistant" id="pending-response">
    <div class="markdown-content">Chat response text</div>
  </div>
  <div class="message activity">
    <div class="activity-header">Activity (2)</div>
    <div class="activity-box">
      tool: view
      tool: edit
    </div>
  </div>
  <div class="message assistant">
    <div class="markdown-content">More response text</div>
  </div>
</div>
```

## Design Principles

### 1. Flat Message List
- All messages (user, activity, assistant) are peers in `#chat`
- No nesting of activity inside assistant bubbles
- Clear visual separation between activity and responses

### 2. Automatic Bubble Switching
**Activity arrives:**
- Check last message in `#chat`
- If last is `pending-activity`, append to it
- Otherwise, create new activity bubble

**Chat content arrives:**
- Check last message in `#chat`
- If last is `pending-response`, append to it
- Otherwise, create new assistant bubble

### 3. Simplified Activity Rendering
- No complex expandable items (initially)
- Simple text list: "thinking...", "tool: bash", "✓ bash"
- Collapsible header (expand/collapse entire box)
- No markdown processing

### 4. Chat Response Rendering
- Standard markdown processing
- Debounced rendering during streaming
- Streaming cursor
- Output containers for tool results

## Implementation Plan

### Phase 1: Core Structure (Priority)
1. ✅ Remove activity-wrapper from assistant bubbles
2. ✅ Create standalone activity bubble type
3. ✅ Implement `ensurePendingActivity()` - creates peer bubble
4. ✅ Implement `ensurePendingChat()` - creates peer bubble
5. Update message handlers to check last bubble type

### Phase 2: Message Routing
**WebSocket activity handler:**
```typescript
onActivity((item) => {
  const activityBox = ensurePendingActivity();
  if (activityBox) {
    appendActivityItem(activityBox, item);
  }
});
```

**WebSocket message handler:**
```typescript
onMessage((msg) => {
  if (msg.role === 'assistant') {
    const chatBubble = ensurePendingChat();
    if (msg.deltaContent) {
      appendChatContent(chatBubble, msg.deltaContent);
    }
  }
});
```

### Phase 3: Finalization
- When chat complete: remove `#pending-response` ID
- When activity phase ends: remove `#pending-activity` ID
- New activity starts new bubble
- New chat starts new bubble

## CSS Structure

```css
/* Activity bubbles - peer to user/assistant */
.message.activity {
  background: var(--bg-raised);
  padding: var(--space-md);
  border-left: 3px solid var(--color-info);
}

.activity-header {
  cursor: pointer;
  display: flex;
  gap: var(--space-sm);
}

.activity-box {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  margin-top: var(--space-sm);
}

.activity-box.collapsed {
  display: none;
}

/* Chat bubbles - simplified, no nested activity */
.message.assistant {
  background: var(--color-assistant-bg);
}

.markdown-content {
  /* Standard markdown styles */
}
```

## Key Functions

### `ensurePendingActivity(): HTMLElement`
- Check if last message is `#pending-activity`
- If yes, return its `.activity-box`
- If no, create new activity bubble, append to chat, return `.activity-box`

### `ensurePendingChat(): HTMLElement`
- Check if last message is `#pending-response`
- If yes, return its `.markdown-content`
- If no, create new assistant bubble, append to chat, return `.markdown-content`

### `appendActivityItem(box, item)`
- Simple text append: `"tool: bash"`, `"✓ bash"`
- Update header count
- Update header label (latest activity)
- No complex rendering

### `appendChatContent(bubble, delta)`
- Accumulate content
- Debounced markdown render
- Scroll to bottom

## Benefits

1. **Simplicity:** No complex nested state management
2. **Visual Clarity:** Activity and responses clearly separated
3. **Flexible Interleaving:** Natural back-and-forth pattern
4. **History Rendering:** Same structure for live and historical messages
5. **Debugging:** Easy to inspect message order in DOM

## Considerations

### History Storage
- Store activity bubbles as separate messages? Or metadata?
- Current: Activity nested in assistant messages
- Future: Activity as first-class message type in history

### Multi-turn Responses
- Each thinking → response cycle creates 2 bubbles
- Long sessions = many bubbles
- Acceptable: mirrors VSCode/CLI UX

### Scroll Performance
- More DOM elements
- Acceptable: modern browsers handle this well
- Virtualization not needed for typical sessions

### Activity Aggregation
- All activity for a phase goes into one bubble
- Reasonable: matches user mental model
- Alternative: One bubble per tool call (too verbose)

## Migration Path

1. ✅ Simplify scroll logic (always scroll)
2. ✅ Remove auto-scroll state tracking
3. ⚠️ Refactor activity to peer bubbles (in progress)
4. ⚠️ Update message handlers for flat structure
5. Test with real streaming scenarios
6. Update history rendering if needed
7. Consider activity storage format

## Open Questions

1. Should activity bubbles be stored in chat history?
   **✓ YES** - Activity bubbles are first-class messages, stored in history

2. How to handle activity that arrives after response is "complete"?
   **✓ Create new activity bubble** - Check if last message is activity, create new if not

3. Should we show activity timestamps?
   **✓ NO** - Keep activity bubbles simple, no timestamps

4. Max activity items per bubble before creating new?
   **✓ NO LIMIT** - All activity for a phase goes into one bubble until chat starts

## Related Files

- `public/ts/activity.ts` - Activity bubble management
- `public/ts/response-streaming.ts` - Message and content streaming
- `public/ts/ui-utils.ts` - Scroll utilities
- `public/style.css` - Message bubble styling
- `src/routes/session-messages.ts` - Server-side activity broadcasting
