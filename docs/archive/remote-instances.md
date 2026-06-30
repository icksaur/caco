# Remote Instance Capabilities

## Goal

Extend Caco's multi-instance architecture so agents can interact across instances — dispatching work to remote sessions, querying remote state, and coordinating multi-machine workflows. Build on the existing portal, peer system, and session transfer infrastructure.

## Current State

### What exists today

- **Portal** (`portal.html`): Aggregates Caco instances in iframes. Sidebar shows instances. Manual URL entry.
- **Peer storage**: `~/.caco/peers.json` persists known instances. `GET/POST /api/peers` manages the list.
- **Session transfer**: Drag-drop in portal exports session as tar.gz from source, imports at destination. CORS enabled for localhost origins.
- **Delegation tools**: `send_caco_message` (fire-and-forget) and `caco_session_delegate` (wait-for-response) send prompts to sessions via `POST /api/sessions/:id/messages`. Currently local-only — they call the local API.
- **Swarm tool**: `caco_session_swarm` creates and dispatches 1-6 parallel sessions. Local-only.
- **Status broadcast**: Child iframes send `caco:status` postMessages to portal with busy/unobserved counts.

### What's missing

- Agents have no way to dispatch work to a remote instance
- No API proxy for cross-instance tool calls
- CORS only allows localhost — no remote origin support
- No discovery beyond manual URL entry
- No authentication between instances

## Proposed Capabilities

### Tier 1: Agent-to-remote fire-and-forget (low risk, high value)

**New tool: `send_remote_message`**

Send a prompt to a named session on a remote Caco instance. Fire-and-forget — the remote session works autonomously.

```typescript
Parameters:
  instanceUrl: string   // Peer URL (e.g., "http://work:53000")
  sessionId?: string    // Target session ID (optional — uses active session if omitted)
  sessionName?: string  // Find session by name (alternative to sessionId)
  message: string       // Prompt to send
```

Implementation:
- Resolve instance URL from peers list (allow both URL and hostname match)
- `POST {instanceUrl}/api/sessions/{sessionId}/messages` with `{ prompt, source: 'remote' }`
- If `sessionName` given instead of ID: `GET {instanceUrl}/api/sessions` → find by name → use ID
- Returns immediately with confirmation or error
- No waiting, no response collection

**CORS change**: Add configured peer origins to allowed CORS list (not just localhost). Read from `peers.json` at startup.

### Tier 2: Remote session creation (medium risk, medium value)

**New tool: `create_remote_session`**

Create a new session on a remote instance and optionally send an initial prompt.

```typescript
Parameters:
  instanceUrl: string
  cwd?: string          // Working directory on remote machine
  model?: string
  name?: string         // Session name
  message?: string      // Optional initial prompt
```

Implementation:
- `POST {instanceUrl}/api/sessions` with `{ cwd, model, description: name }`
- If `message` provided: `POST {instanceUrl}/api/sessions/{newId}/messages` with prompt
- Returns `{ sessionId, instanceUrl }` for reference

Use case: "Start a research session on my work machine to look into X while I continue here."

### Tier 3: Remote state queries (low risk, medium value)

**New tool: `query_remote_session`**

Read state from a session on a remote instance without sending a message.

```typescript
Parameters:
  instanceUrl: string
  sessionId: string
  include?: ('roadmap' | 'notes' | 'state')[]
```

Implementation:
- Calls existing endpoints: `GET /api/sessions/{id}/roadmap`, `/notes`, `/state`
- Aggregates and returns results
- Read-only, no side effects

Use case: "Check if the work machine session has finished the build."

### Tier 4: Remote swarm (higher risk, high value)

Extend `caco_session_swarm` to distribute sessions across instances.

```typescript
Parameters:
  // existing params...
  instances?: string[]  // Optional: distribute across these instances (round-robin)
```

Implementation:
- If `instances` provided, round-robin session creation across instances
- Each session created via `POST {instanceUrl}/api/sessions`
- Prompts sent via `POST {instanceUrl}/api/sessions/{id}/messages`
- Wait for idle via polling `GET {instanceUrl}/api/sessions/{id}/state`
- Collect results via history endpoint

Risk: Polling remote instances for completion is fragile. Could use WebSocket connection to remote instance instead, but that's significantly more complex.

### Tier 5: Instance discovery (low risk, quality-of-life)

**mDNS/broadcast discovery** for LAN instances.

- On startup, Caco broadcasts its presence on a well-known port
- Portal auto-discovers instances on the same network
- Reduces manual URL entry

Alternative: Caco instances periodically `GET /api/peers` from known peers and merge — gossip protocol. If A knows B and B knows C, eventually A discovers C.

### Tier 6: Bidirectional WebSocket bridge (high complexity)

Connect instances via persistent WebSocket for real-time events:
- Remote session busy/idle notifications
- Remote intent updates
- Cross-instance `caco_session_delegate` (wait-for-response across machines)

This is the most complex tier and should only be considered after Tiers 1-3 are proven.

## Security Considerations

1. **No authentication today** — any client on the network can call any API. This is acceptable for personal use on trusted networks but blocks deployment in shared environments.
2. **CORS expansion** — adding peer origins to CORS means configured peers can make cross-origin requests. Still requires the browser to be on a machine that can reach both instances.
3. **Prompt injection via remote** — a compromised remote instance could send malicious prompts to local sessions. Mitigated by: source field in messages (`source: 'remote'` vs `source: 'user'`), and agents seeing the source context.
4. **Instance trust** — peers are manually configured. No auto-trust of discovered instances.

## Recommended Implementation Order

1. **CORS for peers** — prerequisite for everything. Add peer origins to allowed CORS list.
2. **`send_remote_message`** — highest value, simplest. Enables "go do this on my work machine" workflow.
3. **`query_remote_session`** — enables "check on remote work" without switching instances.
4. **`create_remote_session`** — enables "start something new on remote" without portal UI.
5. **Remote swarm** — only after 1-3 are proven stable.
6. **Discovery** — quality-of-life, not blocking.

## Open Questions

1. Should remote tools be separate tools or extensions to existing tools? Adding `instanceUrl` to `send_caco_message` is simpler but changes the existing tool signature.
2. Should CORS allow all configured peers or require explicit opt-in per peer?
3. Is polling acceptable for remote swarm completion, or must we build WebSocket bridges first?
4. Should the portal UI show remote session activity (roadmap, intent) inline, or only as links to the remote instance?
