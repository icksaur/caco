# Artifact Passthrough Research Summary

## Overview

This document summarizes research into implementing artifact passthrough in the copilot-web application to avoid sending large data (stdout, file contents, images) through LLM round-trips.

---

## 1. SDK Capabilities for Artifacts

### ToolBinaryResult and binaryResultsForLlm

The SDK has support for binary results, but it's **not fully implemented yet**:

```typescript
// From nodejs/src/types.ts
export type ToolBinaryResult = {
    data: string;          // Base64-encoded data
    mimeType: string;      // e.g., "image/png"
    type: string;          // e.g., "base64"
    description?: string;  // Optional description for LLM
};

export type ToolResultObject = {
    textResultForLlm: string;                  // Text result for LLM
    binaryResultsForLlm?: ToolBinaryResult[]; // Binary results (NOT FULLY WORKING)
    resultType: ToolResultType;
    error?: string;
    sessionLog?: string;                       // Logging separate from LLM content
    toolTelemetry?: Record<string, unknown>;   // Telemetry data
};
```

**Critical Finding**: In the .NET SDK test file, there's a skipped test with this comment:
```csharp
[Fact(Skip = "Behaves as if no content was in the result. Likely that binary results aren't fully implemented yet.")]
public async Task Can_Return_Binary_Result()
```

### sessionLog Field

The `sessionLog` field is interesting - it's designed for **logging content that appears in the UI but NOT sent to the LLM**:

```python
# From python/copilot/types.py
class ToolResult(TypedDict, total=False):
    textResultForLlm: str              # What the LLM sees
    binaryResultsForLlm: list[...]     # Binary data for LLM
    resultType: ToolResultType
    error: str
    sessionLog: str                     # UI logging, NOT sent to LLM
    toolTelemetry: dict[str, Any]       # Telemetry data
```

This `sessionLog` field could potentially be used to pass metadata to the UI while keeping `textResultForLlm` minimal.

---

## 2. Session Events in the SDK

### Tool Execution Events

The SDK emits several tool-related events that the UI can listen to:

| Event Type | Description | Key Data Fields |
|------------|-------------|-----------------|
| `tool.execution_start` | Tool begins executing | `toolCallId`, `toolName`, `arguments` |
| `tool.execution_progress` | Progress update | `toolCallId`, `progressMessage` |
| `tool.execution_partial_result` | Streaming partial output | `toolCallId`, `partialOutput` |
| `tool.execution_complete` | Tool finished | `toolCallId`, `success`, `result.content` |

### Important: Ephemeral Events

Some events are marked as `ephemeral: true`, meaning they're for real-time streaming and NOT persisted to conversation history:

```typescript
// From nodejs/src/generated/session-events.ts
{
  type: "tool.execution_partial_result";
  ephemeral: true;  // Not persisted!
  data: {
    toolCallId: string;
    partialOutput: string;
  };
}
```

This is significant - **partial output events are designed for UI streaming without bloating the conversation**.

---

## 3. Current copilot-web Implementation

### Server-Side Event Forwarding

In [server.js](server.js#L314-L377), events are forwarded to the client via SSE:

```javascript
// Subscribe to events
const unsubscribe = session.on((event) => {
  // Send event to client
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event.data || {})}\n\n`);
});
```

**Problem**: All event data is sent through verbatim, including potentially large `result.content` fields.

### Activity Box Implementation

In [script.js](public/script.js#L556-L652), tool events are rendered:

```javascript
// Tool execution events
eventSource.addEventListener('tool.execution_start', (e) => {
  const data = JSON.parse(e.data);
  const toolName = data.toolName || 'tool';
  const args = formatToolArgs(data.arguments);
  addActivityItem('tool', summary, details);
});

eventSource.addEventListener('tool.execution_complete', (e) => {
  const data = JSON.parse(e.data);
  const details = data.result ? formatToolResult(data.result) : null;
  addActivityItem('tool-result', summary, details);
});
```

### Current Truncation (Client-Side)

```javascript
// Format tool result for display
function formatToolResult(result) {
  if (result.content) {
    const content = typeof result.content === 'string' 
      ? result.content 
      : JSON.stringify(result.content);
    return content.length > 500 ? content.substring(0, 500) + '...' : content;
  }
  return JSON.stringify(result).substring(0, 200);
}
```

**Problem**: This truncates for **display only** - the full content already went through the SSE stream and LLM.

---

## 4. Skills System

### SkillDirectories Configuration

The SDK supports loading skills from directories:

```typescript
// From nodejs/src/types.ts
export interface SessionConfig {
    skillDirectories?: string[];  // Directories to load skills from
    disabledSkills?: string[];    // Skills to disable
}
```

### Skill Format

Skills are markdown files with YAML frontmatter:

```markdown
---
name: test-skill
description: A test skill that adds a marker to responses
---

# Skill Instructions

IMPORTANT: You MUST include the text "MARKER" in every response.
```

Skills can extend the system prompt but **do not directly help with artifact handling**.

---

## 5. Proposed Solutions for Artifact Passthrough

### Solution A: Leverage sessionLog + Server-Side Caching

**Concept**: Use `sessionLog` for UI-displayable content and keep `textResultForLlm` minimal.

**Implementation**:
1. Create a custom tool wrapper on the server that:
   - Captures large outputs (terminal stdout, file contents)
   - Stores them in a server-side cache with a UUID
   - Returns to LLM: `"Output stored as artifact://abc123 (2048 lines)"`
   - Puts full content in `sessionLog`

2. Modify the SSE stream handler to:
   - Parse `tool.execution_complete` events
   - Extract `sessionLog` content if present
   - Forward to client for display

**Pros**: Works with existing SDK
**Cons**: Requires custom tool wrappers; sessionLog support may vary

### Solution B: Server-Side Event Filtering

**Concept**: Filter/transform events on the server before sending to SSE client.

**Implementation**:
```javascript
// In server.js streaming handler
const unsubscribe = session.on((event) => {
  // Transform large tool results
  if (event.type === 'tool.execution_complete' && event.data?.result?.content) {
    const content = event.data.result.content;
    if (content.length > 10000) {
      // Cache full content server-side
      const artifactId = cacheArtifact(content);
      event.data.artifactId = artifactId;
      event.data.result.content = `[Truncated: ${content.length} chars. Artifact: ${artifactId}]`;
      event.data.artifactPreview = content.substring(0, 500);
    }
  }
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event.data || {})}\n\n`);
});
```

**Add API endpoint for artifact retrieval**:
```javascript
app.get('/api/artifacts/:id', (req, res) => {
  const content = getArtifactFromCache(req.params.id);
  res.json({ content });
});
```

**Client changes**:
```javascript
function addActivityItem(type, text, details, artifactId) {
  // If artifactId present, add "View Full" button
  if (artifactId) {
    const btn = document.createElement('button');
    btn.textContent = 'View Full';
    btn.onclick = async () => {
      const res = await fetch(`/api/artifacts/${artifactId}`);
      const data = await res.json();
      showArtifactModal(data.content);
    };
    item.appendChild(btn);
  }
}
```

**Pros**: No SDK changes needed; works now
**Cons**: Doesn't reduce LLM token usage (the LLM still processes full content internally)

### Solution C: Custom Tool Definitions with Metadata Return

**Concept**: Define SDK-side tools that return metadata instead of full content.

**For terminal output** (example):
```javascript
const tools = [
  defineTool("run_command_cached", {
    description: "Run a command and cache output",
    parameters: z.object({ command: z.string() }),
    handler: async (args, invocation) => {
      const result = await executeCommand(args.command);
      const artifactId = cacheResult(result.stdout);
      return {
        textResultForLlm: `Command completed. Exit code: ${result.exitCode}. ` +
                          `Output: ${result.stdout.length} chars (first 500: ${result.stdout.substring(0, 500)})`,
        sessionLog: `Full output cached as ${artifactId}`,
        resultType: "success"
      };
    }
  })
];
```

**Pros**: Reduces LLM tokens significantly
**Cons**: Requires replacing built-in tools with custom ones; loses CLI tool benefits

### Solution D: Wait for SDK BinaryResult Support

The SDK has infrastructure for `binaryResultsForLlm` but it's not working yet. When fixed:

```typescript
return {
  textResultForLlm: "Here's an image of the chart",
  binaryResultsForLlm: [{
    data: base64ImageData,
    mimeType: "image/png",
    type: "base64"
  }],
  resultType: "success"
};
```

**Timeline**: Unknown - the test is skipped indicating active development

---

## 6. Recommended Approach

### Phase 1: Immediate (Solution B)

Implement server-side event filtering and caching:

1. **Add artifact cache to server.js**:
   - In-memory Map with TTL (30 min)
   - LRU eviction for memory management

2. **Modify SSE handler**:
   - Detect large `tool.execution_complete` results
   - Cache and truncate before sending to client
   - Add `artifactId` to event data

3. **Add artifact API**:
   - `GET /api/artifacts/:id` for retrieval
   - `DELETE /api/artifacts/:id` for cleanup

4. **Update activity box UI**:
   - Show truncated preview with "View Full" button
   - Modal/panel for viewing complete artifacts

### Phase 2: Future

1. Monitor SDK updates for `binaryResultsForLlm` fixes
2. Consider custom tool wrappers for high-volume tools (terminal, file read)
3. Explore WebSocket upgrade for bidirectional artifact streaming

---

## 7. Code Locations Summary

| File | Purpose | Key Lines |
|------|---------|-----------|
| [server.js](server.js) | SSE streaming, event forwarding | Lines 314-377 |
| [script.js](public/script.js) | Activity box, tool result display | Lines 556-652 |
| [session-manager.js](src/session-manager.js) | SDK wrapper, session lifecycle | Full file |
| SDK types.ts | ToolResult, ToolBinaryResult definitions | nodejs/src/types.ts |
| SDK session-events.ts | Event type definitions | nodejs/src/generated/session-events.ts |

---

## 8. Open Questions

1. **LLM Token Usage**: The SDK processes tool results server-side before sending to LLM. Does the CLI truncate large results internally?

2. **Ephemeral Events**: Can we emit our own ephemeral events for UI-only data?

3. **sessionLog Visibility**: Does sessionLog appear anywhere in CLI output? Need to test if it's useful for artifact metadata.

4. **Binary Result Timeline**: When will `binaryResultsForLlm` be fully implemented?
