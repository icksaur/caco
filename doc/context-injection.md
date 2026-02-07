# Context Injection System (Out-of-Band Agent Input)

## Overview

The **Context Injection System** enables external sources to inject real-time context into active agent sessions without interrupting streaming responses. This allows agents to receive updates from webhooks, file watchers, monitoring systems, other agents, and scheduled jobs while maintaining their current response flow.

### Design Philosophy

The system follows Caco's core principles:

- **Pull-based, not push-based** - Agents explicitly check for input using tools
- **Transparent provenance** - All inputs use `[source:id]` prefixing pattern  
- **Correlation-aware** - Participates in runaway prevention system
- **API-first** - No client-side session tracking dependencies
- **Explicit over implicit** - Agent chooses when and how to consume input

This design avoids interrupting the "premium request" stream while enabling real-time contextual awareness.

---

## Use Cases

### Real-Time Agent Coordination
**Scenario:** Agent A delegates work to Agent B. Agent B is working on a complex analysis when Agent A discovers a critical constraint change.

**Without context injection:** Agent A must wait for B to finish, then send a new message (potentially wasting B's work).

**With context injection:** Agent A enqueues an update. Agent B proactively checks the queue mid-task, adjusts approach, and continues seamlessly.

### File Watcher Integration
**Scenario:** Agent is refactoring test suite. Tests run in background via file watcher.

**Workflow:**
1. Agent modifies test files
2. Watcher detects changes, runs tests, enqueues results
3. Agent checks queue periodically: `check_input_queue(source: 'filesystem')`
4. Discovers test failures, adjusts refactoring strategy

### Webhook Event Handling
**Scenario:** Agent monitoring deployment receives status updates from CI/CD pipeline.

**Workflow:**
1. External system POSTs deployment events to `/api/sessions/:id/input`
2. Agent polls between analysis steps: `check_input_queue(source: 'webhook')`
3. Reacts to failures immediately without manual user intervention

### Scheduled Context Updates
**Scenario:** Agent performs long-running security analysis. Scheduled job periodically scans for new vulnerabilities.

**Workflow:**
1. Scheduler runs job every 15 minutes
2. Job enqueues findings in agent's input queue
3. Agent retrieves updates: `check_input_queue(source: 'scheduler')`
4. Incorporates new findings into ongoing analysis

### Applet User Feedback
**Scenario:** Agent presents UI with multiple options. While user deliberates, agent prepares supporting context for each option.

**Workflow:**
1. Applet displays options to user
2. Agent continues preparing background analysis
3. User selects option → applet enqueues selection
4. Agent checks queue, receives selection, responds immediately with pre-prepared context

---

## Architecture

### Core Components

#### InputQueue Service

Singleton service managing per-session input queues:

```typescript
class InputQueue {
  private queues: Map<sessionId, QueuedInput[]>;
  
  // Add input from external source
  enqueue(sessionId: string, input: QueuedInput): string;
  
  // Retrieve and remove pending inputs
  dequeue(sessionId: string, options?: DequeueOptions): QueuedInput[];
  
  // Check without dequeuing
  peek(sessionId: string, filter?: InputFilter): number;
  
  // Remove expired inputs
  cleanup(): void;
}
```

#### QueuedInput Data Model

```typescript
interface QueuedInput {
  id: string;                    // Unique identifier (UUID)
  source: InputSource;           // Origin classification
  sourceId: string;              // Specific source identifier
  content: string;               // The message/data
  metadata?: Record<string, any>; // Extensible context
  timestamp: Date;               // When enqueued
  expiresAt?: Date;              // Auto-cleanup time
  priority?: 'low' | 'normal' | 'high';
  correlationId?: string;        // For agent-spawned flows
}

type InputSource = 
  | 'webhook'      // External HTTP callbacks
  | 'scheduler'    // Scheduled job updates
  | 'filesystem'   // File watcher events
  | 'agent'        // Agent-to-agent messages
  | 'applet'       // Applet state changes
  | 'monitoring';  // System alerts
```

### Message Flow

```
External Source
    |
    | POST /api/sessions/:id/input
    v
InputQueue.enqueue()
    |
    | Stores in memory (per session)
    v
Queue Storage
    |
    | Agent calls check_input_queue tool
    v
InputQueue.dequeue()
    |
    | Returns formatted inputs
    v
Agent receives: "[webhook:github] Deployment failed..."
```

---

## API Reference

### HTTP Endpoints

#### POST /api/sessions/:id/input

Enqueue input for a specific session.

**Request:**
```json
{
  "source": "webhook",
  "sourceId": "github-deploy",
  "content": "Deployment to staging failed: connection timeout",
  "metadata": {
    "repo": "myorg/myapp",
    "commit": "abc123",
    "environment": "staging"
  },
  "ttl": 300,
  "priority": "high"
}
```

**Parameters:**
- `source` (required): Input source type
- `sourceId` (required): Identifier for specific source instance
- `content` (required): The message content
- `metadata` (optional): Additional structured context
- `ttl` (optional): Time-to-live in seconds (default: 300)
- `priority` (optional): `low` | `normal` | `high` (default: `normal`)

**Response:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "queued": true
}
```

**Error Codes:**
- `404` - Session not found
- `400` - Invalid input format
- `429` - Rate limit exceeded (10/min per session)

#### GET /api/sessions/:id/input

Retrieve queued inputs without consuming (peek mode).

**Query Parameters:**
- `source` (optional): Filter by input source
- `limit` (optional): Max results (default: 10)
- `priority` (optional): Filter by priority

**Response:**
```json
{
  "inputs": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "source": "webhook",
      "sourceId": "github-deploy",
      "content": "Deployment to staging failed",
      "metadata": { ... },
      "timestamp": "2026-02-07T23:30:00.000Z",
      "priority": "high"
    }
  ],
  "total": 1
}
```

---

## Agent Tools

### check_input_queue

Retrieve external input injected into the session.

**Tool Definition:**
```typescript
{
  name: 'check_input_queue',
  description: 'Check for external input injected into your session (webhooks, file changes, agent messages, scheduled updates). Returns pending messages that influenced your task context.',
  parameters: {
    source: {
      type: 'string',
      enum: ['webhook', 'scheduler', 'filesystem', 'agent', 'applet', 'monitoring'],
      description: 'Filter by input source type (optional)'
    },
    peek: {
      type: 'boolean',
      description: 'If true, view without removing from queue (default: false)'
    },
    limit: {
      type: 'number',
      description: 'Max inputs to retrieve (default: 10, max: 50)'
    }
  }
}
```

**Example Usage (Agent Perspective):**

```
I'll check if there are any updates from the deployment webhook:

<check_input_queue>
  <source>webhook</source>
  <limit>5</limit>
</check_input_queue>
```

**Tool Result:**
```json
[
  {
    "formatted": "[webhook:github-deploy] Deployment to staging failed: connection timeout",
    "metadata": {
      "repo": "myorg/myapp",
      "commit": "abc123",
      "environment": "staging"
    },
    "timestamp": "2026-02-07T23:30:00.000Z",
    "priority": "high"
  }
]
```

**Behavior:**
- By default, **consumes** inputs (removes from queue)
- `peek: true` allows checking without dequeuing
- Returns empty array if no matching inputs
- Results automatically formatted with source prefix
- Expired inputs automatically filtered out

### wait_for_input (Advanced)

Block until external input arrives or timeout expires.

**Tool Definition:**
```typescript
{
  name: 'wait_for_input',
  description: 'Block until external input arrives or timeout expires. Use when you need to synchronize with a specific external event.',
  parameters: {
    source: {
      type: 'string',
      enum: ['webhook', 'scheduler', 'filesystem', 'agent', 'applet', 'monitoring'],
      description: 'Filter by input source type (optional)'
    },
    timeout: {
      type: 'number',
      description: 'Seconds to wait (default: 30, max: 180)'
    },
    filter: {
      type: 'object',
      description: 'Match specific metadata fields (e.g., {"jobId": "scan-123"})'
    }
  }
}
```

**Example Usage:**
```
I'll wait for the security scan job to complete:

<wait_for_input>
  <source>scheduler</source>
  <timeout>120</timeout>
  <filter>{"jobId": "security-scan-001"}</filter>
</wait_for_input>
```

**Behavior:**
- Uses async polling (100ms intervals)
- Returns immediately if matching input already queued
- Returns empty array on timeout
- Consumes matched inputs (removes from queue)

**Use Cases:**
- Synchronizing with scheduled jobs
- Waiting for user selection in applet
- Coordinating multi-agent workflows with dependencies

---

## Integration Patterns

### Agent-to-Agent Communication

Enhanced `send_agent_message` with queue option.

**Standard Messaging (Existing):**
```typescript
// Sends message immediately, interrupts target if busy
send_agent_message(targetSessionId, "Task complete: analysis results")
```

**Queued Messaging (New):**
```typescript
// Enqueues message, target retrieves when ready
send_agent_message(targetSessionId, "Update: found security issue", {
  queue: true,
  priority: "high",
  metadata: { issueType: "sql-injection", severity: 9 }
})
```

**Receiver Pattern:**
```javascript
// Agent B working on task, checks periodically
const updates = await check_input_queue({ source: 'agent' });

if (updates.length > 0) {
  // Process updates from Agent A
  updates.forEach(update => {
    console.log(`Received: ${update.formatted}`);
    // Adjust strategy based on update.metadata
  });
}
```

### Scheduler Integration

Scheduled jobs can push results/updates to active agent sessions.

**Job Implementation:**
```typescript
// In scheduled job handler
async function runSecurityScan(context: SchedulerContext) {
  const results = await performScan();
  
  // Find active sessions monitoring this scan
  const sessions = await findMonitoringSessions('security-scan');
  
  for (const sessionId of sessions) {
    await inputQueue.enqueue(sessionId, {
      source: 'scheduler',
      sourceId: context.slug,
      content: `Security scan complete: ${results.summary}`,
      metadata: {
        jobId: context.jobId,
        vulnerabilities: results.vulnerabilities,
        scanTime: results.duration
      },
      ttl: 600 // 10 minutes
    });
  }
}
```

**Agent Pattern:**
```javascript
// Agent initiates scan, continues other work
await scheduleJob('security-scan', { ... });

// Later, check for results
const scans = await check_input_queue({ 
  source: 'scheduler',
  limit: 1
});

if (scans.length > 0) {
  const results = scans[0].metadata.vulnerabilities;
  // Process scan results
}
```

### File Watcher Pattern

Monitor filesystem changes and inject events.

**Watcher Implementation:**
```typescript
import fs from 'fs';
import { inputQueue } from './services/input-queue';

function watchDirectory(path: string, sessionId: string) {
  fs.watch(path, { recursive: true }, async (event, filename) => {
    await inputQueue.enqueue(sessionId, {
      source: 'filesystem',
      sourceId: path,
      content: `File ${event}: ${filename}`,
      metadata: {
        path: `${path}/${filename}`,
        event: event, // 'rename' | 'change'
        timestamp: Date.now()
      },
      ttl: 60 // Short TTL for high-frequency events
    });
  });
}
```

**Agent Pattern:**
```javascript
// Agent starts task, enables watcher
await startFileWatcher('/home/project/tests');

// Work on refactoring...
await refactorTestSuite();

// Check for test results
const changes = await check_input_queue({ source: 'filesystem' });

for (const change of changes) {
  if (change.metadata.path.includes('test')) {
    // React to test file changes
  }
}
```

### Webhook Integration

External systems POST events to running agents.

**Webhook Endpoint Setup:**
```typescript
// External webhook handler
app.post('/webhooks/github', async (req, res) => {
  const event = req.body;
  
  // Find session monitoring this repo
  const sessionId = await findSessionByRepo(event.repository.full_name);
  
  if (sessionId) {
    await fetch(`http://localhost:3000/api/sessions/${sessionId}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'webhook',
        sourceId: 'github',
        content: `${event.action} on ${event.repository.name}`,
        metadata: event,
        priority: event.action === 'failure' ? 'high' : 'normal'
      })
    });
  }
  
  res.json({ received: true });
});
```

**Agent Pattern:**
```javascript
// Agent monitors deployment
const status = await check_input_queue({ 
  source: 'webhook',
  peek: true // Don't consume yet
});

if (status.some(s => s.metadata.action === 'failure')) {
  // Deployment failed, investigate immediately
  const failures = await check_input_queue({ source: 'webhook' });
  // Process failure details
}
```

### Applet User Interaction

Applets can enqueue user selections for agent consumption.

**Applet Implementation:**
```javascript
// In applet JavaScript
async function sendSelection(option) {
  const sessionId = new URLSearchParams(window.location.search).get('session');
  
  await fetch(`/api/sessions/${sessionId}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: 'applet',
      sourceId: 'option-selector',
      content: `User selected: ${option.label}`,
      metadata: {
        optionId: option.id,
        value: option.value,
        timestamp: Date.now()
      }
    })
  });
  
  showConfirmation('Selection sent to agent');
}
```

**Agent Pattern:**
```javascript
// Agent presents options via applet, continues preparing context
await showApplet('option-selector', { options: [...] });

// Continue other work while user decides
await prepareContextForAllOptions();

// Check for user selection
const selection = await wait_for_input({ 
  source: 'applet',
  timeout: 120
});

if (selection.length > 0) {
  const chosen = selection[0].metadata.optionId;
  // Respond with pre-prepared context
}
```

---

## Message Prefixing & History

### Automatic Prefixing

All inputs retrieved via `check_input_queue` are automatically prefixed following the established `[source:id]` pattern:

```
[webhook:github] Deployment failed on staging
[scheduler:security-scan] Found 3 critical vulnerabilities
[filesystem:/home/project] test.spec.ts modified
[agent:abc123] Subtask completed successfully
[applet:option-selector] User selected: Option A
[monitoring:datadog] CPU usage exceeded 90%
```

This maintains transparency and allows agents to understand context provenance.

### History Persistence

**Important:** Inputs are **not** automatically added to session message history.

**Only added when:**
1. Agent calls `check_input_queue` (tool invocation recorded)
2. Tool result includes prefixed content
3. Agent references input in its response

**Rationale:**
- Prevents history pollution from unread inputs
- Maintains agent control over what becomes context
- Expired inputs never enter history
- Keeps correlation tracking clean

**Example History:**
```
User: Monitor the deployment
Assistant: I'll watch for updates... [calls check_input_queue]
Tool: [webhook:github] Deployment succeeded
Assistant: The deployment completed successfully!
```

---

## Queue Management

### Size Limits

**Per-Session Limits:**
- Max 50 inputs per session
- Eviction strategy: FIFO (oldest first)
- Priority preservation: High-priority inputs resist eviction

**Global Limits:**
- Max 1000 total queued inputs across all sessions
- Per-session rate limit: 10 enqueues/min
- Cleanup runs every 60 seconds

### Expiration

**Default TTL:** 300 seconds (5 minutes)

**Configurable per input:**
```json
{
  "ttl": 600  // 10 minutes
}
```

**Auto-cleanup:**
- Expired inputs automatically removed during cleanup cycle
- Not returned by `check_input_queue` or `peek`
- Cleanup logs count of removed inputs

### Priority Handling

**Three levels:** `low`, `normal`, `high`

**Behavior:**
- `check_input_queue` returns highest priority first
- High-priority inputs resistant to FIFO eviction
- Priority visible in tool results and GET endpoint

**Priority Guidelines:**
- `high`: Critical errors, security alerts, user blocking on response
- `normal`: Standard updates, informational messages (default)
- `low`: Nice-to-have context, background notifications

---

## Correlation & Runaway Prevention

### Correlation ID Propagation

Inputs from agent-spawned activities should include correlation ID:

```typescript
// Agent A enqueues input for Agent B
await inputQueue.enqueue(sessionId, {
  source: 'agent',
  sourceId: originSessionId,
  content: 'Update: constraint changed',
  correlationId: context.correlationId // Inherited from dispatch
});
```

**Why this matters:**
- Maintains depth tracking across input boundaries
- Prevents circumventing runaway guards via queuing
- Enables full flow tracing for debugging

### Depth Tracking

When agent retrieves input with `correlationId` and spawns new agent activity:

```javascript
// Agent B retrieves update from Agent A
const updates = await check_input_queue({ source: 'agent' });

// If spawning new work, inherit correlation
if (updates[0]?.correlationId) {
  await create_agent_session({
    cwd: '/path',
    correlationId: updates[0].correlationId // Inherit for depth tracking
  });
}
```

**Runaway Protection:**
- Correlation depth still enforced (max 5)
- Flow age still tracked (max 5 minutes)
- Rate limits still apply (20 calls/60s)

---

## WebSocket Events

### New Input Notification

When input enqueued, broadcast to all clients subscribed to the session:

**Event:**
```json
{
  "type": "session.input.queued",
  "sessionId": "abc123",
  "input": {
    "id": "550e8400-...",
    "source": "webhook",
    "priority": "high",
    "timestamp": "2026-02-07T23:30:00.000Z"
  }
}
```

**Client Handling:**
- Show badge: "3 pending inputs"
- Color-code by priority (red=high)
- Toast notification if session active
- Update applet UI showing queue status

### Input Consumed Notification

When agent calls `check_input_queue` (not peek mode):

**Event:**
```json
{
  "type": "session.input.consumed",
  "sessionId": "abc123",
  "count": 2,
  "sources": ["webhook", "agent"]
}
```

**Client Handling:**
- Update badge count
- Remove notifications
- Log for debugging

---

## Error Handling

### Invalid Session

**Scenario:** POST to non-existent session ID

**Response:** `404 Not Found`
```json
{
  "error": "Session not found",
  "sessionId": "invalid-id"
}
```

**Handling:** External source should verify session exists before enqueuing

### Rate Limit Exceeded

**Scenario:** More than 10 enqueues/min for a session

**Response:** `429 Too Many Requests`
```json
{
  "error": "Rate limit exceeded",
  "limit": 10,
  "window": "60s",
  "retryAfter": 42
}
```

**Handling:** Implement backoff in external source

### Queue Overflow

**Scenario:** Session already has 50 queued inputs

**Behavior:**
- Oldest input evicted (FIFO)
- High-priority inputs protected
- New input successfully enqueued
- Warning logged

**Response:** `200 OK`
```json
{
  "id": "550e8400-...",
  "queued": true,
  "evicted": {
    "id": "previous-input-id",
    "source": "filesystem"
  }
}
```

### Malformed Input

**Scenario:** Missing required fields or invalid format

**Response:** `400 Bad Request`
```json
{
  "error": "Invalid input",
  "details": "Missing required field: content"
}
```

---

## Security Considerations

### Authentication

**Current State:** No authentication required for POST endpoint

**Recommended for Production:**
```typescript
// API key authentication
app.post('/api/sessions/:id/input', 
  authenticateApiKey,
  validateInputSource,
  async (req, res) => { ... }
);
```

### Source Whitelisting

**Configuration:**
```json
{
  "inputQueue": {
    "allowedSources": {
      "webhook": ["github", "gitlab", "circleci"],
      "monitoring": ["datadog", "sentry"],
      "filesystem": ["/home/project/**"]
    }
  }
}
```

### Content Sanitization

**Considerations:**
- Strip HTML/script tags from content
- Limit content length (max 10KB)
- Validate metadata structure
- Escape special characters in display

### Session Isolation

**Guarantees:**
- Inputs only retrievable by target session
- No cross-session queue access
- Session disposal clears all queued inputs
- Correlation tracking prevents unauthorized spawning

---

## Performance Considerations

### Memory Usage

**In-Memory Queue:**
- 50 inputs × 10KB avg = ~500KB per session
- 100 active sessions = ~50MB total
- Acceptable for most deployments

**Persistent Queue (Future):**
- Redis/DB backend for high-scale deployments
- Reduced memory footprint
- Survives server restarts
- Higher latency (acceptable for async use case)

### Latency

**Enqueue Operation:**
- Target: <5ms (in-memory)
- Current: ~2ms average
- Bottleneck: Correlation validation

**Dequeue Operation:**
- Target: <10ms (in-memory)
- Current: ~5ms average
- Includes filtering, sorting, formatting

### Cleanup Overhead

**Periodic Cleanup:**
- Runs every 60 seconds
- Scans all sessions for expired inputs
- Target: <50ms per cleanup cycle
- Uses lazy deletion (mark-and-sweep)

---

## Testing Strategy

### Unit Tests

```typescript
describe('InputQueue', () => {
  test('enqueue adds input to session queue', () => {
    const id = queue.enqueue('session-1', {
      source: 'webhook',
      sourceId: 'test',
      content: 'Test message'
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/); // UUID
  });

  test('dequeue removes inputs from queue', () => {
    queue.enqueue('session-1', { ... });
    const inputs = queue.dequeue('session-1');
    expect(inputs).toHaveLength(1);
    expect(queue.peek('session-1')).toBe(0); // Empty
  });

  test('peek does not remove inputs', () => {
    queue.enqueue('session-1', { ... });
    queue.peek('session-1');
    expect(queue.peek('session-1')).toBe(1); // Still there
  });

  test('expired inputs not returned', () => {
    queue.enqueue('session-1', {
      ...,
      expiresAt: new Date(Date.now() - 1000) // Expired
    });
    expect(queue.dequeue('session-1')).toHaveLength(0);
  });

  test('priority sorting works', () => {
    queue.enqueue('session-1', { priority: 'low', ... });
    queue.enqueue('session-1', { priority: 'high', ... });
    const inputs = queue.dequeue('session-1');
    expect(inputs[0].priority).toBe('high');
  });

  test('FIFO eviction on overflow', () => {
    for (let i = 0; i < 51; i++) {
      queue.enqueue('session-1', { content: `msg-${i}` });
    }
    const inputs = queue.dequeue('session-1', { limit: 50 });
    expect(inputs[0].content).toBe('msg-1'); // msg-0 evicted
  });

  test('correlation ID preserved', () => {
    queue.enqueue('session-1', {
      correlationId: 'corr-123',
      ...
    });
    const inputs = queue.dequeue('session-1');
    expect(inputs[0].correlationId).toBe('corr-123');
  });
});
```

### Integration Tests

```typescript
describe('Input Queue API', () => {
  test('POST enqueues and returns ID', async () => {
    const res = await request(app)
      .post('/api/sessions/test-session/input')
      .send({
        source: 'webhook',
        sourceId: 'test',
        content: 'Test'
      });
    expect(res.status).toBe(200);
    expect(res.body.queued).toBe(true);
    expect(res.body.id).toBeDefined();
  });

  test('GET retrieves queued inputs', async () => {
    await request(app)
      .post('/api/sessions/test-session/input')
      .send({ ... });
    
    const res = await request(app)
      .get('/api/sessions/test-session/input');
    
    expect(res.status).toBe(200);
    expect(res.body.inputs).toHaveLength(1);
  });

  test('check_input_queue tool retrieves and formats', async () => {
    await request(app)
      .post('/api/sessions/test-session/input')
      .send({
        source: 'webhook',
        sourceId: 'github',
        content: 'Deploy failed'
      });
    
    // Simulate tool call
    const result = await toolHandlers.check_input_queue({
      sessionId: 'test-session'
    });
    
    expect(result[0].formatted).toMatch(/^\[webhook:github\]/);
  });

  test('rate limiting enforced', async () => {
    // Send 11 requests rapidly
    const requests = Array(11).fill(null).map(() =>
      request(app)
        .post('/api/sessions/test-session/input')
        .send({ ... })
    );
    
    const responses = await Promise.all(requests);
    const rateLimited = responses.filter(r => r.status === 429);
    expect(rateLimited.length).toBeGreaterThan(0);
  });
});
```

### End-to-End Tests

```typescript
describe('Input Queue Workflows', () => {
  test('File watcher workflow', async () => {
    // Start session
    const session = await createTestSession();
    
    // Setup file watcher
    const watcher = watchDirectory('/tmp/test', session.id);
    
    // Agent checks queue (empty)
    let inputs = await checkInputQueue(session);
    expect(inputs).toHaveLength(0);
    
    // Modify file
    fs.writeFileSync('/tmp/test/file.txt', 'content');
    await delay(100); // Allow watcher to fire
    
    // Agent checks again (has input)
    inputs = await checkInputQueue(session);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].formatted).toMatch(/\[filesystem:/);
    
    watcher.close();
  });

  test('Agent coordination workflow', async () => {
    const agentA = await createTestSession();
    const agentB = await createTestSession();
    
    // Agent A sends queued message to B
    await sendAgentMessage(agentB.id, 'Update available', {
      queue: true,
      priority: 'high'
    });
    
    // Agent B checks queue
    const inputs = await checkInputQueue(agentB);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].priority).toBe('high');
    expect(inputs[0].formatted).toMatch(/\[agent:/);
  });

  test('Priority handling', async () => {
    const session = await createTestSession();
    
    // Enqueue multiple priorities
    await enqueueInput(session.id, { priority: 'low', content: 'A' });
    await enqueueInput(session.id, { priority: 'high', content: 'B' });
    await enqueueInput(session.id, { priority: 'normal', content: 'C' });
    
    // Retrieve in priority order
    const inputs = await checkInputQueue(session);
    expect(inputs[0].content).toBe('B'); // high
    expect(inputs[1].content).toBe('C'); // normal
    expect(inputs[2].content).toBe('A'); // low
  });

  test('Expiration and cleanup', async () => {
    const session = await createTestSession();
    
    // Enqueue with short TTL
    await enqueueInput(session.id, {
      content: 'Expires soon',
      ttl: 1 // 1 second
    });
    
    // Immediate check (exists)
    let inputs = await checkInputQueue(session, { peek: true });
    expect(inputs).toHaveLength(1);
    
    // Wait for expiration
    await delay(1500);
    
    // Check again (expired)
    inputs = await checkInputQueue(session);
    expect(inputs).toHaveLength(0);
  });
});
```

---

## Monitoring & Debugging

### Logging

**Enqueue Events:**
```
[InputQueue] Enqueued webhook:github for session abc123 (priority: high)
[InputQueue] Session abc123 queue: 3 inputs (2 normal, 1 high)
```

**Dequeue Events:**
```
[InputQueue] Session abc123 dequeued 2 inputs (webhook, agent)
[InputQueue] Session abc123 queue now empty
```

**Cleanup Events:**
```
[InputQueue] Cleanup removed 5 expired inputs across 3 sessions
[InputQueue] Evicted 2 inputs from session abc123 (overflow)
```

**Error Events:**
```
[InputQueue] Rate limit exceeded for session abc123 (10/min)
[InputQueue] Invalid input for session abc123: missing content field
```

### Metrics

**Queue Depth:**
- Current inputs per session
- Average queue depth across sessions
- Max queue depth observed

**Latency:**
- Enqueue operation time (p50, p95, p99)
- Dequeue operation time
- End-to-end latency (enqueue to agent retrieval)

**Throughput:**
- Enqueues per second
- Dequeues per second
- Expirations per cleanup cycle

**Error Rate:**
- Rate limit violations
- Invalid inputs rejected
- Queue overflows

### Debug Endpoint

**GET /api/debug/input-queue**

Returns global queue state:

```json
{
  "sessions": {
    "abc123": {
      "queueDepth": 3,
      "inputs": [
        {
          "id": "550e8400-...",
          "source": "webhook",
          "age": 45,
          "priority": "high"
        }
      ]
    }
  },
  "stats": {
    "totalQueued": 12,
    "totalSessions": 4,
    "avgQueueDepth": 3,
    "oldestInput": 120
  }
}
```

---

## Migration Guide

### For Existing Agent Workflows

**Before (Polling Pattern):**
```javascript
// Agent manually polls external API
while (taskInProgress) {
  await doWork();
  
  // Poll external API every iteration
  const status = await fetch('https://api.example.com/status');
  if (status.failed) {
    adjustStrategy();
  }
}
```

**After (Input Queue Pattern):**
```javascript
// External API pushes to input queue
while (taskInProgress) {
  await doWork();
  
  // Check queue only when needed
  const updates = await check_input_queue({ source: 'webhook' });
  if (updates.some(u => u.metadata.status === 'failed')) {
    adjustStrategy();
  }
}
```

**Benefits:**
- Reduced API calls
- Instant notification
- Works offline (queue persists)
- No polling overhead

### For send_agent_message Users

**Before (Immediate Messaging):**
```javascript
// Agent A sends to Agent B (interrupts if busy)
await send_agent_message(agentB, 'Task complete');
```

**After (Queued Messaging):**
```javascript
// Agent A enqueues for Agent B (non-interrupting)
await send_agent_message(agentB, 'Task complete', { queue: true });

// Agent B retrieves when ready
const messages = await check_input_queue({ source: 'agent' });
```

**Use Queued When:**
- Update is non-urgent
- Target agent is doing complex work
- Want to send multiple updates (batch retrieval)

**Use Immediate When:**
- Target must respond now
- Starting new conversation
- Blocking on response

---

## Future Enhancements

### V2 Features

**Structured Input Validation:**
```json
{
  "source": "webhook",
  "content": "Deploy failed",
  "schema": {
    "type": "object",
    "properties": {
      "environment": { "type": "string" },
      "errorCode": { "type": "number" }
    }
  }
}
```

**Input Acknowledgment:**
```javascript
// Agent marks input as handled
await acknowledge_input(inputId, {
  status: 'handled',
  result: 'Fixed deployment issue'
});

// External source receives acknowledgment
```

**Bidirectional Callbacks:**
```json
{
  "source": "webhook",
  "content": "Deploy failed",
  "replyTo": "https://api.example.com/deploy/123/status"
}

// Agent sends result back
await reply_to_input(inputId, {
  status: 'resolved',
  details: '...'
});
```

**Persistent Queue (Redis/DB):**
- Survives server restarts
- Handles high-scale deployments
- Enables queue introspection tools

**Input Aggregation:**
```javascript
// 10 file changes → 1 summary input
const aggregated = await check_input_queue({
  source: 'filesystem',
  aggregate: true // Returns: "10 files changed"
});
```

### Integration Opportunities

**GitHub Actions:**
```yaml
- name: Notify Agent
  run: |
    curl -X POST http://localhost:3000/api/sessions/$SESSION_ID/input \
      -d '{"source":"webhook","sourceId":"github-ci","content":"Tests passed"}'
```

**Monitoring (Datadog/PagerDuty):**
```javascript
// In alert webhook handler
await notifyAgent(sessionId, {
  source: 'monitoring',
  content: 'CPU exceeded 90%',
  metadata: alertDetails
});
```

**LSP Integration:**
```javascript
// Editor events as inputs
lspClient.onSave(async (file) => {
  await enqueueInput(activeSession, {
    source: 'filesystem',
    content: `File saved: ${file}`
  });
});
```

**Cron Jobs:**
```javascript
// Scheduled reports
cron.schedule('0 9 * * *', async () => {
  const report = await generateReport();
  await enqueueInput(monitoringSession, {
    source: 'scheduler',
    content: `Daily report: ${report.summary}`,
    metadata: report
  });
});
```

---

## Best Practices

### For External Sources

1. **Include rich metadata** - Don't just send text, include structured context
2. **Set appropriate TTL** - Shorter for high-frequency events, longer for rare updates
3. **Use priority correctly** - Reserve 'high' for urgent/blocking situations
4. **Implement retry logic** - Handle 429 rate limits with exponential backoff
5. **Verify session exists** - Check session active before enqueuing

### For Agents

1. **Check proactively** - Poll queue at natural breakpoints in workflow
2. **Filter by source** - Only retrieve relevant input types
3. **Use peek for decisions** - Check queue without consuming to decide strategy
4. **Batch retrieval** - Use `limit` to process multiple inputs efficiently
5. **Handle empty queue** - Don't assume inputs exist, check array length

### For System Integrators

1. **Rate limit external sources** - Prevent queue flooding
2. **Monitor queue depth** - Alert on sustained high depth (backlog)
3. **Set global TTL limits** - Prevent unbounded memory growth
4. **Log all enqueues** - Audit trail for debugging
5. **Implement cleanup** - Run periodic cleanup to remove expired inputs

---

## Troubleshooting

### Input Not Appearing

**Symptoms:** External source POSTs successfully but agent doesn't see input

**Checks:**
1. Verify session ID is correct: `GET /api/sessions/:id/state`
2. Check input wasn't expired: TTL too short?
3. Verify source filter: Agent filtering wrong source?
4. Check queue depth: Input evicted due to overflow?
5. Review logs: Look for enqueue confirmation

### Rate Limiting Issues

**Symptoms:** 429 errors when enqueuing

**Solutions:**
1. Implement exponential backoff in external source
2. Batch multiple updates into single input with array metadata
3. Increase rate limit if legitimate high-frequency source
4. Use aggregation to reduce enqueue frequency

### Memory Growth

**Symptoms:** Server memory increasing over time

**Checks:**
1. Review TTL settings: Inputs expiring properly?
2. Check cleanup frequency: Running every 60s?
3. Monitor queue depth: Sessions accumulating inputs?
4. Verify session disposal: Old sessions cleaned up?

**Solutions:**
1. Reduce default TTL (300s → 60s for high-frequency)
2. Lower max queue depth per session (50 → 25)
3. Implement persistent queue (offload to Redis)

### Missing Correlation

**Symptoms:** Runaway protection not working with queued inputs

**Cause:** Correlation ID not propagated through queue

**Solution:**
```javascript
// When enqueuing from agent context
const correlationId = context.getCorrelationId();
await enqueueInput(targetSession, {
  ...input,
  correlationId // Propagate
});

// When retrieving
const inputs = await check_input_queue({ ... });
if (inputs[0].correlationId) {
  // Pass to spawned work
  await create_agent_session({
    cwd: '/path',
    correlationId: inputs[0].correlationId
  });
}
```

---

## API Summary Reference

### HTTP Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/sessions/:id/input` | Enqueue input |
| GET | `/api/sessions/:id/input` | Retrieve inputs (peek) |
| GET | `/api/debug/input-queue` | Debug all queues |

### Agent Tools

| Tool | Purpose | Consumes Queue |
|------|---------|----------------|
| `check_input_queue` | Retrieve pending inputs | Yes (unless peek=true) |
| `wait_for_input` | Block until input arrives | Yes |

### Enhanced Tools

| Tool | Enhancement | New Parameter |
|------|-------------|---------------|
| `send_agent_message` | Queue option | `queue: boolean` |

### Queue Limits

| Limit | Value | Configurable |
|-------|-------|--------------|
| Per-session queue depth | 50 | Yes |
| Global queue depth | 1000 | Yes |
| Rate limit (per session) | 10/min | Yes |
| Default TTL | 300s | Per-input |
| Max TTL | 3600s | Yes |
| Cleanup frequency | 60s | Yes |

---

## Conclusion

The Context Injection System enables powerful real-time workflows while maintaining Caco's core design principles. By using a pull-based queue mechanism, agents remain in control of when and how they consume external context, avoiding interruption of streaming responses while enabling sophisticated coordination patterns.

Key benefits:

- **Non-interrupting** - External input doesn't break active response streams
- **Transparent** - Source prefixing shows context provenance
- **Flexible** - Supports webhooks, file watchers, agent messages, schedulers, applets
- **Safe** - Participates in correlation tracking and runaway prevention
- **Discoverable** - Tools self-document when to use input queue
- **Scalable** - In-memory for fast access, persistent queue option for scale

This system unlocks new use cases like real-time agent coordination, event-driven automation, and seamless external system integration while keeping the agent in the driver's seat.
