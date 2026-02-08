# Model Query

Query which model a session is using.

## Problem

1. **SDK doesn't expose model** - `CopilotSessionInstance` has no `.model` property
2. **Model can change mid-session** - copilot-cli allows switching models during a session
3. **Agent-to-agent needs model info** - Spawning sessions requires knowing available models and current session's model
4. **Session list should show model** - User wants to see which model each session uses

## Data Sources

### Primary: SDK Events (`.copilot/session-state/<id>/events.jsonl`)

First line contains `session.start` event with `data.selectedModel`:

```json
{"type":"session.start","data":{"sessionId":"...","selectedModel":"gpt-5-mini",...}}
```

**Pros:** Authoritative, always current
**Cons:** Parsing internal SDK files is fragile, format may change

### Fallback: Caco Metadata (`.caco/sessions/<id>/meta.json`)

Cache `model` in our metadata as fallback:

```json
{
  "name": "",
  "model": "gpt-5-mini",
  "modelSyncedAt": "2026-02-08T00:41:43.662Z",
  ...
}
```

**Pros:** Under our control, fast to read
**Cons:** Can drift if user switches model via copilot-cli

## Design

### Resolution Order

1. Try parsing `.copilot/session-state/<id>/events.jsonl` first line
2. If parse fails (file missing, format changed), use `meta.json` cache
3. If cache missing, return `null` (unknown model)

**On parse failure:** Log warning to make SDK format changes visible without breaking.

### Sync Strategy

Single `syncModelCache(sessionId)` function called from:
- **Session created** - Store model from create config
- **Session resumed** - Re-parse SDK events, update if changed

**Session list uses cache only** - No parsing during list for performance. Stale cache is acceptable until session is resumed.

### Schema Update

Extend `SessionMeta` in `src/storage.ts`:

```typescript
interface SessionMeta {
  name: string;
  // ... existing fields
  
  // Model tracking
  model?: string;           // Last known model ID
}
```

Note: `modelSyncedAt` dropped - not surfaced in UI/API, adds no value.

### API Response Update

**GET /api/sessions** - Add `model` to session list items:

```typescript
interface SessionListItem {
  sessionId: string;
  cwd: string | null;
  model: string | null;  // NEW
  // ... rest
}
```

**GET /api/sessions/:id/state** - Include model:

```typescript
{
  "sessionId": "abc123",
  "status": "idle",
  "model": "claude-sonnet-4.5",  // NEW
  "cwd": "/path/to/project"
}
```

## Implementation

### Phase 1: Query Model (~40 lines)

Core functionality: query model for existing sessions.

### New Function: `syncModelCache(sessionId: string, model?: string)`

Single function for all cache updates:

```typescript
// src/session-manager.ts

function syncModelCache(sessionId: string, model?: string): void {
  const resolvedModel = model ?? parseModelFromSDK(sessionId);
  if (resolvedModel) {
    const meta = getSessionMeta(sessionId) ?? { name: '' };
    if (meta.model !== resolvedModel) {
      setSessionMeta(sessionId, { ...meta, model: resolvedModel });
    }
  }
}
```

### `parseModelFromSDK(sessionId: string)`

```typescript
function parseModelFromSDK(sessionId: string): string | null {
  try {
    const eventsPath = join(homedir(), '.copilot', 'session-state', sessionId, 'events.jsonl');
    const firstLine = readFileSync(eventsPath, 'utf8').split('\n')[0];
    const event = JSON.parse(firstLine);
    if (event.type === 'session.start' && event.data?.selectedModel) {
      return event.data.selectedModel;
    }
    console.warn(`[MODEL] Unexpected event format for ${sessionId}`);
  } catch (e) {
    console.warn(`[MODEL] Could not parse SDK events for ${sessionId}: ${e instanceof Error ? e.message : e}`);
  }
  return null;
}
```

### `getSessionModel(sessionId: string)`

```typescript
function getSessionModel(sessionId: string): string | null {
  // Cache-only read (sync happens on create/resume)
  const meta = getSessionMeta(sessionId);
  return meta?.model ?? null;
}
```

### Call Sites

1. **`SessionManager.create()`** - After session created:
   ```typescript
   syncModelCache(session.sessionId, config.model);
   ```

2. **`SessionManager.resume()`** - Re-sync from SDK:
   ```typescript
   syncModelCache(sessionId);  // Parses SDK, updates cache if changed
   ```

---

### Phase 2: Agent Tools (~35 lines)

Add model selection for agent-to-agent spawning. Can be implemented separately.

- `list_models` tool - Returns available models
- `model` param on `create_agent_session` - Required when spawning

## Changes Required

### Phase 1: Code

| File | Change |
|------|--------|
| `src/storage.ts` | Add `model` to `SessionMeta` |
| `src/session-manager.ts` | Add `parseModelFromSDK()`, `syncModelCache()`, `getSessionModel()` |
| `src/session-manager.ts` | Call `syncModelCache()` in `create()` and `resume()` |
| `src/session-manager.ts` | Update `_buildSessionList()` to include model (from cache) |
| `src/routes/sessions.ts` | Include model in state response |

### Phase 2: Code

| File | Change |
|------|--------|
| `src/agent-tools.ts` | Add `list_models` tool |
| `src/agent-tools.ts` | Add `model` param to `create_agent_session` |

### Docs

| File | Change |
|------|--------|
| `doc/agent-to-agent.md` | Already updated with `list_models` and model param |
| `doc/API.md` | Document model field in session responses |

## Decisions

| Question | Decision |
|----------|----------|
| Stale cache on list? | Acceptable. Sync on resume is sufficient. |
| Parse SDK on every list? | No. Cache-only for performance. |
| `modelSyncedAt` field? | Dropped. Not useful without UI surface. |
| Lazy sync on list? | No. Committed to cache-only. |

## Complexity

### Phase 1
| Component | Lines |
|-----------|-------|
| `SessionMeta.model` | 1 |
| `parseModelFromSDK()` | 15 |
| `syncModelCache()` | 8 |
| `getSessionModel()` | 4 |
| Call sites in create/resume | 2 |
| Session list item update | 5 |
| State response update | 3 |
| **Phase 1 Total** | ~38 |

### Phase 2
| Component | Lines |
|-----------|-------|
| `list_models` tool | 20 |
| `create_agent_session` model param | 10 |
| **Phase 2 Total** | ~30 |
