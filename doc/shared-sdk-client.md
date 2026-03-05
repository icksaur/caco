# Shared SDK Client

## Problem

Caco creates a new `CopilotClient` for every session create, resume, delete, and model list operation. Each client spawns a fresh CLI backend process, which independently connects to all MCP servers and triggers OAuth flows. When creating sub-sessions via `create_caco_session`, the user sees OAuth popups for every MCP server that needs auth — one popup per server per session.

## Goal

Share a single `CopilotClient` across all sessions. MCP servers connect once, OAuth happens once, and all sessions reuse the same CLI backend process.

## Current Architecture

### Client Lifecycle (4 separate clients)
```
create()      → new CopilotClient({ cwd }) → client.start() → client.createSession()
resume()      → new CopilotClient({ cwd }) → client.start() → client.resumeSession()
delete()      → new CopilotClient({ cwd }) → client.start() → client.deleteSession()
_fetchModels()→ new CopilotClient()        → client.start() → client.listModels() → client.stop()
```

### ActiveSession Map
```typescript
private activeSessions = new Map<string, ActiveSession>();
// ActiveSession = { cwd: string, session: CopilotSessionInstance, client: CopilotClientInstance }
```

Each session stores its own `client` reference.

### SDK Facts (verified)
- `CopilotClient` constructor `cwd` only controls CLI process spawn directory
- `workingDirectory` in `createSession`/`resumeSession` config is per-session
- `session.destroy()` removes only that session — other sessions unaffected
- `client.stop()` destroys ALL sessions on that client and closes the connection
- `client.sessions` is a `Map<string, CopilotSession>` — designed for multi-session
- `mcpServers` passed per-session but MCP connections are managed by the CLI process

## Design

### Shared Client Singleton

Replace per-session clients with a single shared client managed by `SessionManager`.

```typescript
class SessionManager {
  private sharedClient: CopilotClientInstance | null = null;
  private activeSessions = new Map<string, ActiveSession>(); // Remove 'client' from ActiveSession
}
```

### ActiveSession Simplification

```typescript
// BEFORE
interface ActiveSession { cwd: string; session: CopilotSessionInstance; client: CopilotClientInstance }

// AFTER
interface ActiveSession { cwd: string; session: CopilotSessionInstance }
```

### Client Lifecycle

```typescript
private clientStarting: Promise<CopilotClientInstance> | null = null;

private async ensureClient(): Promise<CopilotClientInstance> {
  if (this.sharedClient) return this.sharedClient;
  
  // Mutex: if already starting, wait for that attempt
  if (this.clientStarting) return this.clientStarting;
  
  this.clientStarting = (async () => {
    const client = new CopilotClient({ cwd: process.cwd() }) as unknown as CopilotClientInstance;
    await client.start();
    this.sharedClient = client;
    console.log('[SDK] Shared client started');
    return client;
  })();
  
  try {
    return await this.clientStarting;
  } finally {
    this.clientStarting = null;
  }
}
```

### Changes by Method

#### `create()`
```typescript
// BEFORE
const client = new CopilotClient({ cwd }) as unknown as CopilotClientInstance;
await client.start();
const session = await client.createSession({ ... });
this.activeSessions.set(id, { cwd, session, client });

// AFTER  
const client = await this.ensureClient();
const session = await client.createSession({ ..., workingDirectory: cwd });
this.activeSessions.set(id, { cwd, session });
```

Key: Add `workingDirectory: cwd` to session config since the shared client's CWD is `process.cwd()`, not the session's CWD.

#### `_doResume()`
```typescript
// BEFORE
const client = new CopilotClient({ cwd }) as unknown as CopilotClientInstance;
await client.start();
const session = await client.resumeSession(sessionId, { ... });
this.activeSessions.set(sessionId, { cwd, session, client });

// AFTER
const client = await this.ensureClient();
const session = await client.resumeSession(sessionId, { ..., workingDirectory: cwd });
this.activeSessions.set(sessionId, { cwd, session });
```

#### `stop()`
```typescript
// BEFORE
const { cwd, session, client } = active;
await session.destroy();
await client.stop();       // ← KILLS THE CLIENT

// AFTER
const { cwd, session } = active;
await session.destroy();   // ← Only destroys this session
// DO NOT stop the shared client
```

#### `_fetchModels()`
```typescript
// BEFORE
const client = new CopilotClient({ cwd: process.cwd() });
await client.start();
this.cachedModels = await client.listModels();
await client.stop();

// AFTER
const client = await this.ensureClient();
this.cachedModels = await client.listModels();
// DO NOT stop - it's shared
```

#### `delete()`
```typescript
// BEFORE (creates throwaway client)
const client = new CopilotClient({ cwd });
await client.start();
await client.deleteSession(sessionId);
await client.stop();

// AFTER
const client = await this.ensureClient();
await client.deleteSession(sessionId);
```

### Shutdown

Add a `shutdown()` method for graceful server exit:

```typescript
async shutdown(): Promise<void> {
  if (this.sharedClient) {
    await this.sharedClient.stop();
    this.sharedClient = null;
  }
}
```

Wire into server shutdown / restart flow.

### Error Recovery

If the shared client dies (CLI process crashes), `ensureClient()` needs to handle reconnection:

```typescript
private async ensureClient(): Promise<CopilotClientInstance> {
  if (this.sharedClient) {
    // Check if still connected (SDK exposes state)
    try {
      // A lightweight check — listModels or similar
      return this.sharedClient;
    } catch {
      console.warn('[SDK] Shared client died, recreating...');
      this.sharedClient = null;
    }
  }
  const client = new CopilotClient({ cwd: process.cwd() }) as unknown as CopilotClientInstance;
  await client.start();
  this.sharedClient = client;
  console.log('[SDK] Shared client started');
  return client;
}
```

Note: The SDK has `this.state` tracking ("connected", "disconnected", "error"). We'd need to check if this is exposed. If not, wrapping calls in try/catch and recreating on failure is sufficient.

## Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Shared client crash kills all sessions | High | `ensureClient()` recreates on failure; active sessions are SDK-resumed on next message anyway |
| `workingDirectory` doesn't fully replace constructor `cwd` | Medium | Verify with testing — SDK docs confirm per-session CWD is `workingDirectory` |
| Session eviction calls `session.destroy()` which may affect shared client state | Low | SDK `destroy()` only removes one session from the sessions Map — verified in source |
| MCP servers may be per-session not per-client | Medium | Test empirically — if MCP connects per-session, the OAuth benefit is lost |
| Concurrent `ensureClient()` calls during startup | Low | Use promise-based mutex (same pattern as `resumeInProgress`) to serialize client creation |
| `session.destroy()` fails on dead client | Low | Wrap in try/catch, same as today — failure is non-fatal |

## Shutdown Ordering

The existing shutdown flow is:
```
SIGINT → sessionState.shutdown() → sessionManager.stop(each session) → process.exit
```

After refactor, `stop()` no longer calls `client.stop()`. The shared client must be stopped explicitly after all sessions are destroyed:
```
SIGINT → sessionState.shutdown()     // destroys all sessions via session.destroy()
       → sessionManager.shutdown()   // stops shared client
       → process.exit
```

Wire `sessionManager.shutdown()` into `server.ts` SIGINT handler, after `sessionState.shutdown()` resolves.

## Restart Behavior

When `restart_server` is called, the process exits and respawns. The shared client dies with the process. On restart, `ensureClient()` lazily creates a fresh client on first use. No special handling needed — this is the same as today where each client is fresh per-session.

## Testing Plan

1. **Basic flow**: Create session, send message, verify response — same as today
2. **Multi-session**: Create 2+ sessions, verify both work on shared client
3. **Session stop**: Stop one session, verify others still work
4. **Model listing**: Verify models still load
5. **Session delete**: Delete session, verify shared client stays alive
6. **OAuth**: Create multiple sessions with MCP servers — verify only ONE OAuth popup per server
7. **Error recovery**: Kill CLI process, verify next operation recreates client

## Implementation Plan

1. Add `sharedClient` field, `clientStarting` mutex, and `ensureClient()` method
2. Remove `client` from `ActiveSession` interface
3. Update `create()` — use shared client, add `workingDirectory: cwd`
4. Update `_doResume()` — use shared client, add `workingDirectory: cwd`
5. Update `stop()` — call `session.destroy()` only, remove `client.stop()`
6. Update `_fetchModels()` — use shared client, remove `client.stop()`
7. Update `delete()` — use shared client, remove `client.stop()`
8. Add `shutdown()` method that stops the shared client
9. Wire `sessionManager.shutdown()` into `server.ts` SIGINT handler after `sessionState.shutdown()`
10. Remove the error recovery section from `ensureClient()` — keep it simple for v1, add health checks if needed
11. Test all flows manually: create, resume, stop, delete, models, multi-session, shutdown
