# Steering

## Goal

Allow users to send guidance to the agent mid-turn without canceling. The SDK's `mode: "immediate"` injects messages into the current LLM turn.

## SDK Behavior

`session.send({ prompt, mode: "immediate" })` adds to the `ImmediatePromptProcessor` queue. Before the next LLM request within the current turn, all queued immediate messages are injected as user messages. The agent adjusts its response.

Key details:
- Multiple steers **append** (FIFO). Each `send({ mode: "immediate" })` adds another.
- If the turn completes before processing, the message auto-moves to the regular queue for the next turn.
- Best-effort within current turn — if agent committed to a tool call, steering takes effect after that call completes (still same turn).
- No capability flag needed — `mode` is passed directly via RPC.

`pending_messages.modified` event fires when the queue changes (empty payload — no count or contents exposed). No RPC to query queue state.

## Current Form Behavior

- `setFormEnabled(false)` adds `.streaming` class to `#chatForm`
- Textarea is not HTML `disabled` — `.streaming` class controls visual muting
- Enter key handler (multiline-input.ts:92) checks `.streaming` and blocks submit
- Session drafts (`sessionDrafts` Map) save/restore textarea on session switch
- Slash commands: `tryExecuteSlashCommand()` intercepts before send. Runs locally regardless of busy state.

## Proposed Behavior

### Form state machine

Pure function, two inputs, four states:

```typescript
type ButtonState = 'send' | 'stop' | 'steer' | 'hidden';
type ButtonAction = 'send' | 'abort' | 'steer' | 'none';

interface FormState {
  buttonLabel: ButtonState;
  buttonAction: ButtonAction;
  placeholder: string;
  textareaBusy: boolean;
}

function computeFormState(sessionBusy: boolean, hasText: boolean): FormState {
  if (!sessionBusy) {
    return {
      buttonLabel: hasText ? 'send' : 'hidden',
      buttonAction: hasText ? 'send' : 'none',
      placeholder: 'Ask anything...',
      textareaBusy: false,
    };
  }
  return {
    buttonLabel: hasText ? 'steer' : 'stop',
    buttonAction: hasText ? 'steer' : 'abort',
    placeholder: 'Steer the agent...',
    textareaBusy: true,
  };
}
```

| busy | hasText | Button | Action |
|------|---------|--------|--------|
| false | false | hidden | — |
| false | true | **Send** | normal send |
| true | false | **Stop** | abort |
| true | true | **Steer** | `mode: "immediate"` |

### Submit flow

```
On submit (Enter or button click):
  1. If slash command (starts with /) → tryExecuteSlashCommand() → if matched, done
  2. Read computeFormState(sessionBusy, hasText)
  3. If buttonAction === 'send' → normal streamResponse()
  4. If buttonAction === 'steer' → POST /api/sessions/:id/messages with { mode: 'immediate' }
  5. If buttonAction === 'abort' → POST /api/sessions/:id/cancel
  6. If buttonAction === 'none' → no-op
```

Slash commands run identically in busy and idle states — they're local UI actions.

### Enter key guard

Replace the `.streaming` guard (multiline-input.ts:92) with:
```typescript
if (form) form.requestSubmit();
```
The submit handler itself decides what to do based on `computeFormState()`. No need to block Enter while busy.

### Steer counter

Track steers client-side since the SDK doesn't expose queue contents:
- Increment on each steer sent
- Reset to 0 on `session.idle`
- Display as badge on Stop button when > 0: `Stop (2)`
- `pending_messages.modified` event not used for counter (empty payload, unreliable for counting)

### Visual feedback

- Steered message appears immediately in chat as a normal user message (optimistic insert)
- Textarea clears after steer, button reverts to Stop
- Placeholder changes to "Steer the agent..." while busy
- No special "steered" label on messages — they're just user messages

### Draft interaction

No changes needed. Existing `saveDraft()`/`restoreDraft()` works naturally:
- Switch away from busy session with steer text → saves as draft
- Switch back → restores draft, `computeFormState()` re-evaluates
- Session goes idle while away → draft becomes normal Send on return

## API Changes

### Modified: POST /api/sessions/:id/messages

Accept `mode` field. When `mode === 'immediate'`:
- Skip `dispatchState.start()` (session already dispatching)
- Skip the busy-session rejection guard
- Call `sessionManager.sendStream(sessionId, prompt, { mode: 'immediate' })`
- Broadcast user message event to WebSocket subscribers
- Return 200 immediately

This is a **separate code path** from `dispatchMessage()` — no event subscription setup, no retry logic, no dispatch state tracking. Just send + broadcast.

## Implementation

### Step 1: computeFormState + tests

Create `public/ts/form-state.ts`:
- Export `computeFormState(sessionBusy, hasText): FormState`
- Export types

Create `tests/unit/form-state.test.ts`:
- Test all 4 state table rows
- Test that slash commands are orthogonal (not part of state machine)

### Step 2: Backend — steer route

`src/routes/session-messages.ts`:
- Read `mode` from request body
- If `mode === 'immediate'`: validate session exists + is active, call `sendStream()` with mode, broadcast user message, return. No `dispatchMessage()`.
- Normal sends unchanged

### Step 3: Wire form state to UI

`public/ts/multiline-input.ts`:
- Remove `.streaming` Enter guard (line 92)
- Import and use `computeFormState()` to determine submit behavior

`public/ts/view-controller.ts`:
- `setFormEnabled()` toggles `.busy` class instead of `.streaming`
- Update placeholder text based on state

`public/ts/message-streaming.ts`:
- Form submit handler: check `computeFormState()` before deciding send vs steer vs abort
- On steer: POST with `{ mode: 'immediate' }`, insert user message optimistically, clear textarea
- Track steer counter, reset on idle

### Step 4: Button rendering

- Button text driven by `computeFormState().buttonLabel`
- Re-evaluate on: textarea `input` event, busy state change, session switch
- Steer counter badge: `Stop (N)` when N > 0

### Step 5: CSS

- Replace `.streaming` with `.busy` on form
- `.chat-form.busy textarea` — muted styling (editable but visually dimmed)
- Button label transitions
- Steer counter badge styling

### Step 6: Audit + build + test

- `grep -rn 'streaming' public/ts/` — update all `.streaming` references
- `npx tsc --noEmit`, `npm run build:client`, `npm test`
- Manual test: send message, type while busy, Enter steers, button shows Steer/Stop correctly

## Risks

1. **`.streaming` class removal** — other code checks this class. Must audit and update all references.
2. **Busy-guard bypass** — the `mode: 'immediate'` path must be precise. Only `immediate` mode skips the guard.
3. **Optimistic insert** — user message appears in chat before SDK processes it. If the session dies, the message is orphaned in the DOM. Acceptable — same as current behavior for normal sends.
4. **Steer counter desync** — counter is client-side, SDK processing is async. Off-by-one is harmless since it resets on idle.
5. **Untested SDK behavior** — `mode: "immediate"` is documented but Caco hasn't used it. First steer in production is a live test.
