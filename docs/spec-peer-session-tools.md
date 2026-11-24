# Peer session tools

## Goals

Carl does a lot of work in Caco sessions on other machines (devboxes reached as
portal peers). An orchestrating session can already see them through
`caco_sessions_overview`, but it cannot act on them without hand-written HTTP
calls through `caco_run_workflow`, which is slow and expensive. This spec lets
two existing tools reach a session on a peer:

- `get_session_state` reads a peer session's state, including its final offer
  and last reply.
- `caco_session_delegate` sends a peer session a message and waits for its
  reply, as it already does locally.

No new tools. A tool that supports peers says so in one short sentence. A tool
that does not (`create_caco_session`, `caco_herd`, `caco_herd_state`) says
nothing about peers.

The same change removes the leftover `swarm` session kind. The
`caco_session_swarm` tool was removed earlier (spec-tool-removals); only its
session kind and timeouts remain, and the `task` tool covers the use case.

Non-goals: creating sessions on a peer, herds that span machines, a WebSocket
bridge between instances, peer discovery, and authentication between
instances. `docs/archive/remote-instances.md` proposed new `*_remote_*` tools
for this; it is superseded by this spec.

## Design

### Addressing

A peer session is addressed by the same key `caco_sessions_overview` prints:
`<instanceId>:<sessionId>`. A bare session id (with or without the
`caco-session:` prefix) is local, exactly as today. The key is split at the
last `:` (session ids never contain one), so an instance part may itself
contain colons. The instance part may also be the peer's name as shown in the
overview (`hostname`/`name` in `peers.json`). A key whose instance part is this
instance's own id or name is treated as local.

`resolvePeerTarget(raw)` (new, `src/peer-target.ts`) returns either
`{ local: sessionId }` or `{ peer: { origin, name, id }, sessionId }`, or an
error string. It reads `getPeers()` and matches `peer.id` first, then
`peer.name`. The same origin rule as the overview fan-out applies: loopback
origins, or origins listed in `CACO_PEERS_ALLOW_REMOTE`. Errors:

- `Unknown instance "<x>". Run caco_sessions_overview to list instances.`
- `Instance name "<x>" matches more than one peer; use the instance id.`
- `Instance "<x>" is not reachable from this server (not loopback and not in CACO_PEERS_ALLOW_REMOTE).`

**Learning peer ids.** The overview fan-out already reports each peer's
instance id through `FanoutOptions.onIdentity`, but nothing consumed it.
`rememberPeerId(origin, id)` in `peer-store.ts` keeps learned ids in memory
(the overview never writes, spec-session-overview), and `getPeers()` applies
them. `computeOverview` passes it as `onIdentity`, so after one overview run
every key the overview printed resolves. When an id is still unknown,
`resolvePeerTargetFresh` fetches the overview (`context=none`) of each
reachable peer without an id once, then resolves again. A peer's name always
works.

### Peer HTTP client

`peerFetch(origin, path, init)` (new, in `src/peer-target.ts`) wraps `fetch`
with the overview fan-out's rules: `redirect: 'error'`, a timeout (10 s), the
`X-Caco-Peer-Hop: 1` header, and a capped body read (export `readCapped` from
`overview-fanout.ts`; 1 MB cap). It never sends cookies or an `Origin` header,
so the peer's same-origin guard treats it like any server self-call.

### `get_session_state`

Local behaviour is unchanged, except that `GET /api/sessions/:id/state` gains
two fields, for local and peer reads alike:

- `turn: { active: string | null, lastCompleted: string | null }`: the turn id
  of the running dispatch, and of the last turn that ended with a real
  `session.idle`. An error, timeout, cancel, or a turn waiting for a network
  retry is not finished. Both live in `dispatchState`, in memory only. A turn
  id is the root message's correlation id; auto-continue and retry carry it.
- `lastResponse`: the session's last assistant message
  (`getLastAssistantMessage`), bounded with `boundDelegateResponse(text, id8,
  4096)`. It is included only when the query has `?reply=1`, so the UI and
  other pollers do not pay for a history read. It is left out when a turn
  started or ended while history was being read, so it always belongs to
  `turn.lastCompleted`.

The `turn` field doubles as the capability check: a peer whose `/state` has
no `turn` runs an older build.

`responseOptions` (the final offer) is already in the response.

For a peer target the tool calls `peerFetch(origin,
/api/sessions/<id>/state?reply=1)` and returns the JSON with an added
`instance: { id, name }`. The tool always asks for `reply=1`. Description
addition: "Accepts a local session ID or an `instance:sessionId` key from
caco_sessions_overview."

### `caco_session_delegate` to a peer

Entries in `prompts` may mix local and peer targets. Local entries follow the
current path unchanged. A peer entry:

1. **Preflight**: `GET <peer>/api/sessions/<id>/state`. A 404 maps to
   `Session <id8> not found on <name>.` A response without `turn` maps to
   `<name> runs an older Caco; update it first.` A busy status maps to the
   local busy message plus ` on <name>`. A peer entry with `pluginDirectories`
   is refused: `pluginDirectories is local only.` Nothing is sent unless the
   preflight passes.
2. **Send**: `POST <peer>/api/sessions/<id>/messages` with
   `{ prompt, source: 'peer', fromPeer: { instanceId, instanceName, sessionId } }`
   (this instance's id and display name, and the caller's session id). No
   `fromSession` and no `correlationId`: the call is a new root on the peer.
   The peer's response includes `correlationId` (the fresh id it generated).
   That id is the **token** for this delegate.
3. **Wait**: poll `GET <peer>/api/sessions/<id>/state?reply=1` every 5 s.
   - `turn.active === token`: still working.
   - `turn.lastCompleted === token` and nothing running: done; the result is
     `lastResponse` (poll again if the snapshot has none).
   - `turn.lastCompleted === token` but another turn is running: the reply is no
     longer the last one, so the result is the not-available text below.
   - Neither, on two polls in a row: the turn was lost (the peer restarted, or
     another message ran after the reply and before the poll). Result:
     `(reply not available; read it with get_session_state)`.
   A user steering the session mid-turn is part of the same dispatch and the
   same token, so the steered reply is returned.
4. **Stop conditions**: three polls in a row that fail (network, timeout,
   non-2xx other than 404) end the wait with
   `(lost contact with <name>; check later with get_session_state)`. A 404
   ends it with `(session disappeared during processing)`. After
   `DELEGATE_MAX_TOTAL_MS` (60 min):
   `(still running on <name> after 60m; check later with get_session_state)`.

The result list keeps its current shape; a peer entry's `sessionId` is the
full key (`<instanceId>:<sessionId>`).

Description addition: "Targets may be local session IDs or
`instance:sessionId` keys from caco_sessions_overview."

### Receiving a peer message

`POST /api/sessions/:id/messages` accepts `source: 'peer'` with a `fromPeer`
object. `instanceId` and `sessionId` must match the overview's id pattern
(`[A-Za-z0-9._-]{1,100}`); anything else is a 400. `instanceName` is display
text only: the receiver keeps letters, digits, space, `.`, `_` and `-`,
replaces anything else with `_`, and truncates to 40 characters, falling back
to the first 8 characters of `instanceId` when empty. The request must carry
`X-Caco-Peer-Hop: 1` exactly; otherwise 400.

It is handled like an agent message for display and observation, with these
differences:

- Steering (`mode: 'immediate'`) is refused with 403, as for agent messages.
- The persisted prefix is `[peer:<instanceName>/<session8>]`.
  `message-source.ts` parses it as a new `peer` source, WebSocket event
  enrichment passes it through, and the client renders it like an agent
  message. Live and reloaded history look the same.
- `needsObservation` is false, as for agent messages.
- It is a root dispatch: depth 1, a fresh correlation id, returned in the
  response body as `correlationId`.
- `fromSession` together with `source: 'peer'` is a 400 (the agent biconditional
  still holds).
- A herd child refuses it with 409 and the same text as a local delegate
  (`is a herd child ... its parent supervises it`), so a remote delegate cannot
  fight a herd parent.
- The dispatch is marked `peerOrigin: true` in `dispatchState` (next to depth).

`fromPeer` is an unauthenticated claim used for display only. It never
authorizes anything. The trust model is unchanged: Caco binds to loopback, and
anything that can reach that port can already post messages. Exposing Caco
beyond loopback without authentication is outside the supported model.

### Loop guard

A cross-machine ping-pong (A on the laptop delegates to B on a devbox, B
delegates back to A) would bypass the per-machine depth limit because each send
is a new root. To prevent this:

- `dispatchState` stores `peerOrigin` per live dispatch, next to depth. A
  `source: 'peer'` dispatch sets it. An agent dispatch inherits it from the
  caller's dispatch (`fromSession`), so it follows local delegate, herd and
  `create_caco_session` chains.
- **Wherever depth is carried forward, `peerOrigin` is carried with it.** Today
  that is the auto-continue dispatch (`auto-continue-runtime.ts`) and the
  transient retry (`session-messages.ts`). Implement this by carrying one
  record `{ depth, peerOrigin }` instead of a bare depth, so a future carrier
  cannot copy one without the other.
- `caco_session_delegate` and `get_session_state` refuse peer targets when the
  caller's live dispatch has `peerOrigin`:
  `This turn started from another machine, so it cannot reach other machines.`
  Local targets are still allowed.

New roots on the receiving machine start clean: herd completion wakes
(`source: 'system'`), schedules, session wakes, and user or applet messages.
A loop through those is slow by construction (the herd stall guard, the
hourly minimum on wakes and schedules) and visible in the overview, so they
are not tainted. Raw HTTP calls made from `caco_run_workflow` bypass the
tools and are out of scope.

### Removing the `swarm` session kind

- `SessionKind` drops `'swarm'` (server and client types). The meta read
  migration maps `kind: 'swarm'` and `isSwarmSession: true` to `kind: 'agent'`
  and deletes `isSwarmSession`.
- `POST /api/sessions` ignores `isSwarmSession`.
- `SWARM_TIMEOUT_MS` becomes `AGENT_TIMEOUT_MS`; the agent branch is unchanged.
- Remove `swarm` from the session panel's and `main.ts`'s filters,
  `ui-utils` kind order, the pager's excluded kinds, `/api/sessions`'s skip,
  and the overview's `hidden` union and tool label. The overview fan-out
  validator still accepts `kind: 'swarm'` and `hidden: 'swarm'` from an older
  peer and maps both to `'agent'`, so a peer on an older build is not reported
  invalid.
- Fix stale comments that mention swarm (`dispatch-state.ts`,
  `dispatch-watchdog.ts`, `activity-version.ts`, `app-state.ts`,
  `unobserved-tracker.ts`, `pager-view.ts`, `session-manager.ts`).

## Invariants

1. A bare session id behaves exactly as today in both tools.
2. Peer calls use only `GET /api/sessions/:id/state` and
   `POST /api/sessions/:id/messages` on the peer. No other peer endpoint.
3. Peer origins follow the overview fan-out rule: loopback or
   `CACO_PEERS_ALLOW_REMOTE`. No new trust setting.
4. A dispatch whose root came from a peer, and every dispatch that carries its
   depth (agent calls, auto-continue, retry), can never reach a peer through
   the tools.
5. A peer message is always a root dispatch on the receiver and never carries
   `fromSession` or a caller correlation id.
6. A peer message never reaches a herd child.
7. Nothing in Caco writes `kind: 'swarm'` after this change.
8. A peer delegate returns only the reply of the turn it started (its token),
   or a fixed text saying the reply is not available. Never another turn's
   reply.
9. `fromPeer` is display text. No decision depends on it.

## Considerations

- **Not-loaded sessions.** The local delegate refuses a session that exists on
  disk but is not loaded. The peer's messages route already returns 404 for
  those, so the peer message reads "not found". Acceptable: the overview shows
  whether the session exists.
- **Peer on an older build.** An older messages route would accept
  `source: 'peer'` as a plain, unprefixed message. The preflight's `turn`
  check refuses before anything is sent, so this cannot happen through the
  tools.
- **Turn tokens are in memory.** A peer restart mid-turn loses `turn`; the
  wait reports "reply not available" after two polls instead of hanging.
- **Auto-continue.** A tool-reveal idle is not a real idle and the
  continuation keeps the correlation id, so `lastCompleted` is only set when
  the whole turn ends. Phase 4 verifies the continuation keeps the id and
  carries it if not.
- **Reply size.** `lastResponse` is bounded to 4 KB on the peer, and the
  delegate bounds it again with its per-response budget.
- **Polling cost.** One small GET every 5 s per peer target. Fine for 1-2
  targets.
- **Who sees the message.** The peer session shows it with the peer prefix and
  marks the reply unobserved like an agent message. No new UI.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Ping-pong between machines | `peerOrigin` loop guard (Invariant 4); slower loops through herd wakes, wakes and schedules are bounded by their own guards |
| The wait returns a later turn's reply | Server-issued token; done only when `lastCompleted` equals it (Invariant 8) |
| Peer goes away mid-wait (laptop sleeps, port forward drops) | Three failed polls end the wait with a clear text; the work continues on the peer |
| Older peer runs the message unprefixed | Preflight `turn` check refuses first |
| Six old swarm sessions on the laptop reappear in the list as agent sessions | Expected; archive them by hand. The overview already hides `agent` kind |
| A prompt from a peer is trusted like a local agent prompt | Same trust as today: anything that can reach a loopback port can already POST messages. The prefix shows the claimed source; nothing relies on it |

## Acceptance

| # | Criterion |
|---|---|
| A1 | `resolvePeerTarget`: bare id and `caco-session:` id are local; self id and self name are local; `peer-id:x` and `peer-name:x` resolve; an instance part containing `:` splits at the last colon; unknown instance, duplicate name and disallowed origin return the fixed errors |
| A2 | `rememberPeerId` applies a learned id without writing `peers.json`; after an overview with a fake peer, a key the overview printed resolves |
| A3 | `GET /state` returns `turn.active` while busy and `turn.lastCompleted` after a real idle (not after a tool-reveal idle); with `?reply=1` it returns `lastResponse` bounded to 4096 bytes, without it no history read happens |
| A4 | `get_session_state` on a peer key calls only the peer's `/state?reply=1` with the hop header and returns its JSON plus `instance` |
| A5 | Delegate preflight: 404, busy, missing `turn` (older peer) and `pluginDirectories` give the fixed texts and send nothing; the send body has `source:'peer'` and `fromPeer` and no `fromSession` |
| A6 | Delegate wait: returns `lastResponse` when `lastCompleted` equals the token; keeps waiting while `active` equals it; a different `lastCompleted` on two polls gives the not-available text; three failed polls give the lost-contact text; 404 gives the disappeared text; the total limit gives the 60m text |
| A7 | A delegate call mixing one local and one peer target returns both results in order |
| A8 | Receive: `source:'peer'` with a valid `fromPeer` and hop `1` dispatches at depth 1, returns `correlationId`, persists `[peer:<name>/<session8>]`, and does not need observation; the prefix parses as source `peer` in live events and reloaded history; a bad `fromPeer`, a sanitized name, `fromSession` with peer, a missing or non-`1` hop header, and a herd-child target are covered |
| A9 | Loop guard: a peer-rooted dispatch, an agent dispatch inheriting from it, its auto-continue, and its retry are each refused peer targets by both tools; local targets still work; a herd wake root is not tainted |
| A10 | Swarm removal: a meta with `kind:'swarm'` or `isSwarmSession:true` reads as `agent`; an older peer's overview entry with `kind:'swarm'` and `hidden:'swarm'` validates as `agent`; `'swarm'` remains only in the meta migration and the fan-out compatibility mapping |
| A11 | Tool descriptions: both tools carry the one-sentence peer note; `create_caco_session`, `caco_herd` and `caco_herd_state` do not mention peers |
| A12 | API.md: the agent tools section lists the current tools, the `/state` fields, and `source:'peer'` on the messages route |

## Plan

| Phase | Work | Files |
|---|---|---|
| 1 | Remove the swarm kind, keep the meta migration and fan-out mapping; fix comments; tests (A10) | `src/session-meta-store.ts`, `src/routes/sessions.ts`, `src/routes/session-messages.ts`, `src/session-overview.ts`, `src/overview-fanout.ts`, `src/overview-tool.ts`, `src/pager-view.ts`, `public/ts/*`, tests |
| 2 | `dispatchState`: `{ depth, peerOrigin }` record carried by auto-continue and retry; `lastCompleted` correlation id on real idle; `/state` adds `turn` and `?reply=1` `lastResponse` (A3, A9 carry half) | `src/dispatch-state.ts`, `src/session-manager.ts`, `src/auto-continue-runtime.ts`, `src/routes/session-messages.ts`, `src/routes/sessions.ts`, tests |
| 3 | `peer-target.ts`: resolve plus `peerFetch`; export `readCapped`; `rememberPeerId` wired as `onIdentity` (A1, A2) | `src/peer-target.ts`, `src/peer-store.ts`, `src/overview-fanout.ts`, `src/overview-service.ts`, tests |
| 4 | Receive side: `source:'peer'`, `fromPeer`, hop check, herd-child refusal, returned `correlationId`, `peerOrigin` set and inherited; `peer` source in `message-source.ts`, WebSocket enrichment and the client (A8) | `src/routes/session-messages.ts`, `src/message-source.ts`, `src/routes/websocket.ts`, `public/ts/*`, tests |
| 5 | `get_session_state` peer path and loop guard (A4, A9) | `src/agent-tools.ts`, tests |
| 6 | Delegate peer path: preflight, send, token wait, mixed batches, loop guard (A5-A7, A9) | `src/delegate-tool.ts`, tests |
| 7 | Tool descriptions, API.md refresh, README note (A11, A12) | `src/agent-tools.ts`, `src/delegate-tool.ts`, `API.md`, `README.md` |

## Rationale

Decisions from Carl (2026-11-24):

1. No new tools. Existing tools state their peer support; tools that are local
   only say nothing about it.
2. Delegate is critical, so it gets peer support even though it needs polling.
   Herd stays local.
3. Remove what is left of swarm; `task` covers it.
4. Keep messages simple: short tool-description additions and short error texts.

Polling `/state` was chosen over a WebSocket subscription to the peer: it reuses
the existing endpoint, needs no connection management, and the 5 s latency does
not matter for turns that take minutes. The wait keys on a token the peer
issues (its correlation id) rather than timestamps, which avoids clock skew
and cannot pick up another turn's reply.

Implementation review (gpt-5.6-sol-fast, 2026-11-24): only a real idle finishes
a turn; the reply is tied to its turn (consistent `/state` snapshot, and no
reply once another turn starts); peer messages cannot steer. Learned peer ids
stay in memory, because the overview must not write.

Spec review (gpt-5.6-sol-fast, 2026-11-24) changes folded in: peer ids are now
persisted from the overview; the loop guard carries through auto-continue and
retry and states which roots start clean; the wait uses a turn token instead of
`lastIdleAt`; preflight detects older peers; the `peer` source is wired through
message parsing and display; `fromPeer` uses the instance id and a sanitized
display name and is declared untrusted; older peers' swarm `kind` is mapped.
