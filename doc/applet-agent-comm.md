# Applet-Agent Communication

Analyzing communication patterns between applets and agents for reliability, simplicity, and speed.

## Scope Clarification

**In scope:** Communication when applet needs AI reasoning/decision-making from agent.

**Out of scope:** Direct tool calls (`/api/mcp/*`, `/api/shell`). These exist so agents can write applets that replace agent involvement with self-service UI. That's a separate feature, not a communication pattern.

## Problem Statement

When an applet needs the agent to perform work requiring AI reasoning and return results, the current pattern is:

```
Applet: sendAgentMessage("Analyze this data and set_applet_state({ insights: ... })")
Agent:  (processes, hopefully calls set_applet_state)
Applet: onStateUpdate(state => ...) // hoping agent called set_applet_state
```

**Use cases requiring agent round-trip:**
- Analysis/summarization of applet content
- Decision-making based on applet state
- Multi-step reasoning the applet can't do alone
- Natural language understanding of user intent

**Issues with current pattern:**
1. **No guaranteed response** - Agent may ignore `set_applet_state` instruction
2. **No structured contract** - Natural language callback instructions are ambiguous
3. **No timeout/error handling** - Applet can't know if request failed
4. **No correlation** - Multiple concurrent requests can't be distinguished

## Current Architecture

### Applet → Agent

| Method | Description | Limitation |
|--------|-------------|------------|
| `sendAgentMessage(prompt)` | Fire-and-forget chat message | No response channel |
| `setAppletState(state)` | Push state for agent to query | Agent must poll |

### Agent → Applet

| Method | Description | Limitation |
|--------|-------------|------------|
| `set_applet_state` tool | Push state via WebSocket | One-way, no ack |
| `get_applet_state` tool | Read applet's current state | Polling only |

### Data Flow

```
┌─────────────┐                           ┌─────────────┐
│   Applet    │                           │    Agent    │
│  (iframe)   │                           │   (SDK)     │
└──────┬──────┘                           └──────┬──────┘
       │                                         │
       │ sendAgentMessage(prompt)                │
       │ ─────────────────────────────────────>  │
       │        POST /sessions/:id/messages      │
       │                                         │
       │              (agent works...)           │
       │                                         │
       │       set_applet_state({ result })      │
       │ <─────────────────────────────────────  │
       │           WebSocket push                │
       │                                         │
```

## Requirements

1. **Reliability** - Applet gets response or error, not silence
2. **Simplicity** - Minimal API surface, easy to use correctly
3. **Speed** - Low latency for interactive use cases
4. **Backward compatible** - Existing applets continue to work

## Alternative Patterns

### Pattern A: Correlation IDs (Enhance Current)

Add optional `correlationId` to track request/response pairs.

```typescript
// Applet sends request with correlation ID
const id = crypto.randomUUID();
sendAgentMessage("Analyze this chart data", { correlationId: id });

// Applet registers response handler
onAgentResponse(id, (response) => {
  // Called when agent's turn ends
  // response contains final assistant message
  displayInsights(response.content);
}, { timeout: 60000 });
```

**Agent-side change:** None needed. Correlation tracked by server.

**Server-side change:**
- Track pending correlations per session
- On dispatch complete, resolve correlation with final assistant message
- Timeout after N seconds if no response

**Pros:**
- No agent behavior change required
- Works with existing `sendAgentMessage` pattern
- Applet gets the full response text

**Cons:**
- Response is unstructured text, applet must parse
- Agent might not produce actionable response
- No way to get structured data back

### Pattern B: Structured Response via set_applet_state

Improve reliability of current pattern with conventions.

```typescript
// Applet sends with explicit response schema
sendAgentMessage(`
  Analyze the chart data in applet state.
  Call set_applet_state with: { analysis: string, confidence: number, suggestions: string[] }
`);

// Applet waits for state update matching expected shape
const result = await waitForState(
  state => state.analysis && state.confidence, 
  { timeout: 60000 }
);
```

**Pros:**
- Uses existing infrastructure
- Structured response schema in prompt
- Applet validates response shape

**Cons:**
- Agent may not follow schema
- Prompt engineering required
- Still no guaranteed response

### Pattern C: Callback Tool

Create a dedicated tool for agent→applet responses.

```typescript
// New tool: respond_to_applet
defineTool('respond_to_applet', {
  description: 'Send structured response to the requesting applet',
  parameters: z.object({
    correlationId: z.string(),
    data: z.record(z.unknown())
  }),
  handler: async ({ correlationId, data }) => {
    resolveAppletRequest(correlationId, data);
    return { textResultForLlm: 'Response sent to applet' };
  }
});
```

**Applet side:**
```typescript
const result = await requestAgentWork("Analyze chart trends", {
  responseSchema: { trend: 'string', confidence: 'number' }
});
// result: { trend: 'upward', confidence: 0.85 }
```

**How it works:**
1. Applet calls `requestAgentWork(prompt, options)` 
2. Server generates correlationId, stores pending request
3. Message sent to agent with instruction to call `respond_to_applet(correlationId, {...})`
4. Agent processes, calls the tool with structured data
5. Server resolves pending request, returns to applet

**Pros:**
- Structured request/response
- Explicit tool for responses (agent sees it in tool list)
- Timeout handling built-in

**Cons:**
- New tool for agent to learn
- Agent might still ignore/misuse it
- Additional complexity

### Pattern D: Completion Notification

Server notifies applet when agent turn completes, with final message.

```typescript
// Applet sends message
sendAgentMessage("Summarize this data");

// Applet listens for completion
onDispatchComplete((result) => {
  // Fired when agent finishes (idle)
  // result.content = final assistant message
  // result.toolCalls = tools called during dispatch
  parseAndDisplay(result.content);
});
```

**Server-side:**
- On dispatch complete, broadcast event to applet
- Include final message content and tool call summary

**Pros:**
- Simple - no new tools needed
- Applet always knows when agent finished
- Can inspect what tools were called

**Cons:**
- Response is still unstructured text
- Applet must parse natural language
- May not distinguish which request completed (if multiple in flight)

## Comparison

| Pattern | Structured Response | Agent Required | Complexity | Reliability |
|---------|---------------------|----------------|------------|-------------|
| A: Correlation IDs | ❌ Text only | ✅ Yes | Low | Medium |
| B: Schema in prompt | ⚠️ Best-effort | ✅ Yes | Low | Low |
| C: Callback tool | ✅ Structured | ✅ Yes | Medium | Medium |
| D: Completion notify | ❌ Text only | ✅ Yes | Low | High |

## Recommendation

**Pattern A + D: Correlation IDs with Completion Notification**

Combine for best trade-off:

1. **Correlation IDs** - Track which request a response belongs to
2. **Completion notification** - Applet knows when agent finished
3. **Implicit state return** - Agent's `set_applet_state` calls are captured

### Proposed API

```typescript
// Applet sends request, gets promise
const response = await sendAgentRequest("Analyze this chart data", {
  timeout: 60000,
  expectState: ['analysis', 'confidence']  // Optional: wait for these state keys
});

// response.content = final assistant message text
// response.stateUpdates = all set_applet_state calls during dispatch
// response.toolCalls = tools invoked
```

**How it works:**
1. `sendAgentRequest` generates correlationId, sends message
2. Server tracks pending request with correlationId
3. Agent processes, may call `set_applet_state` (state updates captured)
4. On dispatch complete, server resolves promise with:
   - Final assistant message
   - All state updates from the dispatch
   - Tool call summary
5. Timeout rejects promise if agent takes too long

### Implementation

**Phase 1: Completion notification (foundation)**
- Add `dispatch.complete` WebSocket event to applets
- Include final message content

**Phase 2: Correlation tracking**
- Add optional `correlationId` to `sendAgentMessage`
- Track pending requests server-side
- Match completion events to requests

**Phase 3: State capture**
- Capture all `set_applet_state` calls during dispatch
- Include in completion response

**Phase 4: `sendAgentRequest` wrapper**
- Promise-based API built on above primitives
- Timeout handling
- Optional state key waiting

## Effort Estimate

| Phase | Scope | Effort | Files |
|-------|-------|--------|-------|
| 1 | Completion notification | ~30 lines | session-messages.ts, applet-runtime.ts |
| 2 | Correlation tracking | ~40 lines | session-messages.ts, new tracking module |
| 3 | State capture | ~20 lines | applet-tools.ts, tracking module |
| 4 | sendAgentRequest API | ~50 lines | applet-runtime.ts |

**Total: ~140 lines**

## Non-Goals

- **Guaranteed agent behavior** - LLMs are probabilistic; we improve reliability, not guarantee it
- **Synchronous responses** - Agent latency is inherent; promises with timeouts are the model
- **Complex orchestration** - Keep server simple; intelligence is in the agent

## Open Questions

1. Should completion notification include full message content or just signal?
2. What's a reasonable default timeout? (30s? 60s?)
3. Should `expectState` block until keys appear, or just include whatever state was set?

## Files to Modify

- `src/routes/session-messages.ts` - Dispatch completion event
- `public/ts/applet-runtime.ts` - `sendAgentRequest()` API
- `src/applet-request-tracker.ts` - New: correlation tracking
- `src/applet-tools.ts` - State capture during dispatch
- `doc/API.md` - Document new APIs
