# Endpoint Decoupling Analysis

## Key Questions

For each endpoint we ask:
1. **Used?** - Is there a client caller? (grep verified)
2. **Required?** - Is the functionality necessary?
3. **Stateful?** - Does it read/write server singletons?
4. **Stateless equiv?** - RESTful route if redesigned

**Target stateless pattern:**
```
GET    /sessions           → list all
GET    /sessions/:id       → get one  
POST   /sessions           → create new
POST   /sessions/:id/messages → send message
DELETE /sessions/:id       → delete
```

---

## Session Routes

| Current | Used | Required | Stateful | Stateless Equiv | Status |
|---------|------|----------|----------|-----------------|--------|
| `GET /session` | ✓ | ✓ | ~~singleton~~ | `?sessionId=` param | ✅ Done |
| `GET /sessions` | ✓ | ✓ | reads only | ✓ already stateless | ✅ Done |
| `POST /sessions/new` | ✗ | ✗ | — | — | ✅ Deleted |
| `POST /sessions/:id/resume` | ✓ | ✓ | ~~singleton~~ | X-Client-ID header | ✅ Done |
| `DELETE /sessions/:id` | ✓ | ✓ | ~~singleton~~ | X-Client-ID header | ✅ Done |

**Notes:**
- `POST /sessions/new` deleted (zero client callers, verified via grep)
- `GET /session` now accepts `?sessionId=` for stateless queries
- Resume/delete now accept `X-Client-ID` header for multi-client isolation

---

## Streaming Routes

| Current | Used | Required | Stateful | Stateless Equiv | Status |
|---------|------|----------|----------|-----------------|--------|
| `POST /sessions` | ✓ | ✓ | none | ✓ RESTful create | ✅ Done |
| `POST /sessions/:id/messages` | ✓ | ✓ | none | ✓ RESTful | ✅ Done |
| `POST /message` | ✓ | compat | ~~singleton~~ | ↑ use above | ⚠️ Deprecated |
| `GET /stream/:streamId` | ✓ | ✓ | ~~singleton~~ | clientId in pending msg | ✅ Done |

**Notes:**
- **NEW:** `POST /sessions` creates session explicitly, returns `{ sessionId, cwd }`
- **NEW:** `POST /sessions/:id/messages` sends message to session, returns `{ streamId, sessionId }`
- `POST /message` kept for backward compatibility, but deprecated
- `GET /stream/:streamId` passes clientId/sessionId for isolation
- Client now uses RESTful flow: create session → send messages to session

---

## Applet Routes

| Current | Used | Required | Stateful | Stateless Equiv |
|---------|------|----------|----------|-----------------|
| `GET /applets` | ✓ | ✓ list applets | disk only | ✓ already stateless |
| `GET /applet/state` | ✓ | ✓ get rendered + user state | reads singleton | `GET /applets/:slug/state?sessionId=` |
| `POST /applet/state` | ✓ | ✓ save user state | writes singleton | `PUT /applets/:slug/state` |
| `PUT /applet/reload` | ✓ | ✓ trigger reload | writes flag | `POST /applets/:slug/reload` |

**Notes:**
- All state is in module-level `let` variables (no client isolation).
- Stateless design: state keyed by `(sessionId, appletSlug)`.

---

## Output/History Routes

| Current | Used | Required | Stateful | Stateless Equiv |
|---------|------|----------|----------|-----------------|
| `GET /outputs/:id` | ✓ | ✓ get output | disk only | ✓ already stateless |
| `GET /history` | ✓ | ✓ chat history | reads active session | `GET /sessions/:id/history` |

**Notes:**
- `/history` should take `sessionId` param instead of reading singleton.

---

## File Routes

| Current | Used | Required | Stateful | Stateless Equiv |
|---------|------|----------|----------|-----------------|
| `GET /file` | ✓ | ✓ read file | disk only | ✓ already stateless |
| `GET /files` | ✓ | ✓ list dir | disk only | ✓ already stateless |

---

## Preference/Model Routes

| Current | Used | Required | Stateful | Stateless Equiv |
|---------|------|----------|----------|-----------------|
| `GET /models` | ✓ | ✓ list models | none | ✓ already stateless |
| `GET /preferences` | ✓ | ✓ get prefs | reads singleton | `GET /sessions/:id/preferences` |
| `PUT /preferences` | ✓ | ✓ save prefs | writes singleton + disk | `PUT /sessions/:id/preferences` |

---

## Summary

**Already stateless (5):** `/sessions`, `/applets`, `/outputs/:id`, `/file`, `/files`, `/models`

**Completed (session + streaming):**
- `POST /sessions` — create session (RESTful) ✅
- `POST /sessions/:id/messages` — send message to session (RESTful) ✅
- `GET /session?sessionId=` — stateless query ✅
- `POST /sessions/:id/resume` — with X-Client-ID ✅
- `DELETE /sessions/:id` — with X-Client-ID ✅
- `GET /stream/:streamId` — uses sessionId from pending message ✅

**Deprecated:** `POST /message` — kept for backward compat, client migrated to RESTful

**Needs work:**
- `GET /history` → `GET /sessions/:id/history`
- `GET /preferences` → `GET /sessions/:id/preferences`
- `PUT /preferences` → `PUT /sessions/:id/preferences`
- `GET/POST /applet/state` → keyed by sessionId

---

## Completed Changes

### Session State Refactor (commit f0697a2)
- `_activeSessionId` → `_clientSessions: Map<string, string | null>`
- `_pendingResumeId` → `_clientPendingResume: Map<string, string | null>`
- All lifecycle methods accept optional `clientId` param
- `DEFAULT_CLIENT = 'default'` fallback for backward compat

### Session Routes (commit cebe843)
- Deleted `POST /sessions/new` (dead code)
- `GET /session` accepts `?sessionId=` param
- Resume/delete accept `X-Client-ID` header

### RESTful API (commit b19ae75)
- `POST /sessions` — create new session
- `POST /sessions/:id/messages` — send message to specific session
- Client updated to use RESTful flow
- 15 integration tests passing
