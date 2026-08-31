# Increment 5 (cf-reload) — implementation plan

The original bug's operator-facing fix (spec-enable-tools-config-freshness D1/F1): after
editing MCP config, a WARM session must be able to observe the new config WITHOUT a full
server restart — via an EXPLICIT operator action (never a silent auto-watch of warm
sessions, C4). New/cold sessions already pick up config on create/resume. Constraint on
this box: typecheck + unit tests only (no build/restart).

## What "reload" must do (D1)
1. **Transactional (SHOULD).** Re-read `~/.copilot/mcp-config.json`. A malformed /
   partially-written file must FAIL the reload as a NO-OP and retain every warm session's
   prior config — never recreate a session with zero MCP servers. `loadMcpServers`
   currently catches+returns `undefined`, which is INDISTINGUISHABLE from "no config file"
   — so the reload needs a STRICT loader that separates parse-failure from absent-config.
2. **Drop the SDK runtime's in-memory config cache** so its OWN discovery
   (`enableConfigDiscovery` project/plugin MCP configs, which Caco does NOT pass
   explicitly) observes disk on the next session build: `session.rpc.mcp.config.reload()`
   (SDK rpc.d.ts:15891-15894; process-wide, so calling it via any one active session's rpc
   suffices).
3. **Warm-recreate each active session** via the established disconnect → `resume(…,
   { warmRecreate:true })` path, which re-reads `loadMcpServers()` (session-manager.ts:1122,
   1148) and rebuilds the SDK session with the fresh `mcpServers` map + fresh SDK discovery.
   Re-passes `ActiveSession.excludedTools` so the session's defer state is preserved. Busts
   that session's prompt cache once — acceptable because it is operator-EXPLICIT.

Registry pruning is NOT part of this increment (spec: pruning is the operator "forget
unknown tools" purge from increment 2, never automatic on reload — an automatic age/absence
sweep would over-hide).

## New: strict loader in `mcp-config-loader.ts`
```ts
// Returns { ok:true, servers } on a clean read (servers undefined = no file / empty),
// { ok:false, error } ONLY on a parse/read error (the transactional-reload gate).
export async function loadMcpServersStrict():
  Promise<{ ok: true; servers: Record<string, unknown> | undefined } | { ok: false; error: string }>
```
Extract the existing try body: `existsSync` false ⇒ `{ ok:true, servers:undefined }`;
`JSON.parse` throw ⇒ `{ ok:false, error }`; empty `mcpServers` ⇒ `{ ok:true,
servers:undefined }`; else inject tokens + `{ ok:true, servers }`. Keep `loadMcpServers`
as a thin wrapper (`strict.ok ? strict.servers : undefined`) so create/resume behaviour is
byte-identical (a fresh session with a broken config still legitimately gets no servers —
only the RELOAD path treats a parse error as a no-op, because it has prior good state to
protect).

## New: `session-manager.ts` `reloadMcpConfig()`
```ts
async reloadMcpConfig(): Promise<{
  ok: boolean; error?: string;
  recreated: string[]; failed: { sessionId: string; error: string }[]; skippedBusy: string[];
}>
```
**Serialized (SHOULD): a module-level `reloadInFlight` promise chains concurrent calls so
two reloads never run overlapping disconnect/recreate loops** (mirrors the per-session
reveal mutex). A second call awaits the first, then runs against the now-current state.

1. `const strict = await loadMcpServersStrict();` — if `!strict.ok`, RETURN
   `{ ok:false, error, recreated:[], failed:[], skippedBusy:[] }` immediately. NO session
   touched, NO SDK cache dropped (fully transactional). `strict.servers` (which may be
   `undefined` = validated-empty) is the ONE validated snapshot threaded into every
   recreate below.

2. **Drop the SDK runtime cache BEFORE recreating** (review: correct order — recreates must
   observe fresh project/plugin discovery), and treat its FAILURE as a reported reload
   failure BEFORE touching any session (MUST — continuing silently could leave discovery
   stale while reporting success):
   - If an active session exists: `await active.session.rpc.mcp.config.reload()` in
     try/catch; on throw RETURN `{ ok:false, error, recreated:[], ... }` (transactional —
     nothing recreated yet).
   - If NO active session exists: there is no session rpc to call `reload()` on. Set a
     `pendingSdkCacheReload = true` flag and return `{ ok:true, recreated:[], … }` (nothing
     warm to recreate). The flag is consumed on the NEXT session build as a
     **reload-THEN-recreate** (BLOCKER: calling `reload()` on a freshly-built session cannot
     un-stale the discovery ALREADY used to build it): when a create/resume completes with
     the flag set, call `session.rpc.mcp.config.reload()` on the new session, then
     immediately warm-recreate that same session (a second build that now observes the
     dropped cache), and clear the flag BEFORE the session is exposed/used. Guard against
     recursion (the recreate itself must not re-consume the flag — clear it first, then
     recreate). This keeps the SDK's project/plugin discovery correct for the first post-
     reload session without a persistent stale cache.

3. Snapshot `{ sessionId, session }` PAIRS (not ids alone — MUST) before iterating:
   `const targets = [...this.activeSessions.entries()].map(([id, s]) => ({ id, session: s }))`.
   For each:
   - If `this.isBusy(id)` ⇒ `skippedBusy.push(id)` (a mid-dispatch recreate would abort the
     user's turn). 
   - **Identity re-check immediately before teardown**: `if (this.activeSessions.get(id) !==
     target.session) continue;` — a session concurrently torn down / replaced under the same
     id must not be disconnected by us (MUST).
   - Else disconnect + `resume(id, { toolFactory, excludedTools, warmRecreate:true,
     mcpServersOverride: strict.servers ?? null })` — threading the VALIDATED snapshot with
     the `null` sentinel so a validated-EMPTY config also bypasses the disk re-read (BLOCKER:
     `strict.servers` alone is `undefined` for empty ⇒ would re-read; `?? null` fixes it).
     On success `recreated.push(id)`; on failure `failed.push({ sessionId:id, error })` and
     CONTINUE (independent — one failure neither aborts nor rolls back the others; the file
     is already validated, and each session's SDK-session is left untouched on its own
     failure per the existing resume posture).
4. Return the aggregate.

## Threading the validated snapshot (BLOCKER fix)
Add `mcpServersOverride?: Record<string, unknown> | null` to `ResumeConfig` (types.ts) and
consume it in `_doResume` (session-manager.ts:1122/1148):
```ts
const mcpServers = config.mcpServersOverride !== undefined
  ? (config.mcpServersOverride ?? undefined)   // null sentinel = validated "no servers"
  : await loadMcpServers();                      // unchanged default path
```
- `undefined` (field absent) ⇒ existing behaviour: re-read `loadMcpServers()` (every other
  resume caller is byte-identical).
- A concrete map ⇒ use it verbatim (the validated reload snapshot).
- `null` ⇒ explicit "validated to have NO servers" (distinct from undefined) ⇒ pass
  `undefined` to the SDK, i.e. a genuine empty config, NOT a re-read. This closes the TOCTOU
  hole: the reload's server set is fixed at validation time, immune to a mid-loop edit.

**Never-messaged-session branch (MUST).** `_doResume` reifies a never-messaged session's
resume as `create(...)` under its id (session-manager.ts:1063-1075). That `create` call must
ALSO thread the override, or the TOCTOU reopens for that case. So Caco's `CreateConfig`
(NOT the SDK's `CreateSessionConfig` — NIT) gains the same `mcpServersOverride?:
Record<string, unknown> | null`, `create`'s `mcpServers: loadMcpServers()`
(session-manager.ts:880) applies the same override logic, and the never-messaged branch
forwards `mcpServersOverride: config.mcpServersOverride`.

## Pending-reload: NOT NEEDED (client-rpc simplification)
`mcp.config.reload()` and `mcp.discover()` are CLIENT rpcs (SDK rpc.d.ts:15852), not
per-session. So `reloadMcpConfig` calls `this.sharedClient.rpc.mcp.config.reload()`
directly — it works with ZERO active sessions, eliminating the entire pending-flag /
consume-on-next-build / double-build machinery from earlier drafts. With no active session
the cache is simply dropped and the next new session reads fresh config for free. (This
also fixed a latent increment-3 bug: `mcpDiscover` was calling `session.rpc.mcp.discover`,
which does not exist on the session rpc — corrected to `sharedClient.rpc.mcp.discover`.)

## New route: `POST /api/mcp/reload` (explicit operator trigger)
In `src/routes/mcp-auth.ts` (already the `/api/mcp/*` home). Calls
`sessionManager.reloadMcpConfig()`; on `ok:false` → 400 `{ error }` (config parse failure,
nothing changed); on ok → 200 `{ recreated, failed, skippedBusy }`. This is the
operator-EXPLICIT entry point the spec requires (a button/endpoint, never an auto-watch).

## SDK type addition
Add `config: { reload: () => Promise<void> }` to the structural `mcp` rpc interface in
session-manager.ts (mirrors the `discover` addition from increment 3).

## Invariants preserved
- Never over-hide: reload only REBUILDS sessions with fresh config; it never hides an
  enable-able tool. A parse failure (or a `config.reload()` throw) is a total no-op (prior
  config retained, no session touched).
- Transactional: the server set is fixed at validation time (threaded snapshot), immune to
  a mid-loop malformed edit (no TOCTOU).
- Explicit-only: warm sessions recreate ONLY on this operator call, never a silent watch.
- Serialized: overlapping reloads cannot interleave disconnect/recreate loops.
- Identity-safe: a session is disconnected only if the SAME session object is still active
  at teardown time.
- Busy sessions are skipped (a recreate would abort an in-flight dispatch), reported so the
  operator can retry when idle.
- One session's recreate failure does not abort the others or roll back the successful ones.

## Deliberately deferred
- cf-verify (increment 6): full suite gate.
- Optional `fs.watch` snapshot-invalidation (spec D1 "Optional") — NOT implemented.

## Validation on this box
`npx tsc --noEmit` + new unit tests:
- `loadMcpServersStrict`: clean-with-servers, no-file ⇒ ok+undefined, empty ⇒ ok+undefined,
  parse-failure ⇒ `{ok:false}` (the transactional gate). fs mocked.
- `reloadMcpConfig`: parse failure ⇒ ok:false, NO session recreated + NO cache drop
  (transactional); `config.reload()` throw ⇒ ok:false, NO session recreated (MUST); happy
  path ⇒ each active session recreated, config.reload called once BEFORE recreates; a busy
  session ⇒ skippedBusy, not recreated; a session replaced under the same id mid-loop ⇒ NOT
  disconnected (identity guard); one session's resume throw ⇒ that id in `failed`, others in
  `recreated`; no-active-session ⇒ pendingSdkCacheReload set, next build calls reload();
  concurrent reloads serialize (no interleave).
- TOCTOU test: the validated snapshot is threaded to every recreate — a loadMcpServers
  re-read that returns DIFFERENT/undefined servers mid-loop does NOT reach the recreated
  sessions (they get the snapshot). Mock the SDK session + resume like the existing
  session-manager tests.
- route test if the mcp-auth route file has a test harness; else assert via the manager.
No runtime verify possible here.
