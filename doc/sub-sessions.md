# Sub-Sessions: Agent-Dispatched Session Tracking

## Problem

When a Caco agent dispatches work to child sessions via `create_caco_session`, those child sessions go through the normal unobserved lifecycle: they complete, get marked idle, appear in the unobserved badge count, and demand the user's attention. But the user didn't create them — the parent agent did. The parent agent is responsible for observing their results. These sub-sessions are polluting the unobserved UI.

## Goal

Sessions created by agents via `create_caco_session` should be marked as **sub-sessions** of their parent. Sub-sessions should **not** increment the unobserved badge or appear as needing attention. The dispatching agent is responsible for monitoring them.

## Current Architecture

### Session Creation Flow
1. Agent calls `create_caco_session` tool → `POST /api/sessions` → new session created
2. Agent sends initial message → `POST /api/sessions/:id/messages` with `{ fromSession, correlationId }`
3. Child session works autonomously
4. Child goes idle → `unobservedTracker.markIdle()` → badge increments → user distracted

### Existing Correlation Infrastructure
- `correlationId` — UUID tracking a request chain across sessions (for runaway protection)
- `fromSession` — the session ID that sent an agent-to-agent message
- `source: 'agent'` — message source field distinguishing agent vs user messages
- `dispatchState` — tracks active dispatches with `{ sessionId, correlationId }`

### Key Files
| File | Role |
|------|------|
| `src/agent-tools.ts` | `create_caco_session`, `send_caco_message` tools |
| `src/unobserved-tracker.ts` | Tracks which sessions need user attention |
| `src/storage.ts` | `SessionMeta` interface, persisted to meta.json |
| `src/routes/session-messages.ts` | Message dispatch, correlationId handling |
| `src/routes/sessions.ts` | `POST /api/sessions` creation endpoint |

## Design

### Approach: `parentSessionId` on SessionMeta

Add `parentSessionId?: string` to `SessionMeta`. When `create_caco_session` creates a session, it passes `parentSessionId` to the creation endpoint. The unobserved tracker skips sessions that have a parent.

### Changes

#### 1. `SessionMeta` — add field (`src/storage.ts`)
```typescript
export interface SessionMeta {
  name: string;
  parentSessionId?: string;  // Set when created by another session via create_caco_session
  // ... existing fields
}
```

#### 2. `POST /api/sessions` — accept `parentSessionId` (`src/routes/sessions.ts`)
The creation endpoint accepts an optional `parentSessionId` in the body and persists it to meta.

#### 3. `create_caco_session` — pass parent ID (`src/agent-tools.ts`)
```typescript
body: JSON.stringify({ cwd, model, parentSessionId: sessionRef.id })
```

#### 4. `unobservedTracker.markIdle()` — skip sub-sessions (`src/unobserved-tracker.ts`)
Before adding to the unobserved set, check `meta.parentSessionId`. If set, skip.

```typescript
markIdle(sessionId: string): boolean {
  const meta = getSessionMeta(sessionId) ?? { name: '' };
  meta.lastIdleAt = new Date().toISOString();
  setSessionMeta(sessionId, meta);
  
  // Sub-sessions don't become unobserved — parent agent observes them
  if (meta.parentSessionId) {
    console.log(`[UNOBSERVED] markIdle: ${sessionId.slice(0, 8)} (sub-session, skipping)`);
    return false;
  }
  // ... existing logic
}
```

Also update `hydrate()` with the same check so sub-sessions don't reappear after restart.

### What does NOT change
- `correlationId` — unchanged, still used for runaway protection
- `send_caco_message` — doesn't need `parentSessionId` (only creation marks parentage)
- Frontend session list — sub-sessions still appear in the list, they just don't trigger the unobserved badge
- `POST /sessions/:id/observe` — still works if user manually opens a sub-session

## Implementation Plan

1. Add `parentSessionId` to `SessionMeta` in `src/storage.ts`
2. Accept `parentSessionId` in `POST /api/sessions` in `src/routes/sessions.ts`
3. Pass `sessionRef.id` as `parentSessionId` in `create_caco_session` tool in `src/agent-tools.ts`
4. Skip sub-sessions in `markIdle()` and `hydrate()` in `src/unobserved-tracker.ts`
5. Add unit tests for sub-session unobserved behavior

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| User creates sessions via API with `parentSessionId` spoofed | Low concern — personal software, user controls all inputs |
| Sub-session hangs and user never notices | Sessions still appear in list; user can browse and observe manually |
| Breaking change to meta.json format | `parentSessionId` is optional, old sessions unaffected |
