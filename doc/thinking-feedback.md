# Thinking Feedback

**Status: Implemented**

Visual feedback when agent is processing complex tasks.

## Problem

When the agent is doing complex work (reasoning, tool calls), users see only a blinking cursor. Between sending a message and the first `assistant.message_delta`, there's no visual feedback — could be seconds to tens of seconds.

## Goals

- Clear indication that agent is working
- Non-intrusive (shouldn't dominate the UI)
- Works on mobile (small screen)
- Low implementation complexity

## Decision

Uses `assistant.turn_start` event — already emitted by the SDK but was previously filtered out (no content properties). This fires when the assistant begins processing, before intent or any other events.

### Implementation

| File | Change |
|------|--------|
| `src/event-filter.ts` | Added `assistant.turn_start` to `PASSTHROUGH_TYPES` |
| `public/ts/element-inserter.ts` | Added mappings for `assistant.turn_start` |
| `public/ts/event-inserter.ts` | Added inserter: displays "Thinking..." |
| `public/ts/message-streaming.ts` | Added `hideThinkingIndicator()` on content events |
| `public/style.css` | Added `.thinking-text` with subtle pulse animation |

Thinking indicator is hidden on first content event (intent, tool, message_delta, session.idle, session.error).
