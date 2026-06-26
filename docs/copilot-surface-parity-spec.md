# Copilot CLI surface parity (Spec Kit enablement)

Status: spec (not started). Supersedes the gap analysis in `docs/speckit.md` with
SDK-grounded facts. Goal: bring Caco's interactive surface to **parity with the
Copilot CLI's own config consumption** so that anything `specify init --integration
copilot` (or any plugin/agent/prompt author) installs into `~/.copilot/` or a project
**just works** in a Caco session.

**Explicit non-goal:** supporting Spec Kit *directly* (no Spec-Kit-specific code,
templates, or commands). Spec Kit is merely the motivating consumer. The deliverable
is generic: *Caco consumes the same SDK-surfaced commands/agents/prompts/hooks the CLI
does.*

## The reframing this research forces

The earlier assumption — "lean on the SDK's consumption of `~/.copilot/` and bolt on
slash-command registration" — is **half right**. The SDK already exposes a **first-
class slash-command RPC** that the CLI itself renders. Parity is therefore mostly
**"surface what the SDK already computes,"** not "re-derive commands from files."

Verified against `@github/copilot-sdk@1.0.1` (`node_modules/@github/copilot-sdk/dist`):

| Concept | SDK surface | Evidence |
|---|---|---|
| **Slash commands** | `session.commands.list` → `CommandList { commands: SlashCommandInfo[] }`; `session.commands.invoke` → `SlashCommandInvocationResult`; `commands.changed` event | rpc.js:1166/1174; rpc.d.ts:2680, 1336 |
| **Command kinds** | `SlashCommandKind = "builtin" | "skill" | "client"` | rpc.d.ts:206 |
| **Invoke result** | `text` (render), **`agent-prompt`** (submit `prompt` to the agent, show `displayPrompt`), `completed`, `select-subcommand` | rpc.d.ts:10577 (`SlashCommandAgentPromptResult`) |
| **Agents** | `rpc.agent.list/select`; `custom-agents.updated` event; `customAgents`/`customAgentsLocalOnly` create-config | session-manager.ts:157-161; types.d.ts:1408,1523 |
| **Prompts** | Surfaced *as slash commands* by the SDK — there is **no separate "prompts" RPC**. Whether `~/.copilot/prompts` + project prompt/command files actually appear in `commands.list` is **unverified** (only the RPC *shape* is proven by types); gated by probe U1. | rpc.d.ts:2680 (no prompts.* RPC); `CommandList.commands` lists "available commands" without naming discovery sources |
| **Hooks** | `hooks: SessionHooks` create-config (in-process JS handlers: `onSessionStart`, `onUserPromptSubmitted`, `onPreToolUse`, `onPostToolUse`, `onSessionEnd`, …) **and** file/plugin hooks via `sessions.reloadPluginHooks`, `loadDeferredRepoHooks` (which "return queued startup prompts" — repo-level prompt **strings**, not auto-executed) | types.d.ts:1483; rpc.js:378-392 |
| **Plugins** | Full manager + session RPC: `plugins.list/install/uninstall/enable/disable/update`, `plugins.marketplaces.*`, `session.plugins.list/reload` | rpc.js:110-190, 1075-1081 |
| **configDir** | SDK public option is **`configDirectory`** (`types.d.ts:1287`); the client maps it to wire `configDir` (`client.js:812`). **Caco currently passes `configDir`** to create/resume (`session-manager.ts:632,807`) — i.e. the **wrong option name**, so Caco's value is likely ignored and the SDK falls back to its `~/.copilot` default. Works today by luck of the default; must fix (see R0). | types.d.ts:1287; client.js:812; session-manager.ts:632,807 |

### Answers to the four considerations

1. **Hooks = auto-fired prompts?** *Partly yes.* Two distinct mechanisms:
   - **Programmatic `SessionHooks`** — in-process JS callbacks (Caco wires only
     `onPostToolUse` today). `onUserPromptSubmitted`/`onSessionStart` can *inspect or
     amend* a turn but are Caco-authored JS, not user prompt files.
   - **File/plugin hooks** — installed by plugins/repo config; `reloadPluginHooks` and
     `loadDeferredRepoHooks` explicitly **"return queued startup prompts"** and a
     "hook command count." So yes, the SDK supports **hooks that enqueue prompts**
     (e.g. a `sessionStart` hook that fires an onboarding prompt). Caco does **not**
     surface these queued startup prompts today — that is a parity gap, though **not
     one Spec Kit needs** (Spec Kit is command-driven). Treated as optional R5.

2. **Use `~/.copilot/prompts` and drop `.caco/prompts`?** *Likely yes, pending U1.*
   The SDK has no separate prompts RPC; prompts/command files are expected to surface
   through `session.commands.list` as `SlashCommandInfo`. **This is unverified from
   types** — the probe (U1) must confirm `~/.copilot/prompts` and project command files
   actually appear. If confirmed, Caco renders the SDK command list and **retires its
   bespoke `.caco/prompts` scanner** (one source of truth, zero file parsing). If not,
   fall back to **repointing** the scanner from `.caco/prompts` → `~/.copilot/prompts`.

3. **`/agent` already works** — confirmed. `rpc.agent.list/select` + `agent-dispatch`
   is wired (`command-registry.ts:60-117`, `routes/sessions.ts:330-380`). Spec Kit's
   commands may surface as **agents** *or* as **slash commands** depending on install
   mode; rendering the SDK command list (R2) covers both because agent-backed commands
   appear in `commands.list` too.

4. **Is `/plugin` required? What does it do?** The CLI `plugin` command installs
   plugins that "extend Copilot CLI with additional skills, agents, hooks, MCP
   servers, and LSP servers" from marketplaces/GitHub. The SDK exposes the whole
   surface (`plugins.*`). **Spec Kit does not require it** (Spec Kit installs files
   directly, not a plugin). It is a **parity nice-to-have** (R6): a future
   plugins-management applet/commands. Not on the Spec-Kit critical path.

## Requirements (parity, generic)

| # | Requirement | Priority | Spec Kit needs? |
|---|---|---|---|
| R0 | **Fix the config-dir option name** (`configDir` → `configDirectory`) so Caco actually pins the SDK config root to `~/.copilot` instead of relying on the default | Must (prereq) | Yes (correct config consumption) |
| R1 | **Naming hygiene:** Caco's own slash commands must not collide with SDK/plugin/prompt commands | Must | Yes (collision avoidance) |
| R2 | **Render the SDK slash-command list** (`session.commands.list`) in the `/` menu; invoke via `session.commands.invoke`, handling all `SlashCommandInvocationResult` variants | Must | Yes (this *is* `/speckit.*`) |
| R3 | **Retire `.caco/prompts`** bespoke scanner; prompts come from the SDK command list (per U1) | Should | Indirectly (removes a parallel surface) |
| R4 | **Agent commands**: keep `/agent`; ensure agent-backed commands also appear via R2 | Done/verify | Yes |
| R5 | **Hook-queued startup prompts**: surface prompt strings returned by `loadDeferredRepoHooks`/session start | Could | No |
| R6 | **Plugin management** surface (`plugins.*`) | Could | No |

## Design

### R0 — Fix the SDK config-dir option (prerequisite, tiny)
Rename the create/resume config key `configDir` → `configDirectory`
(`session-manager.ts:632,807`). The SDK's public option is `configDirectory`
(`types.d.ts:1287`); it maps that to the wire field `configDir` internally
(`client.js:812`). Passing `configDir` directly means the value is dropped and the SDK
uses its default. Functionally `~/.copilot` is the default so behavior is unchanged
today — but parity work that *depends* on the config root being honored must not rest
on luck. Verify in the probe that, post-fix, agents/commands/prompts under the chosen
config dir are surfaced.

### R1 — `caco.` prefix for first-class Caco commands (collision hygiene)
Caco's built-in commands (`session-new`, `agent`, `restart`, `session-*`, …;
`command-registry.ts:19-33`) live in the **same `/` namespace** the SDK commands will
populate (R2). Spec Kit installs `/speckit.*`; other plugins install arbitrary names.
To guarantee no collision and a clear ownership signal, **prefix all Caco-owned
commands with `caco.`** (e.g. `/caco.new`, `/caco.agent`, `/caco.restart`,
`/caco.rename`). Rules:
- Built-in registry renamed; the `/` menu shows `caco.*` grouped separately from SDK
  commands.
- **Back-compat:** keep the old bare names as **fallback-only** aliases for one release
  (a `Command.aliases` field; the picker shows only `caco.*`). Resolution precedence:
  an **SDK command's exact name always wins** over a Caco alias, so a plugin/prompt
  named `restart`/`agent` is never shadowed by a legacy Caco alias — aliases resolve
  only when no SDK/extension command claims that name. Emit a one-time deprecation
  toast on alias use.
- Extension-registered commands (`extension-api.ts`) are author-owned; **not**
  force-prefixed, but documented to avoid the `caco.` and known plugin prefixes.
- `caco.` chosen over `/caco ` subcommands to mirror Spec Kit's `speckit.` dotted
  convention and keep one token per action.

### R2 — Render & invoke SDK slash commands (the core)
- **Server:** add `listCommands(sessionId)` → `session.commands.list` and
  `invokeCommand(sessionId, name, input)` → `session.commands.invoke` to
  `session-manager.ts` (beside `listAgents/selectAgent`), plus routes
  `GET /api/sessions/:id/commands` and `POST /api/sessions/:id/commands/invoke`.
- **Client:** a new command source `'sdk'` in `command-registry.ts`. On session
  activate (R2 lands on the R2-lifecycle `onSessionActivate` hook from the
  session-lifecycle work), fetch the SDK command list and register each
  `SlashCommandInfo` as a `/` entry (name, description, `input.hint`/`required`,
  `allowDuringAgentExecution`). Subscribe to the SDK **`commands.changed`** event to
  re-register live (so a mid-session `specify`/plugin install appears without reload).
- **Invocation result handling** (`SlashCommandInvocationResult` — handle **all four**):
  - `agent-prompt` → submit `prompt` to the agent as a normal turn; render
    `displayPrompt` as the user-visible message. **This is how `/speckit.specify <x>`
    runs.** The result `prompt` is explicitly "prompt to submit to the agent" — the SDK
    does **not** auto-submit, so Caco owns the single send (no double-turn). Map the
    result's `mode?: SessionMode` to the send call's **`agentMode`** (the SDK's send
    option is `agentMode`, not a delivery `mode` — do not pass it through verbatim). If
    `runtimeSettingsChanged`, refresh cached settings.
  - `text` → render `text` in the transcript (honor `markdown` and `preserveAnsi`
    flags), no agent turn. If `runtimeSettingsChanged`, refresh settings.
  - `select-subcommand` → present the subcommands (picker), then invoke the chosen.
  - `completed` → ack; render its optional `message` and honor `runtimeSettingsChanged`.
- **Input:** pass the user's free text as the command input; honor
  `input.required`/`hint` in the picker. `$ARGUMENTS` substitution is the SDK's job
  inside `invoke` — Caco does **not** parse command bodies (this resolves
  `speckit.md` U2: substitution lives behind `commands.invoke`, not in Caco).
- **Filtering:** hide commands that duplicate a `caco.*` action only if names would
  confuse; otherwise show all SDK commands grouped under an "SDK / project" section.

### R3 — Retire the `.caco/prompts` scanner
Once R2 renders SDK-surfaced prompts/commands, the bespoke `scanPromptDir`
(`api.ts:587-614`) + `/api/prompts` + the client `loadPromptTemplates`
(`main.ts:58-93`) are redundant **iff** the SDK surfaces `~/.copilot/prompts` in
`commands.list`. **Verify first** (U1 below). If confirmed: delete the scanner,
`/api/prompts*`, and the `template` command source; migrate any user's existing
`.caco/prompts/*.md` by documenting the move to `~/.copilot/prompts/`. If the SDK does
**not** surface `~/.copilot/prompts`, keep the scanner but **repoint it** from
`.caco/prompts` → `~/.copilot/prompts` + project prompt dirs (smaller change, still
removes the non-standard `.caco/prompts`).

### R4 — Agents (verify only)
`/agent` stays. Confirm via U3 that agent-backed commands also appear in
`commands.list` (kind `skill`/`client`); if so, users get both `/agent <name>` and the
native `/<name>` for the same agent — acceptable. No code beyond R2.

### R5 — Hook-queued startup prompts (optional, deferred)
On session start/resume, `loadDeferredRepoHooks` returns "queued repo-level startup
prompts." Surfacing these (render or auto-submit) would complete hook parity. Deferred:
not needed for Spec Kit, and auto-submitting prompts has UX/safety implications
(consent, loops) that deserve their own spec.

### R6 — Plugin management (optional, deferred)
A `plugins.*`-backed management surface (list/install/enable/disable, marketplace
browse) — likely a future applet. Out of scope here; documented so the SDK capability
isn't forgotten.

## Empirical unknowns (resolve before/with implementation)

- **U1 (gates R3):** Does `session.commands.list` include entries sourced from
  `~/.copilot/prompts/*.prompt.md`? (Decides full retire vs. repoint of the scanner.)
- **U2 (gates R2 result handling):** For a Spec Kit `speckit.specify` command, does
  `session.commands.invoke` return `agent-prompt` with `$ARGUMENTS` already
  substituted into `prompt`? (Expected yes — substitution is runtime-side.)
- **U3 (gates R4):** Do project `.github/agents/*.agent.md` appear in `commands.list`
  and/or `agent.list` when `workingDirectory` is the project? (Confirms project-local
  discovery; `speckit.md` U1.)

A short probe resolves all three: in a Caco dev session against a `specify
init`-scaffolded project, call `session.commands.list` (try both defaults and explicit
`{ includeBuiltins:true, includeSkills:true, includeClientCommands:true }`) +
`agent.list`, log every entry, and capture one `invoke` result (its `kind`, `mode`,
`markdown`/`completed` fields). Also: (a) confirm the R0 `configDirectory` fix is
honored, and (b) confirm the SDK **`commands.changed`** event reaches Caco's event
plumbing. Do this **first**; it sizes R0–R4 exactly.

## Plan (slices)

1. **Probe (U1–U3 + R0/`commands.changed`):** add a temporary dev route/log that dumps
   `commands.list` (default + explicit include flags), `agent.list`, an `invoke`
   result, confirms `configDirectory` is honored, and confirms `commands.changed`
   reaches Caco's event plumbing, for a scaffolded project. Record findings.
2. **R2 Slice A — server:** `listCommands`/`invokeCommand` + routes + `commands.changed`
   subscription plumbing.
3. **R2 Slice B — client:** `'sdk'` command source, picker grouping, the three
   invocation-result branches, live `commands.changed` refresh.
4. **R1:** rename Caco commands to `caco.*` with hidden back-compat aliases + picker
   grouping. (Independent; can land before or after R2.)
5. **R3:** per U1 — retire or repoint the prompt scanner.
6. **R4 verify;** R5/R6 deferred.

## Risks & mitigations
| Risk | Mitigation |
|---|---|
| Renaming Caco commands breaks muscle memory/docs/extensions | One-release hidden aliases + deprecation toast; update README/API/EXTENSIONS |
| SDK `commands.list` is `@experimental` (may shift) | Isolate behind the server methods; one place to adapt; pin SDK version |
| `agent-prompt` invocation double-submits or races the form | Route through the existing send path (single turn owner); reuse R2-lifecycle guards |
| `commands.changed` storms re-register churn | Debounce; diff against current `sdk` command set |
| Dropping `.caco/prompts` strands a user's files | Only after U1 confirms SDK coverage; document migration to `~/.copilot/prompts` |
| Collisions between SDK command and a `caco.*` (none expected) | `caco.` prefix is reserved; SDK commands rendered in a separate group |

## Acceptance
A `specify init --integration copilot` project opened in a Caco session shows
`/speckit.*` in the `/` menu (from `session.commands.list`), and invoking
`/speckit.specify <text>` runs the agent turn (via `agent-prompt`) and writes the spec
files — **with no Spec-Kit-specific code in Caco**. Caco's own commands are
`caco.*`-prefixed and never collide. `.caco/prompts` is gone (retired or repointed to
`~/.copilot/prompts`). Plugin/hook parity (R5/R6) is documented and deferred.
