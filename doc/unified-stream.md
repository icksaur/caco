# Unified WebSocket Streaming

Single persistent WebSocket connection for all session communication.

## Problem

1. WS connects with `?session=XXX` in URL — reconnects when switching sessions
2. Race conditions during session switches
3. Complex `waitForConnect()` logic for new chats

## Architecture

### Single WS Connection

- Connect on page load (no session in URL)
- Stay connected across session switches
- Server broadcasts ALL events, client filters by active sessionId

### Client Filtering

```typescript
onMessage((msg) => {
  if (msg.sessionId !== getActiveSessionId()) return;
  renderMessage(msg);
});
```

### Session Lifecycle

1. **Page load**: Connect WS immediately
2. **Load existing session**: Send `requestHistory`, wait for `historyComplete`
3. **New chat**: Just POST to create session, WS already connected
4. **Switch session**: Clear chat, send `requestHistory` for new session
5. **Network loss**: Auto-reconnect, re-request history for current session

## Message Protocol

### Server → Client
```typescript
{ type: 'message', sessionId: string, message: ChatMessage }
{ type: 'activity', sessionId: string, item: ActivityItem }
{ type: 'historyComplete', sessionId: string }
{ type: 'stateUpdate', sessionId: string, state: {...} }
```

### Client → Server
```typescript
{ type: 'requestHistory', sessionId: string }
{ type: 'ping' }
```
