# spec-agent-slash-command

## Goals

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

## Invariants

- **Dispatch critical section** (invariant): agent select + send start inside the
  one shared session lock used by normal messages; no concurrent message slips
  between `agent.select` and send. Code rots toward a second unlocked path.
- **Current-session only** (invariant): `/agent` acts on the active session; it is
  not a background launcher.
- **SDK is the agent source of truth** (fact): Caco lists exactly what
  `agent.list()` reports; no Caco-side agent registry in V1.
- **No fake selectable rows** (invariant): empty list → no rows + a toast, never a
  synthesized agent.
- **No prompt loss** (invariant): a pre-dispatch failure restores the full typed
  command to its bound draft.
- **Name-based selection** (mechanism): `agent.select({ name })`; `id` is
  display/debug only. Swappable if the SDK adds id-based select.

## Considerations

`agent.select` is name-only and persists after dispatch (no one-shot override), so
V1 is explicitly foreground selection. Whitespace-named agents are omitted from the
picker and rejected backend-side (grammar is whitespace-delimited). Opening the
picker may resume a cold session — accept a short loading row over caching in V1.

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

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Opening picker resumes a cold session and feels slow. | Show a short loading/empty row; do not cache across sessions in V1. |
| `agent.select` changes future turns unexpectedly. | Document V1 as foreground selection. Add one-shot restore only if SDK later exposes current selected agent. |
| SDK agent id/name mismatch. | Return both `id` and `name`; test against installed SDK behavior during implementation. |
| Custom-agent discovery may require additional SDK config. | V1 lists SDK-visible agents only; separate spec for Caco-shipped agent registry or plugin directory wiring. |
| Race between selection and normal send. | Use one shared session dispatch critical section covering select and send startup. |
| Prompt loss on slash-command failure. | Restore failed `/agent` commands to the correct bound draft/textarea. |

## Acceptance

- Observable: typing `/agent` opens a picker of the session's SDK agents; selecting
  fills `/agent <name> `; submitting dispatches the prompt under the selected agent.
- Budgets: no new persistence; no second dispatch path (reuse the locked helper); n/a perf.
- Gates: typecheck ×2, lint:strict, full tests, build:client.
- Oracles:

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

## Plan

Status: all steps shipped. Files+Oracle preserved for traceability.

| # | Step | Files | Oracle |
|---|------|-------|--------|
| 1 | SDK agent types + list/select + shared locked dispatch helper | `src/session-manager.ts` | session-manager test: select-before-send under lock |
| 2 | Refactor message dispatch to one locked helper with pre-send hook | `src/routes/session-messages.ts` | busy-safety test: concurrent dispatch returns busy, no select |
| 3 | Backend list/select/dispatch helpers (validation, busy safety) | `src/session-manager.ts`, `src/routes/sessions.ts` | route test: unknown/hidden/whitespace names → 404/400, no select |
| 4 | `GET /agents` + `POST /agent-dispatch` routes | `src/routes/sessions.ts` | route test: JSON error shapes |
| 5 | `/agent` built-in + picker fetching session agents | `public/ts/command-registry.ts` | registry unit test contains `/agent` |
| 6 | Picker uses `value ?? id` for trailing-space fill | `public/ts/chat-form-popups.ts` | hand-case: picked yields `/agent reviewer ` |
| 7 | Frontend restore-on-failure | `public/ts/command-registry.ts` | unit: failed POST restores full command to draft |
| 8 | README slash-command row | `README.md` | by-construction |
