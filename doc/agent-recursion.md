# Agent Runaway Guard

**Goal:** Prevent runaway agent-to-agent calls while allowing legitimate delegation patterns including recursion.

**Scope:** Cooperative safety for single-user situated software. Not abuse prevention, just error prevention.

---

## Valid Patterns

### 1. Simple Delegation: `1 → 2 → 1`
Outer agent delegates work, inner agent reports back. Clean handoff.

### 2. Oscillating Collaboration: `1 → 2 → 1 → 2 → 1 → 2 → 1`
Back-and-forth where outer maintains state, inner does discrete tasks. Bounded iteration.

---

## Suspicious Patterns

| Pattern | Example | Risk |
|---------|---------|------|
| Long chain | `1 → 2 → 3 → 4 → 5` | High — buck-passing |
| Self-loop | `1 → 1 → 1 → 1` | Critical — infinite loop |
| Unbounded oscillation | `1 → 2 → 1 → 2 ...` (no exit) | High — burns budget |
| Rapid-fire no work | Many calls, no tool usage | Medium — conversation loop |
| Long duration | Any flow >5 minutes | Medium — stuck or poor design |

---

## Correlation ID System

### Solution: Client-Generated Correlation GUID
1. **User-initiated POST**: Client generates new GUID for each independent action
2. **Agent-initiated POST**: MCP tool `create_agent_session` automatically passes correlation GUID
3. **Session manager**: Tracks metrics per correlation ID

All calls in a flow share the same correlation ID.

- POST without `fromSession` → User action, new correlation ID
- POST with `fromSession` → Agent action, requires correlation ID
- Missing correlation ID on agent call → Reject (400)

---

## Stack Collapse Algorithm

Detect the "effective chain depth" by collapsing returns.

```typescript
function collapseChain(rawChain: string[]): string[] {
  const stack: string[] = [];
  for (const sessionId of rawChain) {
    const existingIndex = stack.indexOf(sessionId);
    if (existingIndex !== -1) {
      stack.length = existingIndex + 1;  // Return to existing session - pop back
    } else {
      stack.push(sessionId);  // New session - push
    }
  }
  return stack;
}
```

**Why this works:**
- Delegation `1→2→1` collapses to `[1]` — depth 1
- Oscillation `1→2→1→2→1` collapses to `[1]` — depth 1
- Deep chain `1→2→3→4→5` stays `[1,2,3,4,5]` — depth 5

---

## Rules

### Correlation Flow Tracking
```typescript
interface CorrelationFlow {
  correlationId: string;
  rawChain: string[];
  collapsedStack: string[];
  uniqueSessions: Set<string>;
  startTime: number;
  lastCallTime: number;
  callCount: number;
}
```

### Rule 1: Correlation ID Required for Agent Calls
Agent calls without correlation ID are rejected.

### Rule 2: Max Collapsed Stack Depth (default: 5)
Collapsed depth represents actual delegation depth. `1→2→1→2→1` is fine (depth 1), but `1→2→3→4→5→6` is not (depth 6).

### Rule 3: Max Unique Sessions Per Flow (default: 10)
Even with good collapse, involving 10+ sessions suggests poor design.

### Rule 4: Max Flow Duration (default: 5 minutes)

### Rule 5: Max Call Rate (default: 20 calls/minute)
Allows rapid work. More suggests tight loop.

### Rule 6: Max Total Calls Per Flow (default: 100)

---

## Edge Cases

### Parallel Calls
`Session 1 → Session 2` and `Session 1 → Session 3` simultaneously — each creates separate flow.

### Resume After Break
After MAX_DURATION, flow expires. New call starts fresh chain.

### User-Initiated Call in Middle of Flow
User messages don't participate in recursion tracking. Only agent-to-agent via `fromSession`.

---

## Implementation Status

### Implemented

- Server-side correlation metrics tracking (`src/correlation-metrics.ts`)
- Runaway rules engine (`src/rules-engine.ts`)
- Chain collapse algorithm (`src/chain-stack.ts`)
- POST requires correlationId for agent calls (has `fromSession`)
- correlationId invisible to agents — server generates for user/applet/scheduler, agent tools inherit from dispatch context

### Flow

```
User POST → server generates correlationId
  → sessionManager.recordAgentCall(correlationId, sessionId)
  → dispatchMessage with correlationId
    → setDispatchContext(sessionId, correlationId)
    → agent calls send_agent_message → reads dispatch context → POSTs with correlationId
    → on idle: clearDispatchContext(sessionId)
```

---

## Open Questions

1. Should collapsed depth count the current session? (Proposal: yes, length = depth)
2. Cleanup timing for expired flows? (Proposal: lazy — check on each call)
3. What if legitimate use needs >5 depth? (Proposal: configurable, but >5 is a design smell)

