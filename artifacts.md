# Artifacts: Efficient Data Passthrough

**Goal:** Avoid sending large data through LLM round-trips. Let the agent emit artifacts (stdout, files, images) directly to the UI without bloating conversation context.

---

## The Problem

Currently, when a tool produces large output:

```
User: "Run the test suite"
  → Agent calls run_terminal_command
  → Tool returns 500 lines of test output
  → Full output goes to LLM context (tokens consumed)
  → LLM summarizes: "Tests passed with 3 failures"
  → User sees summary but can't access full output
```

**Issues:**
1. **Token waste** - Large outputs consume context window
2. **Latency** - LLM must process full output before responding
3. **Data loss** - User can't access original output
4. **Cost** - Paying for tokens on data the LLM just summarizes anyway

---

## SDK Capabilities (Current State)

### What Works

| Feature | Description | Use Case |
|---------|-------------|----------|
| `textResultForLlm` | Primary text sent to LLM | Short summaries |
| `sessionLog` | UI-only logging (not sent to LLM) | Debug info |
| `toolTelemetry` | Metadata about execution | Size hints, timing |
| `tool.execution_partial_result` | Ephemeral streaming events | Progress output |

### What Doesn't Work (Yet)

| Feature | Status |
|---------|--------|
| `binaryResultsForLlm` | Skipped in tests - "not fully implemented" |
| File attachment passthrough | No direct mechanism |
| Artifact references | No built-in concept |

### Relevant Session Events

```typescript
// Events emitted during tool execution
"tool.execution_start"        // { toolName, arguments }
"tool.execution_progress"     // { message }
"tool.execution_partial_result" // Ephemeral streaming (not persisted)
"tool.execution_complete"     // { result: ToolResult }
```

The key insight: **`sessionLog` and `toolTelemetry` don't go to the LLM**, so we can use them for artifact metadata.

---

## Proposed Solution: Artifact Cache + References

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Tool Execution                           │
├─────────────────────────────────────────────────────────────────┤
│  Tool produces large output (500 lines, image, file)            │
│                              │                                  │
│                              ▼                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Tool Handler Decision:                                    │  │
│  │   if (output.length > THRESHOLD) {                        │  │
│  │     artifactId = cache.store(output);                     │  │
│  │     return {                                              │  │
│  │       textResultForLlm: "Output: 500 lines (see artifact)",│  │
│  │       sessionLog: artifactId,     // For UI               │  │
│  │       toolTelemetry: { size: 500, type: 'stdout' }        │  │
│  │     };                                                    │  │
│  │   }                                                       │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              │                                  │
│              ┌───────────────┴───────────────┐                  │
│              ▼                               ▼                  │
│     LLM gets summary              UI gets artifactId            │
│     (few tokens)                  (can fetch full data)         │
└─────────────────────────────────────────────────────────────────┘
```

### Implementation Phases

---

## Phase 1: Server-Side Artifact Cache

Add artifact caching to `server.js`:

```javascript
// Artifact cache with TTL
const artifacts = new Map();
const ARTIFACT_TTL = 30 * 60 * 1000; // 30 minutes

function storeArtifact(data, metadata = {}) {
  const id = `art_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  artifacts.set(id, {
    data,
    metadata,
    createdAt: Date.now()
  });
  
  // Auto-cleanup after TTL
  setTimeout(() => artifacts.delete(id), ARTIFACT_TTL);
  
  return id;
}

// Endpoint to fetch artifacts
app.get('/api/artifacts/:id', (req, res) => {
  const artifact = artifacts.get(req.params.id);
  if (!artifact) {
    return res.status(404).json({ error: 'Artifact expired or not found' });
  }
  
  const { data, metadata } = artifact;
  
  if (metadata.mimeType) {
    res.setHeader('Content-Type', metadata.mimeType);
  }
  
  res.send(data);
});
```

---

## Phase 2: Event Filtering in SSE Stream

Intercept large tool results before sending to client:

```javascript
// In /api/stream handler
const unsubscribe = session.on((event) => {
  // Intercept large tool results
  if (event.type === 'tool.execution_complete') {
    const result = event.result?.textResultForLlm || '';
    
    if (result.length > 2000) {
      // Store full content as artifact
      const artifactId = storeArtifact(result, {
        toolName: event.toolName,
        type: 'text'
      });
      
      // Truncate for SSE, add artifact reference
      event = {
        ...event,
        result: {
          ...event.result,
          // Truncated preview
          textResultForLlm: result.slice(0, 500) + `\n\n... [${result.length} chars, artifactId: ${artifactId}]`,
          // Metadata for UI
          _artifactId: artifactId,
          _artifactSize: result.length
        }
      };
    }
  }
  
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
});
```

---

## Phase 3: Custom Tools with Artifact Awareness

Define tools that use the artifact pattern:

```javascript
import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';

const runCommand = defineTool("run_command", {
  description: "Run a shell command and return the output",
  parameters: z.object({
    command: z.string().describe("The command to run")
  }),
  handler: async ({ command }, invocation) => {
    const { stdout, stderr, exitCode } = await exec(command);
    const fullOutput = stdout + stderr;
    
    // If output is large, use artifact pattern
    if (fullOutput.length > 1000) {
      const artifactId = storeArtifact(fullOutput, {
        type: 'stdout',
        command,
        exitCode
      });
      
      return {
        // Short summary for LLM
        textResultForLlm: `Command completed (exit ${exitCode}). Output: ${fullOutput.length} chars. First 200 chars:\n${fullOutput.slice(0, 200)}...`,
        
        // Telemetry for confidence
        toolTelemetry: {
          artifactId,
          outputSize: fullOutput.length,
          exitCode,
          truncated: true
        },
        
        // Log for debugging
        sessionLog: `Full output stored as artifact ${artifactId}`
      };
    }
    
    // Small output - send directly
    return fullOutput;
  }
});
```

---

## Phase 4: UI Integration

Update the activity box to show artifact links:

```javascript
// In script.js - handle tool.execution_complete events
function handleToolComplete(event) {
  const { result } = event;
  
  // Check for artifact reference
  if (result._artifactId) {
    const artifactLink = document.createElement('a');
    artifactLink.href = `/api/artifacts/${result._artifactId}`;
    artifactLink.target = '_blank';
    artifactLink.className = 'artifact-link';
    artifactLink.textContent = `View full output (${formatSize(result._artifactSize)})`;
    
    activityBox.appendChild(artifactLink);
  }
}

// CSS for artifact links
.artifact-link {
  display: inline-block;
  padding: 4px 8px;
  background: #1f6feb;
  color: white;
  border-radius: 4px;
  text-decoration: none;
  font-size: 0.85em;
  margin-top: 8px;
}
```

---

## Phase 5: Image/Binary Artifacts

Extend for binary data:

```javascript
const captureScreenshot = defineTool("capture_screenshot", {
  description: "Capture a screenshot of the current window",
  handler: async () => {
    const imageBuffer = await screenshot();
    
    const artifactId = storeArtifact(imageBuffer, {
      type: 'image',
      mimeType: 'image/png'
    });
    
    return {
      textResultForLlm: "Screenshot captured successfully",
      toolTelemetry: {
        artifactId,
        mimeType: 'image/png',
        size: imageBuffer.length
      }
    };
  }
});
```

UI shows inline image:

```javascript
if (metadata.mimeType?.startsWith('image/')) {
  const img = document.createElement('img');
  img.src = `/api/artifacts/${artifactId}`;
  img.className = 'artifact-image';
  activityBox.appendChild(img);
}
```

---

## Size Estimation for Confidence

Give the agent size hints so it knows data was captured:

```javascript
return {
  textResultForLlm: `File saved: ${filename}`,
  toolTelemetry: {
    // Agent can reference these in response
    bytesWritten: buffer.length,
    linesCount: content.split('\n').length,
    artifactId,
    
    // Timing for perf analysis
    durationMs: Date.now() - startTime
  }
};
```

The LLM doesn't see `toolTelemetry` but it's available in events, so we could potentially inject a summary if needed.

---

## Alternative: Streaming Partial Results

For real-time output (like running tests), use partial results:

```javascript
// Tool can emit progress during execution
// These are ephemeral - not stored in conversation
session.emitPartialResult({
  type: 'stdout',
  line: 'Running test 1...'
});
```

**Note:** This requires SDK support for emitting from within tool handlers - need to verify if available.

---

## Skills Consideration

Skills (`skillDirectories` config) are markdown files that extend system prompts. They're **not helpful for artifact handling** but could document artifact patterns:

```markdown
---
name: artifact-aware
description: Handle large outputs efficiently
---

When tool output exceeds 1000 characters:
- Store as artifact and return summary
- Include size in response so user knows data was captured
- Reference artifactId in confirmation message
```

---

## Summary: Implementation Priority

| Phase | Effort | Impact | Recommendation |
|-------|--------|--------|----------------|
| 1. Artifact cache | Low | Medium | **Do first** - foundation |
| 2. Event filtering | Medium | High | Core functionality |
| 3. Custom tools | Low | High | Enable new use cases |
| 4. UI integration | Low | High | User-facing value |
| 5. Binary support | Medium | Medium | Nice to have |

### Quick Win

Even without custom tools, we can implement Phase 1+2 to automatically cache and truncate large tool outputs in the SSE stream. This works with existing built-in tools immediately.

---

## References

- [SDK Tool Types](https://github.com/github/copilot-sdk/blob/main/nodejs/src/types.ts)
- [Session Events](https://github.com/github/copilot-sdk/blob/main/nodejs/src/generated/session-events.ts)
- [Custom Tools Doc](./custom-tools.md)
