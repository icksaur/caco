# Spec Kit support in Caco

Status: requirements + gap analysis. **Model corrected (empirical, 2025):** in the
Copilot CLI, custom **agents** are *selected* (`/agent <name>`), not given per-name
slash commands; **skills** are the surface that becomes `/skill-name <prompt>`; **prompt
files** are not a CLI feature. See "Invocation model (confirmed)" below.

Goal: determine what GitHub **Spec Kit**
(github/spec-kit) needs from a harness, confirm the Copilot SDK provides it, assess
what Caco offers for *interactive* Spec Kit use, enumerate gaps, give a runnable test
plan, and document how a user would drive the workflow inside a Caco session.

## Goals

Determine what GitHub Spec Kit needs from a harness, confirm the Copilot SDK provides it, assess what Caco offers for interactive Spec Kit use, enumerate gaps, give a runnable test plan, and document how a user would drive the workflow inside a Caco session.

## Invocation model (confirmed — empirical probe + official docs)

| Type | File location | SDK surface | Slash command? | How invoked |
|---|---|---|---|---|
| **Custom agent** | `.github/agents/*.agent.md`, `~/.copilot/agents/*.agent.md` | `agent.list` | **No** | `/agent <name>` *selects* it (loads persona; no per-name command) |
| **Skill** | `.github/skills/<name>/SKILL.md`, `~/.copilot/skills/<name>/SKILL.md` | `commands.list` (`kind:skill`) | **Yes** | `/skill-name <prompt>` (auto-chosen or manual) |
| **Prompt file** | `.github/prompts/*.prompt.md` | — (not surfaced) | **No** | IDE-only (VS Code picker); ✗ in Copilot CLI |

Verified by probe against `@github/copilot-sdk@1.0.1` with `enableConfigDiscovery:true`:
user + project skills appear in `commands.list` as `kind:skill`; prompt files appear
nowhere; agents appear only in `agent.list`. Consequence: **the native `/speckit.*`
surface only exists in Spec Kit's *skills* mode** (`--integration-options="--skills"`,
which writes `.github/skills/speckit-{name}/SKILL.md` → `/speckit-specify`). In default
(agent) mode you drive it via Caco's existing `/agent speckit.specify <text>` picker.

## Design

Spec Kit is **slash-command-driven**, not hook-driven. Its Copilot integration has two
install modes: **default (agents)** writes `.github/agents/speckit.*.agent.md`
(+ companion prompt files) — driven via the **agent picker** (`/agent speckit.specify`),
NOT native slash commands; **skills mode** (`--integration-options="--skills"`) writes
`.github/skills/speckit-{name}/SKILL.md` — these DO become native `/speckit-specify`
slash commands. The fixed workflow either way is
`constitution → specify → clarify → plan → tasks → analyze → implement`.

Caco is **closer than expected**: it already has a working `/agent` picker that lists
SDK-discovered agents and dispatches them (`selectAgent` + `dispatchMessage`), runs
the agent in the project cwd with full file + shell tools, and supports MCP. With
`enableConfigDiscovery:true` (shipped, RA) the SDK discovers both `~/.copilot/agents`
and project `<cwd>/.github/agents`, so **`/agent speckit.specify <text>` works today**
for default (agent) mode. The remaining ergonomic gap is **skills mode**: Caco does not
yet render `commands.list` skills as native `/speckit-specify` slash commands (the
corrected R2 / former G6). Note its prompt-template scanner reads `.caco/prompts/`, a
Caco-specific feature unrelated to CLI parity (CLI has no prompt-file surface).

## How Spec Kit works (the model)

- Installed by `specify init my-project --integration copilot` (the `specify` CLI is a
  `uv`/`pipx` Python tool, run once outside Caco).
- For the **copilot** integration it writes, **into the project repo**:
  - `.github/agents/speckit.{name}.agent.md` — the command bodies as **agent files**
    (markdown; contain a `$ARGUMENTS` placeholder for user input).
  - `.github/prompts/{name}.prompt.md` — companion prompt files (VS Code IDE).
  - `.github/copilot-instructions.md` — context file.
  - `.vscode/settings.json` — prompt recommendations.
  - `.specify/` — bash/PowerShell **scripts** + spec/plan/task **templates** the
    commands call (e.g. create a feature branch, scaffold `specs/NNN-*/spec.md`).
  - Skills mode (`--integration-options="--skills"`): instead writes
    `.github/skills/speckit-{name}/SKILL.md`, invoked as `speckit-{name}`.
- A command is "run the agent body with `$ARGUMENTS` = the user's text"; the body
  instructs the agent to call a `.specify/` script and fill a template. So the harness
  requirements are mostly **generic agent execution**, not Spec-Kit-specific.
- Invocation separator: `.` by default (`/speckit.specify`), `-` in skills mode
  (`speckit-specify`).
- Spec Kit can also dispatch the CLI headlessly: `copilot -p "<prompt>" --yolo
  --model <m> --output-format json` — relevant only to Spec Kit's own automation, not
  to interactive Caco use.

## Requirements Spec Kit needs from the harness

| # | Requirement | Why |
|---|---|---|
| R1 | Run the agent in the **project working directory** | Commands read/write `specs/`, `.specify/`, `.github/`, `memory/` relative to cwd |
| R2 | **File tools** (read/write/create/edit/search) | Templates → `spec.md`/`plan.md`/`tasks.md`; constitution edits |
| R3 | **Shell execution** | `.specify/scripts/*.sh` create branches, scaffold dirs, compute paths |
| R4 | Discover & invoke **named commands** carrying their own instructions + a `$ARGUMENTS` slot | The whole `/speckit.*` surface |
| R5 | Substitute user text into the command (**`$ARGUMENTS`**) | Each command takes a free-text payload |
| R6 | Persist **multi-step state across turns** (branch, spec/plan/tasks files on disk) | The workflow is sequential and resumable |
| R7 | Load **project context instructions** (`.github/copilot-instructions.md`) | Steers all commands |
| R8 | (Optional) MCP tools | Some presets/extensions add MCP-backed steps |
| R9 | (Not required) Lifecycle **hooks** | Spec Kit is command-driven; hooks are not part of the core loop |

## Does the Copilot SDK provide these?

SDK: `@github/copilot-sdk@1.0.1`. Caco config at session create
(`src/session-manager.ts:625-642`).

| Req | SDK provides | Evidence |
|---|---|---|
| R1 | ✅ `workingDirectory: cwd` per session | session-manager.ts:634 |
| R2 | ✅ built-in `view`/`edit`/`create`/`grep`/`glob` | SDK built-ins (Caco keeps these) |
| R3 | ✅ shell built-ins exist (Caco *excludes* them — see gaps) | tool-registry.ts:66-70 |
| R4 | ✅ `rpc.agent.list()` / `rpc.agent.select({name})`; agents carry `path`, `tools`, `model`, `userInvocable` | session-manager.ts:157-161, agent-command.ts:1-13 |
| R5 | ⚠️ **unverified** — whether `select`+dispatch substitutes `$ARGUMENTS` in the agent body, or treats the body as system context + user prompt | empirical |
| R6 | ✅ state is on disk (files) + SDK session persistence | events.jsonl + cwd |
| R7 | ✅ `configDir: ~/.copilot` + project context loading | session-manager.ts:632 |
| R8 | ✅ `mcpServers: loadMcpServers()` | session-manager.ts:633 |
| R9 | ✅ `hooks.onPostToolUse` wired (others available, unused) | session-manager.ts:636 |

The remaining make-or-break is **agent discovery scope** (does the SDK read the
project's `.github/agents`, or only `~/.copilot/agents`?) and **`$ARGUMENTS`
semantics** — both empirical (below).

## What Caco offers for interactive Spec Kit use today

| Capability | State | Where |
|---|---|---|
| `/agent` slash command (picker + `/agent <name> <prompt>`) | ✅ works | command-registry.ts:60-117; agent-command.ts:6-13 |
| Lists SDK agents (`/api/sessions/:id/agents` → `rpc.agent.list`) | ✅ | session-manager.ts:1062-1067 |
| Selects + dispatches an agent (`/api/sessions/:id/agent-dispatch`) | ✅ | routes/sessions.ts:330-380 |
| Runs in project cwd, full file tools | ✅ | session-manager.ts:634; SDK built-ins |
| Shell for `.specify` scripts | ✅ via `caco_run_workflow` (built-in `bash`/`powershell` **excluded**) | tool-registry.ts:66-70 |
| MCP | ✅ | mcp-config-loader.ts |
| Prompt-template → slash command | ✅ but scans `~/.caco/prompts/` + `./.caco/prompts/` only | api.ts:587-614; main.ts:58-93 |
| Agent name with `.` (e.g. `speckit.specify`) | ✅ accepted (`/agent` rejects only whitespace) | agent-command.ts:6-13 |

## Caco gaps (prioritized)

| # | Gap | Impact | Sketch of fix |
|---|---|---|---|
| ~~G1~~ | ~~No first-class `/speckit.*` from agents.~~ **WRONG MODEL — reverted.** The CLI gives agents NO per-name slash command; they are *selected* via `/agent <name>` (which Caco already has). | n/a | Revert the agent→slash-command registration; keep the `/agent` picker. |
| **R2** | **Skills not rendered as slash commands.** Spec Kit *skills mode* writes `.github/skills/speckit-{name}/SKILL.md`; these surface in `commands.list` (`kind:skill`) but Caco shows no slash command for them. **This is the real CLI-parity deliverable.** | Ergonomic (skills mode unusable in Caco) | Fetch `commands.list`, register each `kind:skill` as `/skill-name`, dispatch via `commands.invoke({name,input})`. |
| G2 | Prompt scanner ignores `.github/prompts/`. | **Moot for parity** — prompt files are not a CLI feature (proven absent from `commands.list`). | None for parity. Caco's `.caco/prompts` stays a Caco-specific feature. |
| ~~G3~~ | ~~Agent-discovery scope unverified.~~ **RESOLVED.** | n/a | `enableConfigDiscovery:true` (RA, shipped) discovers `~/.copilot/agents` + `<cwd>/.github/agents`. |
| G4 | `$ARGUMENTS` substitution unverified. | Low — agents take the dispatched user text as the prompt; `$ARGUMENTS` is a skill/prompt-template concern. | For skills (R2), pass user text as `commands.invoke` `input`. |
| G5 | **Shell built-ins excluded.** Spec Kit `.agent.md`/`SKILL.md` bodies may call `bash` directly. | Medium — scripts may no-op | Re-include `bash` for these sessions (`CACO_EXCLUDED_BUILTINS`) or confirm the agent adapts via `caco_run_workflow`. Resolve via test T6. |
| G7 | No hooks needed; only `onPostToolUse` exists. | Negligible for core SDD | None for v1. |

## Acceptance

- Observable: T0–T8 steps (see below) constitute the end-to-end acceptance suite. Key gates: `speckit.specify` agent appears in the `/agent` picker (T3); `/agent speckit.specify <text>` creates a spec file whose content reflects the passed text (T5); the workflow state persists across session switch (T7).
- Budgets: n/a.
- Gates: `npm test`, `npm run build:client`; `npm run typecheck`; T3/T5/T6 manual probes pass.
- Oracles: T3 → `listAgents` returns discovered `speckit.*` agents (by-construction via `enableConfigDiscovery`; confirmed by `tests/unit/session-manager-config-discovery.test.ts`). T5 → spec file written with user text substituted (manual). T6 → plan/tasks files written; G5 probe decides bash exclusion.

Prereqs: `uv` (or `pipx`), the `specify` CLI, and a Caco server running.

T0. **Install Spec Kit & scaffold a project** (outside Caco):
```
uv tool install specify-cli --from git+https://github.com/github/spec-kit.git@<tag>
specify init speckit-smoke --integration copilot
cd speckit-smoke && git init && git add -A && git commit -m init
```
Confirm on disk: `.github/agents/speckit.*.agent.md`, `.github/prompts/*.prompt.md`,
`.github/copilot-instructions.md`, `.specify/` scripts+templates.

T1. **Open a Caco session in that cwd.** New chat → set cwd to the project (or
`/session-cwd`). Confirm the footer cwd is the project root.

T2. **Confirm file/shell reach.** Ask: "list `.specify/` and run
`.specify/scripts/bash/*` --help if present." Verify the agent reads files and can
execute a script (via `caco_run_workflow`). → validates R1/R2/R3.

T3. **Agent discovery (G3).** Run `/agent` with no args → open the picker. **Expected:
`speckit.specify`, `speckit.plan`, … appear.** If absent, the SDK isn't reading
project `.github/agents` → G3 is blocking; record and pursue the G3 fix.

T4. **Constitution.** `/agent speckit.constitution Create principles for code quality,
testing, UX consistency, performance.` → expect `.specify/memory/constitution.md` (or
equivalent) created/updated.

T5. **Specify + `$ARGUMENTS` (G4).** `/agent speckit.specify Build a photo-album
organizer; albums by date, drag-to-reorder, tiled previews.` → expect a feature
branch + `specs/NNN-*/spec.md` whose content reflects the **passed text**. If the spec
ignores the text or contains a literal `$ARGUMENTS`, G4 is the cause.

T6. **Plan/tasks/implement.** `/agent speckit.plan Vite + vanilla HTML/CSS/JS, SQLite
metadata.` → `plan.md`. `/agent speckit.tasks` → `tasks.md`. `/agent speckit.implement`
→ code changes. Watch for any hard `bash`/terminal calls failing (G5).

T7. **Resume.** Switch away and back (or reload). Confirm the workflow state (branch,
files) persists and the next command continues. → validates R6.

T8. **Negative/ergonomics.** Try `/speckit.specify …` directly (no `/agent`). Today
this should **fail** (no such command) → confirms G1. After a G1 fix, it should work.

Record per step: did it run, what files changed, any literal `$ARGUMENTS`, any excluded
tool error. T3/T5/T6 outcomes decide whether G3/G4/G5 need code.

## How users interact (target experience)

**Today (works if T3/T5 pass):**
1. Scaffold with `specify init … --integration copilot` (one-time, outside Caco).
2. Open a Caco chat in the project cwd.
3. Drive the workflow with the agent picker:
   `/agent speckit.constitution …` → `/agent speckit.specify …` →
   `/agent speckit.clarify` → `/agent speckit.plan …` → `/agent speckit.tasks` →
   `/agent speckit.analyze` → `/agent speckit.implement`.
4. Each step writes to `specs/`, `.specify/`, and the repo; switch sessions freely —
   state lives on disk and resumes.

**After G1 (target ergonomics):** the same steps as native `/speckit.specify …`
commands (auto-registered from discovered agents), matching Spec Kit's documented UX,
with the picker showing them grouped as agent commands.

## Empirical unknowns (resolved)

- **U1 (RESOLVED):** With `enableConfigDiscovery:true`, `rpc.agent.list()` includes
  project-local `.github/agents/*.agent.md` (and `~/.copilot/agents`). Probe-confirmed.
- **U2 (RESOLVED for agents):** Agents take the dispatched user text as the prompt;
  the agent body is loaded as subordinate context, not a `$ARGUMENTS` template. For
  skills (R2), user text is passed as `commands.invoke` `input`.
- **U3 (T6, open):** Do Spec Kit bodies hard-depend on the excluded `bash` built-in, or
  adapt to available shell tooling? (Decides G5.)

## Plan
1. **Revert G1** (agent→slash-command registration in `public/ts/command-registry.ts`):
   it does not match the CLI. Keep the `/agent <name>` picker as the agent surface.
2. Implement **R2** (the real parity deliverable): render `commands.list` `kind:skill`
   entries as native `/skill-name` slash commands, dispatched via `commands.invoke`.
   This makes Spec Kit *skills mode* (`/speckit-specify …`) work natively.
3. Default (agent) mode already works via `/agent speckit.specify <text>` (RA shipped).
   Validate end-to-end with T0–T8; G5 (excluded `bash`) is the main remaining empirical.
4. Drop G2/prompt-file parity — not a CLI feature. `.caco/prompts` stays Caco-specific.
