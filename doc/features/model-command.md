# /model Command — Change Session Model

## Goal

Let users change the model of an active session via `/model` slash command. A picker shows available models. Selecting one calls the SDK's `session.setModel()` to switch without losing conversation history.

## Design

### 1. Command with sub-picker

Extend the `Command` interface with an optional `picker` property. When present, selecting the command shows a second popup with the picker's items instead of running the handler immediately.

```typescript
interface Command {
  name: string;
  description: string;
  source: 'built-in' | 'template' | 'extension';
  handler: (args: string) => void | Promise<void>;
  picker?: () => PopupItem[] | Promise<PopupItem[]>;
}
```

Flow:
1. User types `/` → slash popup shows commands
2. User selects `/model` → slash popup hides
3. Picker items load (sync or async) → new popup appears with model list
4. User selects a model → `handler(modelId)` runs
5. Handler calls `PATCH /api/sessions/:id` with `{ model: modelId }`

### 2. Server endpoint

Extend existing `PATCH /api/sessions/:id` to accept `{ model: string }`.

```typescript
// In sessions.ts PATCH handler:
if (model !== undefined) {
  const session = sessionManager.getSession(sessionId);
  if (session) {
    await (session as { setModel: (m: string) => Promise<void> }).setModel(model);
    syncModelCache(sessionId, model);
  }
}
```

Add `setModel` to `CopilotSessionInstance` interface in session-manager.ts.

### 3. /model command registration

Register in `command-registry.ts`:

```typescript
registerCommand({
  name: 'model',
  description: 'Change session model',
  source: 'built-in',
  picker: () => {
    const models = getAvailableModels();
    return models.map(m => ({
      id: m.id,
      label: m.name,
      description: m.cost === 0 ? 'free' : `${m.cost}x`
    }));
  },
  handler: async (modelId) => {
    const sessionId = getActiveSessionId();
    if (!sessionId) return;
    await fetch(`/api/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId })
    });
    chatView.updateStatus(chatView.getCwd(), modelId);
  }
});
```

### 4. Multiline-input sub-picker flow

In `handleSlash` (`multiline-input.ts`), after the user selects a command with a `picker`:

```typescript
onSelect: (item) => {
  slashPopup.hide();
  textarea.value = '';
  const cmd = findCommand(item.id);
  if (!cmd) return;
  
  if (cmd.picker) {
    // Show sub-picker
    void Promise.resolve(cmd.picker()).then(items => {
      slashPopup.show(items);
      // Override onSelect for sub-picker
    });
  } else {
    void Promise.resolve(cmd.handler(''));
  }
}
```

The challenge: `InputPopup`'s `onSelect` is set at creation time. For the sub-picker, we need a different `onSelect` that calls `cmd.handler(item.id)`. Two options:

**A. Create a second InputPopup** for sub-picks. Simple, no state management.
**B. Re-show the same popup** with a temporary onSelect override. Requires InputPopup to support dynamic onSelect.

Option A is simpler and avoids modifying InputPopup internals.

## Considerations

- `getAvailableModels()` may be empty if SDK models haven't loaded. The picker should show a fallback message or the hardcoded list from model-selector.
- `session.setModel()` only works on active sessions. The command should only be available in chatting view.
- The model change should update the footer status bar.
- The PATCH endpoint already handles `name` and `setContext`. Adding `model` is consistent.

## Acceptance

- [ ] `/model` appears in slash command list
- [ ] Selecting it shows a model picker popup
- [ ] Picking a model changes the session's model via SDK
- [ ] Footer status bar updates with new model name
- [ ] Other slash commands with `picker` work the same way (generic)
- [ ] Commands without `picker` work unchanged
