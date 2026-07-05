# Session Fork

## Goals

`/session-fork [optional message]` creates a new Caco session that branches off the current one. The new session inherits the full conversation history, metadata, and working directory but has its own session ID. Diverging changes don't affect the parent.

This is for side conversations: "let me ask the agent a quick question about X without losing my main thread."

## Design

`POST /api/sessions/:id/fork` calls the Copilot SDK `client.rpc.sessions.fork({ sessionId, toEventId? })` (marked `@experimental`), then registers the child session in Caco's cache. Child inherits cwd, model, and folder from the parent; name gets a `[fork]` prefix; plan-state (roadmap, notes, intents) resets fresh. A shared `registerNewSession(sessionId, cwd, meta)` helper is used by both the create and fork routes. The frontend slash command `/session-fork [message]` calls the endpoint, activates the new session via `activateSession()`, then delivers `initialMessage` as a normal `/messages` POST after activation — ensuring the client is subscribed before the message arrives. `session.listChanged` is broadcast so all clients refresh.

## SDK support

The Copilot SDK exposes `client.rpc.sessions.fork({ sessionId, toEventId? })` (marked `@experimental`):

- Creates a new session ID
- Copies events from source up to (but not including) `toEventId`. If `toEventId` omitted, copies all events.
- Returns `{ sessionId: <new-id> }`

The new session is independent at the SDK level. Caco wraps this to mirror metadata and route the user appropriately.

## User experience

1. User is in session A, running a primary task.
2. User types `/session-fork explain how the auth code in src/auth works` (or just `/session-fork`).
3. Caco creates a new session B that has all of A's conversation history.
4. Caco switches the chat view to B. B appears in the session list (broadcasts list change so other clients refresh too).
5. If a prompt was provided, it's sent to B as the first user message after switch.
6. User has a side conversation in B. A stays untouched.
7. User switches back to A via the session list when done.

## Slash command

```
/session-fork
/session-fork <message>
```

- No args → fork only. Switch to new session. User types their first message themselves.
- With args → fork, switch, then send args as the first message in the new session.

The fork name uses one canonical prefix: `[fork] <parent-name>`.

## What's inherited from parent

Child meta is built from scratch — we explicitly opt-in to fields we want to inherit. Everything else defaults to empty.

| Property | Inherited | Source |
|---|---|---|
| Conversation history (events.jsonl) | ✓ | SDK fork RPC |
| Working directory (cwd) | ✓ | Parent's `sessionCache` entry |
| Model | ✓ | Parent's caco meta `model` |
| Caco name | Modified | `[fork] ${parentName}` |
| Caco folder | ✓ | Parent's meta `folder` |
| parentSessionId | ✓ | Set to parent ID for lineage |
| Caco kind | "interactive" | Always, even if parent was swarm/agent |
| Caco intent history | ✗ fresh | Not copied |
| Caco roadmap | ✗ fresh | Stored per-session in `~/.caco/sessions/<id>/`, naturally fresh |
| Caco notes | ✗ fresh | Same reasoning |
| activeApplet / appletParams / appletPanelVisible | ✗ fresh | New session, new applet panel |
| currentIntent | ✗ fresh | Not copied |

The split: SDK-owned state copies; Caco-owned plan-state resets. Fresh branch = fresh side of the desk.

## API

### New endpoint: `POST /api/sessions/:id/fork`

Body:
```json
{ "toEventId": "optional-uuid" }
```

(initialMessage is NOT in this body — the frontend handles message delivery after resume. See "Flow control" below.)

Response:
```json
{
  "ok": true,
  "sessionId": "new-uuid",
  "cwd": "/path",
  "name": "[fork] Original name",
  "model": "claude-sonnet-4.5"
}
```

### Server logic

1. Look up parent in `sessionManager.sessionCache`. If absent → 404. Get parent's cwd from this entry (not from events).
2. Read parent's caco meta. If absent → 404.
3. Try the SDK fork:
   ```typescript
   const result = await client.rpc.sessions.fork({ sessionId: parentId, toEventId });
   const newId = result.sessionId;
   ```
4. **Caco-side setup** (wrap in try/catch, see Failure modes):
   - Write child meta: `{ name: '[fork] ' + parentMeta.name, folder: parentMeta.folder, model: parentMeta.model, parentSessionId: parentId, kind: 'interactive' }`.
   - Mirror what `sessionManager.create()` does for cache registration:
     - `sessionManager.sessionCache.set(newId, { cwd: parentCwd, summary: null })`
     - `registerSession(cwd, newId)` (file-system registration)
     - `ensureSessionMeta(newId)` (no-op if meta written in previous step)
   - Broadcast `session.listChanged` so all clients refresh.
5. Return new session ID, cwd, name, model.

**Refactor opportunity (per code-quality.md):** extract a shared `registerNewSession(sessionId, cwd, meta)` helper used by both `create()` and the fork route. One way to register a session.

## Frontend (slash command)

```typescript
registerBuiltin('session-fork', async (message) => {
  const sessionId = getActiveSessionId();
  if (!sessionId) { showToast('No active session'); return; }
  const trimmed = message.trim();
  showToast('Forking session...', { type: 'info', autoHideMs: 2000 });
  try {
    const res = await fetch(`/api/sessions/${sessionId}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'Unknown error' }));
      showToast(data.error || 'Fork failed');
      return;
    }
    const data = await res.json();
    showToast(`Forked → ${data.name}`, { type: 'success', autoHideMs: 3000 });
    await chatView.activateSession(data.sessionId);
    if (trimmed) {
      // Send as first message in new session
      await fetch(`/api/sessions/${data.sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: trimmed }),
      });
    }
  } catch (e) {
    showToast(`Fork failed: ${e instanceof Error ? e.message : String(e)}`);
  }
});
```

Add to `BUILTIN_COMMANDS`:
```typescript
{ name: 'session-fork', description: 'Fork the current session into a new side conversation' }
```

## Flow control: initial message

Owner is **frontend**, not backend. The backend just creates the session and returns. The frontend:
1. Receives fork response with new session ID.
2. Calls `chatView.activateSession(newId)` — this awaits resume completion.
3. After activation, sends `initialMessage` via the standard `/messages` endpoint if one was provided.

Why frontend: backend has no way to know when a client has switched to the new session. Pushing a message before the client subscribes via WebSocket means the event stream is missed (history would catch it on resume but the UX is jarring).

## Failure modes

### SDK fork fails
Return 500 with error message. Parent session unchanged. No new session exists. User sees toast.

### SDK succeeds but Caco-side setup fails
The new session exists in `~/.copilot/session-state/<newId>/` but Caco doesn't know about it.

Recovery: on next server restart, `_discoverSessions()` will find it. The orphan session has parent's events but no caco-side meta — fallback meta is created on first resume.

Behavior: log the orphan session ID prominently (`console.error('[FORK] Caco-side setup failed for orphan session ${newId} — recoverable via restart')`), return 500 to client. Don't attempt automated SDK cleanup — too risky.

### Frontend `initialMessage` send fails
The new session exists and is switched-to. User sees toast with error. User can retype message manually. No state corruption.

## Prompt-cache preservation (fork double-system-message)

**Problem (measured).** A naive fork produces a child whose first-turn prompt is ~2x
the parent's input tokens AND reads **zero** prompt cache (fully cold), where a
normal fresh same-cwd/same-model session reuses ~97% of its ~13k system prefix from
the provider's cross-session prompt cache. Measured, `/tmp` + `claude-opus-4.6`,
first-turn `cacheReadTokens`:

| Fork child variant | Fresh in | Cache read | Total |
|---|---:|---:|---:|
| Naive (baseline) | 27,569 | 0 | 27,569 |
| Skip resume-time memory append | 26,689 | 0 | 26,689 |
| Fix, **cold** parent (first-of-kind, e.g. post-restart) | 24,130 | 0 | 24,130 |
| **Fix, warm parent (the real fork scenario)** | **595** | **23,511** | 24,106 |

The fix requires the parent's prefix to be WARM in the provider cache — which is the
real fork scenario (you fork a conversation you have been actively using). A cold
parent (its prefix not yet cached, e.g. the first session of its kind after a server
restart) leaves the child cold too; that is an accepted artifact, not the workflow.

**Root cause.** The parent is CREATED with `systemMessage: { mode:'replace' }` (Caco's
~13k prompt, `src/prompts.ts`). `sessions.fork` copies the parent's full event log —
including that `system.message` event — into the child. When Caco then RESUMES the
child, the runtime generates its OWN default foundation system prompt (Caco passed
only a `mode:'append'` memory message, not the replace prompt). The child's wire
prompt becomes `[runtime foundation sys][copied Caco replace-sys as history][…]` — a
double system message (~2x tokens) whose LEADING bytes (the runtime foundation) no
longer match the parent's cached `[Caco replace-sys …]` prefix, so longest-common
-prefix matching yields 0% (the provider caches `tools → system → messages`; a
divergent leading system block invalidates everything after).

**Fix.** On a forked INTERACTIVE child's FIRST (cold) resume, pass
`systemMessage: { mode:'replace', content: <parent-identical system message> }`
(rebuilt via `buildSystemMessage()` + `resolveSystemMessage(cwd)`, the same content
the parent was created with). The runtime's system block then matches the parent's,
so the parent's cached system+history prefix is served from cache instead of
re-billed as fresh. Measured effect (warm parent): fresh (full-price) input
`27,569 → 595` (~98% fewer fresh tokens), cache read `0 → 23,511`; total input
`27,569 → ~24,100`. Note the total only dropped slightly — the copied history is
still present, but now **cache-hit (cheap) rather than fresh**; the win is the
fresh-token collapse + cache prefix restoration, not eliminating the duplication on
the wire.

**Gate.** `!alreadyActive && !warmRecreate && modelOverride===undefined &&
meta.parentSessionId && meta.kind === 'interactive'` (the pure
`shouldUseForkReplaceSystemMessage(meta, guards)` predicate). Three exclusions matter:
- `kind === 'interactive'` — swarm/agent children also set `parentSessionId` (see
  "Audit: parentSessionId consumers") but want their own agent prompt.
- `!warmRecreate && modelOverride===undefined` — a warm recreate (model switch,
  context-budget change) deletes `activeSessions` then resumes, so `!alreadyActive`
  alone would misfire and re-inject `mode:'replace'` on a warm forked child, busting
  its warm cache. These flags (the same ones `isColdResume` excludes) keep the fix to
  a genuine first activation.
- `!alreadyActive` — first activation only.

**"Parent-identical" caveat.** `buildSystemMessage()` is rebuilt from the CURRENT
applet list, host/env, config, prompt code, AND `formatMemoryForPrompt()` — so the
child keeps memory, but "parent-identical" holds only if NONE of those inputs changed
since the parent was created (a memory edit, an applet install, or a Caco prompt-code
change between create and fork shifts the content and lowers — does not eliminate —
the cache hit). Accepted: these rarely change within a session's fork window.

**Why replace-not-skip.** Skipping the resume systemMessage entirely (relying on the
copied `system.message` event) does NOT work — the runtime still emits its own
foundation prompt when no replace is given (measured: 26,689 / 0 cache). The child
must be given the replace content explicitly.

This resolves Open Question #3 (token cost): the child processes all parent events,
but with the fix the bulk (parent system + history) is served from cache rather than
re-billed as fresh.

## Audit: parentSessionId consumers

Before implementing, grep `parentSessionId` and confirm no consumer treats its presence as "this is a sub-agent" without also checking `meta.kind`. Known good consumers:
- `storage.ts:206` — legacy fallback infers `kind: 'agent'` from `parentSessionId` ONLY when `kind` is absent. We explicitly set `kind: 'interactive'`, so the fallback doesn't fire. ✓
- `swarm-tool.ts:120`, `agent-tools.ts:180` — set it when creating swarm/agent children. Read by orchestration code only.

If any other code branches on `parentSessionId` presence alone, gate it with `meta.kind === 'agent' || meta.kind === 'swarm'`.

## Testing

Route-level test in `tests/unit/`:
- Mock `client.rpc.sessions.fork()` to return a deterministic new ID.
- Mock `getSessionMeta(parentId)` to return a known parent meta.
- POST `/api/sessions/:parentId/fork` and assert:
  - Response includes `{ ok: true, sessionId, cwd, name, model }`.
  - Child meta written with `[fork] <parentName>`, correct folder/model/parentSessionId.
  - `sessionManager.sessionCache` has new entry with parent's cwd.
  - `broadcastGlobalEvent` called with `session.listChanged`.
- Failure case: SDK fork throws → response is 5xx, no caco-side state mutated.
- Failure case: SDK succeeds but cache write throws → response is 5xx, orphan logged.

## Documentation

Add to `README.md` slash command table:
```
| /session-fork [message] | Branch into a new side session with parent's history |
```

## Open questions to verify before implementing

These need empirical checks against the SDK rather than assumed:

1. **Does SDK fork emit a new `session.start` event** in the child's `events.jsonl`, or copy the parent's verbatim?
   - If new: cwd discovery via `_discoverSessions()` works as-is.
   - If copied verbatim: cwd discovery uses parent's `session.start`, which has parent's cwd. That's still correct since we want to inherit.
   - Either way, we set the cache entry explicitly in step 4, so this is informational, not blocking.

2. **Is the new session immediately resumable?** Or does it need a separate initialization step before `client.resumeSession(newId)` succeeds?
   - If immediately resumable: the frontend's `activateSession()` works directly.
   - If not: need additional API calls between fork and resume.

3. **Token cost** — RESOLVED (see "Prompt-cache preservation" above). The child
   processes all parent events; a naive fork double-counts the system message and
   busts cache (2x tokens, 0% cache read). Fixed by resuming a forked child's first
   activation with `mode:'replace'` + parent-identical system content, which makes
   the parent's system+history prefix cache-hit instead of re-billing as fresh
   (measured ~98% fewer fresh tokens against a warm parent).

## Risks and Mitigations

1. **`@experimental` SDK API** — could change between SDK versions. Mitigation: route is one place to update.
2. **Large event history copy time** — a session with 50MB events.jsonl takes a moment to fork. Acceptable for v1. "Forking session..." toast covers it.
3. **Storage cost** — each fork creates a full copy. Cleanup is the user's responsibility (existing archive command).
4. **Cwd validity** — parent's cwd may no longer exist. The SDK fork itself probably succeeds (just copying events). On first resume, existing fallback-cwd logic handles missing directories.

## Out of scope

- **Forking from a specific past event** — SDK supports it via `toEventId`. Needs UI to pick a chat message as the boundary. Future enhancement.
- **Merging forks back** — not supported by SDK. Forks are one-way branches.
- **Visual lineage tree** — `parentSessionId` is stored but not rendered. Future improvement.
- **Auto-archive parent after fork** — explicitly no. Parent stays alive.

## Implementation phases

1. **Verify open questions** with a smoke test against the SDK. Confirm session.start handling, immediate resumability.
2. **Backend route + shared registerNewSession helper** — refactor existing create() to use the helper, add fork route using it.
3. **Frontend slash command** — including initialMessage handling after `activateSession`.
4. **Tests** — route-level happy path and both failure cases.
5. **Docs** — README slash command table.

Estimated 250-350 lines including tests.

## Acceptance

- Observable: `/session-fork explore auth` → new session named `[fork] <parent>` appears in session list, chat switches to it, "explore auth" is sent as first message. Parent session unchanged.
- Budgets: Fork completes within ~5 s for typical sessions.
- Gates: `npm run build`, `npm test` green.
- Oracles: route-level unit test (mocked SDK fork RPC) — asserts response shape, child meta (`[fork]` prefix, parentSessionId, kind=interactive), cache registration, `session.listChanged` broadcast, SDK-failure → 5xx with no side effects.

## Plan

| # | Step | Files | Oracle |
|---|------|-------|--------|
| 1 | Extract registerNewSession helper | `src/routes/sessions.ts` | by-construction: create() still works |
| 2 | Add POST /api/sessions/:id/fork route | `src/routes/sessions.ts` | unit test: happy path + SDK-fail + setup-fail |
| 3 | Frontend slash command (/session-fork) | `public/ts/command-registry.ts` | visual: fork + switch + initialMessage |
| 4 | Update README slash command table | `README.md` | by-construction |
| 5 | **Cache-preserving fork:** resume a forked child's first activation with `mode:'replace'` + parent-identical system content, via two pure helpers: `shouldUseForkReplaceSystemMessage(meta, guards)` (the gate) and `resolveResumeSystemMessage({useForkReplace, replaceContent, memoryContent})` (the exact object sent to `resumeSession`) | `src/session-manager.ts` (`_doResume` + the two helpers), `ResumeSessionConfig.systemMessage` widened to allow `replace` | unit: gate TRUE only for interactive fork on first plain activation, FALSE for agent/swarm, normal, already-active, warm-recreate/model-switch; resolver returns mode:replace for a fork, mode:append memory otherwise, undefined with no memory; plus manual measurement (warm parent → forked child fresh input ≈98% lower, `cacheReadTokens` ≫ 0) |
