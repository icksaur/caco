# Session Search

## Goals

Search full text across all session conversation histories. Find which session discussed a topic, file, error message, or concept — useful when juggling 20+ sessions.

## Current State

- ~25-40 visible sessions in the session panel (managed by `sessionManager.list()`)
- Event format: JSONL in `~/.copilot/session-state/<id>/events.jsonl`, one JSON object per line
- Searchable text in `data.content` for `user.message` and `assistant.message` events
- **No SDK search API** — `CopilotClient` has metadata filtering only (cwd, branch), no text search
- **No existing search** in Caco
- `sdk-session-store.ts` already reads events.jsonl via `readSessionEvents()` — the persistence layer for SDK data

## Design

### Approach: On-demand grep with optional nightly index

**Phase 1 (MVP):** Direct disk search via `grep` on events.jsonl files. No index. For 489 sessions / 265MB, `grep -l` across all files completes in ~1-3 seconds on SSD. This is fast enough for on-enter search.

**Phase 2 (if needed):** Nightly index build — extract text from message events into a search-friendly format (one file per session with just message text). Faster for repeated searches and enables ranking by relevance.

### Search endpoint

`GET /api/sessions/search?q=<query>`

Server-side search (not client-side) — the client can't access events.jsonl.

Implementation:
1. List sessions from `sessionManager.list()` — same set visible in the session panel (not raw SDK directory scan)
2. For each session, read events.jsonl line by line (streaming)
3. Match `user.message` and `assistant.message` events containing the query string (case-insensitive) in `data.content`
4. Extract: session ID, matching snippet (±40 chars around match), event type, timestamp
5. Return results grouped by session with match count and snippets (max 5 per session)
6. Archived sessions excluded (they're not in sessionManager's cache)

### Result ranking

Results sorted by:
1. **Match count** (more matches = more relevant) — descending
2. **Recency** — `lastUsedAt` from meta.json, then `updatedAt` from workspace.yaml

### Applet: `session-search`

```
[ Search input                    ] [🔍 Search]

  Session: "🌐 Mesh" (3 matches)
  caco-session:29b12eaa...
  > "...the vertex buffer overflow was caused by..."
  > "...tried increasing VERTEX_BUFFER_SIZE to 4096..."
  > "...fixed by pre-allocating the buffer in init()..."

  Session: "Caco Development" (1 match)
  caco-session:400c723d...
  > "...added buffer overflow detection in dispatch..."
```

Each result:
- Session name or ID (clickable → switches to that session)
- `caco-session:UUID` (for copy/paste into messages)
- Up to 5 matching snippets with ±40 chars context, match highlighted
- Match count

### Keyboard shortcut

**Ctrl+Shift+F** — global, opens session-search applet. Handled in `input-router.ts` alongside Ctrl+P.

## Implementation

### Backend

**`src/routes/sessions.ts`** — New endpoint:
```
GET /api/sessions/search?q=<query>&limit=20
```

For each session in `~/.copilot/session-state/`:
- Read events.jsonl line by line (streaming, not full load)
- Match lines containing query (case-insensitive)
- Extract `data.content` from matched `user.message` / `assistant.message` events
- Return top N sessions with snippets

### Frontend

**`applets/session-search/`** — New applet:
- Search input + button
- Enter key triggers search
- Results rendered as session cards with snippets
- Session name links to `/?session=<id>` to switch
- `caco-session:UUID` copyable

**`public/ts/input-router.ts`** — Add Ctrl+Shift+F handler:
```typescript
if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'F') {
  e.preventDefault();
  window.location.href = '/?applet=session-search';
  return;
}
```

### API documentation

Add to API.md.

## Considerations

### Do we need a search index?

**No.** Searching ~25-40 active sessions (not 489 raw SDK sessions) is fast enough with streaming readline. Total data for visible sessions is likely 20-50MB — well under a second on SSD.

### Evicting archived sessions

Archived sessions are removed from `sessionManager`'s cache, so they're automatically excluded from the session list used by search. No explicit eviction needed.

### Ranking

Simple ranking is sufficient:
- **Match count per session** — primary sort (more matches = more relevant)
- **Recency** (`lastUsedAt`) — secondary sort (recent sessions rank higher for same match count)

No TF-IDF, BM25, or fuzzy matching needed. Exact substring match covers the "where did I discuss X" use case.

### Performance

- **~25-40 sessions, ~20-50MB:** Sub-second on SSD
- **Streaming:** readline processes line-by-line, never loads full file into memory
- **Short-circuit:** Stop processing a session after finding 5 snippets
- **Only message events:** Skip non-message lines by checking `type` field before parsing full JSON

## Open Questions

All resolved:
1. **Search scope:** User/assistant messages only. No tool output.
2. **Snippet length:** ±40 chars around match.
3. **No-name sessions:** Session ID is fine — matching text provides context.
4. **Search history:** Not needed.
5. **Session set:** Only sessions in sessionManager cache (same as session panel). Not raw SDK directory.

## Acceptance

- Observable: Ctrl+Shift+F opens the `session-search` applet. Type a query → sessions with matching text appear as cards with ≤5 snippets each (±40 chars context). Click a result → switches to that session.
- Budgets: ≤3 s for a 40-session workspace on SSD. Sub-second typical.
- Gates: `npm run build`, `npm test` green.
- Oracles: `tests/unit/session-search.test.ts` — endpoint returns sessions with match count, snippets, and correct session ID; empty query returns empty results.

## Plan

| # | Step | Files | Oracle |
|---|------|-------|--------|
| 1 | Search endpoint (readline streaming, message events only) | `src/routes/sessions.ts` | `tests/unit/session-search.test.ts` |
| 2 | session-search applet (input, results, session cards) | `applets/session-search/meta.json`, `content.html`, `script.js`, `style.css` | visual: results render, click switches session |
| 3 | Ctrl+Shift+F keyboard shortcut | `public/ts/input-router.ts` | visual: shortcut opens applet |
| 4 | Document endpoint | `docs/API.md` | by-construction |
