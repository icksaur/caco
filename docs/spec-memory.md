# Persistent Memory

## Goals

Cross-session key-value memory that persists user preferences, project context, and learned facts. Agents can safely add/update/remove individual entries without needing context about other entries.

## Storage

`~/.caco/memory.json` — JSON object, key-value pairs.

```json
{
  "preferred-language": "TypeScript, functional style",
  "git-commits": "Facts only, no attribution trailers, no verbose explanations",
  "caco-repo": "~/repo/caco — self-extensible Copilot frontend",
  "no-emoji": "Do not use emoji in responses"
}
```

Keys: slug format (lowercase, numbers, hyphens). Validated on write — reject non-slug keys.
Values: short strings, one fact per key. No length limit but conciseness is encouraged.
Capacity: 50 entries max. Hard-enforced on write.

## Tools

### `caco_memory`

One tool with an explicit `action` parameter (`read` | `set` | `delete`).

Parameters:
- `action` (enum, required) — `read`, `set`, or `delete`
- `key` (string) — slug format; required for `set`/`delete`
- `value` (string) — the fact to store; required for `set`

`action="read"` returns all entries + capacity (no mutation):

```json
{
  "entries": {
    "preferred-language": "TypeScript, functional style",
    "git-commits": "Facts only, no attribution"
  },
  "count": 2,
  "capacity": 50
}
```

`action="set"` / `action="delete"` return `{ ok: true, count: N, capacity: 50 }` or an error.
The explicit action means `read` can never delete (unlike arg-presence overloading).

Errors:
- Invalid key format (not slug)
- At capacity (50) when adding a new key (updating existing keys always succeeds)

## Injection

### New sessions

`buildSystemMessage()` reads `~/.caco/memory.json` and appends a `## User Memory` section listing all entries as `- **key**: value` bullet points.

### Resumed sessions

`resumeSession()` passes `systemMessage: { mode: 'append', content }` with memory contents. The SDK's `ResumeSessionConfig` accepts this field — the local interface needs updating to include it.

### Format in prompt

```
## User Memory
- **preferred-language**: TypeScript, functional style
- **git-commits**: Facts only, no attribution trailers
```

At 50 entries averaging 60 chars each, this is roughly 500 tokens. Well within budget.

## System prompt section

```
## Memory
Persistent key-value memory across all sessions via `caco_memory` (action: read | set | delete).
Keys are slugs (lowercase, hyphens, numbers). One concise fact per key.
When the user says "remember", "forget", "always", or "never" about a preference, update memory.
Memory is loaded into your context at session start. Use `caco_memory` action="read" for the latest version if memory may have changed since session start.
```

## Design

### Step 1: Memory tool

`src/memory-tool.ts`:
- `caco_memory` with `action` enum: `read` returns entries + count + capacity; `set` validates slug key and stores; `delete` removes a key. Enforces capacity on set.
- Handle ENOENT (first-time user) — return empty entries
- Write backup to `memory.json.bak` before overwriting

Wire into `server.ts` toolFactory.

### Step 2: Prompt injection

`src/prompts.ts`: read memory, format as bullet list, append to system message.
`src/session-manager.ts`: update local `ResumeSessionConfig` interface, pass `systemMessage: { mode: 'append', content }` at both resume call sites.

### Step 3: Build, test, acceptance

Unit tests: get/set/delete/capacity/invalid-key/ENOENT.
Manual: "remember I prefer TypeScript" → check memory.json → new session → agent knows.

### Step 4: Memories applet (view + remove)

A bundled applet `memories` that lets the **user** inspect and delete memory entries —
today the only way to remove a memory is to ask an agent to call `caco_memory` with
`action="delete"`, and there is no way to see what is stored without a live agent turn.
The applet is the human-facing manager for the same `~/.caco/memory.json` the tool owns.

**HTTP surface (new, thin).** The memory store logic lives in `src/memory-tool.ts` but is
not currently reachable over HTTP. Add a small router `src/routes/memory.ts`, backed by
functions exported from `src/memory-tool.ts` (extract/export `readMemory`, `writeMemory`,
the `SLUG_RE` validation, and `MAX_ENTRIES` — the tool handler and the routes then share ONE
implementation, never two). Follow the existing route pattern: the router declares sub-paths
and is mounted at `/api` in `server.ts` (repo root, NOT `src/server.ts`) via
`src/routes/index.ts`, exactly like `scheduleRoutes` (which declares `/schedule` and mounts
at `/api`). Concretely the router declares:
- `GET /memory` → `{ entries: Record<string,string>, count, capacity }` (→ `/api/memory`;
  same shape as the tool's `action="read"`).
- `DELETE /memory/:key` → validate the slug FIRST (before any store access); on an invalid
  slug return HTTP 400 `{ error }` and leave the store untouched; otherwise delete if present
  and return `{ ok: true, deleted?: key, notFound?: key, entries, count, capacity }`
  (→ `/api/memory/:key`). A missing key is a successful no-op (mirrors the tool's delete
  semantics), not a 404.

**DELETE returns the fresh store.** The `DELETE` response includes the full post-delete
`entries` map (not just `count`), so the applet re-renders directly from the response with no
follow-up `GET` and no optimistic mutation. `GET` and `DELETE` therefore return the same
`entries`-bearing shape.

The applet is **view + delete only**. Creating/editing memories stays an agent concern
(the agent curates one concise fact per key); the applet is for the user to see and prune.
No `set`/`PUT` endpoint in this slice.

**Applet package** `applets/memories/` (bundled, served via `BUNDLED_APPLET_DIR` — no
registration needed), opened at `/?applet=memories`. Files:
- `meta.json` — exact shape (mirrors the other bundled applets, e.g. `mcp-servers`):
  ```json
  {
    "slug": "memories",
    "name": "Memories",
    "description": "View and remove persistent cross-session memory entries",
    "params": {},
    "createdAt": "<ISO>",
    "updatedAt": "<ISO>",
    "agentUsage": { "purpose": "User views and prunes persistent memory entries" },
    "stateSchema": { "get": { "count": "number" }, "set": null }
  }
  ```
- `content.html` (no `<html>`/`<body>` wrapper; loading/empty/error containers like the jobs applet), `script.js`, `style.css`.

On load it `GET /api/memory`, renders each entry as a row — monospace key (`--font-mono`),
value below/beside in secondary text — with a delete control per row. Delete asks for
confirmation (`confirm()`), calls `DELETE /api/memory/:key` with the key URL-encoded, and
re-renders the list from the response's `entries` (no optimistic mutation). Empty state when
`count === 0`; loading state while fetching; error state on fetch/DELETE failure (mirror the
jobs applet's loading/empty/error pattern). Cancelling the confirm makes no request.

**Style (spec-style).** Consume semantic tokens ONLY — `--color-text` (bright key),
`--color-text-muted` (value/secondary), `--color-border` hairlines between rows,
`--color-bg-hover` on row hover, `--color-danger`/`--color-error` for the delete control,
`--space-*`/`--radius-*`/`--font-{sans,mono}`. No raw palette vars (`--text`, `--red`), no
hardcoded hex, no `var(--x, #hex)` fallbacks (spec-style invariants). Density and hierarchy
match the session-list/jobs baseline: one bright title level, secondary dimmed, hairline
grouping — not boxes-within-boxes.

## Risks and Mitigations

1. **Resume systemMessage append** — SDK accepts it in types but untested in Caco. Verify empirically. Fallback: agent calls `caco_get_memory` manually.
2. **Concurrent writes** — two agents writing different keys simultaneously could race on file read-write. Low probability (memory writes are rare). Mitigated by backup file.
3. **Agent key collisions** — different agents may use different keys for the same concept. Acceptable — 50 slots is enough headroom, and agents seeing existing keys via `caco_get_memory` naturally avoids duplicates.
4. **Applet/tool divergence (INVARIANT)** — the applet's HTTP routes and the `caco_memory` tool MUST NOT implement memory logic twice (read/write/slug/capacity), or they will drift (e.g. one validates keys, the other doesn't). Both consume the SAME exported functions from `src/memory-tool.ts`; `src/routes/memory.ts` is a thin adapter with zero re-implemented store logic. A future change that adds store logic to the route instead of the tool module violates this invariant.
5. **Untrusted `:key` param** — the delete key arrives from the URL. Validate it against `SLUG_RE` BEFORE any file/store access; a non-slug key is rejected 400 and never reaches `writeMemory`. Since the store is a flat JSON object keyed by validated slugs (no path/filename derived from the key), this also forecloses path-traversal by construction.
6. **Accidental deletion** — the applet deletes real cross-session state with no undo beyond `memory.json.bak`. Per-row delete confirmation; the delete re-renders from the server's returned `entries` so the UI always reflects the true store; no bulk "clear all".
7. **Applet reads stale state** — the applet is a snapshot at load; an agent may mutate memory concurrently. Every response (GET and DELETE) returns fresh `entries` + `{count, capacity}`; a manual refresh re-fetches. Live push is out of scope.

## Acceptance

- Observable (tool): Agent says "remember I prefer TypeScript" → `~/.caco/memory.json` updated → new session → agent mentions the preference without being told. `caco_memory` action=read returns all entries + count + capacity.
- Observable (applet, needs signoff): opening `/?applet=memories` lists all stored entries with keys + values; deleting a row (with confirmation) removes it from `~/.caco/memory.json` and the row disappears (list re-rendered from the DELETE response's `entries`); cancelling the confirm makes no request; the empty state shows when the last entry is removed; a fetch/DELETE failure shows the error state. Recolors correctly under one light + one dark theme (spec-style).
- Budgets: ≤50 entries. Prompt overhead ~500 tokens at capacity.
- Gates: `npm run build`, `npm test` green.
- Oracles: `tests/unit/memory-tool.test.ts` — read/set/delete/capacity enforcement/invalid-key/ENOENT paths. `tests/unit/memory-routes.test.ts` — tests the exported route-backing handlers (not `readMemory`/`writeMemory` directly): `GET` returns `{entries,count,capacity}`; `DELETE` of an existing key removes it and returns the fresh `entries` without it; `DELETE` of a missing key is a no-op returning `ok:true`+`notFound`; `DELETE` of an invalid slug returns 400 and leaves the store unchanged. Applet behavior (loading/empty/error, confirm cancel = no request, successful-delete refresh, DELETE URL encoding) is covered by the manual signoff checklist in the applet observable above.

## Plan

| # | Step | Files | Oracle |
|---|------|-------|--------|
| 1 | Memory tool (read/set/delete + capacity + slug validation) | `src/memory-tool.ts` | `tests/unit/memory-tool.test.ts` |
| 2 | Wire into server toolFactory | `server.ts` | by-construction |
| 3 | Inject memory into new-session system message | `src/prompts.ts` | manual: new session sees `## User Memory` section |
| 4 | Inject memory on session resume | `src/session-manager.ts` | manual: resumed session sees injected memory |
| 5 | Export `readMemory`/`writeMemory`/`SLUG_RE`/`MAX_ENTRIES` from the tool; add `src/routes/memory.ts` (router declares `GET /memory`, `DELETE /memory/:key`; slug-validate before store access; DELETE returns fresh `entries`) consuming them; export from `src/routes/index.ts`; mount `app.use('/api', memoryRoutes)` in `server.ts` | `src/memory-tool.ts`, `src/routes/memory.ts`, `src/routes/index.ts`, `server.ts` | `tests/unit/memory-routes.test.ts`: GET `{entries,count,capacity}` shape; DELETE existing→removed+fresh entries; DELETE missing→no-op `notFound`; DELETE invalid slug→400 + store unchanged (via the exported route handlers) |
| 6 | `memories` applet: `meta.json` (shape above), list entries, per-row confirm-delete re-rendering from the DELETE response, loading/empty/error states | `applets/memories/{meta.json,content.html,script.js,style.css}` | manual signoff checklist (applet observable): list renders; delete+confirm removes row; confirm-cancel = no request; empty state; error state; recolors under 2 themes (1 light, 1 dark) |
