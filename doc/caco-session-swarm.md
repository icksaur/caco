# Caco Session Swarm

**Status: Proposed**

## Problem

Dispatching parallel work requires the agent to manually call `create_caco_session` N times, craft individual prompts, and has no way to wait for all sessions to finish. Results must be manually collected. The agent often polls or relies on unreliable callbacks.

## Goal

One tool call dispatches N parallel sessions and blocks until all complete. Results are aggregated and returned inline. The calling agent gets a structured response with all outputs, no polling needed.

## Design

### Tool: `caco_session_swarm`

```typescript
defineTool('caco_session_swarm', {
  description: `Dispatch up to 6 parallel Caco sessions and wait for all to complete.
Returns aggregated results from all sessions.

Use this for fan-out tasks: run the same analysis across multiple repos,
parallelize independent subtasks, or get diverse perspectives on a problem.

Each session runs independently with its own prompt. Results are collected
and returned as a single structured response.

**Model tiers (weaker models only for larger swarms):**
- 1-2 sessions: opus models allowed
- 3-4 sessions: sonnet models or cheaper
- 5-6 sessions: gpt-4.1 or cheaper

**Tips for prompts:**
- Give each session a complete, self-contained task
- Ask sessions to write results to a temp file or keep responses brief
- Avoid prompts that require cross-session coordination`,

  parameters: z.object({
    cwd: z.string().describe('Working directory for all sessions'),
    model: z.string().describe('Model ID for all sessions'),
    prompts: z.array(z.string()).min(1).max(6).describe('Prompts for each session (1-6)')
  }),

  handler: async ({ cwd, model, prompts }) => { ... }
});
```

### Model Tier Enforcement

```typescript
const OPUS_MODELS = ['claude-opus-4.5', 'claude-opus-4.6', 'claude-opus-4.6-1m', 'claude-opus-4.6-fast'];
const SONNET_MODELS = ['claude-sonnet-4', 'claude-sonnet-4.5', 'claude-sonnet-4.6'];

function validateSwarmModel(model: string, count: number): string | null {
  if (count <= 2) return null; // any model
  if (count <= 4 && OPUS_MODELS.some(m => model.includes(m))) {
    return `${model} not allowed for ${count} sessions (max 2 for opus). Use sonnet or cheaper.`;
  }
  if (count <= 6 && (OPUS_MODELS.some(m => model.includes(m)) || SONNET_MODELS.some(m => model.includes(m)))) {
    return `${model} not allowed for ${count} sessions (max 4 for sonnet). Use gpt-4.1 or cheaper.`;
  }
  return null;
}
```

### Execution Flow

```
1. Validate model tier for swarm size
2. Create N sessions (POST /api/sessions for each)
3. Send prompts to all sessions in parallel (POST /api/sessions/:id/messages)
4. Poll all sessions for idle state (GET /api/sessions/:id/state)
5. Collect results from each session's last assistant message
6. Return aggregated results to calling agent
```

### Concurrency Lock

Only one swarm can run at a time. A module-level flag prevents concurrent swarms:

```typescript
let swarmActive = false;

// In handler:
if (swarmActive) {
  return { textResultForLlm: 'A swarm is already running. Wait for it to complete.', resultType: 'error' };
}
swarmActive = true;
try { ... } finally { swarmActive = false; }
```

### Sub-Session Integration

Swarm sessions are created with `parentSessionId` set to the calling session. This:
- Suppresses unobserved badge notifications (confirmed: `unobserved-tracker.ts:58` skips sub-sessions)
- Shows parent relationship in session metadata
- Session descriptions: `swarm 1/4: <prompt preview>`

### Polling with Timeout

```typescript
const PER_SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 min per session
const POLL_INTERVAL_MS = 5000;

let completed = 0;
while (completed < prompts.length) {
  await sleep(POLL_INTERVAL_MS);
  for (const s of sessions) {
    if (s.done) continue;
    const elapsed = Date.now() - s.startedAt;
    if (elapsed > PER_SESSION_TIMEOUT_MS) {
      s.done = true;
      s.result = '(timed out after 10 minutes)';
      completed++;
      continue;
    }
    const state = await fetchState(s.id);
    if (state.status === 'idle' || state.status === 'inactive') {
      s.done = true;
      s.result = await fetchLastMessage(s.id);
      completed++;
    }
  }
}
```

### SDK Timeout Behavior

Verified: the SDK has **no tool execution timeout**. `handleToolCallRequest` calls `await handler(args)` with no deadline. The JSON-RPC transport also has no request timeout. The tool can run for hours.

The calling session stays busy because the tool handler hasn't returned. The Caco dispatch watchdog resets on SDK events — and during a tool call, the SDK keeps emitting `tool.execution_start` which the watchdog counts as activity. No timeout risk on either side.

### Result Aggregation

```typescript
return {
  textResultForLlm: sessions.map((s, i) => 
    `## Session ${i + 1}\n\n${s.result || '(no response)'}`
  ).join('\n\n---\n\n'),
  toolTelemetry: {
    sessionsCreated: prompts.length,
    sessionsCompleted: completed,
    totalTimeMs: Date.now() - startTime
  }
};
```

### Error Handling

- **Session creation fails:** Skip that session, include error in results
- **Session hangs (no idle after 10 min):** Mark as timed out, include partial result if available
- **All sessions fail:** Return error result with details

### Session Description

Each swarm session gets a description like `swarm 1/4: <first 50 chars of prompt>` for identification in the session panel.

## Implementation

### File: `src/swarm-tool.ts`

New file containing:
- `validateSwarmModel()` — tier enforcement
- `createSwarmTool()` — tool factory (needs sessionRef for correlation)
- Polling loop with 5s interval
- Result collection from session history

### Wire into server.ts

Add to tool factory return array alongside other tools.

### Key Dependencies

- `POST /api/sessions` — create sessions
- `POST /api/sessions/:id/messages` — send prompts
- `GET /api/sessions/:id/state` — poll status
- Session history via `sessionManager.getHistory()` or `/api/sessions/:id/state` with last message

## Risks

| Risk | Mitigation |
|------|------------|
| 6 opus sessions = expensive | Model tier enforcement |
| Long-running tool blocks calling session | Acceptable — tool returns results inline |
| Swarm sessions clutter session list | Description prefix helps identify; could auto-delete on completion (future) |
| OAuth popups per session | Shared client (this branch) solves this |
