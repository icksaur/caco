# Out-of-Band Agent Input

## Overview

Inject content into a busy agent session to change its course without interrupting the "premium request." This allows automated external factors (similar to stop or permission requests) to influence agent behavior mid-execution.

## Problem Statement

Currently, when an agent is streaming a response, there's no way to inject information or directives from external sources without:
- Waiting for the agent to finish its current response
- Interrupting/stopping the agent entirely
- Losing the context of the current premium request

This limits the ability for:
- Real-time monitoring systems to alert agents
- External services to provide updated information
- Coordinating agents to share urgent updates
- Time-sensitive notifications to redirect agent work

## Use Cases

1. **Multi-agent coordination**: Agent A discovers critical information that Agent B (currently streaming) needs immediately
2. **External monitoring**: A file watcher detects changes that invalidate the agent's current approach
3. **User escalation**: User wants to add constraints or redirect without stopping the current work
4. **Time-sensitive updates**: New information arrives (API response, build failure) that changes requirements
5. **Resource alerts**: System detects memory/CPU issues requiring the agent to change strategy

## Requirements

### Functional Requirements

1. **Non-disruptive injection**: Must not terminate or restart the current response stream
2. **Priority handling**: Out-of-band messages should be processed with configurable priority
3. **Context preservation**: Agent retains awareness of both original task and injected content
4. **Source attribution**: Agent knows the origin of out-of-band input (user, agent, system)
5. **Visibility**: Injected content should be visible in chat UI (distinguished from regular messages)
6. **Agent acknowledgment**: Agent can acknowledge receipt and indicate how it's adapting

### Non-functional Requirements

1. **Low latency**: Injection should reach agent within 100ms
2. **Reliable delivery**: Messages must not be lost or duplicated
3. **State safety**: Must not corrupt agent state or cause race conditions
4. **Backwards compatible**: Existing sessions should continue to work

## Current SDK Limitations

**As of investigation 2026-02-08, the Copilot-CLI SDK does NOT support out-of-band injection during active sessions.**

### Existing Constraints:

1. **Sequential Processing Only**: The SDK enforces one message at a time per session
   - Attempting to send while busy returns `409 SESSION_BUSY` error
   - Hard check in `/src/routes/session-messages.ts:77-79`

2. **No Message Queue**: No built-in queueing mechanism for concurrent messages
   - Multiple sends are rejected immediately at HTTP layer
   - No buffering or priority handling

3. **No In-Flight Injection**: Cannot inject content into active streaming
   - System messages only at session creation or resume
   - No API to insert messages mid-turn

### Available Hooks:

✅ **Event subscription** via `session.on()` - listen to events while streaming  
✅ **Abort capability** via `session.abort()` - stop streaming  
✅ **Session state** via `sessionManager.isBusy()` - check if busy  
✅ **Session access** via `sessionManager.getSession()` - get live session object

### What Must Be Built:

To implement out-of-band injection, we need:

1. **Message Queue Per Session**: Buffer OOB messages with priority handling
2. **Injection Mechanism**: Insert messages at safe points (between tool calls)
3. **Bypass Busy Check**: Allow OOB messages even when session is busy
4. **Event Protocol**: Define how OOB messages reach the agent's context

This feature requires **new capabilities at the SDK/wrapper layer**, not just using existing APIs.

---

## Technical Design

### Message Structure

```typescript
interface OutOfBandMessage {
  id: string;
  sessionId: string;
  source: 'user' | 'agent' | 'system' | 'external';
  sourceId?: string; // Agent session ID or system component name
  priority: 'low' | 'normal' | 'high' | 'critical';
  timestamp: number;
  content: string;
  metadata?: {
    relatedTo?: string; // Message or tool call ID
    action?: 'inform' | 'redirect' | 'abort' | 'enhance';
    [key: string]: any;
  };
}
```

### Architecture

#### 1. Session Message Queue Enhancement
Since the SDK blocks concurrent sends, we need to work around this:
- **Option A**: Queue OOB messages and inject on next turn (after current response completes)
- **Option B**: Modify session dispatch to allow OOB bypass of busy check
- **Option C**: Use session context manipulation to inject before next tool call

**Recommended: Option B** - Add special handling in `/src/routes/session-messages.ts`:
```typescript
// Allow OOB messages even when busy
if (sessionManager.isBusy(sessionId) && !isOutOfBandMessage) {
  return res.status(409).json({ error: 'Session is busy' });
}
```

#### 2. OOB Message Buffering
- Maintain `oobQueue: Map<sessionId, OutOfBandMessage[]>` in SessionManager
- Buffer messages by priority during active streaming
- Inject at safe points using event subscription hooks

#### 3. Injection Strategy
Since we can't interrupt mid-stream, we use the event listener pattern:

```typescript
session.on((event) => {
  if (event.type === 'tool.execution_complete') {
    // Tool just finished - safe injection point
    const oobMessages = getQueuedOOBMessages(sessionId);
    if (oobMessages.length > 0) {
      injectAsSystemMessage(session, oobMessages);
    }
  }
});
```

**Injection points:**
- **Between tool calls**: Most natural, agent can adjust next action
- **After turn completion**: Queue for next user message (safest)
- **Before tool execution**: For critical priority only

#### 4. Context Injection Methods

**Method A: Append to next message** (Safest)
- Queue OOB messages
- When session becomes idle, prepend to next user message as system context
- No SDK modification needed

**Method B: Tool result manipulation** (Medium complexity)
- Inject OOB content into tool result text
- Agent sees it as part of tool output
- Requires intercepting tool.execution_complete events

**Method C: SDK extension** (Most powerful, requires SDK fork)
- Add `session.injectSystemMessage()` method to SDK
- Directly manipulate conversation context
- Full control but requires maintaining SDK fork

**Recommended: Start with Method A**, upgrade to C if needed.

#### 5. UI Representation
```
┌────────────────────────────────────────┐
│ 🔔 Out-of-band message from Agent-2   │
│ Priority: High                          │
│                                         │
│ "Build failed on test suite. Consider  │
│  skipping integration tests."           │
└────────────────────────────────────────┘
```

### API Design

#### Server-side API
```typescript
// Inject message into active session
function injectOutOfBand(
  sessionId: string,
  message: Omit<OutOfBandMessage, 'id' | 'timestamp'>
): Promise<void>

// From agent-to-agent
function sendOutOfBand(
  targetSessionId: string,
  content: string,
  priority?: Priority
): Promise<void>
```

#### Client Tool
```typescript
// Available to agents
tool('send_out_of_band', {
  sessionId: 'string',
  content: 'string',
  priority: 'low' | 'normal' | 'high' | 'critical'
})
```

### Implementation Phases

#### Phase 1: Basic Infrastructure (MVP)
- [ ] Create OOB message queue in SessionManager
- [ ] Add `/api/sessions/:id/oob` endpoint (bypass busy check)
- [ ] Implement Method A: Queue and prepend to next message
- [ ] Add basic UI indicator for queued OOB messages
- [ ] Create `send_out_of_band` tool for agents

#### Phase 2: Event-Based Injection
- [ ] Subscribe to `tool.execution_complete` events per session
- [ ] Implement Method B: Inject via tool result manipulation
- [ ] Add priority-based injection timing
- [ ] Test with multi-agent coordination scenarios

#### Phase 3: SDK Enhancement (Optional)
- [ ] Fork/extend SDK to add `session.injectSystemMessage()`
- [ ] Implement Method C: Direct context manipulation
- [ ] Add delivery confirmation/acknowledgment
- [ ] Performance testing under load

#### Phase 4: Polish & Integration
- [ ] UI improvements (show OOB status in session list)
- [ ] Agent prompt updates to handle OOB gracefully
- [ ] Documentation and examples
- [ ] Integration with file watchers, build systems

## Considerations

### Agent Prompt Design
The agent must understand how to handle OOB input:
```
When you receive <out_of_band> messages during a task:
- Acknowledge the message
- Assess if it requires changing your approach
- If critical, explain how you're adapting
- If informational, note it and continue
- If contradictory, ask for clarification
```

### Potential Issues

1. **Cognitive load**: Too many OOB messages could confuse agents
   - Solution: Rate limiting, priority filtering, batching
   
2. **Prompt injection**: Malicious OOB content
   - Solution: Clear XML tags, source attribution, sandboxing

3. **Race conditions**: OOB arrives during tool execution
   - Solution: Queue until safe injection point

4. **Context window**: OOB messages consume tokens
   - Solution: Summarize/compress old OOB messages, configurable retention

5. **User confusion**: OOB messages appearing during unrelated work
   - Solution: Clear UI distinction, optional user approval for non-critical

## Success Metrics

- **Latency**: OOB messages delivered within 100ms
- **Adoption**: Used in >20% of multi-agent workflows
- **Effectiveness**: Reduces time to completion in >50% of cases where used
- **Reliability**: <0.1% message loss rate
- **User satisfaction**: Positive feedback on feature utility

## Related Documentation

- [Agent-to-Agent Communication](agent-to-agent.md)
- [Session Management](session-management.md)
- [WebSocket Protocol](websocket.md)
- [Security Considerations](security.md)

## Open Questions

1. Should users be able to disable OOB input for privacy/focus?
2. How to handle OOB messages when agent is in tool-only mode (task agent)?
3. Should there be a way to "undo" or "override" an OOB message?
4. How to visualize OOB message flow in multi-agent scenarios?
5. Should agents be able to "subscribe" to specific types of OOB messages?
6. **Should we fork the SDK or work within current constraints?**
7. **What's the acceptable latency for Method A (queue until idle)?**
8. **How do we test OOB effectiveness without real concurrent workloads?**

## Example Scenarios

### Scenario 1: Agent Coordination
```
Agent-A (streaming): "Analyzing the authentication module..."
Agent-B sends OOB: "I found a breaking change in auth.ts that was just committed"
Agent-A (adapts): "I've just received information about a breaking change. 
                   Let me adjust my analysis to account for this..."
```

### Scenario 2: Build System Integration
```
Agent (streaming): "Refactoring the API endpoints..."
Build System sends OOB: "Unit tests failing after your recent changes"
Agent (adapts): "I see tests are failing. Let me review what I changed and fix that first..."
```

### Scenario 3: User Refinement
```
Agent (streaming): "Creating comprehensive documentation..."
User sends OOB: "Focus on API docs only, skip implementation details"
Agent (adapts): "Adjusting scope - I'll focus exclusively on API documentation..."
```
