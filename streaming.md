# Streaming Implementation Plan

## Current State
- Send button greyed with `htmx-request` class until Copilot responds
- User input stays in text field until response completes
- No visibility into what's happening between send and response
- Silent failures - no indication why model isn't responding

## Goals
1. **Immediately** put user input into chat bubble when sending
2. **Stream events** to a grey "activity" box showing what's happening
3. **Collapse** activity box when response begins
4. **Stream** response text word-by-word

---

## Research: Copilot SDK Streaming API

### Enable Streaming
```javascript
const session = await client.createSession({
  model: "gpt-4.1",
  streaming: true,  // <-- Enable streaming
});
```

### Event Types
When `streaming: true`, the SDK fires these events via `session.on()`:

| Event Type | Data | Description |
|------------|------|-------------|
| `user.message` | `{ content }` | User's message sent |
| `assistant.turn_start` | | Assistant begins processing |
| `assistant.intent` | `{ intent }` | What assistant plans to do |
| `assistant.reasoning` | `{ content }` | Full reasoning (final) |
| `assistant.reasoning_delta` | `{ deltaContent }` | Reasoning chunk (streaming) |
| `assistant.message_delta` | `{ deltaContent }` | Response chunk (streaming) |
| `assistant.message` | `{ content }` | Full response (final) |
| `assistant.turn_end` | | Assistant done processing |
| `tool.execution_start` | `{ name }` | Tool starting |
| `tool.execution_end` | `{ name, result }` | Tool completed |
| `session.idle` | | Session ready for next message |
| `session.error` | `{ message, stack }` | Error occurred |

### Non-Streaming vs Streaming
- **Non-streaming**: Only `assistant.message` (final) fires
- **Streaming**: `assistant.message_delta` fires multiple times with `deltaContent`, then `assistant.message` with full content

### Example: Streaming Handler
```javascript
session.on((event) => {
  switch (event.type) {
    case "assistant.message_delta":
      // Append deltaContent to response bubble
      process.stdout.write(event.data.deltaContent);
      break;
    case "assistant.message":
      // Final message - could verify/replace accumulated content
      console.log("\n--- Final ---");
      console.log(event.data.content);
      break;
    case "tool.execution_start":
      console.log(`🔧 Running: ${event.data.name}`);
      break;
    case "session.error":
      console.error(`❌ Error: ${event.data.message}`);
      break;
    case "session.idle":
      // Ready for next message
      break;
  }
});

// Use send() not sendAndWait() to get events as they happen
await session.send({ prompt: "Hello" });
```

---

## Research: HTMX Streaming Options

### Option 1: Server-Sent Events (SSE)
HTMX has an SSE extension that can receive streaming updates.

**Server-side:**
```javascript
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  session.on((event) => {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event.data)}\n\n`);
  });
});
```

**Client-side:**
```html
<div hx-ext="sse" sse-connect="/api/stream" sse-swap="assistant.message_delta">
  <!-- Content swapped here -->
</div>
```

**Pros:** Native HTMX, declarative
**Cons:** Complex swap logic, need to accumulate deltas, SSE extension required

### Option 2: Vanilla JS EventSource + DOM Manipulation
Skip HTMX for streaming, use vanilla JS EventSource.

```javascript
const eventSource = new EventSource('/api/stream?prompt=' + encodeURIComponent(message));

eventSource.addEventListener('assistant.message_delta', (e) => {
  const data = JSON.parse(e.data);
  document.getElementById('response').textContent += data.deltaContent;
});

eventSource.addEventListener('session.idle', () => {
  eventSource.close();
});
```

**Pros:** Simple, full control
**Cons:** Not HTMX, requires managing DOM manually

### Option 3: Hybrid - HTMX for User Message, JS for Response
1. HTMX immediately adds user message bubble (via `hx-on::before-request`)
2. JavaScript opens EventSource for streaming response
3. Close EventSource on `session.idle`

**This is the recommended approach.**

---

## Implementation Plan

### Phase 1: Immediate User Message Display
**No server changes needed**

```html
<form 
  hx-post="/api/message" 
  hx-target="#chat" 
  hx-swap="beforeend"
  hx-on::before-request="addUserBubble(this)"
>
```

```javascript
function addUserBubble(form) {
  const message = form.querySelector('input[name="message"]').value;
  const chat = document.getElementById('chat');
  chat.innerHTML += `
    <div class="message user">
      <strong>You:</strong> ${escapeHtml(message)}
    </div>
    <div class="message assistant pending" id="pending-response">
      <strong>Copilot:</strong>
      <div class="activity-box"></div>
    </div>
  `;
  // Scroll to bottom
  document.querySelector('main').scrollTop = document.querySelector('main').scrollHeight;
}
```

### Phase 2: Activity Box for Events
Show events while waiting for response:

```css
.activity-box {
  background: #2d2d2d;
  border-radius: 4px;
  padding: 0.5rem;
  font-size: 0.85rem;
  color: #858585;
  max-height: 100px;
  overflow-y: auto;
}

.activity-box.collapsed {
  display: none;
}

.activity-item {
  margin: 0.25rem 0;
}

.activity-item.tool { color: #4daafc; }
.activity-item.error { color: #f48771; }
```

### Phase 3: Server Streaming Endpoint
New endpoint that streams SSE events:

```javascript
app.get('/api/stream', async (req, res) => {
  const { prompt, model } = req.query;
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  
  // Get session
  const session = sessionManager.getSession(activeSessionId);
  
  // Subscribe to events
  const unsubscribe = session.on((event) => {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event.data || {})}\n\n`);
    
    if (event.type === 'session.idle' || event.type === 'session.error') {
      res.write('event: done\ndata: {}\n\n');
      res.end();
      unsubscribe();
    }
  });
  
  // Send message (non-blocking)
  await session.send({ prompt, model });
  
  // Handle client disconnect
  req.on('close', () => {
    unsubscribe();
  });
});
```

### Phase 4: Client EventSource Handler

```javascript
function streamResponse(prompt, model) {
  const url = `/api/stream?prompt=${encodeURIComponent(prompt)}&model=${encodeURIComponent(model)}`;
  const eventSource = new EventSource(url);
  
  const activityBox = document.querySelector('#pending-response .activity-box');
  const responseDiv = document.querySelector('#pending-response .markdown-content');
  let responseContent = '';
  
  eventSource.addEventListener('assistant.message_delta', (e) => {
    const data = JSON.parse(e.data);
    responseContent += data.deltaContent;
    responseDiv.textContent = responseContent;
    // Collapse activity box on first delta
    activityBox.classList.add('collapsed');
  });
  
  eventSource.addEventListener('assistant.message', (e) => {
    const data = JSON.parse(e.data);
    // Final message - render markdown
    responseDiv.innerHTML = marked.parse(data.content);
    renderMarkdown(); // syntax highlighting, mermaid, etc.
  });
  
  eventSource.addEventListener('tool.execution_start', (e) => {
    const data = JSON.parse(e.data);
    activityBox.innerHTML += `<div class="activity-item tool">🔧 ${data.name}...</div>`;
  });
  
  eventSource.addEventListener('session.error', (e) => {
    const data = JSON.parse(e.data);
    activityBox.innerHTML += `<div class="activity-item error">❌ ${data.message}</div>`;
  });
  
  eventSource.addEventListener('done', () => {
    eventSource.close();
    // Remove pending class
    document.querySelector('#pending-response').classList.remove('pending');
    document.querySelector('#pending-response').removeAttribute('id');
  });
  
  eventSource.onerror = () => {
    eventSource.close();
    activityBox.innerHTML += `<div class="activity-item error">❌ Connection error</div>`;
  };
}
```

### Phase 5: Integration
Replace HTMX form submission with JS that:
1. Adds user bubble immediately
2. Clears input
3. Starts EventSource streaming

```javascript
document.querySelector('form').addEventListener('submit', (e) => {
  e.preventDefault();
  
  const form = e.target;
  const input = form.querySelector('input[name="message"]');
  const message = input.value.trim();
  const model = document.getElementById('selectedModel').value;
  
  if (!message) return;
  
  // Add user bubble
  addUserBubble(message);
  
  // Clear input
  input.value = '';
  
  // Start streaming
  streamResponse(message, model);
});
```

---

## SessionManager Changes

### Enable Streaming on Session Creation
```javascript
// In session-manager.js create()
const session = await client.createSession({
  model: config.model || 'gpt-4.1',
  streaming: true,  // <-- Enable
  systemMessage: config.systemMessage,
  ...config
});
```

### Expose Session for Event Subscription
```javascript
// In session-manager.js
getSession(sessionId) {
  const active = this.activeSessions.get(sessionId);
  if (!active) return null;
  return active.session;
}
```

### Use send() Instead of sendAndWait()
```javascript
// In session-manager.js
async sendStream(sessionId, message, options = {}) {
  const active = this.activeSessions.get(sessionId);
  if (!active) throw new Error(`Session ${sessionId} is not active`);
  
  // Just send, don't wait
  return active.session.send({
    prompt: message,
    ...options
  });
}
```

---

## Migration Path

### Step 1: Enable streaming flag (no UI change)
- Add `streaming: true` to session creation
- Verify events are received via console logging

### Step 2: Add activity box UI
- Create pending response bubble with activity box
- Style the activity box

### Step 3: Create /api/stream endpoint
- Implement SSE streaming
- Test with curl: `curl -N http://localhost:3000/api/stream?prompt=hello`

### Step 4: Replace form submission
- Switch from HTMX to JS event handling
- Wire up EventSource

### Step 5: Polish
- Smooth scroll during streaming
- Auto-resize activity box
- Better error handling

---

## Fallback: Non-Streaming Improvements

If full streaming is too complex, simpler improvements:

1. **Immediate user bubble**: Use `hx-on::before-request` to add user message
2. **Spinner in response**: Show "Copilot is thinking..." placeholder
3. **Timeout indicator**: Show elapsed time after 5s
4. **Error visibility**: Better error display with retry option

```html
<form 
  hx-post="/api/message" 
  hx-target="#chat" 
  hx-swap="beforeend"
  hx-on::before-request="showPendingMessage(this)"
  hx-on::after-request="clearPending()"
>
```
