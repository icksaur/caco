# WebSocket Applet Channel

## WebSocket Primer

WebSocket is a bidirectional protocol over a single TCP connection. Unlike HTTP (request/response) or SSE (server-push only), either side can send messages at any time. Connection starts as HTTP upgrade, then becomes persistent binary/text frames.

**When to use:** Real-time bidirectional communication (chat, live updates, gaming).
**When not to use:** Simple request/response, infrequent updates (HTTP is simpler).

## Current State

| Direction | Current Mechanism | Problem |
|-----------|-------------------|---------|
| Applet → Server | `setAppletState()` batched with next message POST | Requires user to send message |
| Server → Applet | SSE `_applet` event (reload only) | No general state push |
| Agent → Applet | ❌ None | Agent can't update running applet |
| Applet → Agent | ❌ None | Applet can't invoke agent directly |

## Proposed Solution

Single WebSocket per applet session. Server handles all messages - some locally, some routed to agent.

### Endpoint
```
ws://localhost:3000/ws/applet?session=<sessionId>
```

### Message Types

**Client → Server (server-local):**
| Type | Payload | Purpose |
|------|---------|---------|
| `setState` | `{ data: {...} }` | Push UI state |
| `readFile` | `{ path }` | Stream file content back |
| `writeFile` | `{ path, content }` | Write file |
| `subscribe` | `{ path }` | Watch file for changes |

**Client → Server (agent-routed):**
| Type | Payload | Purpose |
|------|---------|---------|
| `invoke` | `{ prompt, background? }` | Trigger agent action |

**Server → Client:**
| Type | Payload | Purpose |
|------|---------|---------|
| `stateUpdate` | `{ data }` | State pushed (from agent tool or server) |
| `fileContent` | `{ path, chunk, done }` | Streamed file data |
| `fileChanged` | `{ path, event }` | Watched file changed |
| `stream` | `{ delta }` | Agent response chunk |
| `invokeComplete` | `{ id, result, error? }` | Agent finished |

### Client API (applet JS)

```javascript
// State sync (server-local)
setAppletState({ key: value });

// File operations (server-local, streamed)
const content = await readFile('/path/to/file');
await writeFile('/path/to/file', content);
subscribeFile('/path/to/file', (event) => reload());

// Agent invocation
const result = await invokeAgent("Analyze this", { background: true });

// Receive pushed state (from agent or server)
onStateUpdate((state) => {
  document.getElementById('progress').value = state.progress;
});
```

### MCP Tools

**Existing:**
- `get_applet_state` - Query state pushed by applet

**New:**
```typescript
set_applet_state({
  data: { progress: 50, status: "Processing..." }
})
// Pushes state to applet via WebSocket
```

## Implementation Plan

### Phase 1: WebSocket Infrastructure ✅
- [x] Add `ws` package dependency
- [x] Create `/ws/applet` endpoint in `src/routes/applet-ws.ts`
- [x] Track connections by sessionId
- [x] Client-side connection manager in `public/ts/applet-ws.ts`
- [x] Auto-connect when applet loads

### Phase 2: State Push (Agent → Applet) ✅
- [x] `set_applet_state` MCP tool
- [x] `pushStateToApplet(sessionId, data)` server function
- [x] `onStateUpdate(callback)` client API

### Phase 3: Agent Invocation (Applet → Agent)
- [ ] `invokeAgent(prompt, options)` client API
- [ ] Server routes `invoke` message to session
- [ ] Stream response back via WebSocket

### Phase 4: File Operations
- [ ] `readFile(path)` with streaming response
- [ ] `writeFile(path, content)`
- [ ] `subscribe(path)` for file watching

## Files to Create/Modify

| File | Action | Status |
|------|--------|--------|
| `src/routes/applet-ws.ts` | New - WebSocket server | ✅ |
| `src/applet-tools.ts` | Add `set_applet_state` tool | ✅ |
| `public/ts/applet-ws.ts` | New - Client WebSocket manager | ✅ |
| `public/ts/applet-runtime.ts` | Integrate WS, expose new APIs | ✅ |
| `server.ts` | Mount WebSocket on HTTP server | ✅ |

## Flow Diagram

```mermaid
sequenceDiagram
    participant A as Applet JS
    participant S as Server
    participant M as Agent/MCP

    Note over A,S: Server-local operations
    A->>S: setState({ formData })
    S->>S: store in memory

    A->>S: readFile("/config.yaml")
    S-->>A: fileContent (chunked)

    A->>S: subscribe("/data.json")
    Note right of S: fs.watch()
    S-->>A: fileChanged (on edit)

    Note over A,M: Agent-routed operations
    A->>S: invoke("Process this")
    S->>M: send to session
    M-->>S: streaming response
    S-->>A: stream chunks
    S-->>A: invokeComplete

    M->>S: set_applet_state tool
    S-->>A: stateUpdate
```
