# Thinking Feedback

**Status: Ready** - Implementation plan finalized.

Visual feedback when agent is processing complex tasks.

## Problem

When the agent is doing complex work (reasoning, tool calls), users see only a blinking cursor. This can make users uncertain whether the agent is still active, especially for long-running operations.

**Current behavior:**
1. User sends message → form disabled, blinking cursor appears
2. Agent reasons internally (no visual feedback)
3. First `assistant.message_delta` arrives → text starts streaming
4. `session.idle` → form re-enabled

**Gap:** Between steps 1 and 3, user sees only the cursor. Could be seconds to tens of seconds.

**Reproduction case:** Applet creation request that triggers `applet_howto` tool. After intent was shown, there was no feedback during a long "thinking" period.

## Investigation Complete

Analyzed SDK source (`node_modules/@github/copilot-sdk/dist/generated/session-events.d.ts`):

1. ✅ **Logged all SDK events** - Complete type definitions analyzed
2. ✅ **Documented event sequence** - See table below
3. ✅ **Found usable event**: `assistant.turn_start` is emitted but currently filtered

### Complete SDK Event Types (from session-events.d.ts)

Source: `node_modules/@github/copilot-sdk/dist/generated/session-events.d.ts`

| Event Type | Has Data | Currently Displayed? |
|------------|----------|---------------------|
| **Session Lifecycle** |||
| `session.start` | sessionId, model, context | No (internal) |
| `session.resume` | resumeTime, eventCount | No (internal) |
| `session.error` | errorType, message | ✅ Passthrough |
| `session.idle` | (empty) | ✅ Passthrough (signals done) |
| `session.info` | infoType, message | No (no handler) |
| `session.model_change` | previousModel, newModel | No |
| `session.handoff` | context, summary | No |
| `session.truncation` | tokenLimit, etc. | No |
| `session.usage_info` | tokenLimit, currentTokens | No (ephemeral) |
| `session.compaction_start` | (empty) | ✅ Displayed |
| `session.compaction_complete` | success, summary | ✅ Displayed |
| **User** |||
| `user.message` | content | ✅ Displayed |
| `pending_messages.modified` | (empty) | No (ephemeral) |
| **Assistant** |||
| `assistant.turn_start` | **turnId** | ❌ **FILTERED** (no content props) |
| `assistant.intent` | intent | ✅ Displayed (💡) |
| `assistant.reasoning` | reasoningId, content | ✅ Displayed |
| `assistant.reasoning_delta` | deltaContent | ✅ Displayed |
| `assistant.message` | messageId, content | ✅ Displayed |
| `assistant.message_delta` | deltaContent | ✅ Displayed |
| `assistant.turn_end` | **turnId** | ❌ **FILTERED** (no content props) |
| `assistant.usage` | model, tokens, cost | No (ephemeral, internal) |
| `abort` | reason | No |
| **Tool** |||
| `tool.user_requested` | toolCallId, toolName | ✅ Displayed (toolName) |
| `tool.execution_start` | toolCallId, toolName | ✅ Displayed (🔧) |
| `tool.execution_partial_result` | partialOutput | ✅ Displayed |
| `tool.execution_progress` | progressMessage | ✅ Displayed |
| `tool.execution_complete` | toolCallId, success | ✅ Displayed |
| **Subagent** |||
| `subagent.started` | toolCallId, agentName | ✅ Displayed |
| `subagent.completed` | agentName | ✅ Displayed |
| `subagent.failed` | agentName, error | ✅ Displayed |
| `subagent.selected` | agentName | ✅ Displayed |
| **Hook** |||
| `hook.start` | hookType | No |
| `hook.end` | hookType, success | No |
| **System** |||
| `system.message` | content | ✅ Displayed (has content) |

### Key Finding: `assistant.turn_start` and `assistant.turn_end`

These events ARE emitted by the SDK with a `turnId`, but are **filtered out** because our event filter looks for content properties like `content`, `deltaContent`, `intent`, etc.

**`assistant.turn_start`** could be the perfect "Thinking..." indicator - it fires when the assistant begins processing, before intent or any other events.

### Event Filter Logic

Events pass through if they have ANY of these properties:
- `content`, `deltaContent`, `intent`, `toolName`, `toolCallId`
- `message`, `progressMessage`, `partialOutput`, `agentName`

Events like `assistant.turn_start` have no data properties, so they're filtered.

### Action: Add Debug Logging

To capture the exact event sequence, temporarily log all raw events:

```typescript
// In session-messages.ts, add near top of event handler:
console.log(`[SDK-RAW] ${event.type}`, JSON.stringify(event.data || {}).slice(0, 200));
```

Then reproduce the long-thinking scenario and capture the console output.

## Current Event Flow

The SDK emits these events during processing:

| Event | When | Currently Displayed |
|-------|------|---------------------|
| `assistant.intent` | Agent declares intent | 💡 intent text (in activity) |
| `tool.execution_start` | Tool begins | 🔧 toolName (in activity) |
| `tool.execution_complete` | Tool ends | Updates same element |
| `assistant.reasoning_delta` | Reasoning tokens | Streamed (collapsible) |
| `assistant.message_delta` | Reply tokens | Streamed with cursor |

**Observation:** `assistant.intent` events ARE displayed, but:
1. They appear in the "activity" box, not prominently
2. Not all models emit intent events
3. Doesn't cover the initial "starting to think" moment

## Use Cases

1. **Simple query** - Agent responds quickly, minimal delay acceptable
2. **Complex reasoning** - Agent thinks for 5-30s before first token
3. **Tool execution** - Agent calls tools, waits for results
4. **Agent-to-agent** - Parent waits for child agent response

## Goals

- Clear indication that agent is working
- Non-intrusive (shouldn't dominate the UI)
- Works on mobile (small screen)
- Low implementation complexity

## Options

### Option A: Synthetic "Thinking..." Event

Emit `caco.thinking` on message send, hide on first content.

**Implementation:**
1. When form submits, insert a synthetic `caco.thinking` event
2. Display: `💭 Thinking...` in activity area
3. Hide/remove when first real event arrives (intent, tool, or message_delta)

**Pros:**
- Simple to implement
- Clear visual feedback
- Uses existing event system

**Cons:**
- Adds synthetic event
- Need to hide when real events arrive

### Option B: Animated Cursor Enhancement

Keep blinking cursor, but add text nearby.

**Implementation:**
1. Add label near cursor: "Thinking..." or "Processing..."
2. Could use CSS ::before on the assistant-message container

**Pros:**
- Pure CSS, no event changes
- Minimal code

**Cons:**
- Less clear than dedicated indicator
- Cursor might not be visible if no message box yet

### Option C: Sticky "Processing" Banner

Show banner at bottom of chat while busy.

**Implementation:**
1. Add fixed-position element below chat
2. Show while `isBusy = true`
3. Could show elapsed time

**Pros:**
- Always visible
- Could show timer

**Cons:**
- Takes up space on mobile
- More intrusive

### Option D: Enhance Intent Display

Make `assistant.intent` more prominent.

**Implementation:**
1. Style intent events more visibly
2. Auto-scroll to intent when it appears
3. Add fallback text if no intent received within X seconds

**Pros:**
- Uses existing events
- Shows actual agent intent

**Cons:**
- Depends on model emitting intents
- Still gap before first intent

## Recommendation: Use `assistant.turn_start`

The SDK already emits `assistant.turn_start` with a `turnId` when the assistant begins processing. This is the ideal "Thinking..." indicator - we just need to stop filtering it out.

### Implementation Plan

#### Phase 1: Basic Thinking Indicator

**Files to modify:**

1. **`src/event-filter.ts`**
   - Add `assistant.turn_start` to `PASSTHROUGH_TYPES`
   - This makes the event reach the frontend

2. **`public/ts/event-inserter.ts`**
   - Add handler for `assistant.turn_start`: display `💭 Thinking...`
   - Track thinking element reference
   - Remove on first content event (intent, tool, message_delta)

3. **`public/ts/element-inserter.ts`**
   - Add `assistant.turn_start` → `assistant-activity` mapping

4. **`public/style.css`**
   - Style `.thinking-text` with subtle animation (optional)

#### Pseudocode

```typescript
// In event-inserter.ts

let thinkingElement: HTMLElement | null = null;

function handleTurnStart(turnId: string): void {
  // Remove any existing thinking indicator
  thinkingElement?.remove();
  
  // Create thinking element
  const el = document.createElement('div');
  el.className = 'assistant-activity thinking';
  el.textContent = '💭 Thinking...';
  el.dataset.turnId = turnId;
  
  document.getElementById('chat')!.appendChild(el);
  thinkingElement = el;
}

function hideThinkingIndicator(): void {
  thinkingElement?.remove();
  thinkingElement = null;
}

// In event handler switch:
case 'assistant.turn_start':
  handleTurnStart(event.data.turnId);
  break;

// Call hideThinkingIndicator() on content events (intent, tool, message_delta)
```

#### Content Events (hide thinking on these)

```typescript
const CONTENT_EVENTS = new Set([
  'assistant.intent',
  'assistant.message',
  'assistant.message_delta',
  'assistant.reasoning',
  'assistant.reasoning_delta',
  'tool.execution_start',
  'session.idle',
  'session.error'
]);
```

### Phase 2 Enhancements (Future)

- Show elapsed time: `💭 Thinking... (5s)`
- Different text for tool execution: `🔧 Running tool...`
- Animate the lightbulb/thought emoji

## Effort Estimate

| Phase | Scope | Lines |
|-------|-------|-------|
| 1 | Basic thinking indicator | ~40 |
| 2 | Timer, contextual text | ~30 |

## Risks

1. **Race condition** - Thinking shows briefly then hides (acceptable)
2. **Multiple messages** - Need to track per-request (use message count?)
3. **History load** - Don't show thinking on history replay

## Decision

✅ **Ready for implementation** - Use `assistant.turn_start` event.

### Implementation Steps

1. Add `assistant.turn_start` to `PASSTHROUGH_TYPES` in `src/event-filter.ts`
2. Add handler in `public/ts/event-inserter.ts` to show "💭 Thinking..."
3. Track thinking element, remove on first content event
4. Optional: Add subtle animation via CSS
