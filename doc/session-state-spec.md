# Session State Architecture

Implementation details for session state management, observation tracking, and real-time sync.

For UI/UX design, see [session-ux.md](session-ux.md).

## Data Sources

| Source | Location | Data |
|--------|----------|------|
| SDK | `~/.copilot/session-state/<id>/workspace.yaml` | cwd, summary, updatedAt |
| Caco meta | `~/.caco/sessions/<id>/meta.json` | name, lastIdleAt, lastObservedAt |
| Runtime | `UnobservedTracker` (in-memory Set) | unobserved session IDs |
| Schedule | `~/.caco/schedule/<slug>/` | definition.json, last-run.json |

## UnobservedTracker

Single source of truth for unobserved session state.

### Design

```typescript
class UnobservedTracker {
  private unobservedSet: Set<string> = new Set();
  
  markIdle(sessionId: string): boolean     // Add to set, persist lastIdleAt
  markObserved(sessionId: string): boolean // Remove from set, persist lastObservedAt
  getCount(): number                        // O(1) count
  isUnobserved(sessionId: string): boolean  // O(1) check
  remove(sessionId: string): void           // On session delete
  hydrate(sessionIds: string[]): void       // Load from meta.json on startup
}
```

### Persistence

- `markIdle()` writes `lastIdleAt` to `meta.json`
- `markObserved()` writes `lastObservedAt` to `meta.json`
- On startup, `hydrate()` loads sessions where `lastIdleAt > lastObservedAt`

### Broadcast

All mutations broadcast `session.listChanged` event with:
```json
{ "type": "session.listChanged", "data": { "reason": "idle|observed", "sessionId": "...", "unobservedCount": 2 } }
```

## WebSocket Events

### session.listChanged

Unified event for all session list mutations. Client handler: `loadSessions()`.

**Emitted by**:
- `POST /api/sessions` (created)
- `DELETE /api/sessions/:id` (deleted)
- `PATCH /api/sessions/:id` (renamed)
- `UnobservedTracker.markIdle()` (idle)
- `UnobservedTracker.markObserved()` (observed)

**Client behavior**:
- Single event handler calls `loadSessions()` for full re-fetch
- No DOM micromanagement - always consistent with server state

### session.busy

Immediate feedback for busy state changes. Handled separately for cursor animation.

```json
{ "type": "session.busy", "data": { "sessionId": "...", "isBusy": true } }
```

## API Endpoints

### GET /api/sessions

Returns session list with state:

```json
{
  "grouped": {
    "/cwd": [{
      "sessionId": "...",
      "summary": "...",
      "updatedAt": "...",
      "isBusy": false,
      "isUnobserved": true,
      "name": "..."
    }]
  },
  "unobservedCount": 3,
  "models": [...]
}
```

### POST /api/sessions

Create new session with optional description:

```json
{
  "cwd": "/path",
  "model": "claude-sonnet",
  "description": "daily-standup"
}
```

### POST /api/sessions/:id/observe

Mark session as observed. Called by client when:
- `session.idle` arrives while viewing session
- `historyComplete` arrives after switching to session

## Session Meta Schema

```typescript
interface SessionMeta {
  name?: string;           // Custom session name
  lastIdleAt?: string;     // ISO timestamp of last idle
  lastObservedAt?: string; // ISO timestamp of last view
  currentIntent?: string;  // What session is doing (planned)
}
```

## Implementation Files

| File | Purpose |
|------|---------|
| `src/unobserved-tracker.ts` | Single source of truth for unobserved state |
| `src/storage.ts` | `SessionMeta` persistence, `getSessionMeta`/`setSessionMeta` |
| `src/routes/sessions.ts` | Session API endpoints, broadcasts |
| `src/routes/session-messages.ts` | Calls `markIdle()` on `session.idle` |
| `src/session-manager.ts` | Hydrates tracker on init |
| `public/ts/session-panel.ts` | Session list UI, event handling |

## Multi-Client Sync

```
┌─────────────────────────────────────────────────────────────────┐
│                     UnobservedTracker                           │
│  ┌─────────────────┐   ┌─────────────────┐   ┌──────────────┐  │
│  │ Memory: Set<id> │ ← │ markIdle()      │ ← │ session.idle │  │
│  │                 │   │ markObserved()  │   │ /observe API │  │
│  └────────┬────────┘   └────────┬────────┘   └──────────────┘  │
│           │                     │                               │
│           │ persist             │ broadcast                     │
│           ▼                     ▼                               │
│  ┌─────────────────┐   ┌─────────────────────────────────────┐  │
│  │ meta.json files │   │ WebSocket { session.listChanged }   │  │
│  │ (lastIdleAt,    │   │ → All clients call loadSessions()   │  │
│  │  lastObservedAt)│   └─────────────────────────────────────┘  │
│  └─────────────────┘                                            │
└─────────────────────────────────────────────────────────────────┘
```

## Schedule Session Recovery

If a schedule references a deleted session:

1. Schedule tries to POST to `lastRun.sessionId`
2. If 404, calls `createAndExecute(slug, definition)`
3. Creates new session with `description: slug`
4. Saves new sessionId to `last-run.json`
5. Broadcasts `session.listChanged` with reason `created`

No manual intervention needed.

## Testing

Unit tests in `tests/unit/unobserved-tracker.test.ts` (20 tests):
- `markIdle` adds to set, persists, broadcasts
- `markObserved` removes from set, persists, broadcasts
- `getCount` is O(1)
- `hydrate` loads from meta.json on startup
- Idempotent operations (double markIdle, etc.)
