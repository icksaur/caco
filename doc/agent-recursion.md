# Agent Runaway Guard

**Goal:** Prevent runaway agent-to-agent calls while allowing legitimate delegation patterns including recursion.

**Scope:** Cooperative safety for single-user situated software. Not abuse prevention, just error prevention.

---

## Valid Patterns

### 1. Simple Delegation: `1 → 2 → 1`
```
Session 1 (coordinator): "Ask session 2 to analyze this data"
Session 2 (worker):       Analyzes data
Session 1 (coordinator):  Receives results, continues
```
**Characteristic:** Outer agent delegates work, inner agent reports back. Clean handoff.

### 2. Oscillating Collaboration: `1 → 2 → 1 → 2 → 1 → 2 → 1`
```
Session 1 (state keeper):  "Get latest data"
Session 2 (data fetcher):  Fetches data, returns
Session 1 (state keeper):  "Process next batch"
Session 2 (data fetcher):  Processes, returns
...
```
**Characteristic:** Back-and-forth where outer maintains state, inner does discrete tasks. Bounded iteration.

---

## Suspicious Patterns

### 1. Long Chain: `1 → 2 → 3 → 4 → 5`
**Problem:** Each agent delegates further instead of doing work. Buck-passing.
**Risk:** High - indicates poor delegation design or confusion.

### 2. Self-Loop: `1 → 1 → 1 → 1`
**Problem:** Agent calls itself (via tool or recursion).
**Risk:** Critical - immediate infinite loop if not caught.

### 3. Unbounded Oscillation: `1 → 2 → 1 → 2 → 1 → 2 ...` (continues indefinitely)
**Problem:** No exit condition, agents keep bouncing.
**Risk:** High - burns budget, no progress.

### 4. Rapid-Fire with No Work
**Problem:** Many calls in quick succession with no tool usage, no outputs.
**Risk:** Medium - might be stuck in conversation loop.

### 5. Long Duration Flow
**Problem:** Any flow lasting >5 minutes.
**Risk:** Medium - either stuck or poorly designed.

---

## Correlation ID System

### Problem
How do we know which POST requests are part of the same agent flow vs independent user actions?

### Solution: Client-Generated Correlation GUID
1. **User-initiated POST**: Client generates new GUID for each independent action
2. **Agent-initiated POST**: MCP tool `create_agent_session` automatically passes correlation GUID
3. **Session manager**: Tracks metrics per correlation ID

### Flow Example
```
User clicks "Send" → Client generates correlationId: abc123
POST /api/sessions/session-1/messages { correlationId: "abc123" }

Agent calls create_agent_session(target: session-2)
  → Tool includes correlationId: "abc123" internally
  → POST /api/sessions/session-2/messages { correlationId: "abc123" }

Session-2 agent calls create_agent_session(target: session-1)  
  → Tool includes correlationId: "abc123"
  → POST /api/sessions/session-1/messages { correlationId: "abc123" }
```

All calls share `abc123` - they're part of one flow.

### Detection
- POST without `fromSession` → User action, new correlation ID
- POST with `fromSession` → Agent action, requires correlation ID
- Missing correlation ID on agent call → Reject (400)

---

## Stack Collapse Algorithm

### Purpose
Detect the "effective chain depth" by collapsing returns.

### Algorithm
```typescript
function collapseChain(rawChain: string[]): string[] {
  const stack: string[] = [];
  
  for (const sessionId of rawChain) {
    const existingIndex = stack.indexOf(sessionId);
    if (existingIndex !== -1) {
      // Return to existing session - pop back to it
      stack.length = existingIndex + 1;
    } else {
      // New session - push
      stack.push(sessionId);
    }
  }
  
  return stack;
}
```

### Examples
```
collapseChain([1, 2, 1])       → [1]        (returned to 1, stack collapsed)
collapseChain([1, 2, 1, 2])    → [1, 2]     (back to 2)
collapseChain([1, 2, 1, 2, 1]) → [1]        (fully collapsed)
collapseChain([1, 2, 3])       → [1, 2, 3]  (no returns, chain grows)
collapseChain([1, 2, 1, 3])    → [1, 3]     (returned to 1, then called 3)
collapseChain([1, 2, 1, 3, 1]) → [1]        (complex but collapses fully)
```

### Why This Works
- **Delegation pattern** `1→2→1` collapses to `[1]` - depth 1
- **Oscillation** `1→2→1→2→1` collapses to `[1]` - depth 1  
- **Deep chain** `1→2→3→4→5` stays `[1,2,3,4,5]` - depth 5
- **Multi-peer** `1→2→1→3→1` becomes `[1,3]` then `[1]` - depth 1

The collapsed stack represents the "call depth" at any moment.

---

## Rules Engine Design (Revised)

### Correlation Flow Tracking
```typescript
interface CorrelationFlow {
  correlationId: string;
  rawChain: string[];           // [1, 2, 1, 2, 1]
  collapsedStack: string[];     // [1] after collapse
  uniqueSessions: Set<string>;  // {1, 2}
  startTime: number;            // First call timestamp
  lastCallTime: number;         // Most recent call
  callCount: number;            // Total calls in flow
}
```

### Guard State
```typescript
class RunawayGuard {
  // correlationId → flow metrics
  private flows = new Map<string, CorrelationFlow>();
  
  checkCallAllowed(call: {
    correlationId: string;
    fromSession: string | null;
    toSession: string;
  }): Result<true, string>;
}
```

---

## Rules (Revised)

### Input Data
Each POST to `/api/sessions/:id/messages` includes:
- `correlationId` (string, required for agent calls)
- `fromSession` (string | null) - null means user-initiated
- Target session from URL path

### Rule 1: Correlation ID Required for Agent Calls
```
IF fromSession != null AND !correlationId
THEN reject("Agent calls must include correlation ID")
```

### Rule 2: Max Collapsed Stack Depth
```
collapsed = collapseChain(flow.rawChain + [toSession])
IF collapsed.length > MAX_STACK_DEPTH
THEN reject("Effective call depth exceeded")

DEFAULT: MAX_STACK_DEPTH = 5
```
**Rationale:** Collapsed depth represents actual delegation depth. `1→2→1→2→1` is fine (depth 1), but `1→2→3→4→5→6` is not (depth 6).

### Rule 3: Max Unique Sessions Per Flow
```
IF flow.uniqueSessions.size > MAX_UNIQUE_SESSIONS
THEN reject("Too many unique sessions in flow")

DEFAULT: MAX_UNIQUE_SESSIONS = 10
```
**Rationale:** Even with good collapse, involving 10+ different sessions suggests poor design.

### Rule 4: Max Flow Duration
```
IF (now - flow.startTime) > MAX_DURATION
THEN reject("Flow timeout")

DEFAULT: MAX_DURATION = 5 minutes
```

### Rule 5: Max Call Rate
```
IF flow.callCount > MAX_CALLS AND (now - flow.startTime) < 60 seconds
THEN reject("Call rate limit exceeded")

DEFAULT: MAX_CALLS = 20 calls per minute
```
**Rationale:** 20 calls/minute allows rapid work. More suggests tight loop.

### Rule 6: Max Total Calls Per Flow
```
IF flow.callCount > MAX_TOTAL_CALLS
THEN reject("Total call limit exceeded")

DEFAULT: MAX_TOTAL_CALLS = 100
```
**Rationale:** Any single flow making 100+ calls is runaway.

---

## Implementation Strategy

### Phase 1: Correlation ID in Client
1. Generate UUID on user-initiated send
2. Include in POST body as `correlationId`
3. Pass to agent tools automatically

### Phase 2: Runaway Guard Module
```typescript
// runaway-guard.ts
export class RunawayGuard {
  checkCallAllowed(call: AgentCall): Result<true, string>;
  recordCall(call: AgentCall): void;
  cleanupExpiredFlows(): void;
}
```

### Phase 3: Integration Points
1. **stream.ts** - Call guard before dispatching message
2. **agent-tools.ts** - Pass correlationId to `create_agent_session` tool
3. **main.ts (client)** - Generate correlationId for user actions

### Phase 4: Configuration
```typescript
// runaway-config.ts
export const RUNAWAY_LIMITS = {
  maxStackDepth: 5,           // Collapsed stack depth
  maxUniqueSessions: 10,      // Unique sessions per flow  
  maxDuration: 5 * 60,        // 5 minutes
  maxCallsPerMinute: 20,      // Rate limit
  maxTotalCalls: 100,         // Total calls per flow
};
```

---

## Data Structures

### Call Chain
```typescript
interface CallChain {
  flowId: string;           // ID of first session in chain
  chain: string[];          // [1, 2, 1, 2, 1]
  startTime: number;        // Timestamp of first call
  calls: CallRecord[];      // Detailed call history
}

interface CallRecord {
  from: string;
  to: string;
  timestamp: number;
  hadWork: boolean;         // Did agent use tools or create outputs?
}
```

### Guard State
```typescript
class RecursionGuard {
  private activeFlows = new Map<string, CallChain>();
  private sessionCallCounts = new Map<string, number[]>();  // session → [timestamps]
  
  checkCallAllowed(call: AgentCall): Result<true, string>;
  recordCall(call: AgentCall): void;
  cleanupOldFlows(): void;
}
```

---

## Error Messages (User-Facing)

```
"Agent call rejected: chain too deep (max 5 hops)"
"Agent call rejected: too many returns to session X (max 4 revisits)"
"Agent call rejected: self-calls not allowed"
"Agent call rejected: flow timeout (max 5 minutes)"
"Agent call rejected: rate limit exceeded (max 10 calls/minute)"
```

---

## Edge Cases

### Parallel Calls
```
Session 1 → Session 2 (call A)
Session 1 → Session 3 (call B, parallel)
```
**Handling:** Each creates separate flow. Track by flowId (originating session).

### Resume After Break
```
Session 1 → Session 2 → Session 1
[5 minute pause]
Session 1 → Session 2 (new flow)
```
**Handling:** After MAX_DURATION, flow expires. New call starts fresh chain.

### User-Initiated Call in Middle of Flow
```
Session 1 → Session 2 (agent-to-agent)
[User manually sends to Session 2]
```
**Handling:** User messages don't participate in recursion tracking. Only agent-to-agent via `fromSession` parameter.

---

## Testing Scenarios

### Stack Collapse Tests
```typescript
test('collapseChain', () => {
  expect(collapseChain(['1', '2', '1'])).toEqual(['1']);
  expect(collapseChain(['1', '2', '1', '2'])).toEqual(['1', '2']);
  expect(collapseChain(['1', '2', '1', '2', '1'])).toEqual(['1']);
  expect(collapseChain(['1', '2', '3'])).toEqual(['1', '2', '3']);
  expect(collapseChain(['1', '2', '1', '3'])).toEqual(['1', '3']);
  expect(collapseChain(['1', '2', '1', '3', '1'])).toEqual(['1']);
});
```

### Guard Tests
1. **Simple delegation:** `1 → 2 → 1` - ALLOWED (depth 1)
2. **Bounded oscillation:** `1 → 2 → 1 → 2 → 1` - ALLOWED (depth 1)
3. **Deep chain:** `1 → 2 → 3 → 4 → 5 → 6` - REJECTED (depth 6)
4. **Multi-peer normal:** `1 → 2 → 1 → 3 → 1` - ALLOWED (depth 1)
5. **Too many sessions:** Flow with 11 unique sessions - REJECTED
6. **Rate limit:** 21 calls in 60 seconds - REJECTED
7. **Timeout:** Flow lasting 6 minutes - REJECTED
8. **Total calls:** Flow with 101 calls - REJECTED

---

## Configuration Override (Future)

Allow per-session customization via `.caco/recursion-limits.json`:
```json
{
  "maxDepth": 7,
  "maxRevisits": 5,
  "maxCallsPerMinute": 20
}
```

For power users who know what they're doing.

---

## Monitoring & Logging

Log when rules trigger:
```
[RECURSION] Rejected call 1→2: chain depth 6 exceeds max 5
[RECURSION] Rejected call 2→1: 5 revisits exceeds max 4
[RECURSION] Warning: rapid calls from session 1 with no work detected
```

Track metrics:
- Total agent-to-agent calls
- Rejected calls by rule
- Average chain depth
- Longest successful chain

---

## Error Messages (User-Facing)

```
"Agent call rejected: correlation ID required for agent-initiated calls"
"Agent call rejected: effective call depth 6 exceeds limit (max 5)"
"Agent call rejected: flow involves too many sessions (11, max 10)"
"Agent call rejected: flow timeout (max 5 minutes)"
"Agent call rejected: call rate limit exceeded (max 20/minute)"
"Agent call rejected: total call limit exceeded (max 100 per flow)"
```

---

## Open Questions

1. ~~How to pass correlationId through MCP tools?~~ **CURRENT GAP - See Implementation Status**

2. **Should collapsed depth count the current session?**
   - Example: `[1, 2]` - is this depth 2 or depth 1?
   - **Proposal:** Length of collapsed stack = depth. `[1, 2]` is depth 2.

3. **Cleanup timing for expired flows?**
   - Run cleanup every N minutes
   - Run cleanup on each call (lazy)
   - **Proposal:** Lazy cleanup - check expiration on each call, clean if needed

4. **What if legitimate use needs >5 depth?**
   - **Proposal:** Make limits configurable, but document that >5 is a design smell

---

## Implementation Status

### ✅ Implemented

**Correlation tracking infrastructure:**
- Server-side correlation metrics tracking (`src/correlation-metrics.ts`)
- Runaway rules engine (`src/rules-engine.ts`)
- Chain collapse algorithm (`src/chain-stack.ts`)
- POST `/api/sessions/:id/messages` requires correlationId for agent calls (has `fromSession`)

**correlationId is invisible to agents:**
- Server generates `correlationId` for all user/applet/scheduler messages (new flows)
- Agent tools inherit `correlationId` from dispatch context (no LLM round-trip)
- `sessionManager.setDispatchContext(sessionId, correlationId)` called before dispatch
- `send_agent_message` reads context: `sessionManager.getDispatchContext(sessionRef.id)`
- Context cleared after dispatch completes

### Flow

```
User message POST (no correlationId)
  → Server generates: effectiveCorrelationId = randomUUID()
  → sessionManager.recordAgentCall(effectiveCorrelationId, sessionId)
  → dispatchMessage(..., correlationId: effectiveCorrelationId)
    → sessionManager.setDispatchContext(sessionId, correlationId)
    → SDK processes, agent calls send_agent_message tool
      → Tool reads: sessionManager.getDispatchContext(sessionRef.id)
      → Tool POSTs with correlationId (invisible to agent)
    → on idle: sessionManager.clearDispatchContext(sessionId)
```

### Runaway Prevention

- Agent-to-agent calls validated via `checkAgentCall(correlationId, sessionId)`
- Rules: max chain depth, rate limits, self-call prevention
- Same correlationId propagates through entire flow
- All calls (including user-initiated) tracked in metrics

