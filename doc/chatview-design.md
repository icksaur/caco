# Chat View Architecture - Flat Message Structure

## Requirements

1. **unified rendering**: all streaming message have identical code
2. **data driven**: map from type string to target class


### Chat Div Classes

| Class | Background | Description |
|-------|------------|-------------|
| `user-message` | Blue | User's input message |
| `assistant-message` | None (transparent) | Assistant's text response |
| `agent-message` | Purple | Caco session-to-session messages (not SDK concept) |
| `applet-message` | Orange | Caco Applet output (not SDK concept) |
| `assistant-activity` | Grey | Activity box (intent, reasoning, tool calls) |

### Event Type → Chat Div Mapping

| `type` String | Chat Div Class |
|-------------------|----------------|
| `user.message` | `user-message` |
| `assistant.message` | `assistant-message` |
| `assistant.message_delta` | `assistant-message` |
| `assistant.turn_start` | `assistant-activity` |
| `assistant.turn_end` | `assistant-activity` |
| `assistant.intent` | `assistant-activity` |
| `assistant.reasoning` | `assistant-activity` |
| `assistant.reasoning_delta` | `assistant-activity` |
| `tool.execution_start` | `assistant-activity` |
| `tool.execution_progress` | `assistant-activity` |
| `tool.execution_partial_result` | `assistant-activity` |
| `tool.execution_complete` | `assistant-activity` |
| `session.start` | `assistant-activity` |
| `session.idle` | `assistant-activity` |
| `session.error` | `assistant-activity` |
| `session.truncation` | `assistant-activity` |
| `session.compaction_start` | `assistant-activity` |
| `session.compaction_complete` | `assistant-activity` |
| `session.usage_info` | `assistant-activity` |
| `assistant.usage` | `assistant-activity` |
| `caco.agent` | `agent-message` |
| `caco.applet` | `applet-message` |

### Event Type → Chat Bubble Child Div Mapping

**Note - these classes are lookup only, and have no style**
`omit` is for doc purpose

| `type` String | Chat Div Class |
|-------------------|----------------|
| `user.message` | `user-text` |
| `assistant.message` | `assistant-text` |
| `assistant.message_delta` | `assistant-text` |
| `assistant.turn_start` | `omit` |
| `assistant.turn_end` | `omit` |
| `assistant.intent` | `intent-text` |
| `assistant.reasoning` | `reasoning-text` |
| `assistant.reasoning_delta` | `reasoning-text` |
| `tool.execution_start` | `tool-text` |
| `tool.execution_progress` | `tool-text` |
| `tool.execution_partial_result` | `tool-text` |
| `tool.execution_complete` | `tool-text` |
| `session.start` | `omit` |
| `session.idle` | `omit` |
| `session.error` | `omit` |
| `session.truncation` | `omit` |
| `session.compaction_start` | `compact-text` |
| `session.compaction_complete` | `compact-text` |
| `session.usage_info` | `omit` |
| `assistant.usage` | `omit` |
| `caco.agent` | `agent-text` |
| `caco.applet` | `applet-text` |

## WORK

### Phase 1: new "outer" divs in id="chat" div
create five named CSS types as above with specified colors, no funny styles
create javascript map/dict/whatever
use phase1 "outer" MessageInserter with map to get child
APPEND content into child (will be ahuge mess of deltas)
test live

### Phase 2: new "inner" divs within "outer"
create named CSS types as above with only default style (lookup only, do not include `omit`)
create javascript map/dict/whatever
use phase1 "outer" MessageInserter with map to get child, appended as needed
use phase2 "inner" MessageInserter with map to get child
REPLACE content (free collapse)

### Phase 3: make it pretty
re-implement debounced rendering for all

### Phase 4: Activity Persistence
Store activity items to disk like outputs (done?)
fabricate activity messages while streaming out history over WS
everything should just work

### Phase 5: fix outputs (no plan)
fabricate new type="caco.output"
emit WS message when agent idle
emit from persistence when loading and streaming history (when?)

## Copilot SDK Event Types (Complete Reference)

### Session Lifecycle Events

| SDK Event Type | JSON `type` Value | Key `data` Fields | Ephemeral | Description |
|----------------|-------------------|-------------------|-----------|-------------|
| Session Start | `session.start` | `sessionId`, `context.cwd`, `context.gitRoot`, `context.branch`, `model` | No | Session created with workspace context |
| Session Idle | `session.idle` | — | Yes | Processing complete, ready for next message |
| Session Error | `session.error` | `message`, `stack?` | No | Error occurred during processing |
| Session Truncation | `session.truncation` | — | No | Message history truncated for token limit |
| Compaction Start | `session.compaction_start` | — | No | Conversation summarization starting |
| Compaction Complete | `session.compaction_complete` | — | No | Conversation summarized to save tokens |

### Message Events

| SDK Event Type | JSON `type` Value | Key `data` Fields | Ephemeral | Description |
|----------------|-------------------|-------------------|-----------|-------------|
| User Message | `user.message` | `content`, `attachments?` | No | User's message sent to assistant |
| Assistant Message | `assistant.message` | `messageId`, `content`, `toolRequests?`, `parentToolCallId?` | No | Full response text (final) |
| Assistant Message Delta | `assistant.message_delta` | `messageId`, `deltaContent`, `totalResponseSizeBytes?` | Yes | Streaming response chunk |
| Turn Start | `assistant.turn_start` | — | Yes | Assistant begins processing turn |
| Turn End | `assistant.turn_end` | — | Yes | Assistant finished processing turn |

### Intent & Reasoning Events

| SDK Event Type | JSON `type` Value | Key `data` Fields | Ephemeral | Description |
|----------------|-------------------|-------------------|-----------|-------------|
| Intent | `assistant.intent` | `intent` | Yes | What assistant plans to do (💡) |
| Reasoning | `assistant.reasoning` | `content` | No | Full reasoning text (final) |
| Reasoning Delta | `assistant.reasoning_delta` | `deltaContent` | Yes | Streaming reasoning chunk (🤔) |

### Tool Execution Events

| SDK Event Type | JSON `type` Value | Key `data` Fields | Ephemeral | Description |
|----------------|-------------------|-------------------|-----------|-------------|
| Tool Start | `tool.execution_start` | `toolName`, `name?`, `arguments?` | Yes | Tool invocation beginning |
| Tool Progress | `tool.execution_progress` | `status?` | Yes | Status updates during execution |
| Tool Partial Result | `tool.execution_partial_result` | `content?` | Yes | Incremental output |
| Tool Complete | `tool.execution_complete` | `toolCallId`, `success`, `result.content?`, `error?`, `toolTelemetry?` | No | Tool finished |

### Subagent Events

| SDK Event Type | JSON `type` Value | Key `data` Fields | Ephemeral | Description |
|----------------|-------------------|-------------------|-----------|-------------|
| Subagent Selected | `subagent.selected` | — | Yes | Custom agent chosen |
| Subagent Started | `subagent.started` | — | Yes | Subagent execution beginning |
| Subagent Completed | `subagent.completed` | — | No | Subagent finished successfully |
| Subagent Failed | `subagent.failed` | `error?` | No | Subagent error |

### Usage & Quota Events

| SDK Event Type | JSON `type` Value | Key `data` Fields | Ephemeral | Description |
|----------------|-------------------|-------------------|-----------|-------------|
| Usage Info | `session.usage_info` | — | Yes | Current token usage |
| Assistant Usage | `assistant.usage` | `model?`, `inputTokens?`, `outputTokens?`, `cacheReadTokens?`, `cost?`, `duration?`, `quotaSnapshots?` | Yes | Token/cost metrics |

---

## Files

- `public/ts/message-streaming.ts` - All rendering logic (~400 lines)
- `public/ts/websocket.ts` - Message/activity callbacks
- `src/routes/websocket.ts` - Server broadcasts
- `src/routes/session-messages.ts` - SDK event → activity translation
