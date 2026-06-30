# R2 — Skills as `/skill-name` slash commands

Status: spec (light). Goal: render the SDK's `commands.list` **skill** entries as native `/<skill-name>` slash commands, invoked via `commands.invoke`. This is the real Spec-Kit *skills-mode* deliverable and the last invocation gap.

## Goals

Render SDK skill commands as native slash commands in Caco so any skill in `~/.copilot/skills` can be invoked as `/<skill-name> <input>`, with the agent prompt dispatched transparently and the timeline showing what the agent actually received. After this change, skills are first-class commands indistinguishable in UX from built-ins.

## Design

**Server** — three new capabilities in `session-manager.ts`: `listCommands(sessionId)` (thin wrap of `rpc.commands.list()`), `invokeCommand(sessionId, name, input)` (thin wrap of `rpc.commands.invoke()`), and `displayPrompt` threading through `SendOptions` → `dispatchMessage`. Routes in `routes/sessions.ts`:
- `GET /sessions/:id/skills` → filter `kind === 'skill'`, return `{ skills: [{ name, description, hint }] }`.
- `POST /sessions/:id/skill-invoke` body `{ name, input }` → validate skill exists → `invokeCommand` → if `agent-prompt`: `dispatchMessage(prompt, { displayPrompt, needsObservation:true })` → `{ ok:true }`. If `text`: broadcast `caco.info`. Other kinds: `{ ok:true, unsupported: kind }`. Guards: `isBusy` → 409; session not found → 404.

**Client** — `command-registry.ts` gains `fetchSessionSkills()` + `loadSkillCommands()` (session-scoped, mirroring the prompt-template lifecycle): dispose the prior batch, fetch skills, register each as a command with `source:'skill'`. Handler posts to `/skill-invoke`; on `!ok` restores input + red toast. A session-id staleness guard wraps the async fetch (capture before, bail if changed). `onSessionActivate(() => void loadSkillCommands())` (skills are cwd-scoped).

**Skill display (R2.1)** — the timeline shows the actual agent prompt, rendered purple as a system-produced message. Mechanism: `MessageSource = 'skill'` (`[skill:<name>]` marker prefix); `enrichUserMessageWithSource` parses it on live + replay → `data.source='skill'` → `caco.skill` render → purple `agent-message` styling. `skillToolEnabled()` guards against `CACO_EXCLUDED_BUILTINS` misconfiguration (returns 400 if excluded).

## Probe Facts

Confirmed against `@github/copilot-sdk@1.0.1` with discovery on: `rpc.commands.list()` returns `{ name, description, kind: 'skill', input?: { hint?, required? }, allowDuringAgentExecution }`; `rpc.commands.invoke({ name, input })` returns `{ kind: 'agent-prompt', prompt, displayPrompt }`. The SDK does not auto-submit — Caco owns the send. `session.send` accepts `displayPrompt` (`types.d.ts:1818`).

## Invariants

- Skills never shadow a built-in or extension command; `loadSkillCommands` checks `findCommand` before registering.
- A stale-session batch is fully discarded when the active session changes before the async fetch completes.
- The `skill` tool being enabled is a precondition for invocation; misconfiguration is surfaced as a 400, not a silent failure.

## Considerations

- Only `kind:'skill'` is rendered; `builtin` and `client` commands are out of scope for v1.
- Live `commands.changed` re-registration is out of scope; reload on session activate is sufficient.
- `input.required`/`hint` UI affordances beyond passing typed text are out of scope.
- `select-subcommand` interactive flow degrades to a toast (unsupported kind).
- Skill display is transparent (purple, system-style) so the user can see the exact prompt dispatched to the agent.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Skill shadows a built-in | `findCommand` check before registration; skills cannot shadow built-ins. |
| Stale session batch registers for the wrong session | Staleness guard captures `getActiveSessionId()` before fetch; discards if session changed. |
| `skill` tool excluded via `CACO_EXCLUDED_BUILTINS` | `skillToolEnabled()` in `/skill-invoke`; returns 400 with clear message → red toast. |
| Timeline shows raw wrapper prompt | `displayPrompt` threads through `dispatchMessage`; purple `[skill:<name>]` marker renders actual prompt. |

## Acceptance

- Observable: `/<skill-name>` appears in the command picker after session activation; invoking it dispatches the agent prompt and shows a purple system message in the timeline with the actual prompt the agent received.
- Budgets: n/a.
- Gates: `npm run build` green; `tests/unit/command-registry.test.ts` green.
- Oracles:
  - `loadSkillCommands` registers `/<name>` from a stubbed `/skills` response (`command-registry.test.ts`).
  - Handler posts `{ name, input }` to `/skill-invoke` (`command-registry.test.ts`).
  - A skill does not shadow an existing built-in (`command-registry.test.ts`).
  - Stale-session batch is discarded when session changes mid-fetch (`command-registry.test.ts`).
  - `skillToolEnabled()` returning false → `/skill-invoke` returns 400 (`tool-registry.test.ts`).
  - `[skill:<name>]` prefix parsed by `enrichUserMessageWithSource` → `source:'skill'` (`message-source.test.ts`).

## Plan

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 1 | Add `listCommands`/`invokeCommand` to `SessionManager` + `displayPrompt` threading | `src/session-manager.ts`, `src/session-messages.ts` | build green | - |
| 2 | Add `GET /skills` and `POST /skill-invoke` routes | `src/routes/sessions.ts` | `isBusy` → 409; skill not found → 404 — by-construction | Busy guard |
| 3 | Add `fetchSessionSkills()` + `loadSkillCommands()` + `onSessionActivate` wiring | `public/ts/command-registry.ts` | skills registered from stub; stale batch discarded — `command-registry.test.ts` | Skills never shadow; stale guard |
| 4 | Add `skillToolEnabled()` guard | `src/tool-registry.ts` | 400 returned when tool excluded — `tool-registry.test.ts` | Tool enabled is precondition |
| 5 | Add `MessageSource = 'skill'` + purple display | `src/session-messages.ts`, `public/ts/message-source.ts`, `public/style.css` | `[skill:<name>]` parsed → `source:'skill'` — `message-source.test.ts` | Transparent display |
| 6 | Unit tests: filter, register, shadow, stale, display | `tests/unit/command-registry.test.ts`, `tests/unit/message-source.test.ts`, `tests/unit/tool-registry.test.ts` | all oracle cases green | - |

## R2.1 — Invocation Refinements

Three follow-ups after the first R2 cut:

1. **Skill-tool guard.** `skillToolEnabled()` (`tool-registry.ts`) guards `CACO_EXCLUDED_BUILTINS` misconfiguration; `/skill-invoke` returns 400 with a clear message → red toast. Caco never excludes it by default.
2. **Explicit wrapper prompt.** The dispatched agent prompt is the SDK's canonical agent-prompt with a `buildSkillPrompt` fallback so a bare slash is never dispatched.
3. **Purple transparent display.** Timeline shows the actual prompt received by the agent, rendered purple as a system-produced message (`[skill:<name>]` marker, `enrichUserMessageWithSource`, `caco.skill` frontend, `agent-message`/`agent-text` styling). Survives reload (enrich runs on history replay).

## Out of Scope

- `builtin`/`client` SDK commands — only `kind:'skill'` is rendered.
- Live `commands.changed` re-registration — reload on session activate is enough for v1.
- `input.required`/`hint` UI affordances beyond passing typed text.
- `select-subcommand` interactive flow (degrades to a toast).
