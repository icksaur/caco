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
| R4 | **Agent invocation by name or slug**: `/agent` accepts the frontmatter `name` **and** the slug `id`; picker presents the slug; unknown names fail gracefully via the SDK. Fix the current `name`-keyed bugs. | Must | Yes |
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

### R4 — Agent invocation by name or slug (the `/agent` surface)
`/agent` stays as the agent surface (the CLI has no per-agent slash command — see the
reverted G1 below). This requirement fixes how `/agent` resolves an agent identifier.

**SDK behavior (probe-confirmed, `@github/copilot-sdk@1.0.1`):** an agent file exposes
three identifiers — frontmatter `name` (may contain spaces, e.g. `"smoke user test"`),
SDK-derived slug `id` (always whitespace-free, e.g. `smoke-user`), and `displayName`.
`rpc.agent.select({ name })` resolves **all three** to the same agent. An unknown value
**throws** `Custom agent '<x>' not found` — so the SDK already "presents a failure if it
doesn't exist." This matches the user's CLI finding: both `/agent <name-from-file>` and
`/agent <slug-name>` succeed; only the slug is presented in the `/agent` picker.

**Current Caco bugs (must fix):**
- `isUsableAgent` (`agent-command.ts:24`) filters out any agent whose **`name`** has
  whitespace → an agent like `name: "smoke user test"` (slug `smoke-user`) is **dropped
  from the picker entirely**, despite being valid and SDK-selectable.
- Everything is keyed on `name` (picker `value`/`id`, dispatch token, validation lookup,
  `parseAgentDispatchInput`), and `agent-dispatch` **rejects whitespace agent names**
  (`sessions.ts:343`, `validateAgentForUserDispatch:47`). The whitespace-free slug `id`
  is the correct key and is never used.

**Required behavior:**
- **Filter on `userInvocable` + a usable slug**, not on `name` whitespace. Define a
  usable slug as `typeof id === 'string' && id.length > 0 && id.trim() === id &&
  !/\s/.test(id)`, plus `userInvocable !== false`. The slug is whitespace-free by
  construction, so usable agents are never dropped.
- **Picker presents the slug.** Insert `id` as the command value (parser-safe, matches
  the CLI); show `displayName`/`name` in the label/description for recognizability.
- **Server is the single home for resolution.** The combined `/agent <token> <prompt>`
  command means the client must NOT pre-split into `{agentName, prompt}` — a multi-word
  frontmatter name (`smoke user test hello`) would lose everything after the first token
  before the server could resolve it. The client sends the **raw** args
  (`{ input: arg.trim() }`); the server fetches the live `agent.list()` and resolves.
- **Deterministic resolution algorithm** (server, exact + case-sensitive, no
  normalization), against the usable-agent list:
  1. Let `firstToken` = input up to the first whitespace. If some agent's **slug `id`**
     equals `firstToken` exactly → that agent; prompt = the remainder. (Slug always wins
     first, so `id=foo` + `name="foo bar"` resolves `/agent foo bar do x` to slug `foo`
     with prompt `bar do x`.)
  2. Else greedily match the **longest** identifier among each agent's `id`, `name`,
     `displayName` such that `input === identifier` **or** `input.startsWith(identifier +
     ' ')` (the match must end on a whitespace/end-of-string boundary, so `name="agent"`
     does NOT match input `agentic …`). Longest identifier wins; prompt = remainder.
  3. Else no match → forward `firstToken` to the SDK; `agent.select` throws
     `not found`, surfaced as a toast (existing `dispatchAgent` failure path).
- **Prompt is required (no select-only).** Caco's `/agent` is combined select+dispatch;
  it does **not** support CLI-style select-only `/agent <name>`. If resolution consumes
  the entire input (no remainder), return `prompt is required`. Stateful select-only is
  a separate future feature (selected-agent UX + route changes), explicitly out of scope.
- **Server selects a resolved KNOWN identifier**, preferring the agent's `id`, and
  enforces `userInvocable !== false`. Free-form whitespace names are never forwarded
  raw — only a value matched against `agent.list()` reaches `agent.select` (this is why
  dropping the client whitespace rejection is safe: it flows to an RPC, not a shell, and
  the server only selects resolved known agents).

This keeps the "pit of success": the picker only ever inserts the slug, so the common
path is unambiguous; manual name-with-spaces entry is best-effort via the boundary-anchored
greedy match and degrades to a clear SDK `not found` toast, never a silent mis-dispatch.

**Success / failure feedback (what the user sees):**
- **Failure → red toast** + input restored for retry. Already the behavior:
  `showToast` defaults to the `error`/red variant and `dispatchAgent` restores the
  command text. The SDK's `Custom agent '<x>' not found` (and `not invocable`) messages
  surface verbatim. No transcript event on failure.
- **Success → synthetic inline activity marker** "Selected agent: `<slug>`", rendered
  exactly like the compaction notice ("Conversation compacted"), positioned immediately
  before the agent's turn (echoes the CLI's `● Selected custom agent: <name>`). An
  optional green (`type:'success'`) toast may accompany it as a near-input confirmation.
- **Mechanism:** the server `agent-dispatch` route, after a successful `selectAgent` and
  before/at `dispatchMessage`, emits `{ type: 'caco.agent_selected', data: { agentId,
  displayName } }` through the session's `onEvent`. The client renders it via the
  `dom-regions` maps: `EVENT_TO_OUTER['caco.agent_selected'] = 'assistant-activity'`,
  `EVENT_TO_INNER = 'compact-text'` (reuse compaction styling), formatter →
  `Selected agent: ${data.agentId}`. `caco.*` events already pass the event filter
  (`event-filter.ts:71`).
- **Persistence caveat (explicit):** `caco.*` synthetic events are **broadcast-only**
  (not written to the SDK `events.jsonl`), so this marker shows **live but does not
  replay on resume/reload** — unlike the compaction notices, which are real SDK events.
  The dispatched prompt (`user.message`) and the agent's reply DO persist, so the turn
  itself survives; only the "Selected agent" line is ephemeral in v1. Persisting it
  across resume is a deliberate follow-up (inject into the replayed history path) — out
  of scope unless requested.

**Divisible:** (a) server — raw-input route + resolver in `agent-command.ts` (pure,
unit-testable: slug-first, boundary greedy, prompt-required, displayName) + `visibleAgents`
slug filter + emit `caco.agent_selected` on success; (b) client — picker inserts `id`,
`/agent` handler posts `{ input }`, render `caco.agent_selected` + green toast. Ship
(a) first (it stands alone and is fully testable); (b) is a thin follow-up.

### R5 — Hook-queued startup prompts (optional, deferred)
On session start/resume, `loadDeferredRepoHooks` returns "queued repo-level startup
prompts." Surfacing these (render or auto-submit) would complete hook parity. Deferred:
not needed for Spec Kit, and auto-submitting prompts has UX/safety implications
(consent, loops) that deserve their own spec.

### R6 — Plugin management (optional, deferred)
A `plugins.*`-backed management surface (list/install/enable/disable, marketplace
browse) — likely a future applet. Out of scope here; documented so the SDK capability
isn't forgotten.

## Probe RESULTS (resolved — 2026-06-26, corrected)

Two SDK probes (`@github/copilot-sdk@1.0.1`, faithful fixtures) settled the unknowns.
**The decisive variable is `enableConfigDiscovery`** (a `SessionConfig` flag,
`types.d.ts:1299`, `@default false`).

**Probe matrix** (project with `.github/agents/probe-proj.agent.md`; fixture
`configDirectory` with `agents/probe-user.agent.md`; trust granted at create):

| Variant | `agent.list` | `commands.list` |
|---|---|---|
| `enableConfigDiscovery: true`, fixture configDir | **2** — `probe-user` (from `<configDir>/agents`) + `probe-proj` (from `<cwd>/.github/agents`), **file-backed** (`path` set) | 30 builtin |
| `enableConfigDiscovery: true`, no configDir override (real `~/.copilot`) | **1** — `probe-proj` | **35** — +5 **`skill`** commands (the real `~/.copilot/skills`) |
| `enableConfigDiscovery: false` (default) | **0** | 30 builtin |

Findings:

- **The SDK DOES auto-discover file-based agents** — from **both** `<cwd>/.github/agents`
  **and** `<configDir>/agents` (`~/.copilot/agents`) — **but only when
  `enableConfigDiscovery: true`.** It defaults to **false**; the **Copilot CLI sets it
  true** (`enableConfigDiscovery??true` in the CLI bundle); **Caco passes nothing →
  false → zero discovery.** *This single flag is the gap*, not a missing file parser.
  (My first probe ran with the flag off, which produced the earlier — wrong —
  "SDK doesn't scan" conclusion.)
- **Discovery is additive.** `enableConfigDiscovery` "merges discovered MCP configs +
  skill directories with any explicitly provided `mcpServers`/`skillDirectories`, with
  explicit values taking precedence on name collision" (`types.d.ts:1289-1299`).
  Programmatic `customAgents` likewise layer on top — so Caco's explicit MCP loading
  is preserved.
- **Skills surface as `skill`-kind `commands.list` entries** (the real `~/.copilot/skills`
  appeared once the flag was on). So skills get parity "for free" too.
- **`configDirectory` IS honored (R0 bug confirmed).** Overriding it changed which
  `agents/`+`skills/` were discovered; with no override the real `~/.copilot` was used.
  Caco's current **`configDir`** (wrong key, `session-manager.ts:632,807`) is silently
  ignored → the SDK uses its default `~/.copilot`. Works by luck today; R0 is real.
- **Custom agents surface in `agent.list`, NOT `commands.list`.** The spec-kit path is
  **agent selection** (Caco's existing `/agent` → `agent.select` + dispatch). Discovered
  agents carry a `path` (file-backed) vs. programmatic ones (in-memory).
- **`$ARGUMENTS` substitution is a non-issue.** Spec Kit bodies say "the text the user
  typed … **is** the feature description … even if `$ARGUMENTS` appears literally
  below." Dispatching the user's text as the message works regardless.
- **RPC surface confirmed:** `session.rpc.commands.{list,invoke,…}`,
  `session.rpc.agent.{list,select,reload,getCurrent,deselect}`,
  `permissions.folderTrust.{isTrusted,addTrusted}`, `plugins.*`.

### Architecture correction (this is the big simplification)
The core deliverable is **two SDK config flags**, not a file-discovery subsystem:
1. **R0:** `configDir` → `configDirectory` (so the config root is actually pinned).
2. **RA (now trivial):** pass **`enableConfigDiscovery: true`** at
   `createSession`/`resumeSession`. That alone makes the SDK scan `~/.copilot/agents`,
   `<cwd>/.github/agents`, `~/.copilot/skills`, and project MCP configs — so
   `/agent speckit.specify <text>` works through Caco's **existing** `/agent` picker,
   and skills/user-agents/MCP get parity too. **No Caco-side `.agent.md` parser.**

`customAgents`/`skillDirectories` remain available for anything Caco wants to inject
programmatically, but are not needed for Spec Kit. Rendering builtin `commands.list`
(`/plan`, `/review`, `/mcp`) and native `/speckit.*` registration stay as separate,
optional ergonomic layers.

### Consideration / risk introduced by the flag
`enableConfigDiscovery: true` also auto-loads **project** `.mcp.json` / `.vscode/mcp.json`
MCP servers and project skill dirs from the working directory. That is the desired
parity behavior, but it means opening an untrusted repo would auto-wire its MCP servers
— a **trust/security** consideration. Mitigation options (decide in RA): gate discovery
on the folder being trusted, and/or surface which project MCP servers/agents were
auto-loaded. (Caco already auto-approves tools via `approveAll`, so this widens an
existing trust posture rather than creating a new one — but it should be explicit.)

## Empirical unknowns — RESOLVED
- **U1 (prompts/agents discovery)** → **Yes, via `enableConfigDiscovery: true`** — the
  SDK scans `~/.copilot/agents` + `<cwd>/.github/agents` (+ `~/.copilot/skills` as
  commands). Off by default; Caco must enable it.
- **U2 (`$ARGUMENTS`)** → **Moot.** Dispatch the user text as the message.
- **U3 (project `.github/agents`)** → **Discovered with the flag on**; appears in
  `agent.list` with a file `path`.

## Plan (slices) — revised post-probe

1. ✅ **Probe (DONE):** the gap is **two SDK config flags**, not a file parser.
2. **R0 (do first, tiny):** fix `configDir` → `configDirectory`
   (`session-manager.ts:632,807`).
3. **RA — enable config discovery (the core deliverable, ~1 line):** pass
   **`enableConfigDiscovery: true`** to `createSession`/`resumeSession`
   (`session-manager.ts:~625,~807`). The SDK then scans `~/.copilot/agents`,
   `<cwd>/.github/agents`, `~/.copilot/skills` (→ skill commands), and project MCP
   configs. Caco's existing `/agent` picker now lists + runs spec-kit:
   `/agent speckit.specify <text>` works end-to-end. **Decide the trust gate** (see
   the consideration above): likely only enable discovery for a trusted/explicitly
   opened folder, or surface what was auto-loaded. Add a focused test asserting a
   fixture `.github/agents/*.agent.md` appears in `listAgents`.
4. ~~**G1 — ergonomic `/speckit.*` commands**~~ **(REVERTED — wrong model).** The CLI
   gives custom agents **no** per-name slash command; they are *selected* via
   `/agent <name>` (Caco's existing picker). Registering agents as `/<name>` commands
   diverged from the CLI and is reverted (`command-registry.ts`). The agent surface is
   R4 (`/agent` by name or slug). The real slash-command surface is **skills**, which
   appear in `commands.list` — covered by R2.
5. **R1 — `caco.*` prefix** with SDK-precedence fallback aliases (independent).
6. **R3 — retire/repoint `.caco/prompts`:** with discovery on, prefer
   `~/.copilot/prompts` / project prompt files surfaced by the SDK; retire the
   bespoke `.caco/prompts` scanner (verify prompts appear as commands first).
7. **R2 — render CLI builtin `commands.list`** (separate parity nice-to-have:
   `/plan`, `/review`, `/mcp`, …) with `list`/`invoke` + the four result variants.
   **Not required for Spec Kit.**
8. R4 folded into RA; R5/R6 deferred.

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
A `specify init --integration copilot` project opened in a Caco session can drive Spec
Kit's **default (agent) mode** via `/agent speckit.specify <text>` — the discovered agent
(slug `speckit.specify`) appears in the `/agent` picker and the dispatch runs the agent
turn and writes the spec files — **with no Spec-Kit-specific code in Caco**. A custom
agent is invocable by its slug `id` **or** frontmatter `name` (R4), and an unknown agent
fails with a clear `not found` toast. Spec Kit's **skills mode** surfaces `/speckit-*` as
SDK `commands.list` skill commands (R2). Custom agents do **not** get per-name slash
commands (the reverted G1). Caco's own commands are `caco.*`-prefixed and never collide.
`.caco/prompts` is gone (retired or repointed to `~/.copilot/prompts`). Plugin/hook
parity (R5/R6) is documented and deferred.
