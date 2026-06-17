# /agent slash command

## Goal

Add a Caco slash command that discovers SDK-configured agents for the current
session, lets the user pick one, and fills the input as:

```text
/agent <agent-name> <prompt>
```

Submitting that command dispatches the prompt in the current Caco session after
selecting the named SDK agent.

## Design

| Area | Decision |
|---|---|
| UX | `/agent` with no args opens a picker of `session.rpc.agent.list()` results. Selecting an agent writes `/agent <name> ` and leaves the cursor after the space. |
| Dispatch | `/agent <name> <prompt>` selects the named SDK agent, then sends `<prompt>` through the normal active session dispatch path. |
| Scope | Foreground/current session only. This is not a background-agent launcher and not a swarm replacement. |
| Agent source | Treat the SDK as source of truth. Caco lists whatever the active/resumed SDK session reports: user, project, plugin, built-in, or Caco-supplied custom agents. |
| Selection lifetime | Leave the selected SDK agent active after dispatch. SDK `agent.select` is name-only and does not expose a one-shot override. |
| Command grammar | V1 accepts only whitespace-free SDK agent names: `/agent <non-space-name> <prompt>`. Agents whose names contain whitespace are omitted from the picker and rejected with a clear error. Quoting can be a later feature. |
| Empty state | If the SDK reports no usable agents, picker opens no row and a toast explains that no SDK agents are available. Do not add fake selectable rows. |
| Validation | Backend validates `agentName` against `agent.list()` immediately before selecting. Unknown, whitespace-containing, or `userInvocable === false` agents return 404/400 and do not select. |
| Errors | Surface SDK/list/select/send failures as normal Caco command toasts; do not silently fall back to primary agent. |
| Failure recovery | If `/agent ...` fails before dispatch starts, restore the full typed command to the textarea/draft instead of losing the prompt. |

## Code analysis

| File | Current behavior | Needed change |
|---|---|---|
| `public/ts/command-registry.ts` | Built-ins register handlers and optional picker functions. | Add `agent` command with picker and handler. |
| `public/ts/chat-form-popups.ts` | Picker selection writes `/${cmdName} ${picked.id}`. | Use `picked.value ?? picked.id` so `/agent` can add the trailing prompt space without affecting existing pickers. |
| `src/session-manager.ts` | SDK session type omits `rpc.agent`; send paths already manage active sessions. | Extend local SDK type; add list/select helpers and a shared locked dispatch helper. |
| `src/routes/sessions.ts` or new route | No HTTP surface for SDK agents. | Add `GET /api/sessions/:sessionId/agents` and `POST /api/sessions/:sessionId/agent-dispatch`. |
| `src/routes/session-messages.ts` | Owns normal message dispatch semantics. | Extract/reuse a shared dispatch function with a pre-send hook; do not duplicate busy/idle/error/watchdog/WebSocket behavior. |
| `README.md` | Slash command list has no `/agent`. | Add one terse row. |

## API

### `GET /api/sessions/:sessionId/agents`

Returns:

```ts
{
  agents: Array<{
    name: string;
    id: string;
    displayName: string;
    description: string;
    model?: string;
    userInvocable?: boolean;
    source?: unknown;
  }>;
}
```

Implementation notes:
- Resume the session if needed using the same config path as message dispatch.
- Filter `userInvocable === false` and names containing whitespace out of the picker.
- Use `agent.name` for SDK selection. Preserve `id` in the response for display/debug
  only; the installed SDK `agent.select` request accepts `name`.

### `POST /api/sessions/:sessionId/agent-dispatch`

Body:

```ts
{ agentName: string; prompt: string }
```

Behavior:
1. Validate non-empty `agentName` and `prompt`.
2. Reject names containing whitespace.
3. Enter the same session-level dispatch critical section used by normal messages.
4. Resume session if inactive.
5. List agents and require a matching `userInvocable !== false` agent.
6. `session.rpc.agent.select({ name: agentName })`.
7. Dispatch `prompt` through the normal streaming path.

The critical section must cover busy check/marking, selection, and send startup.
If the session is busy, return the same status/error shape as normal message
dispatch and do not call `agent.select`.

## Acceptance

| Case | Oracle |
|---|---|
| Slash popup includes `/agent` | Unit test command registry contains built-in command. |
| `/agent` picker lists SDK agents | Mock fetch response; picker items use label/display/description/model from response. |
| Selecting an agent fills exact command prefix | Hand-case unit test: picked `{ id: "reviewer", value: "reviewer " }` yields `/agent reviewer ` with trailing space. |
| Submit requires agent and prompt | Unit test handler shows usage toast and does not POST for `/agent` or `/agent reviewer`. |
| Submit dispatches selected agent prompt | Unit test POST body equals `{ agentName: "reviewer", prompt: "check reliability" }`. |
| Failed frontend POST preserves text | Unit test failed `/agent reviewer long prompt` restores the full command into the bound textarea/draft. |
| Backend rejects unknown agent | Route/session-manager test with mock list lacking name returns 404 and never calls `agent.select`. |
| Backend rejects hidden/bad names | Route tests reject `userInvocable === false` and whitespace-containing names before `agent.select`. |
| Backend selects before sending under lock | Route/session-manager test asserts `agent.select` happens before send/stream call and no concurrent normal message can slip between them. |
| Busy sessions are safe | Backend test: busy/concurrent dispatch returns busy error and does not call `agent.select`. |
| Errors are visible | Route returns non-2xx JSON; frontend displays returned `error` and restores input when dispatch did not start. |

## Risks

| Risk | Mitigation |
|---|---|
| Opening picker resumes a cold session and feels slow. | Show a short loading/empty row; do not cache across sessions in V1. |
| `agent.select` changes future turns unexpectedly. | Document V1 as foreground selection. Add one-shot restore only if SDK later exposes current selected agent. |
| SDK agent id/name mismatch. | Return both `id` and `name`; test against installed SDK behavior during implementation. |
| Custom-agent discovery may require additional SDK config. | V1 lists SDK-visible agents only; separate spec for Caco-shipped agent registry or plugin directory wiring. |
| Race between selection and normal send. | Use one shared session dispatch critical section covering select and send startup. |
| Prompt loss on slash-command failure. | Restore failed `/agent` commands to the correct bound draft/textarea. |

## Plan

- [x] Add SDK agent types to `session-manager.ts`, including `rpc.agent.list/select`.
- [x] Refactor normal message dispatch to expose one shared locked helper with a pre-send hook.
- [x] Add backend helpers: list agents for a session, select agent, dispatch prompt after selection inside the shared lock.
- [x] Add HTTP routes for agent list and agent dispatch with validation, busy safety, and JSON errors.
- [x] Add `/agent` to `BUILTIN_COMMANDS` with a picker that fetches current-session agents.
- [x] Update `FormPopups.openPicker` to use `PopupItem.value ?? PopupItem.id`; make `/agent` picker values include the trailing space.
- [x] Add frontend restore-on-failure path for `/agent` command dispatch.
- [x] Add frontend unit tests for picker population, exact command fill, usage validation, restore-on-failure, and dispatch POST payload.
- [x] Add backend tests for list/select validation, hidden/unknown-agent rejection, busy safety, and locked select-before-send ordering.
- [x] Add README slash-command row.
- [x] Run typecheck, lint, unit tests, and client build.
