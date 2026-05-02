# Steering

## Goal

Allow users to send additional guidance to the agent mid-turn without canceling. While the agent is working, the user can type a message and send it as a "steer" — a queued follow-up that the agent processes after its current turn.

## SDK Capability

The Copilot SDK supports `mode: "enqueue"` on `session.send()`:

```typescript
session.send({ prompt: "focus on the auth module instead", mode: "enqueue" });
```

This queues a message that the SDK delivers after the current turn completes. The agent sees it as the next user message. The SDK emits `pending_messages.modified` (empty payload) when the queue changes.

This is not true mid-execution steering (the agent doesn't see the steer during its current turn). It's a queued follow-up — but the UX feels like steering because the user doesn't have to wait for idle to type.

## Current Behavior

1. User sends a message → textarea greys out, "Stop" button appears
2. Agent works (streaming events)
3. User can only click "Stop" (calls `POST /api/sessions/:id/cancel` → `session.abort()`)
4. On `session.idle` → textarea re-enables, "Stop" disappears

## Proposed Behavior

1. User sends a message → textarea greys out, "Stop" button appears
2. **User types in the greyed-out textarea** → button changes from "Stop" to "Steer ▸"
3. **User clicks "Steer ▸"** (or presses Enter) → message sent via enqueue, textarea clears, button reverts to "Stop"
4. **User clears textarea** → button reverts to "Stop"
5. Agent finishes current turn → picks up the queued steer as next message
6. Only one steer can be queued at a time. Re-steering replaces the pending steer.

## UI Changes

### Textarea behavior while busy

Currently the textarea is disabled (`disabled` attribute) while streaming. Change to:
- Remove `disabled` — textarea is always editable
- Add visual indicator that the session is busy (keep the existing greyed styling via CSS class, not `disabled`)
- Placeholder text: "Steer the agent..." while busy

### Button states

| State | Button text | Action |
|-------|------------|--------|
| Idle, empty textarea | (hidden or "Send") | Normal send |
| Idle, has text | "Send" | Normal send |
| Busy, empty textarea | "Stop" | Cancel/abort |
| Busy, has text | "Steer ▸" | Enqueue message |

### Visual feedback after steering

After the steer is sent:
- Brief toast: "Steer queued" (auto-hide 2s)
- The steered text appears in the chat as a user message (since it will be processed as the next turn)
- Textarea clears, button reverts to "Stop"

## API Changes

### Modified: `POST /api/sessions/:id/messages`

Add optional `mode` field:

```json
{
  "prompt": "focus on auth instead",
  "mode": "enqueue"
}
```

Pass through to `session.send({ prompt, mode })`. Default remains `undefined` (SDK default behavior for normal sends).

### No new endpoints

The existing messages endpoint handles both normal sends and steers.

## Implementation

### Backend

**`src/session-manager.ts`** — `sendStream()`: pass `mode` through to `session.send()`:

```typescript
sendStream(sessionId: string, message: string, options: Partial<SendOptions> = {}): Promise<string> {
  const { session } = this.activeSessions.get(sessionId)!;
  return session.send({ ...options, prompt: message });
}
```

No change needed — `options` already spreads into the send call. The `mode` field just needs to be included in the route handler.

**`src/routes/session-messages.ts`** — POST handler: read `mode` from body, include in send options. Add a guard: if `mode === 'enqueue'`, skip the `dispatchState.start()` call (the session is already dispatching).

### Frontend

**`public/ts/multiline-input.ts`** or **`public/ts/message-streaming.ts`**:
- Remove `disabled` attribute from textarea while busy. Use a CSS class for visual styling instead.
- Track `isBusy` state to determine button behavior.
- On form submit while busy: send with `mode: "enqueue"` instead of normal send.

**`public/ts/view-controller.ts`** or equivalent:
- `setFormEnabled(false)` currently sets `disabled`. Change to toggle a `.busy` class instead.
- Button text logic: check busy state + textarea content to determine label.

**`public/style.css`**:
- `.chat-form.busy textarea` — greyed/muted styling (replaces `:disabled`)
- Button transition between Stop/Steer states

## Edge Cases

1. **User steers then cancels** — Cancel aborts the current turn. The queued steer may or may not be processed depending on SDK behavior. Need to test: does `abort()` clear the pending message queue?
2. **Multiple rapid steers** — Only one can be queued. Second steer replaces the first. The SDK may handle this differently (append vs replace). Need to test.
3. **Steer while session is finishing** — Race between steer send and `session.idle`. If idle arrives before the enqueue completes, it becomes a normal next message. Acceptable — no harm done.
4. **Long tool execution** — User may want to steer while a tool runs for minutes. The steer won't affect the current tool — it queues for after. The UI should make this clear.

## Open Questions

1. Does `session.abort()` clear pending enqueued messages, or do they survive cancellation?
2. Does the SDK support replacing a pending enqueued message, or does each `send({ mode: "enqueue" })` append?
3. Should the steer message appear immediately in the chat (optimistic insert), or only when the SDK processes it?
4. Should the textarea placeholder change to indicate "steering mode" vs "normal input"?

## Risks

1. **SDK behavior untested** — `mode: "enqueue"` exists in types but Caco hasn't used it. First implementation should test basic enqueue behavior before building full UI.
2. **Textarea disabled→enabled change** — Other code may rely on `disabled` attribute checks. Need to audit all references to textarea disabled state.
3. **Button state management** — Adding a third state (Steer) to the existing Send/Stop toggle increases complexity. Must ensure states don't desync.
