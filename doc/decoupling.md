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

| Current | Used | Required | Stateful | Stateless Equiv |
|---------|------|----------|----------|-----------------|
| `POST /message` | ✓ | ✓ send msg | writes pending map + applet state | `POST /sessions/:id/messages` |
| `GET /stream/:streamId` | ✓ | ✓ SSE stream | writes session singleton | keep streamId, add sessionId |

**Notes:**
- `/message` creates session lazily via `ensureSession(model, newChat, cwd)`.
- Stateless equiv: client provides `sessionId` explicitly, server doesn't track "active" session.

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

**Dead code (1):** `POST /sessions/new` — delete

**Needs sessionId param (4):**
- `GET /session` → `GET /sessions/:id`
- `GET /history` → `GET /sessions/:id/history`
- `GET /preferences` → `GET /sessions/:id/preferences`  
- `PUT /preferences` → `PUT /sessions/:id/preferences`

**Needs clientId scope for multi-client (3):**
- `POST /sessions/:id/resume`
- `POST /message` + `GET /stream/:streamId`
- `GET/POST /applet/state`

---

## Next Steps

1. Delete `POST /sessions/new`
2. Add `?sessionId=` param to `/history`, `/preferences`
3. Plan clientId for multi-client support
