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

**What "active" means in client:**
- Which session the user is viewing
- Client filters WS messages by active session ID

### Session Activation on POST

When POST arrives for a session:
1. Check if session exists (404 if not)
2. Check if SDK client is loaded (`isActive`)
3. If not loaded, call `sessionManager.resume()` to load it
4. Dispatch message to SDK
5. Broadcast events to WS (if any clients connected)

Key: `resume()` loads a session **without stopping others**.

## API Design

### POST /api/sessions/:sessionId/messages

Send a message to an existing session. Message saved with `source: 'agent'`, SDK dispatches to model. Returns immediately (async dispatch).

### GET /api/sessions/:sessionId/state

Returns session status (`idle` | `streaming` | `error`), last message, and cwd.

## Message Sources

```typescript
type MessageSource = 'user' | 'applet' | 'agent';
```

UI styling: `user` blue, `applet` orange, `agent` purple.

## Safety Considerations

- **Self-POST prevention**: Block by session ID (Option A — simpler than cwd matching)
- **Rate limiting**: Prevent runaway loops
- **Depth limiting**: Track spawn depth (see [agent-recursion.md](agent-recursion.md))

## MCP Tools

All tools are session-aware — they know their own session ID and include it in requests.

### send_agent_message

Send a message to another agent session. Target receives with `source: 'agent'` and originating session ID.

### get_session_state

Check if a session is idle, streaming, or doesn't exist. Use to poll spawned sessions for completion.

### list_models

Discover available models for spawning sessions.

| Model ID | Best For |
|----------|----------|
| `claude-sonnet-4.5` | General-purpose engineering: edit/compile/test/fix cycles |
| `claude-opus-4.6` | Reasoning, documents, analysis, complex planning |
| `gpt-5-mini` | Simple automation tasks (slower, but follows instructions reliably) |

### create_agent_session

Create a new session with a specific working directory and model. Optional `initialMessage` sent immediately with `source: 'agent'`.

**Model selection guidance:**
- Spawning for code edits? → `claude-sonnet-4.5`
- Spawning for analysis or document generation? → `claude-opus-4.5`
- Unsure? → `claude-sonnet-4.5` (faster, cheaper, good default)

## Open Questions

- Should agent messages show originating session ID in UI?
- How to handle errors from spawned sessions (notify originator?)
- Should there be a "wait for completion" variant that blocks?
- Session cleanup — who cleans up spawned sessions?
