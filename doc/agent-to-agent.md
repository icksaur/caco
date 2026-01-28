# Agent-to-Agent Communication

HTTP API for agents to communicate with other agent sessions.

## Use Cases

1. **Delegate task to specialist** - Agent spawns new session with specific cwd/model for a subtask
2. **Fan-out work** - Agent creates multiple sessions to work in parallel
3. **Check on spawned work** - Agent polls session state to see if idle/complete
4. **Coordinate** - Agents send messages to existing sessions

## Architecture Principles

### POST Independence from WebSocket

```
POST /api/sessions/:id/messages
  └─> Node.js server
        ├─> SDK dispatch (required - this does the work)
        └─> WS broadcast (optional - informational for connected clients)
```

The POST must work without any WS connection. WS is just for real-time UI updates.

### Client Session Filtering

Client ignores WS packets for sessions other than current active session.
Future: may aggregate notifications from spawned sessions.

```typescript
// Client WS handler
onMessage((msg) => {
  if (msg.sessionId !== activeSessionId) {
    return; // Ignore - not our session
  }
  // ... handle message
});
```

## API Design

### POST /api/sessions/:sessionId/messages

Send a message to an existing session.

```
POST /api/sessions/abc123/messages
Content-Type: application/json

{
  "message": "Please analyze the file at src/main.ts",
  "source": "agent",
  "fromSession": "xyz789"  // optional: originating session for traceability
}
```

**Behavior:**
- Message saved to session history with `source: 'agent'`
- SDK dispatches to model (session becomes active)
- Returns immediately (async dispatch)

**Response:**
```json
{
  "messageId": "msg_123",
  "status": "dispatched"
}
```

### POST /api/sessions (create new session)

Already exists. Agent can create new session with specific cwd/model, then POST message to it.

### GET /api/sessions/:sessionId/state

Check session state.

```json
{
  "sessionId": "abc123",
  "status": "idle" | "streaming" | "error",
  "lastMessage": {
    "role": "assistant",
    "content": "...",
    "timestamp": "..."
  },
  "cwd": "/path/to/project"
}
```

## Message Sources

Extend `MessageSource` type:

```typescript
type MessageSource = 'user' | 'applet' | 'agent';
```

UI styling:
- `user` - Standard user bubble (blue)
- `applet` - Applet-branded bubble (shows which applet)
- `agent` - Purple bubble (shows originating session?)

## Safety Considerations

### Self-POST Prevention

Prevent infinite loops where agent POSTs to its own session.

**Option A: Block by session ID**
```typescript
if (fromSession === targetSession) {
  return res.status(400).json({ error: 'Cannot POST to own session' });
}
```

**Option B: Block by cwd**
```typescript
if (fromCwd === targetCwd) {
  return res.status(400).json({ error: 'Cannot POST to session with same cwd' });
}
```

Option A is simpler and more reliable.

### Rate Limiting

Consider rate limiting agent-to-agent POSTs to prevent runaway loops.

### Depth Limiting

Track "spawn depth" to prevent infinite delegation chains.

## MCP Tool Wrapper

```typescript
// send_agent_message tool
{
  name: "send_agent_message",
  description: "Send a message to another agent session",
  parameters: {
    sessionId: { type: "string", description: "Target session ID" },
    message: { type: "string", description: "Message to send" }
  }
}

// create_agent_session tool
{
  name: "create_agent_session", 
  description: "Create a new agent session",
  parameters: {
    cwd: { type: "string", description: "Working directory for new session" },
    model: { type: "string", description: "Model to use" },
    initialMessage: { type: "string", description: "First message to send" }
  }
}

// get_session_state tool
{
  name: "get_session_state",
  description: "Check if a session is idle or streaming",
  parameters: {
    sessionId: { type: "string", description: "Session to check" }
  }
}
```

## Implementation Plan

1. Add `source: 'agent'` support to message schema
2. Implement POST /api/sessions/:sessionId/messages
3. Implement GET /api/sessions/:sessionId/state
4. Add self-POST prevention
5. Create MCP tool wrappers
6. Add agent bubble styling in UI

## Open Questions

- [ ] Should agent messages show originating session ID in UI?
- [ ] How to handle errors from spawned sessions (notify originator?)
- [ ] Should there be a "wait for completion" variant that blocks?
- [ ] Session cleanup - who cleans up spawned sessions?
