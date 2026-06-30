# Collaborative UI State Spec

> **Status: abstract protocol description.** This document describes the data-exchange model in protocol-neutral terms (field names like `doc_token`, generic tool names like `ui_get_state`). For the concrete Caco implementation — actual tool names (`caco_*_surface`), HTTP routes (`/api/sessions/:sessionId/surface/...`), storage location, and UI styles — see `session-surface-applet.md`. When the two documents diverge in naming, the implementation spec wins.

## Goals

Define a safe, efficient protocol for a flat document that can be mutated concurrently by an LLM agent and a human, with optimistic locking, bounded change-tracking, and atomic acknowledgment. After this protocol, the agent can read the human's latest edits in one call and commit writes + acknowledgment atomically, with no window for a lost update.

## Design

**Data model:** a flat collection of typed objects with stable IDs (`id` required on every item) and arbitrary fields, plus a `doc_token` (opaque hash of document state including the changes ledger). The `doc_token` is the sole concurrency control — first writer wins; second gets a stale error.

**Changes ledger:** a separate map `changes: { [id]: object }` tracks human-side mutations. Last write wins per id (no matter how much a human fiddles between agent turns, at most one entry per object — bounded by dataset size). Agent writes never touch the ledger.

**MCP tool interface:**
- `ui_get_state()` → `{ doc_token, items: [...] }` — full document; for small datasets or when the agent needs a complete view.
- `ui_get_changes()` → `{ doc_token, changes: { id: object, … } }` — dirty objects only; for delta workflows.
- `ui_mutate_state(token, { create, update, delete })` → applies agent writes and clears the ledger atomically. Returns `{ ok: true, doc_token }` or `{ ok: false, reason: 'stale' }`.
- `ui_clear_changes(token)` → acknowledges human changes without any write; returns `{ ok: true, doc_token }`.

**Human/UI side:** the UI holds `doc_token` in local state. Every human mutation passes it to the server and updates it on success. On stale error: reload + re-apply or surface conflict.

**Turn semantics:**

| Action | Who clears the ledger |
|---|---|
| Agent writes and responds | `ui_mutate_state(token, ...)` — atomic |
| Agent reads but doesn't write | `ui_clear_changes(token)` — explicit ack |
| Agent ignores changes, cares only about state | `ui_get_state()` then `ui_mutate_state(token, ...)` |

The ledger is **never cleared implicitly**. An agent must always acknowledge it before the next human turn can be considered clean.

Concrete Caco implementation: `caco_get_surface`/`caco_get_surface_changes`/`caco_mutate_surface` tools; `GET|PATCH /api/sessions/:sessionId/surface/...` routes. See `session-surface-applet.md` for full implementation details.

## Invariants

- The `doc_token` is required for every mutation — no mutation without the current token.
- Agent writes and ledger clear are atomic in `ui_mutate_state` — no partial commit.
- The ledger is never implicitly cleared; the agent must acknowledge before the next human turn.
- Human-side mutations never touch the agent's committed document; agent writes never touch the ledger.
- Stable IDs are required on every item — they are the identity anchor across all mutations.

## Considerations

- The changes ledger holds the entire current object per id (not just changed fields): last write wins; bounded by dataset size.
- An agent that calls `ui_get_state` still has a valid token for `ui_mutate_state` — both tools return the same `doc_token`.
- The protocol is defined in abstract terms; the concrete Caco implementation (tool names, routes, storage) may differ from the generic names used here.
- There are no sequence numbers; the token is opaque and cannot be guessed or constructed.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Lost update (agent overwrites human edit) | Optimistic locking: stale token → `{ ok: false, reason: 'stale' }`; UI reloads and re-applies. |
| Unbounded ledger growth | Ledger is bounded by dataset size (one entry per id; last write wins). |
| Agent forgets to acknowledge the ledger | Ledger is never implicitly cleared; the next `ui_get_changes` will still show unacknowledged changes. |
| Protocol/implementation naming divergence | Implementation spec (`session-surface-applet.md`) wins on concrete details; this doc is the abstract model only. |

## Acceptance

- Observable: an agent and a human can mutate the same document concurrently; a stale-token error always prevents a lost update; the ledger is cleared exactly once per acknowledgment; `ui_get_state` and `ui_get_changes` both return the same `doc_token`.
- Budgets: n/a.
- Gates: `npm run build` green; `tests/unit/surface-store.test.ts` green.
- Oracles:
  - Concurrent mutations with the same token: second write returns `{ ok: false, reason: 'stale' }` (`surface-store.test.ts`).
  - `ui_mutate_state` clears the ledger atomically with the write (`surface-store.test.ts`).
  - `ui_clear_changes` clears the ledger without modifying items (`surface-store.test.ts`).
  - Both `ui_get_state` and `ui_get_changes` return the same `doc_token` (`surface-store.test.ts`).

## Plan

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 1 | Flat document store with stable IDs + `doc_token` | `src/surface-store.ts` (or equivalent) | CRUD + token generation — `surface-store.test.ts` | Stable IDs required |
| 2 | Changes ledger (human-side only, last-write-wins, bounded) | same | ledger bounded by dataset size; agent writes don't touch it — unit | Ledger never implicitly cleared |
| 3 | `ui_mutate_state`: atomic write + ledger clear | same | stale token → rejected; atomic commit — `surface-store.test.ts` | First-writer wins; atomic |
| 4 | `ui_get_changes` + `ui_clear_changes` | same | delta-only read; ack without write — `surface-store.test.ts` | Explicit ack required |
| 5 | MCP tool wiring (`caco_*_surface`) + HTTP routes | `src/routes/surface.ts`, MCP tool files | by-construction; see `session-surface-applet.md` | - |

## Data Model Reference

```json
{
  "doc_token": "a3f9c2",
  "items": [
    { "id": "t1", "type": "task", "label": "Fix login bug", "priority": 2, "done": false },
    { "id": "t2", "type": "task", "label": "Update docs",   "priority": 1, "done": true  }
  ]
}
```

Changes ledger (human-side only):
```json
{
  "doc_token": "a3f9c2",
  "changes": {
    "t1": { "id": "t1", "type": "task", "label": "Fix login bug", "priority": 3, "done": false }
  }
}
```
