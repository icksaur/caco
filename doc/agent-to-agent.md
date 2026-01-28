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

### Backend Has No "Active Session" Concept

The backend doesn't track which session the user is looking at. That's a client concern.

**Backend responsibilities:**
- Respond to HTTP requests for any session
- Establish WS connections when clients connect
- Broadcast events to WS for connected sessions
- Load SDK clients into memory as needed (multiple can be active)

**What "active" means in backend:**
- `sessionManager.activeSessions` = sessions with SDK client loaded in memory
- Multiple sessions can be "active" simultaneously
- POST to any session will load its SDK client if needed (via `resume()`)
- Does NOT stop other sessions when activating a new one

**What "active" means in client:**
- Which session the user is viewing
- Client filters WS messages by active session ID
- Client tracks this locally

### Session Activation on POST

When POST arrives for a session:
1. Check if session exists (404 if not)
2. Check if SDK client is loaded (`isActive`)
3. If not loaded, call `sessionManager.resume()` to load it
4. Dispatch message to SDK
5. Broadcast events to WS (if any clients connected)

Key: `resume()` loads a session **without stopping others**.

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

Three tools are provided for agent-to-agent communication. All tools are session-aware - they know their own session ID and include it in requests so receiving sessions can call back.

### send_agent_message

Send a message to another agent session. The target session receives the message with `source: 'agent'` and the originating session ID.

```typescript
send_agent_message(sessionId: string, message: string)
```

**Callback pattern**: Include instructions in your message so the target can report back:

```
"Analyze the API in /src/api. When finished, call send_agent_message('${mySessionId}', 'Analysis results: ...')"
```

The tool description includes your session ID so the model knows what to tell the target.

### get_session_state

Check if a session is idle, streaming, or doesn't exist.

```typescript
get_session_state(sessionId: string)
// Returns: { sessionId, status: 'idle' | 'streaming', cwd, isActive }
```

Use this to poll spawned sessions for completion.

### create_agent_session

Create a new session with a specific working directory.

```typescript
create_agent_session(cwd: string, initialMessage?: string)
// Returns: new session ID
```

If `initialMessage` is provided, it's sent immediately with `source: 'agent'`.

**Example workflow**:
```
1. create_agent_session('/path/to/project', 'Analyze this codebase and send_agent_message("abc123", "Results: ...")') 
2. Poll with get_session_state until idle
3. Or just wait for the callback message
```

## Implementation Plan

1. ✅ Add `source: 'agent'` support to message schema
2. ✅ Implement POST /api/sessions/:sessionId/messages
3. ✅ Implement GET /api/sessions/:sessionId/state
4. ✅ Add self-POST prevention
5. ✅ Create MCP tool wrappers (`src/agent-tools.ts`)
6. ✅ Add agent bubble styling in UI (purple)

## Open Questions

- [ ] Should agent messages show originating session ID in UI?
- [ ] How to handle errors from spawned sessions (notify originator?)
- [ ] Should there be a "wait for completion" variant that blocks?
- [ ] Session cleanup - who cleans up spawned sessions?
