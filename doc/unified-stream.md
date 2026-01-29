# Unified WebSocket Streaming

Single persistent WebSocket connection for all session communication.

## Current Architecture (Problems)

1. WS connects with `?session=XXX` in URL
2. Reconnects when switching sessions
3. Race conditions during session switches
4. Complex `waitForConnect()` logic for new chats
5. Server tracks sessions per-connection

## New Architecture

### Single WS Connection

- Connect on page load (no session in URL)
- Stay connected across session switches
- Reconnect on network issues / sleep / iOS background
- Server broadcasts ALL events, client filters

### Client Filtering

```typescript
onMessage((msg) => {
  // Ignore messages for other sessions
  if (msg.sessionId !== getActiveSessionId()) return;
  renderMessage(msg);
});
```

### History on Demand

```typescript
// Client sends:
{ type: 'requestHistory', sessionId: 'abc123' }

// Server responds with history messages, then:
{ type: 'historyComplete', sessionId: 'abc123' }
```

### Session Lifecycle

1. **Page load**: Connect WS immediately
2. **Load existing session**: Send `requestHistory`, wait for `historyComplete`
3. **New chat**: Just POST to create session, WS already connected
4. **Switch session**: Clear chat, send `requestHistory` for new session
5. **Network loss**: Auto-reconnect, re-request history for current session

## Implementation Plan

### Server Changes (src/routes/applet-ws.ts)

- [x] Remove session from URL query param
- [x] Single global connection pool (not per-session)
- [x] Broadcast ALL messages to ALL connections
- [x] Add `sessionId` to all broadcast messages
- [x] Handle `requestHistory` message from client
- [x] Send `historyComplete` with sessionId

### Client Changes (public/ts/applet-ws.ts)

- [x] Connect on page load (no session param)
- [x] Add `setActiveSession(sessionId)` - sets local filter
- [x] Add `requestHistory(sessionId)` - sends WS message
- [x] Filter incoming messages by active session
- [x] Add `reconnectIfNeeded()` for visibility API
- [ ] Re-request history on reconnect if session active (optional)

### Client Changes (public/ts/state.ts)

- [x] Remove WS connect from `setActiveSession()`
- [x] Just calls `setWsActiveSession()` for filter

### Client Changes (public/ts/response-streaming.ts)

- [x] Remove `waitForConnect()` - WS always ready
- [x] Just POST message, rendering happens via WS

### Client Changes (public/ts/session-panel.ts)

- [x] Call `requestHistory()` when switching sessions
- [x] Clear chat handled by existing code

### Client Changes (public/ts/main.ts)

- [x] Connect WS on page load
- [x] Request history for initial session
- [x] Add visibility change handler for reconnect

## Message Protocol Changes

### Current Server→Client Messages

```typescript
{ type: 'message', message: ChatMessage }
{ type: 'activity', item: ActivityItem }
{ type: 'historyComplete' }
{ type: 'stateUpdate', state: {...} }
```

### New Server→Client Messages

```typescript
{ type: 'message', sessionId: string, message: ChatMessage }
{ type: 'activity', sessionId: string, item: ActivityItem }
{ type: 'historyComplete', sessionId: string }
{ type: 'stateUpdate', sessionId: string, state: {...} }
```

### New Client→Server Messages

```typescript
{ type: 'requestHistory', sessionId: string }
{ type: 'ping' }  // Keep-alive
```

## Reconnect Strategy

```typescript
// Visibility API for mobile/sleep
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    ensureConnected();
  }
});

// Heartbeat every 30s
setInterval(() => {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'ping' }));
  }
}, 30000);

// On reconnect, re-request history if viewing a session
function onReconnect() {
  const sessionId = getActiveSessionId();
  if (sessionId) {
    requestHistory(sessionId);
  }
}
```
