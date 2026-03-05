# backlog

Incomplete, unimplemented, and stretch goals extracted from specs.

---

## incomplete (partially implemented)

---

## unimplemented

### Session auto-cleanup / expiration
Sub-sessions (from `create_caco_session` and swarm) accumulate in the session list. Add an expiration mechanism:
- Sessions with `parentSessionId` could auto-delete after N hours (configurable, default 24h)
- Or: swarm tool deletes its sessions after collecting results
- Or: session panel shows a "clean up sub-sessions" bulk action
- Goal: prevent session list from growing unboundedly with disposable sessions

---

## stretch goals