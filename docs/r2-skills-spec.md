# R2 — Skills as `/skill-name` slash commands

Status: spec (light). Goal: render the SDK's `commands.list` **skill** entries as native
`/<skill-name>` slash commands, invoked via `commands.invoke`. This is the real
Spec-Kit *skills-mode* deliverable (`/speckit-specify …`) and the last invocation gap.

## Probe facts (confirmed, `@github/copilot-sdk@1.0.1`, discovery on)

- `rpc.commands.list()` returns skill commands shaped:
  `{ name, description, kind: 'skill', input?: { hint?, required? }, allowDuringAgentExecution }`.
  (e.g. `code-review`, `cpp-project` from `~/.copilot/skills`.)
- `rpc.commands.invoke({ name, input })` returns a `SlashCommandInvocationResult`. For a
  skill it is `{ kind: 'agent-prompt', prompt, displayPrompt }`:
  - `prompt` = the text to submit to the agent ("Use the skill tool to invoke the
    \"code-review\" skill, then follow the skill's instructions to help with: <input>").
  - `displayPrompt` = what the user should see in the timeline ("/code-review <input>").
  - The SDK does **not** auto-submit — Caco owns the single send.
- The SDK send already supports `displayPrompt`: *"If provided, this is shown in the
  timeline instead of `prompt`."* (`types.d.ts:1818`; `session.send` passes it through).

## Design (mirror the agent surface)

**Server**
1. `session-manager.ts`: add to the rpc interface
   `commands: { list(): Promise<{ commands: SdkCommandInfo[] }>; invoke(p:{name:string; input?:string}): Promise<SdkCommandInvokeResult>; }`
   and thin `listCommands(sessionId)` / `invokeCommand(sessionId, name, input)` methods.
   Add `displayPrompt?: string` to the local `SendOptions` interface (it already flows
   through `sendStream(session.send({ ...options }))`).
2. `session-messages.ts` `dispatchMessage`: add `displayPrompt?: string` to its options
   and thread it into `messageOptions` (so the user sees `displayPrompt`, not the skill
   wrapper prompt).
3. `routes/sessions.ts`:
   - `GET /sessions/:id/skills` → resume-if-needed, `listCommands`, filter
     `kind === 'skill'`, return `{ skills: [{ name, description, hint }] }` (mirror
     `/agents`).
   - `POST /sessions/:id/skill-invoke` body `{ name, input }`:
     resume-if-needed → confirm the named skill exists in `listCommands` (else 404) →
     `invokeCommand(name, input)`:
     - `agent-prompt` → `dispatchMessage(sessionId, result.prompt, { displayPrompt:
       result.displayPrompt || \`/\${name} \${input}\`.trim(), requestId, needsObservation:true,
       beforeSend? none }, { onEvent: broadcast })`. Respond `{ ok:true, sessionId }`.
     - `text` → broadcast a `session.info` (or `caco.info`) with the text; respond ok.
     - any other kind (`completed`/`select-subcommand`) → respond 200
       `{ ok:true, unsupported: kind }` and toast client-side ("Unsupported skill result").
     Reuse the `isBusy` 409 + 404 session guards from `agent-select`.

**Client** (`command-registry.ts`)
4. `fetchSessionSkills()` (mirror `fetchSessionAgents`) → `GET /skills`.
5. `loadSkillCommands()` — session-scoped registration (mirror the prompt-template
   lifecycle): dispose the prior batch, fetch skills, register each as
   `registerCommand({ name, description, source:'skill', handler })`. The handler posts
   `{ name, input: arg.trim() }` to `/skill-invoke`; on !ok restore input + red toast; on
   ok clear (the form already cleared) — no green toast (the turn itself is the feedback).
   **Skills never shadow a built-in/extension command** (`findCommand` check, like the
   reverted G1 did for agents). Add a **session-id staleness guard** around the async
   fetch (capture `getActiveSessionId()` before, bail if it changed) — the same race fix.
6. Add `'skill'` to `Command.source`. Subscribe `onSessionActivate(() =>
   void loadSkillCommands())` (the agent set is cwd-scoped; skills are too).

## Out of scope (light)
- Builtin (`kind:'builtin'`) and `client` commands — only `kind:'skill'` is rendered.
- Live `commands.changed` re-registration — reload on session activate is enough for v1.
- `input.required`/`hint` UI affordances beyond passing the typed text as `input`.
- Picker/argument-hint UX; `select-subcommand` interactive flow (degrade to a toast).

## Tests
- Unit (pure): a `filterSkillCommands(commands)` helper (keep only `kind:'skill'`,
  `userInvocable !== false` if present) — table test.
- `command-registry.test.ts`: `loadSkillCommands` registers `/<name>` from a stubbed
  `/skills`; the handler posts `{ name, input }` to `/skill-invoke`; a skill does not
  shadow a built-in; the stale-session batch is discarded (mirror the old G1 tests).
- Build gate (`npm run build`) green.

## R2.1 — invocation refinements (implemented)

Three follow-ups after the first R2 cut, to make skill invocation explicit and transparent:

1. **Skill-tool guard.** Skills run by asking the agent to call its built-in `skill` tool
   (there is **no** direct skill-exec API — `rpc.skills` is only list/enable/disable/reload;
   the `commands.invoke` → `agent-prompt` → agent-calls-`skill`-tool flow is the SDK's and
   the CLI's only mechanism). `skillToolEnabled()` (`tool-registry.ts`) guards the
   `CACO_EXCLUDED_BUILTINS` misconfiguration; `skill-invoke` returns 400 with a clear
   message (→ red toast) if the tool is excluded. Caco never excludes it by default.

2. **Explicit wrapper prompt.** The dispatched agent prompt is the SDK's canonical
   agent-prompt ("Use the skill tool to invoke the \"<name>\" skill, then follow the
   skill's instructions to help with: <input>"), with a Caco `buildSkillPrompt` fallback
   so a bare slash is never dispatched. (Whether the agent then runs the skill is
   non-deterministic — same as the CLI.)

3. **Purple, transparent display.** Instead of echoing the user's `/skill …` text, the
   timeline shows the **actual prompt the agent received**, rendered purple as a
   system-produced message (like `/session-fork`). Mechanism: a new `skill`
   `MessageSource` (`[skill:<name>]` marker) — `displayPrompt =
   prefixMessageSource('skill', name, agentPrompt)`; `enrichUserMessageWithSource` parses
   it (live + replay) → `data.source='skill'` → frontend `caco.skill` → reuses the purple
   `agent-message`/`agent-text` styling. Survives reload (enrich runs on history replay).

