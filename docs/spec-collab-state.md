# Collaborative UI State Spec

> **Status: abstract protocol description.**
>
> This document describes the data-exchange model in protocol-neutral terms (field names like `doc_token`, generic tool names like `ui_get_state`). For the concrete Caco implementation — actual tool names (`caco_*_surface`), HTTP routes (`/api/sessions/:sessionId/surface/...`), storage location, and UI styles — see [`session-surface-applet.md`](./session-surface-applet.md). When the two documents diverge in naming, the implementation spec wins.

## Overview

A scheme for structured data that can be mutated in turn by an LLM agent and a human, with safe concurrent access and efficient change tracking.

---

## Data Model

The document is a flat collection of typed objects, each with a stable ID and arbitrary fields:

```json
{
  "doc_token": "a3f9c2",
  "items": [
    { "id": "t1", "type": "task", "label": "Fix login bug", "priority": 2, "done": false },
    { "id": "t2", "type": "task", "label": "Update docs",   "priority": 1, "done": true  }
  ]
}
```

**Stable IDs** are required on every item. They are the identity anchor across all mutations and allow both parties to reason about specific objects without positional ambiguity.

---

## Change Tracking

A separate **changes ledger** tracks human-side mutations as a set (map) of dirty objects, keyed by ID. The value is the entire current object, not just the changed fields. Last write wins; no matter how much a human fiddles between agent turns, there is at most one entry per object — the ledger is bounded by dataset size.

```json
{
  "doc_token": "a3f9c2",
  "changes": {
    "t1": { "id": "t1", "type": "task", "label": "Fix login bug", "priority": 3, "done": false },
    "t2": { "id": "t2", "type": "task", "label": "Update docs",   "priority": 1, "done": true  }
  }
}
```

The ledger is the **human's side of the ledger only**. Agent writes do not touch it.

---

## Optimistic Locking

A single `doc_token` — a hash of the full document state including the changes ledger — governs concurrent access for both parties. Every mutation, human or agent, requires the current token and produces a new one. First writer wins; second gets a stale error.

This prevents either party from overwriting the other's changes. There are no sequence numbers; the token is opaque and cannot be guessed or constructed.

---

## MCP Tool Interface

### `ui_get_state()`
Returns the full document. Use for small datasets or when the agent needs a complete view.
```json
{ "doc_token": "a3f9c2", "items": [ ... ] }
```

### `ui_get_changes()`
Returns only the dirty objects since the last clear. Use for large datasets or delta-only workflows.
```json
{ "doc_token": "a3f9c2", "changes": { "t1": { ... }, "t2": { ... } } }
```

Both tools return the same `doc_token`. An agent that calls `ui_get_state` still has a valid token to commit with.

### `ui_mutate_state(token, { create, update, delete })`
Applies agent writes and clears the ledger atomically. Requires the current `doc_token`. Returns a new token on success, or a stale error if the human wrote in the meantime.
```json
// Request
{ "token": "a3f9c2", "create": [...], "update": [...], "delete": ["t3"] }

// Success
{ "ok": true, "doc_token": "b71e44" }

// Stale
{ "ok": false, "reason": "stale" }
```

### `ui_clear_changes(token)`
Acknowledges the human's changes and clears the ledger without making any writes. Used when the agent reads changes and decides no structural mutation is needed. Also requires the current `doc_token`.
```json
{ "ok": true, "doc_token": "b71e44" }
```

---

## Human / UI Side

The UI holds `doc_token` in local state. Every human mutation passes it to the server and updates it on success. On a stale error, the UI reloads state and re-applies or surfaces a conflict.

```
POST /ui/mutate  { "token": "a3f9c2", "update": { "id": "t1", "priority": 3 } }
→ { "ok": true, "doc_token": "b71e44" }
→ { "ok": false, "reason": "stale" }
```

---

## Turn Semantics

| Action | Who clears the ledger |
|---|---|
| Agent writes and responds | `ui_mutate_state(token, ...)` — atomic |
| Agent reads but doesn't write | `ui_clear_changes(token)` — explicit ack |
| Agent ignores changes, cares only about state | `ui_get_state()` then `ui_mutate_state(token, ...)` |

The ledger is never cleared implicitly. An agent must always acknowledge it before the next human turn can be considered clean.
