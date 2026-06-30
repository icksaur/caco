# Session List MRU Sort

## Goals

Sessions sort by true last-use time, not SDK `updatedAt`. Frequently-used sessions stay at the top of the session list regardless of how old they are. Order freezes intra-day so the list doesn't shuffle while working; midnight re-sort captures the day's usage. New sessions always prepend above the frozen order.

## Problem

The session list sorts by: unobserved first → kind → `updatedAt`. The SDK's `updatedAt` reflects creation/resume time, not actual usage. Long-lived sessions that are used daily end up buried below newer sessions that were used once.

Unobserved sessions jumping to the top is acceptable — that's useful. The issue is that **frequently-used sessions sink to the bottom** over time because there's no "last actively used" signal driving the sort.

## Design

### Track "last used" per session

When a user sends a message to a session, write a `lastUsedAt` timestamp to the session's Caco metadata (`meta.json`). This is the real MRU signal — it updates every time the user interacts, not when the SDK internally touches the session.

### Snapshot-based MRU

The session list order is determined by a **snapshot** — a sorted array of session IDs stored on disk. The snapshot is computed:
1. **On server startup** — sort all sessions by `lastUsedAt` descending (falling back to `updatedAt`)
2. **At midnight** — re-sort by `lastUsedAt` descending via an internal timer

Between snapshots, the list order is **frozen** except for unobserved badges and new sessions prepending to the top. No broadcast at midnight — next page refresh picks up the new order.

### Snapshot storage

`~/.caco/session-order.json`:
```json
["session-id-1", "session-id-2", "session-id-3"]
```

### Sort behavior

When rendering the session list:
1. Load the snapshot order
2. Sessions in the snapshot render in snapshot order
3. Sessions NOT in the snapshot (newly created) are prepended, sorted by `updatedAt` desc
4. Deleted/archived sessions silently skipped
5. Unobserved sessions get a visual badge but do NOT change position

## Implementation

### Track lastUsedAt

**`src/routes/session-messages.ts`** — In the POST handler, when `source` is falsy (user-initiated message), update the session meta:
```
setSessionMeta(sessionId, { ...meta, lastUsedAt: new Date().toISOString() })
```

This is the only write point — only user messages count as "using" a session. Agent, scheduler, and delegate messages don't update it.

### Internal timer pattern

The schedule manager uses `setInterval` + cron for user-defined scheduled tasks that dispatch to SDK sessions. The MRU snapshot is different — lightweight housekeeping (read sessions, sort, write JSON). No SDK session needed.

Pattern: `setTimeout` to next midnight, then `setInterval(24h)`. Similar to how `session-manager.ts` uses `setInterval` for health checks.

### Backend

**`src/storage.ts`** — Add:
- `getSessionOrder(): string[]` — read `~/.caco/session-order.json`
- `setSessionOrder(ids: string[]): void` — write it

**`src/session-manager.ts`** or new `src/session-order.ts` — Add:
- `computeSessionOrder(): string[]` — list all sessions, sort by `meta.lastUsedAt` desc (fall back to `updatedAt`)
- `snapshotSessionOrder(): void` — compute and write to disk
- Called on `init()` and by the midnight timer

**`src/routes/sessions.ts`** — `GET /api/sessions`:
- Read snapshot order
- Return sessions in snapshot order, with new sessions prepended
- Unobserved-first sort still applies within the ordered list

**`server.ts`** — After `sessionManager.init()`:
- Snapshot the initial order
- Schedule midnight re-snapshot via setTimeout

### Frontend

**`public/ts/ui-utils.ts`** — `sortSessions()` simplified: remove `updatedAt` sort, just preserve server order. Or remove entirely if server returns correct order.

**`public/ts/session-panel.ts`** — Remove client-side sort call if server handles ordering.

## Acceptance

1. On startup, session list is sorted MRU (most recently updated first)
2. Throughout the day, session order does not change as sessions are used
3. New sessions appear at the top of the list
4. At midnight, the list re-sorts to reflect the day's usage
5. Archived/deleted sessions disappear without reordering others
6. Unobserved badge visible but does not cause position change

## Open Questions

All resolved.

## Plan

| # | Step | Files | Oracle |
|---|------|-------|--------|
| 1 | Write lastUsedAt on user message send | `src/routes/session-messages.ts` | by-construction: meta.lastUsedAt updated on user POST |
| 2 | Add getSessionOrder/setSessionOrder to storage | `src/storage.ts` | by-construction |
| 3 | computeSessionOrder + snapshotSessionOrder | `src/session-manager.ts` | by-construction |
| 4 | Apply snapshot order to GET /api/sessions | `src/routes/sessions.ts` | visual: sessions sorted MRU on page load |
| 5 | Simplify or remove client-side sort | `public/ts/ui-utils.ts`, `public/ts/session-panel.ts` | by-construction |
| 6 | Schedule midnight re-sort timer | `server.ts` | by-construction |
