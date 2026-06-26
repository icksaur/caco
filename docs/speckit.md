# Spec Kit support in Caco

Status: requirements + gap analysis. Goal: determine what GitHub **Spec Kit**
(github/spec-kit) needs from a harness, confirm the Copilot SDK provides it, assess
what Caco offers for *interactive* Spec Kit use, enumerate gaps, give a runnable test
plan, and document how a user would drive the workflow inside a Caco session.

## TL;DR verdict

Spec Kit is **slash-command-driven**, not hook-driven. Its Copilot integration
installs **agent files** (`.github/agents/speckit.*.agent.md`) + companion prompt
files into the *project*, and you run a fixed workflow:
`/speckit.constitution → /speckit.specify → /speckit.clarify → /speckit.plan →
/speckit.tasks → /speckit.analyze → /speckit.implement`.

Caco is **closer than expected**: it already has a working `/agent` picker that lists
SDK-discovered agents and dispatches them (`selectAgent` + `dispatchMessage`), runs
the agent in the project cwd with full file + shell tools, and supports MCP. The
likely-functional path today is **`/agent speckit.specify <text>`** — *if* the SDK
discovers project-local `.github/agents`. Two things are unverified and gate
everything (see "Empirical unknowns"). The ergonomic gap is that Caco does not surface
discovered agents as first-class `/speckit.*` commands, and its prompt-template
scanner reads `.caco/prompts/`, not Spec Kit's `.github/prompts/`.

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
| G1 | **No first-class `/speckit.*` commands.** Discovered agents are reachable only via `/agent <name> …`, not as native `/speckit.specify`. | Ergonomic; workflow still runnable | Auto-register each user-invocable SDK agent as a slash command (`source:'agent'`) that dispatches `agent-dispatch`. Mirrors `loadPromptTemplates`. |
| G2 | **Prompt scanner ignores `.github/prompts/`.** Spec Kit's `.prompt.md` companions aren't surfaced. | Low (CLI uses agents, not prompts) | Add `.github/prompts/` to `scanPromptDir` roots; strip `.prompt.md`. |
| G3 | **Agent-discovery scope unverified.** If the SDK reads only `~/.copilot/agents`, project `.github/agents` won't appear. | **Blocking if true** | If unsupported, copy/symlink project `.github/agents` → discoverable dir, or pass an agents path to the SDK. Resolve via test T3. |
| G4 | **`$ARGUMENTS` substitution unverified.** | **Blocking if the SDK doesn't substitute** | If not substituted, Caco's `agent-dispatch` must replace `$ARGUMENTS` in the agent body before dispatch, or append the user text in the SDK's expected manner. Resolve via test T5. |
| G5 | **Shell built-ins excluded.** Spec Kit's `.agent.md` bodies may call `bash`/`run_in_terminal` directly. | Medium — scripts may no-op | The agent can still run scripts via `caco_run_workflow`; if Spec Kit bodies hard-call `bash`, either re-include `bash` for these sessions (`CACO_EXCLUDED_BUILTINS`) or confirm the agent adapts. Resolve via test T6. |
| G6 | **No skills-mode discovery for `.github/skills/`.** | Low (default mode is agents) | Out of scope unless skills mode chosen. |
| G7 | **No hooks needed**, but if a preset relies on pre/post hooks, only `onPostToolUse` exists. | Negligible for core SDD | None for v1. |

Likely **slash-command work** (G1, optionally G2) is the main ergonomic deliverable;
**G3/G4/G5 are empirical** and decided by the test plan before any code.

## Test plan — make a Spec Kit project and verify it in Caco

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

## Empirical unknowns (resolve before coding)

- **U1 (T3):** Does `@github/copilot-sdk@1.0.1` `rpc.agent.list()` include
  project-local `.github/agents/*.agent.md` when `workingDirectory` is the project?
  (If only `~/.copilot/agents` is read → G3 fix required.)
- **U2 (T5):** Does `select`+`dispatchMessage` substitute `$ARGUMENTS` in the agent
  body, or is the body system-context with the user text appended? (Decides G4.)
- **U3 (T6):** Do Spec Kit agent bodies hard-depend on the excluded `bash` built-in, or
  do they adapt to available shell tooling? (Decides G5.)

## Next steps
1. Run T0–T8; fill in U1–U3.
2. If U1/U2 pass: implement **G1** (auto-register discovered agents as `/speckit.*`
   slash commands) as the primary deliverable; optionally **G2**.
3. If U1 fails: implement **G3** (make project `.github/agents` discoverable to the
   SDK). If U2 fails: implement **G4** (`$ARGUMENTS` substitution in `agent-dispatch`).
4. Spec the chosen items separately; this document is the requirements baseline.
