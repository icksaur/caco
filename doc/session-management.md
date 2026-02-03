# Session Management

**Sessions** are the core concept in the Copilot SDK - each session represents an independent conversation context with its own history, configuration, and state.

## Multiple Sessions

### Creating Multiple Sessions

You can create and manage multiple independent sessions simultaneously. Each session maintains its own:
- Conversation history
- Model configuration
- Tool access
- Context window

```javascript
const client = new CopilotClient();
await client.start();

// Create multiple sessions
const session1 = await client.createSession({ model: "claude-sonnet-4" });
const session2 = await client.createSession({ model: "claude-sonnet-4" });
const session3 = await client.createSession({ model: "claude-opus-4.5" });

// Each session is completely independent
await session1.sendAndWait({ prompt: "You are helping with a Python project" });
await session2.sendAndWait({ prompt: "You are helping with a TypeScript project" });
await session3.sendAndWait({ prompt: "You are helping with a Go project" });
```

### Use Cases
- **Multi-user applications**: One session per user
- **Multi-task workflows**: Separate sessions for different tasks
- **A/B testing**: Compare responses from different models
- **Context isolation**: Keep conversations separate and focused

### ⚠️ Parallel Sessions Warning

**CRITICAL**: Running multiple sessions in parallel that modify files in the same working directory is dangerous and can cause:
- Race conditions (two sessions editing the same file)
- Build/compile interference
- Conflicting git operations
- Resource locks
- State corruption

**Safe approaches:**
1. **Separate working directories**: Use different clients with different `cwd` paths
2. **Restrict tools with whitelist**: Create read-only sessions with `availableTools: ['view', 'grep', 'semantic_search']`
3. **Restrict tools with blacklist**: Exclude specific tools with `excludedTools: ['edit', 'bash']`
4. **Sequential execution**: Run file-modifying sessions one at a time, not in parallel
5. **Permission coordination**: Use `onPermissionRequest` handlers to prevent conflicts
6. **Purpose separation**: Q&A sessions (no files), review sessions (read-only), modification sessions (exclusive)

**Best practice**: If sessions will modify files, run them **sequentially, never in parallel**.

## Session Working Directory

### Client Working Directory (cwd)

The `cwd` option on `CopilotClient` sets the working directory for the **CLI process itself**, not for individual sessions:

```javascript
const client = new CopilotClient({
    cwd: '/path/to/project'  // CLI process runs from this directory
});
```

This affects:
- Where the CLI process looks for `.copilot/` configuration
- Default directory for file operations when no explicit path given
- Environment inherited by the CLI process

### Session Configuration Directory (configDir)

Override where a specific session stores its config and state:

```javascript
const session = await client.createSession({
    configDir: '/custom/config/path'  // Session-specific config location
});
```

This is **rarely needed** - most applications don't need to set this.

### Session Workspace Path

When **infinite sessions** are enabled (default), each session gets a workspace directory for persistence:

```javascript
const session = await client.createSession({ model: "claude-sonnet-4" });

console.log(session.workspacePath);
// => ~/.copilot/session-state/{sessionId}/
//    Contains: checkpoints/, plan.md, files/
```

The workspace path is:
- **Read-only** from your application's perspective
- Automatically managed by the SDK
- Used for context compaction and state persistence
- Available via `session.workspacePath` property
- `undefined` if infinite sessions are disabled

**You don't set the workspace path - the SDK manages it automatically.**

## Session Persistence and Resumption

### Custom Session IDs

Create sessions with memorable IDs for easy resumption:

```javascript
// Create with custom ID
const session = await client.createSession({
    sessionId: "user-123-conversation",
    model: "claude-sonnet-4"
});

await session.sendAndWait({ prompt: "Let's discuss TypeScript generics" });
console.log(session.sessionId); // "user-123-conversation"

// Destroy session but keep data on disk
await session.destroy();
```

### Resuming Sessions

Resume a previous conversation, maintaining full history:

```javascript
// Resume the previous session
const session = await client.resumeSession("user-123-conversation");

// Previous context is restored
await session.sendAndWait({ prompt: "What were we discussing?" });
// AI remembers the TypeScript generics discussion
```

### Resume with New Configuration

You can change configuration when resuming:

```javascript
const session = await client.resumeSession("user-123-conversation", {
    tools: [newTool],           // Add new tools
    streaming: true,            // Enable streaming
    onPermissionRequest: handler // Add permission handler
});
```

### Listing Sessions

See all persisted sessions:

```javascript
const sessions = await client.listSessions();

for (const sessionInfo of sessions) {
    console.log(sessionInfo.sessionId);     // UUID or custom ID
    console.log(sessionInfo.startTime);     // ISO timestamp
    console.log(sessionInfo.modifiedTime);  // ISO timestamp
    console.log(sessionInfo.summary);       // Optional user-friendly description
}
```

**Note**: Sessions only have the `sessionId` string for identification. There's an optional `summary` field in the metadata, but it's auto-generated by the SDK during context compaction—**you cannot set or update it via the API**. For user-friendly display, you'll need to maintain your own mapping (e.g., `sessionId → "Chat about React hooks"`) in your application database.

#### Session Summary (Read-Only)

The `summary` field in `SessionMetadata` is:
- **Auto-generated**: Created during context compaction for infinite sessions
- **Read-only**: No SDK method exists to set or update it
- **Optional**: May not be present for short sessions that never compacted

```javascript
const sessions = await client.listSessions();
for (const s of sessions) {
    // summary is auto-generated, may be undefined
    console.log(s.summary); // e.g., "User discussed TypeScript generics and async patterns"
}
```

If you need custom session titles/descriptions, maintain them in your application's database keyed by `sessionId`.

### Deleting Sessions

Permanently remove a session and its data:

```javascript
await client.deleteSession("user-123-conversation");

// Now resuming will fail
try {
    await client.resumeSession("user-123-conversation");
} catch (error) {
    console.error("Session not found");
}
```

### Getting Session History

Retrieve all messages from a session:

```javascript
const messages = await session.getMessages();

for (const msg of messages) {
    console.log(`[${msg.type}]`, msg.data);
}
```

## Local Session Cache

### Storage Location

Sessions are persisted to disk at:
- **Linux/macOS**: `~/.copilot/session-state/{sessionId}/`
- **Windows**: `%USERPROFILE%/.copilot/session-state/{sessionId}/`

### ⚠️ Session-to-Directory Mapping: Critical Safety Information

**Sessions store their original working directory but the SDK doesn't enforce it on resume.**

#### What's Stored

Each session's `events.jsonl` contains a `session.start` event with context:

```json
{
  "type": "session.start",
  "data": {
    "sessionId": "abc-123",
    "context": {
      "cwd": "/home/user/project-a",
      "gitRoot": "/home/user/project-a",
      "branch": "main"
    }
  }
}
```

The session "knows" it was created in `/home/user/project-a`.

#### What's NOT Enforced

When you call `listSessions()`, you get a **flat list** with no directory information:

```javascript
const sessions = await client.listSessions();
// Returns: [{ sessionId, startTime, modifiedTime, summary?, isRemote }, ...]
// ⚠️ NO cwd field - you can't see which directory each session belongs to!
```

When you call `resumeSession()`, the **current client's cwd is used**, NOT the original:

```javascript
// Original session created in /home/user/project-a
const clientA = new CopilotClient({ cwd: "/home/user/project-a" });
const session = await clientA.createSession({ sessionId: "my-session" });
// Session context: cwd = /home/user/project-a

// Later, resuming with a DIFFERENT cwd
const clientB = new CopilotClient({ cwd: "/home/user/project-b" });
const resumed = await clientB.resumeSession("my-session");
// ⚠️ DANGER: AI thinks it's in project-a but tools operate on project-b!
```

#### The Mismatch Problem

This creates a dangerous mismatch:
1. **AI context**: Remembers discussing files from `project-a`
2. **Tool execution**: All file operations now target `project-b`
3. **Result**: AI might say "Let's edit src/main.py" referring to project-a's file, but the `edit` tool modifies project-b's file!

#### Your Responsibility: Track the Mapping

The SDK does NOT prevent this mismatch. **You must track session→directory mapping yourself:**

```javascript
// Your application's database or in-memory store
const sessionDirectoryMap = new Map();

// When creating sessions, record the directory
async function createTrackedSession(client, cwd, config) {
    const session = await client.createSession(config);
    sessionDirectoryMap.set(session.sessionId, cwd);
    return session;
}

// When resuming, validate the directory matches
async function safeResumeSession(client, sessionId) {
    const originalCwd = sessionDirectoryMap.get(sessionId);
    const currentCwd = client.options.cwd; // Your client's cwd
    
    if (originalCwd && originalCwd !== currentCwd) {
        throw new Error(
            `Session ${sessionId} was created in ${originalCwd} ` +
            `but current client is in ${currentCwd}. ` +
            `Create a new client with the correct cwd to resume safely.`
        );
    }
    
    return await client.resumeSession(sessionId);
}
```

#### Reading Original Context (Advanced)

You CAN read the original cwd from the session's event history:

```javascript
const session = await client.resumeSession(sessionId);
const messages = await session.getMessages();
const startEvent = messages.find(m => m.type === 'session.start');

if (startEvent?.data?.context?.cwd) {
    console.log(`Session was created in: ${startEvent.data.context.cwd}`);
}
```

But this requires resuming first - there's no way to check before resuming.

This is managed by the **Copilot CLI**, not your application.

### Cache Structure

Each session directory contains:
```
~/.copilot/session-state/{sessionId}/
├── workspace.yaml   # Session metadata (id, cwd, summary, timestamps)
├── checkpoints/     # Context compaction checkpoints
│   └── index.md     # Compacted conversation summary
└── files/           # Session-specific generated files (usually empty)
```

**Note**: Older SDK versions stored events in `events.jsonl` and cwd in the session.start event. Current versions store cwd directly in `workspace.yaml` and may not have `events.jsonl`.

#### Subdirectory Purposes

| Path | Purpose |
|------|---------|
| `checkpoints/` | Stores context compaction checkpoints when infinite sessions are enabled. The SDK automatically compacts conversation history to stay within context limits, saving the compacted state here. |
| `checkpoints/index.md` | Markdown summary of compacted conversation history. |
| `files/` | Reserved for session-specific files that may be generated during conversation. This could include downloaded content, generated artifacts, or temporary files the agent creates. In typical usage, this directory remains empty—it's infrastructure for features that may create session-scoped files. |

**Note**: These directories are created automatically and managed by the SDK. Your application should treat them as read-only.

#### events.jsonl Format (Legacy)

Older sessions may have an `events.jsonl` file with a newline-delimited JSON log of all session events:

```json
{"type":"session.start","data":{"sessionId":"abc-123","context":{"cwd":"/path/to/project","gitRoot":"/path/to/project","branch":"main"}}}
{"type":"session.info","data":{"infoType":"authentication","message":"Logged in as user: username"}}
{"type":"user.message","data":{"content":"Hello, world!"}}
{"type":"assistant.message","data":{"content":"Hello! How can I help?","toolRequests":[]}}
{"type":"session.idle","data":{}}
```

**Key fields in `session.start`:**
- `data.sessionId` - The session identifier
- `data.context.cwd` - **Original working directory** (important for safety!)
- `data.context.gitRoot` - Git repository root (if applicable)
- `data.context.branch` - Git branch (if applicable)

#### workspace.yaml Format

```yaml
id: abc-123-def-456
cwd: /home/user/project
summary_count: 0
created_at: 2026-01-24T05:15:54.341Z
updated_at: 2026-01-24T05:16:14.639Z
summary: User asked about session management.
```

**Key fields:**
- `id` - The session identifier
- `cwd` - **Original working directory** (important for safety!)
- `summary` - Auto-generated from conversation content, not manually set
- `summary_count` - Number of compaction cycles performed

**Note**: The `cwd` field was added in newer SDK versions. Older sessions stored cwd only in `events.jsonl`.

### When Sessions Are Written

Sessions are written to disk:
- **After messages are sent**: Conversation state is persisted
- **During compaction**: When infinite sessions compact context
- **On graceful shutdown**: CLI flushes pending state

### Cache Behavior

- **Automatic**: Sessions persist automatically, no manual save needed
- **Transparent**: Your app doesn't manage cache directly
- **Concurrent-safe**: Multiple clients can access different sessions
- **No automatic cleanup**: Old sessions stay until explicitly deleted with `deleteSession()` or by removing the directory manually (`rm -rf ~/.copilot/session-state/{sessionId}`)
- **No cwd filtering**: `listSessions()` returns ALL sessions regardless of working directory

### Checking if a Session Exists

Before resuming, you can check:

```javascript
const sessions = await client.listSessions();
const sessionIds = sessions.map(s => s.sessionId);

if (sessionIds.includes("user-123-conversation")) {
    const session = await client.resumeSession("user-123-conversation");
} else {
    console.log("Session not found - creating new one");
    const session = await client.createSession({
        sessionId: "user-123-conversation"
    });
}
```

## Process Restart Considerations

### Cache Survives Restarts

Sessions persist across:
- Application restarts
- Client stop/start cycles
- CLI process crashes (with auto-restart)
- System reboots

```javascript
// First run
const client1 = new CopilotClient();
await client1.start();
const session = await client1.createSession({
    sessionId: "persistent-session"
});
await session.sendAndWait({ prompt: "Remember this: secret code is 12345" });
await session.destroy();
await client1.stop();

// ... Application restarts ...

// Second run
const client2 = new CopilotClient();
await client2.start();
const resumed = await client2.resumeSession("persistent-session");
await resumed.sendAndWait({ prompt: "What's the secret code?" });
// AI remembers: "The secret code is 12345"
```

### No Manual Cache Management

You **cannot and should not**:
- Copy session directories manually
- Read checkpoint files directly
- Modify session state on disk
- Manually trigger cache writes

The CLI manages all persistence automatically.

### Resume vs Create

| Operation | When to Use | Behavior |
|-----------|-------------|----------|
| `createSession()` | New conversation | Creates new session, generates UUID if no sessionId provided |
| `createSession({ sessionId: "foo" })` | New conversation with custom ID | Creates new session with specified ID, fails if ID already exists |
| `resumeSession("foo")` | Continue existing conversation | Loads previous session, fails if session doesn't exist |

### Session Lifecycle

```
createSession() → send messages → destroy() → session persisted to disk
                                             ↓
                              resumeSession() → continue conversation
```

**Important**: `destroy()` does NOT delete the session - it only closes the connection. The session remains on disk and can be resumed later.

## Infinite Sessions (Default Behavior)

### What Are Infinite Sessions?

By default, sessions use **infinite sessions** which:
- Automatically manage context window limits
- Persist state to a workspace directory
- Run background compaction when context fills up
- Allow conversations to continue indefinitely

### Workspace Path

When infinite sessions are enabled (default):

```javascript
const session = await client.createSession({ model: "claude-sonnet-4" });

console.log(session.workspacePath);
// => ~/.copilot/session-state/{sessionId}/
```

This workspace contains:
- `checkpoints/` - Context compaction checkpoints
- `plan.md` - Session planning state
- `files/` - Session-specific files

### Compaction Thresholds

Configure when compaction occurs:

```javascript
const session = await client.createSession({
    model: "claude-sonnet-4",
    infiniteSessions: {
        enabled: true,
        backgroundCompactionThreshold: 0.80,  // Start compacting at 80% context usage
        bufferExhaustionThreshold: 0.95       // Block at 95% until compaction completes
    }
});
```

### Disabling Infinite Sessions

For short-lived sessions that don't need persistence:

```javascript
const session = await client.createSession({
    model: "claude-sonnet-4",
    infiniteSessions: { enabled: false }
});

console.log(session.workspacePath); // undefined
```

When disabled:
- No workspace directory created
- No background compaction
- Session limited by model's context window
- Faster startup (no persistence overhead)

### Compaction Events

Listen for compaction events:

```javascript
session.on((event) => {
    if (event.type === 'session.compaction_start') {
        console.log('Background compaction started');
    }
    if (event.type === 'session.compaction_complete') {
        console.log('Compaction finished');
    }
});
```

## Best Practices

### Session IDs

1. **Use meaningful IDs**: Include user/context in ID
   ```javascript
   sessionId: `user-${userId}-chat-${chatId}`
   ```

2. **Don't use sequential IDs**: They're predictable and insecure
   ```javascript
   // Bad: sessionId: "session-1", "session-2"
   // Good: sessionId: "user-alice-20260124-e8a9c"
   ```

3. **Generate UUIDs for anonymous sessions**: Let SDK auto-generate
   ```javascript
   const session = await client.createSession(); // Auto-generated UUID
   ```

### Session Cleanup

1. **Delete old sessions periodically**:
   ```javascript
   const sessions = await client.listSessions();
   const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
   
   for (const s of sessions) {
       if (new Date(s.modifiedTime).getTime() < oneWeekAgo) {
           await client.deleteSession(s.sessionId);
       }
   }
   ```

2. **Handle missing sessions gracefully**:
   ```javascript
   try {
       const session = await client.resumeSession(sessionId);
   } catch (error) {
       console.log("Session not found, creating new one");
       const session = await client.createSession({ sessionId });
   }
   ```

3. **Don't forget to destroy sessions**:
   ```javascript
   const session = await client.createSession();
   try {
       await session.sendAndWait({ prompt: "..." });
   } finally {
       await session.destroy(); // Always clean up
   }
   ```

### Resuming Across Clients

Sessions can be resumed by different client instances:

```javascript
// Client 1
const client1 = new CopilotClient();
await client1.start();
const session = await client1.createSession({ sessionId: "shared-session" });
await session.sendAndWait({ prompt: "Remember: foo = bar" });
await session.destroy();
await client1.stop();

// Client 2 (different process, same or different machine)
const client2 = new CopilotClient();
await client2.start();
const resumed = await client2.resumeSession("shared-session");
await resumed.sendAndWait({ prompt: "What is foo?" });
// AI remembers: "foo = bar"
```

**Note**: The session cache directory must be accessible to both clients (same filesystem or shared storage).

### Working Directory Considerations

```javascript
// If your app needs specific working directories:
const client = new CopilotClient({
    cwd: '/path/to/project'  // CLI process context
});

// Sessions inherit this context for file operations
const session = await client.createSession();
await session.sendAndWait({ 
    prompt: "List files in the current directory" 
    // Will list files from /path/to/project
});
```

### State vs Configuration

- **Session state** (conversation history): Automatically persisted, survives restarts
- **Session configuration** (tools, model, etc.): Not persisted, must be re-specified on resume

```javascript
// Create with tools
const session = await client.createSession({
    sessionId: "foo",
    tools: [myTool]
});

// Resume needs tools re-specified
const resumed = await client.resumeSession("foo", {
    tools: [myTool]  // Must provide again
});
```
