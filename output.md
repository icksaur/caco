# SDK Output and Feedback

## Primary Output Modes

### 1. Assistant Messages
The main conversational output from the AI:

**Full Response:**
```typescript
{
  type: "assistant.message",
  data: {
    messageId: string,
    content: string,              // The actual text response
    toolRequests?: Array<{        // Tools the assistant wants to call
      toolCallId: string,
      name: string,
      arguments?: unknown,
      type?: "function" | "custom"
    }>,
    parentToolCallId?: string     // If this is output from a tool
  }
}
```

**Streaming Response (when `streaming: true`):**
```typescript
{
  type: "assistant.message_delta",
  ephemeral: true,
  data: {
    messageId: string,
    deltaContent: string,         // Incremental content chunk
    totalResponseSizeBytes?: number,
    parentToolCallId?: string
  }
}
```

### 2. Tool Execution Results
Output from built-in tools, custom tools, and MCP tools:

**Execution Complete Event:**
```typescript
{
  type: "tool.execution_complete",
  data: {
    toolCallId: string,
    success: boolean,
    result?: {
      content: string            // Tool output as text
    },
    error?: {
      message: string,
      code?: string
    },
    toolTelemetry?: {            // Custom diagnostic data from tool
      [key: string]: unknown
    },
    parentToolCallId?: string
  }
}
```

**Tool Result Format (from custom tool handlers):**
Can return either a simple string or a structured object:
```typescript
// Simple string result
return "Operation completed successfully";

// Structured result with metadata
return {
  textResultForLlm: string,              // Text sent to the AI
  binaryResultsForLlm?: Array<{          // Binary data (images, etc.)
    data: string,                        // Base64 encoded
    mimeType: string,
    type: string,
    description?: string
  }>,
  resultType: "success" | "failure" | "rejected" | "denied",
  error?: string,
  sessionLog?: string,                   // Private log (not sent to AI)
  toolTelemetry?: Record<string, unknown> // Custom metadata
};
```

## MCP Tool Execution

### Process Isolation
**Yes, MCP tools always execute out-of-process.** MCP (Model Context Protocol) servers run as separate processes:

**Local MCP Servers:**
```typescript
mcpServers: {
  "my-server": {
    type: "stdio",
    command: "node",
    args: ["./my-mcp-server.js"],
    env: { "API_KEY": "..." },
    cwd: "/path/to/server"
  }
}
```
- Spawned as child processes
- Communicate via stdio (stdin/stdout)
- Can be written in any language

**Remote MCP Servers:**
```typescript
mcpServers: {
  "remote-server": {
    type: "http" | "sse",
    url: "https://api.example.com/mcp",
    headers: { "Authorization": "Bearer ..." }
  }
}
```
- Accessed over HTTP/SSE
- Already running externally

### In-Process MCP Servers
**Not directly supported.** However, you can:
1. **Use Custom Tools** (recommended) - These run in your Node.js process:
```typescript
const myTool = defineTool("my_tool", {
  description: "Does something",
  handler: async (args) => {
    // Your in-process code here
    return result;
  }
});
```

2. **Wrap in-process logic with local MCP server** - Start an MCP server as part of your app that wraps your in-process functions, then connect to it via stdio.

## Session State Events

### Session Lifecycle
- `session.start` - Session created with context (model, cwd, git info)
- `session.idle` - Processing finished, session ready (ephemeral)
- `session.error` - Error occurred

### Token Management  
- `session.usage_info` - Current token usage (ephemeral)
- `session.truncation` - Message history truncated
- `session.compaction_complete` - Conversation summarized to save tokens

## Additional Event Types

### Tool Progress (ephemeral)
- `tool.execution_start` - Tool invocation beginning
- `tool.execution_progress` - Status updates during execution
- `tool.execution_partial_result` - Incremental output

### Subagents
- `subagent.selected` - Custom agent chosen
- `subagent.started` - Subagent execution beginning  
- `subagent.completed` - Subagent finished successfully
- `subagent.failed` - Subagent error

### Usage Tracking
```typescript
{
  type: "assistant.usage",
  ephemeral: true,
  data: {
    model?: string,
    inputTokens?: number,
    outputTokens?: number,
    cacheReadTokens?: number,
    cost?: number,              // In dollars
    duration?: number,          // Milliseconds
    quotaSnapshots?: {...}      // Quota status
  }
}
```

## Event Structure

All events share this structure:
```typescript
{
  id: string,                  // Unique event ID
  timestamp: string,           // ISO 8601
  parentId: string | null,     // Parent event (for hierarchy)
  ephemeral?: boolean,         // If true, not persisted
  type: string,                // Event type
  data: {...}                  // Event-specific payload
}
```

**Ephemeral events** are real-time feedback not stored in history:
- `assistant.message_delta` - Streaming chunks
- `tool.execution_progress` - Progress updates
- `session.idle` - Processing complete signals
- `assistant.usage` - Token/cost metrics
