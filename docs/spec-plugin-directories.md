# spec-plugin-directories

Document of record for **per-session plugin directories**: loading third-party
extensibility (Open Plugins) into *specific* Caco sessions via the SDK's
`pluginDirectories`, without ever writing to the shared `~/.copilot` system config.

## Goals

**Primary use case — third-party extensibility without polluting system config.** Some
development environments require third-party plugins (custom agents, MCP servers, skills,
hooks, rules) to do their work. Today the only way to supply these to a Copilot session is
to install them into the shared personal/system config (`~/.copilot`), which makes them
**global**: every session in every project pays their context cost and inherits their
behavior forever. That is the pollution this spec eliminates.

The goal is to make plugin loading **per-session and opt-in**, so a small number of
deliberately "dirty" (bloated) sessions carry the plugins a task requires while the rest of
Caco — including the orchestrating session the user talks to — stays clean and unbloated.
A normal Caco session must be able to **set up other sessions** with plugin directories
through orchestration, without loading those plugins itself.

Concretely, plugin directories must be settable at these entry points:
- a **slash command** (`/caco.plugin-directory`) for the session the user is in;
- **`create_caco_session`** — a persistent child born with plugins;
- **`caco_herd`** (`create`/`acquire`) — herd children born/adopted with plugins;
- **`caco_session_delegate`** — apply to an existing target before dispatching;
- the **`task` tool** — see "task-tool coverage" below (inherited, not parameterized).

Non-goal: **no new UI**. The feature is entirely slash-command + tool parameters + durable
per-session metadata. No panel, no picker, no settings screen.

## Design

### The SDK primitive (verified)

All SDK/runtime line numbers below are **approximate (circa the current build)** — they
will drift with SDK upgrades; the symbol names are the durable anchors.

`pluginDirectories?: string[]` is a first-class field on **`SessionConfigBase`**
(`node_modules/@github/copilot-sdk/dist/types.d.ts:~1657`, interface spans ~1321–1760).
Its documented contract:

> Local filesystem paths to Open Plugins-format directories (https://open-plugins.com/) to
> load for this session. Relative paths resolve against `workingDirectory` (or the runtime
> cwd if unset); absolute paths are recommended. Invalid entries are logged and skipped.
> Treated as an **explicit opt-in**: plugin agents and rules load **even when
> `enableConfigDiscovery` is false**. Loaded assets slot between project (cwd) sources and
> personal/home sources in the session-wide precedence order.

Two facts make this feature viable and are load-bearing for the whole design:

1. **Available on BOTH create and resume.** `SessionConfig` (`:1760`) and
   `ResumeSessionConfig` (`:1775`) both `extends SessionConfigBase`, and the SDK client
   sends the field on **both** wire calls — `session.create`
   (`copilot-sdk/dist/client.js:1020`) and `session.resume` (`client.js:1197`). So a
   session's plugin set can be established at birth *and* faithfully re-established every
   time Caco resumes it.
2. **There is NO live-mutation RPC for it.** `pluginDirectories` does not appear in the
   `options.update` surface (only `skillDirectories`-style fields recur elsewhere; the
   runtime `OptionsUpdate` has no plugin field). Therefore **changing the plugin set of a
   running session requires a session recreate**, exactly like Caco's existing
   context-budget change.

What plugins contribute (why this is "extensibility", not just prompts): the runtime
models a `"plugin"` source for **agents** (`AgentInfoSource`, `copilot-linux-x64/sdk/index.d.ts:332`),
**MCP servers** (`sourcePlugin`/`sourcePluginVersion`, `:6851-6854`), **extensions**
(`ExtensionSource`, `:7644`), and **hooks** (`addHooksFromInstalledPlugins`, `:9543`), plus
skills and instruction/rules files.

### Durable per-session state is the source of truth

Because the dirs must be re-supplied on **every** resume (cold open, LRU-evicted reopen,
server restart, model switch, warm recreate), a transient parameter is not enough. The
session's own metadata is the source of truth:

`SessionMeta.pluginDirectories?: string[]` (`src/session-meta-store.ts`), stored as
**absolute, normalized** paths. This mirrors the two existing per-session SDK-config fields
that already work this way — `contextBudgetTokens` and `reasoningEffort` — which are
persisted to meta and re-applied in `_doResume` (`src/session-manager.ts:994-1003`). Plugin
dirs follow that identical, proven path. Absent field = no plugins = today's behavior.

Absolute-and-normalized at write time (resolved against the session cwd when the caller
gives a relative path) is deliberate: the SDK resolves relative paths against
`workingDirectory`, so storing relative would silently re-target if the session's cwd later
changes via `/caco.session-cwd`. Storing absolute makes the binding stable.

### Applying to a session

- **At create** — the **`POST /api/sessions` route is the single owner of create-time
  persistence** (it already stamps `kind`/`name`/`parentSessionId`,
  `src/routes/sessions.ts:210-235`). It validates+normalizes the incoming list, passes it
  through `sessionState.ensureSession` → `CreateConfig.pluginDirectories` (`src/types.ts:57`)
  → `client.createSession({ …, pluginDirectories })` (`src/session-manager.ts:793`), **and**
  writes the same normalized list to the new session's meta in its existing
  `updateSessionMeta` block. One owner, one normalized value, no layer-race: `create()` never
  writes `pluginDirectories` to meta itself, it only forwards the config to the SDK.
  (`ensureSession`/`ensureSessionLocked` gain a pass-through parameter — `src/session-state.ts:102,158`.)
- **At resume** — `_doResume` reads `getSessionMeta(sessionId)?.pluginDirectories` and adds
  it to `resumeArgs` (`src/session-manager.ts:1034`), alongside the existing
  `reasoningEffort`/`infiniteSessions` conditionals. This is the step that makes the
  feature *reliable* rather than best-effort.
- **On change to an existing session** — `setSessionPluginDirectories(sessionId, dirs)` on
  `SessionManager`. Its contract is **active-vs-inactive aware**, which is where it differs
  from its sibling `setSessionContextBudget` (`src/session-manager.ts:1697`, which *throws*
  when the session is not active):
  - **Inactive** (not in `activeSessions` — evicted, or never opened, the common case for a
    freshly `acquire`d herd member): **persist to meta and return.** No recreate is needed
    or possible; the next resume reads meta and applies the dirs — which is exactly when the
    session next runs. This is the cheap, always-available path.
  - **Active**: persist to meta **first**, `disconnect()`, drop from `activeSessions`, then
    `resume(…, { warmRecreate: true })` so the recreate reads the new meta; **on failure
    restore the previous meta value and re-resume**, surfacing a "reverted" error — the
    exact persist-then-recreate-with-rollback shape of `setSessionContextBudget`, so no new
    lifecycle semantics are introduced. `warmRecreate: true` correctly suppresses
    cold-resume auto-defer.
  - **Busy**: refuse (existing busy guards), never yank a running session.
  - Unchanged input is a **no-op** in both modes (no meta write, no recreate).

**A plugin change on an *active* session costs a session recreate. This is inherent** (no
live RPC) and must be stated in the command's user-facing text, exactly as the
context-window command already warns "reconnecting…". On an inactive session it is free.

### Entry points

**1. Slash command `/caco.plugin-directory [<path…>|clear]`** (`public/ts/command-registry.ts`,
added to `BUILTIN_COMMANDS` at `:18`). Sets the **full list** for the current session
(replace semantics; space-separated paths). It PATCHes
`/api/sessions/:id { pluginDirectories }` — the same route that already handles
`contextBudgetTokens`/`reasoningEffort` (`src/routes/sessions.ts:635-700`) — which validates
and calls `setSessionPluginDirectories`. Replace-not-append is chosen because it is the only
semantics with a single obvious inverse and no hidden accumulated state.

**Bare invocation shows, it does not clear.** `/caco.plugin-directory` with **no argument**
reports the session's current list (or "none") and changes nothing. This deliberately
differs from `/caco.session-context-window`, where an empty argument means "reset to
default": that setting is a scalar with an obvious default, whereas this one is a list whose
current value is otherwise invisible, and a bare-Enter typo must not silently destroy a
working plugin configuration. Clearing is always **explicit** (`clear`/`none`/`reset`).

### Clearing contract (every setter, one table)

`[]` and the `clear` word are the same operation expressed in the two available idioms —
tools take an array, a slash command takes text. Where there is nothing yet to clear (create
time), an empty list is simply "no plugins", never an error.

| Setter | Value that clears | Bare/omitted | Notes |
|---|---|---|---|
| `/caco.plugin-directory` | `clear` \| `none` \| `reset` | **shows current list**, no change | a slash command cannot pass `[]`; the words are its idiom |
| `PATCH /api/sessions/:id` | `[]` **or** `null` | field omitted ⇒ untouched | both idioms accepted so a client may send either |
| `create_caco_session` | `[]` ≡ absent (no-op) | absent ⇒ no plugins | nothing exists yet to clear; **not** an error |
| `caco_herd create` | `[]` ≡ absent (no-op) | absent ⇒ no plugins | same as above |
| `caco_herd acquire` | `[]` **clears** the adopted session's dirs | absent ⇒ **leave the target's existing dirs untouched** | adoption must not silently wipe a session that was already configured |
| `caco_session_delegate` | `[]` **clears** the target's dirs | absent ⇒ target's existing dirs untouched | per-prompt entry |
| `caco_herd resume` / `disown` | — | — | parameter **rejected** with an error (any value, including `[]`) |

The two rules that make this memorable: **omitted always means "don't touch"**, and
**empty always means "make it empty"** — except at create time, where those coincide.

### Slash-command feedback (toasts)

The command is the only *human*-facing entry point, and its outcomes are not uniform — the
active path costs a reconnect, the inactive path is instant, and validation can partially
accept. So feedback is specified explicitly rather than left to one generic "done":

| Outcome | Toast |
|---|---|
| Bare invocation (show) | info — `Plugin directories: <abs paths>` or `Plugin directories: none` |
| Applying to an **active** session | info, before the request — `Loading plugins — reconnecting…` (mirrors the context-window command's existing warning, because this path recreates the SDK session) |
| Applying to an **inactive** session | *no* pending toast (nothing to wait for) |
| Success, recreate happened | success — `Plugin directories set (N) — session reconnected` |
| Success, no recreate | success — `Plugin directories set (N) — applies on next open` |
| Success, cleared | success — `Plugin directories cleared` |
| Unchanged input (no-op) | info — `Plugin directories unchanged` (explicitly not silent, so a repeat isn't mistaken for a failure) |
| Validation rejected | error — the specific reason and the offending path (`Not a directory: /x/y`, `Path does not exist: …`, `Too many plugin directories (max 16)`) |
| Accepted with a warning | success + warning — `Set (N); no plugin.json in: <path>` (the shallow-manifest warning is surfaced, never swallowed) |
| Busy session | error — `Cannot change plugin directories while the session is working` |
| Failed apply, reverted | error — `Plugin directory change failed; reverted to previous` |

Two properties this pins down: the user is always told **whether a reconnect occurred**
(because that is the cost), and **warnings are shown, not swallowed** — the whole point of
boundary validation is that the SDK's own "logged and skipped" is invisible here.

**2. `create_caco_session`** (`src/agent-tools.ts:65`) gains an optional
`pluginDirectories: string[]`, forwarded in its `POST /api/sessions` body. This is the
main "clean orchestrator sets up a dirty worker" path.

**3. `caco_herd`** (`src/herd-tools.ts:101`) gains an optional `pluginDirectories: string[]`:
- `create` — included in the child's `POST /api/sessions` body (`herd-tools.ts:125`), so the
  child is born with plugins;
- `acquire` — applied to the adopted session via the same PATCH/recreate path **before** any
  prompt is dispatched, so the child's first turn already has its plugins. **Omitted leaves
  the target's existing dirs untouched** (adoption never silently wipes a session that was
  already configured); `[]` explicitly clears them.
- `resume`/`disown` — **reject** the parameter with a clear error ("plugin directories are
  set via `create`/`acquire` or `/caco.plugin-directory`; `resume` only dispatches work").
  Silently ignoring a passed parameter is a footgun; an explicit error keeps `resume` a
  single-purpose verb (preserving the stall-guard's progress semantics) without pretending
  the input was honored.

**4. `caco_session_delegate`** (`src/delegate-tool.ts:107`) gains an optional
`pluginDirectories: string[]` per prompt entry. When present, the plugin set is applied to
that target (recreate) **before** the message is dispatched and before the blocking wait
begins, so the delegate answers with its plugins loaded. Because delegate blocks, applying
mid-flight is forbidden: if the target is busy the call fails fast with the existing
busy-target error rather than yanking a running session.

**5. The `task` tool — MEASURED (Slice D1 probe, real SDK/CLI).** `task` is an **SDK
built-in agent** (`copilot-linux-x64/definitions/task.agent.yaml`), not a Caco tool, so Caco
cannot add parameters to it. Coverage therefore depends on what a sub-agent inherits. This
was **measured empirically** against the real runtime with a minimal Open-Plugins fixture
(plugin agent + real stdio MCP server + skill + command), comparing a session created with
`pluginDirectories` against a control session without. Results:

| Question | Measured result |
|---|---|
| Plugin **agents** load into the session? | **Yes** — as `probeplugin:probe-agent`, `source: "plugin"` (control session: none) |
| `task` can **delegate to a plugin agent**? | **Yes** — `agent_type: "probeplugin:probe-agent"` dispatches; `subagent.started` reports that agent, and the **plugin's own prompt is honored** (its marker token came back) |
| Plugin agents advertised to the model? | **Yes** — a sub-agent independently observed the plugin agent listed in the `task` tool's agent types |
| Plugin **MCP server** connects? | **Yes** — `status: "connected"`, `source: "plugin"`, `sourcePlugin: "probeplugin"` |
| Parent session sees plugin **MCP tools**? | **Yes** — exposed as `<server>-<tool>` (`probemcp-probe_ping`) |
| **`task` sub-agent** sees plugin MCP tools? | **Yes** — the wildcard (`tools: ["*"]`) sub-agent listed `probemcp-probe_ping` |
| Plugin-agent sub-agent sees plugin MCP tools? | **Yes** — same tool visible |
| Plugin **skills/commands** load? | **Yes** — as `probeplugin:probe-skill`, `probeplugin:probe-cmd` |
| Control session (no `pluginDirectories`) | **Zero** plugin agents/MCP — isolation confirmed |

**So the requirement "plugins usable from the `task` tool" is satisfied by configuring the
session that invokes `task`** — which is exactly the "dirty session" the orchestrator sets
up. Two measured caveats that MUST be documented in the command/tool text:

- **Agents with an explicit `tools:` allowlist do not gain plugin MCP tools.** `explore`
  declares an explicit tool list, so it only ever receives allowlisted tools; only
  wildcard-tool agents (`task`, `tools: ["*"]`, and plugin agents that declare `["*"]`) see
  plugin MCP tools. Choose the sub-agent accordingly.
- **Plugin rules/instructions do NOT reach the `task` sub-agent's prompt**, because
  `task.agent.yaml` sets `promptParts.includeCustomAgentInstructions: false`. Plugin
  *agents*, *MCP tools*, and *skills* work; plugin *instruction/rule files* apply to the
  session's own turns, not to a `task` sub-agent's prompt. Work that depends on plugin
  **rules** must run either in the session itself or in a plugin-provided **agent** (whose
  own prompt is honored, as measured).

An earlier draft asserted blanket inheritance without evidence; that claim was rejected in
review and replaced by this measured table. Probe scripts are throwaway (not committed);
re-running them is described in the D1 plan row.

### Stickiness: configuration is persistent, never per-request

**A plugin directory set through *any* entry point — including `caco_session_delegate` —
sticks to the target session for all of its future turns, until explicitly cleared.** This
is deliberate and worth stating plainly because a delegate call *looks* transient:

- **Sticky by mechanism.** Every entry point routes through the same durable write
  (`SessionMeta.pluginDirectories`), and `_doResume` re-supplies it on every subsequent
  resume. So the dirs outlive the delegate reply, the session's eviction, and a server
  restart.
- **Sticky by necessity.** The SDK offers **no per-turn plugin option**: `pluginDirectories`
  exists only on `SessionConfigBase` and is sent only on `session.create` and
  `session.resume`. There is no per-message parameter. Scoping a plugin set to exactly one
  request would therefore require a recreate *before* the request **and another recreate
  after** — two full session rebuilds per delegate, racing any concurrent activity on that
  session, with no atomicity if the caller dies in between. That is strictly worse than
  persistent configuration, so this spec does not offer per-request scoping.
- **Sticky by intent.** The goal is *"usable localized to a few dirty/bloated sessions"* —
  a worker session that needs a plugin generally needs it for the whole job, not for one
  message. Persistent configuration is the desired behavior, not a workaround.

**Consequences that MUST be in the tool text** so no caller is surprised:
- `caco_session_delegate`'s `pluginDirectories` is a **configure** action, not a scoped
  one: it permanently changes the target's configuration (and, on a loaded target, costs a
  recreate). Delegating once with plugins **bloats that session for good**.
- The inverse is explicit and available everywhere: passing an **empty array `[]` clears**
  the target's plugin directories (and the slash command's word idiom, `clear`, does the
  same — see the clearing-contract table). "Set" and "unset" are the same verb with
  different arguments — the only two states. **Omitting** the parameter never changes
  anything.
- Because it is sticky, the natural pattern is **configure once, delegate many**: set the
  plugin dirs at `create_caco_session` / `caco_herd create` time (free — no recreate, the
  session is born with them) and let subsequent delegates simply send work. Passing the
  same dirs on every delegate is a **no-op** (unchanged input short-circuits before any
  meta write or recreate), so repeating them is harmless but pointless.

### Isolation from system config (the anti-pollution property)

Nothing in this feature writes to `~/.copilot`, installs a plugin, or mutates any shared
config. `pluginDirectories` is a **per-session runtime parameter** pointing at directories
the user already controls; the only persisted state is a list of paths in that one session's
`meta.json`. A session without the field behaves exactly as today. This is the whole point:
the plugin's blast radius is one session, and deleting/archiving that session removes it.

## Invariants

- **Per-session, never global** (invariant): configuring plugin directories never writes to
  `~/.copilot` or any shared config, and never affects another session. A session with no
  `pluginDirectories` in meta is byte-identical in behavior to today.
- **Durable across every resume** (invariant): a session's plugin set is stored in its own
  `meta.json` and re-supplied on every `session.resume` (cold open, evicted reopen, restart,
  warm recreate, model switch). "Set once, stays set" — never best-effort.
- **Sticky, with exactly two states** (invariant): configuration applied through **any**
  entry point (including `caco_session_delegate`) persists for all of the target's future
  turns until explicitly cleared; there is no per-request or auto-expiring scope. A session
  is either configured with a non-empty list or has no plugin directories at all, and an
  empty array is the explicit clear.
- **Absolute and normalized** (invariant): stored paths are absolute (relative input is
  resolved against the session cwd at write time), so a later `/caco.session-cwd` change
  cannot silently re-target which plugins load.
- **Change ⇒ recreate, atomically or not at all** (invariant): applying a new plugin set to
  a live session persists meta then recreates; on failure the previous meta value is
  restored and the session is brought back, so a failed apply never leaves the session's
  metadata and its live runtime disagreeing.
- **Orchestrator stays clean** (invariant): setting plugin directories on another session
  never loads those plugins into the caller. The configuring session's own context is
  unchanged.
- **No new UI** (invariant): the surface is one slash command plus tool parameters; no
  panel, picker, or settings screen is added.
- **Validated at the boundary** (invariant): a path that does not exist (or is not a
  directory) is rejected at set time with a clear error, rather than being silently skipped
  by the runtime. A directory lacking `plugin.json` is accepted with a warning, never a
  hard block.
- **Capability claims are measured, not assumed** (invariant): no documentation or tool
  text asserts what plugins are available inside a `task`/`explore` sub-agent except what
  the D1 probe measured (§Entry points 5), including its two negative caveats
  (explicit-allowlist agents get no plugin MCP tools; plugin rules do not reach the `task`
  sub-agent prompt).

## Considerations

- **Silent-skip is the trap this must avoid — partially.** The SDK "logs and skips" invalid
  entries; inside Caco that log is invisible, producing "why isn't my plugin loading?".
  Boundary validation (exists + isDirectory + a **shallow `plugin.json` presence check**,
  the Open-Plugins manifest the runtime looks for) catches the common mistakes: a typo'd
  path, a file, and a directory that is not a plugin root. It is **not** a format validator
  — a directory with a `plugin.json` that the runtime later rejects as malformed still
  skips silently at load time. The `plugin.json` check is therefore a **warning, not a hard
  reject** (a future/looser layout must not be blocked by Caco), while non-existent and
  not-a-directory **are** hard rejects. Residual risk is surfaced by echoing the accepted
  list back to the caller/toast. The honest claim: Caco catches path mistakes, not content
  mistakes.
- **List bound.** The stored list is capped at **16** entries; a longer list is rejected
  with a clear error, so a pathological config cannot produce an unbounded load on every
  resume.
- **Recreate cost is real.** Every plugin-set change drops and re-resumes the SDK session
  (history is preserved — this is the same mechanism as a context-budget change), which
  costs a cold-ish resume. Acceptable because plugin sets are configured rarely, and the
  alternative (live mutation) does not exist in the SDK.
- **Plugins are third-party code with real capability.** Plugin directories can contribute
  **hooks** (which run commands) and **MCP servers** (which run processes). This is a
  genuine trust decision by the user pointing at a directory, and it is consistent with
  Caco's existing posture (`approveAll`, `enableConfigDiscovery: true` already auto-loads a
  project's `.mcp.json`, and `caco_run_workflow` runs arbitrary TS at bash parity). The
  spec does **not** claim plugin loading is sandboxed; it claims plugins are *scoped to one
  session* instead of global. Document this in the command help text.
- **Bloat is the intent, contained.** Plugin agents/skills/MCP add context cost — that is
  why the user wants them confined. The feature composes with Caco's existing frugality
  levers (`caco_enable_tools` deferral, auto-defer, context budget), which continue to
  operate on the dirty session normally.
- **Precedence is the runtime's, not Caco's.** Plugin assets slot between project (cwd) and
  personal/home sources; Caco does not attempt to re-order or merge. On name collision the
  runtime's documented precedence wins, and Caco surfaces no custom merge semantics.
- **`enableConfigDiscovery` interaction.** Caco already passes `enableConfigDiscovery: true`
  (`session-manager.ts:813`). `pluginDirectories` is an *independent* explicit opt-in, so the
  two compose without change; no discovery toggling is needed for plugins to load.
- **List bound.** See the cap above (16); rejected beyond the cap with a clear error.
- **Multi-target delegate is non-atomic.** `caco_session_delegate` accepts 1–2 targets;
  applying plugin dirs is **per-target and may partially succeed** (target A configured,
  target B rejected). There is no cross-target rollback: each target's own meta write is
  atomic, failures are reported per-target in the delegate result, and the caller decides.
  Documented rather than engineered around, because the two targets are independent
  sessions with no shared invariant.
- **Herd `resume`/`disown` reject the parameter** (explicit error) so "resume = dispatch
  work" stays a single-purpose verb and no caller is misled into thinking a plugin change
  was applied.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Plugin set silently lost on resume (feature looks flaky) | Meta is the source of truth and is read in `_doResume`; oracle asserts `pluginDirectories` present in `resumeArgs` after evict→reopen and after restart |
| Invalid path silently skipped by the runtime | Validate exists + isDirectory at the set boundary; reject with a clear error; report the accepted list back |
| Failed recreate leaves meta and runtime disagreeing | Persist-then-recreate with meta rollback + re-resume on failure (identical to `setSessionContextBudget`), surfaced as a "reverted" error |
| Relative path re-targets after a cwd change | Resolve to absolute at write time; store absolute only |
| Third-party plugin code (hooks/MCP) runs with session privilege | Explicit user action naming a directory; scoped to one session (not global); consistent with existing `approveAll`/project-`.mcp.json` posture; stated plainly in command help — no sandbox claim |
| Plugin bloat leaks into the clean orchestrator | Configuration is applied to the *target* session only; the caller never loads the dirs; invariant + oracle |
| Recreate on a busy session interrupts work | Route/tool refuse when the target is busy (existing busy guards), same as other recreate paths |
| Unbounded list degrades every resume | Cap list length; reject over-cap with a clear error |

## Acceptance

- Observable: from a clean orchestrating session, `create_caco_session` /
  `caco_herd create` produce a child whose SDK session was created **with**
  `pluginDirectories`; the child's plugin-provided agents/skills/MCP are available to it
  (including from its `task` sub-agents) while the orchestrator's own session is unchanged.
  `/caco.plugin-directory <path>` on the current session applies (with a
  "reconnecting…" toast) and survives eviction, restart, and a model switch.
  `/caco.plugin-directory clear` removes it. `~/.copilot` is never modified.
- Gates: typecheck ×2, lint:strict, knip, full tests (`npm test`, coverage thresholds),
  build:client, check:specs.
- Oracles:
  - **create** — `sessionManager.create` with `pluginDirectories` passes them to
    `client.createSession`; the created session's meta stores the **absolute** list.
  - **resume durability** — a session with `meta.pluginDirectories` passes them in
    `client.resumeSession` args on cold resume, on evicted-reopen, on warm recreate, and
    **after a server restart** (meta is re-read from disk; restart is asserted explicitly,
    not assumed equal to cold); a session without the field passes **no**
    `pluginDirectories` key (today's behavior).
  - **live change (active)** — `setSessionPluginDirectories` on an **active** session
    persists meta, disconnects, and re-resumes with the new list; a failing resume
    **restores the previous meta value**, re-resumes, and throws a "reverted" error;
    unchanged input is a no-op (no recreate).
  - **inactive change** — on a session **not** in `activeSessions`, the same call
    **persists meta and performs NO recreate** (and does not throw); the next resume then
    supplies the dirs. A **busy** session is refused.
  - **validation** — non-existent path, a file (not a directory), and an over-cap list
    (>16) are each **rejected** with a clear error and **no** meta write and **no**
    recreate; a directory **without `plugin.json`** is **accepted with a warning** (not
    rejected) and appears in the echoed accepted list.
  - **normalization** — a relative path is stored resolved against the session cwd;
    a subsequent `/caco.session-cwd` change does not alter the stored dirs.
  - **route** — `PATCH /api/sessions/:id { pluginDirectories }` applies/clears; refuses a
    busy session; `null`/`[]` clears the field; an **omitted** field leaves it untouched.
  - **clearing contract** — for each setter: `[]` clears on `acquire`/`delegate`/PATCH;
    `[]` at **create** time is a no-op (no plugins, **not** an error); omitted never
    changes an existing value; `clear`/`none`/`reset` on the slash command clears; a
    **bare** `/caco.plugin-directory` **shows** the current list and performs no write.
  - **command feedback** — each outcome emits its specified toast: show, pending
    (**only** when the session is active), success-with-reconnect vs
    success-applies-on-next-open, cleared, unchanged/no-op, validation error naming the
    offending path, `plugin.json` warning surfaced alongside success, busy, and
    reverted-failure.
  - **orchestration** — `create_caco_session` and `caco_herd create` forward the parameter
    into the child's create body; `caco_herd acquire` applies it before dispatch (via the
    inactive persist-only path when the target is not loaded);
    `caco_session_delegate` applies it before the blocking wait, fails fast on a busy
    target, and reports **per-target** success/failure (non-atomic across targets);
    **the caller's own meta is never modified** in every case.
  - **herd resume/disown reject it** — passing `pluginDirectories` to `caco_herd resume` or
    `disown` returns a clear error and performs **no** recreate and **no** meta write
    (explicitly not a silent ignore).
  - **task-tool surface (D1 probe — MEASURED, see §Entry points 5)** — with a plugin
    configured: `task` delegates to `<plugin>:<agent>` and the plugin agent's prompt is
    honored; plugin MCP tools (`<server>-<tool>`) are visible to the parent, to the wildcard
    `task` sub-agent, and to plugin-agent sub-agents; plugin skills/commands load namespaced;
    a control session without `pluginDirectories` sees none of it. Documented caveats:
    explicit-allowlist agents (e.g. `explore`) do **not** receive plugin MCP tools, and
    plugin **rules** do not enter the `task` sub-agent prompt
    (`includeCustomAgentInstructions: false`). Re-runnable via the D1 fixture recipe.
  - **stickiness** — after a `caco_session_delegate` call carrying `pluginDirectories`, the
    target's **subsequent, unrelated** turns still receive those dirs (assert they appear in
    the next `resumeSession` args and in meta after the delegate reply); passing the **same**
    dirs again is a no-op (no meta write, no recreate); passing **`[]` clears** them and the
    next resume supplies **no** `pluginDirectories` key.
  - **isolation** — configuring a target never writes `~/.copilot` and never touches any
    other session's meta.

## Plan

Delivered in four slices: **D** = an empirical probe that settles the `task`-tool surface
(**DONE — results recorded in "Entry points" §5**); **A** = the durable core (persist +
create + resume), which is what makes everything else reliable; **B** = the user-facing
command; **C** = orchestration parameters.

**Slice D — measure the sub-agent surface (DONE; de-risk, no product code)**

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| D1 | **DONE.** Probe (throwaway scripts against the real SDK/CLI): built a minimal Open-Plugins fixture (`plugin.json` + `agents/*.agent.md` + real stdio MCP server + `skills/<n>/SKILL.md` + `commands/*.md`), created a session with `pluginDirectories` vs a control without, then introspected (`rpc.agent.list`, `rpc.mcp.list`, `rpc.commands.list`) and ran live `task` delegations forcing `agent_type` to both the plugin agent and the wildcard `task` agent. Measured table recorded in §Entry points 5, including the two caveats (explicit-allowlist agents get no plugin MCP tools; plugin *rules* do not reach the `task` sub-agent prompt) | (measurement only) → `docs/spec-plugin-directories.md` | task-tool-surface oracle: **satisfied** — plugin agents delegatable via `task`, plugin MCP tools visible to parent and wildcard sub-agents, control session clean | task-claim-is-measured |

**Slice A — durable core**

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| A1 | Add `pluginDirectories?: string[]` to `SessionMeta`; add a pure `normalizePluginDirectories(cwd, input)` (resolve→absolute, dedupe, cap 16, hard-reject missing/not-a-directory, warn on missing `plugin.json`) returning typed errors + warnings | `src/session-meta-store.ts`, `src/plugin-directories.ts` (new) | normalization + validation oracles | absolute-and-normalized, validated-at-boundary |
| A2 | Thread `CreateConfig.pluginDirectories` → `client.createSession`; **`POST /api/sessions` owns** validation + create-time meta persistence, passing through `ensureSession`/`ensureSessionLocked` | `src/types.ts`, `src/session-manager.ts`, `src/session-state.ts`, `src/routes/sessions.ts` | create oracle (SDK arg + meta both carry the normalized list; `create()` itself writes no meta) | per-session, single-owner |
| A3 | Read `meta.pluginDirectories` in `_doResume` → `resumeArgs` (absent ⇒ key omitted) | `src/session-manager.ts` | resume-durability oracle (cold/evicted/warm/**restart**) | durable-across-resume |
| A4 | `setSessionPluginDirectories`: **inactive ⇒ persist-only**; **active ⇒** persist → disconnect → warm recreate → rollback+re-resume on failure; busy ⇒ refuse; unchanged ⇒ no-op | `src/session-manager.ts` | live-change (active) + inactive-change + busy-refuse oracles incl. revert | change⇒recreate-atomically |

**Slice B — user-facing command**

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| B1 | `PATCH /api/sessions/:id { pluginDirectories }` (validate, busy-refuse, `null`/`[]` clears); include current list in the session-state read | `src/routes/sessions.ts` | route oracle | validated-at-boundary |
| B2 | `/caco.plugin-directory` built-in: register in `BUILTIN_COMMANDS` + handler — replace semantics, **bare = show current**, `clear`/`none`/`reset` = clear, the full toast matrix (pending only when active; reconnect vs next-open; no-op; per-path validation errors; `plugin.json` warning; busy; reverted), trust note in the description; add the canonical name to README's command table (the `command-registry` test asserts it) | `public/ts/command-registry.ts`, `README.md` | command unit test incl. bare-show + toast matrix; command-registry doc test stays green | no-new-UI |

**Slice C — orchestration parameters**

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| C1 | `create_caco_session` optional `pluginDirectories`, forwarded in the create body | `src/agent-tools.ts` | orchestration oracle | orchestrator-stays-clean |
| C2 | `caco_herd` optional `pluginDirectories`: `create` → child create body; `acquire` → apply before dispatch (persist-only when the target is inactive); `resume`/`disown` → **explicit error** | `src/herd-tools.ts` | orchestration + herd-resume-rejects oracles | orchestrator-stays-clean |
| C3 | `caco_session_delegate` per-prompt optional `pluginDirectories`: apply before dispatch, fail fast on a busy target, report per-target (non-atomic) | `src/delegate-tool.ts` | delegate oracle incl. partial-success reporting | orchestrator-stays-clean |

## Rationale

The SDK already provides the exact primitive and — critically — provides it on **both**
`session.create` and `session.resume`, so the only thing Caco must add is **durability plus
reach**: remember the choice per session, re-apply it on every resume, and let the three
orchestration tools set it on *other* sessions. Storing the list in the session's own
`meta.json` and re-reading it in `_doResume` is the same mechanism that already makes
`contextBudgetTokens` and `reasoningEffort` reliable, so this introduces no new lifecycle
concept; likewise `setSessionPluginDirectories` is a direct sibling of
`setSessionContextBudget`, inheriting its persist-then-recreate-with-rollback correctness.

The design deliberately refuses a UI. Plugin configuration is a rare, deliberate act that a
clean orchestrating session performs on the sessions that need it — which is exactly the
shape of Caco's existing herd/delegate/agent tooling. The result is the property the user
asked for: third-party extensibility is available where it is needed and **absent
everywhere else**, with the shared `~/.copilot` config never touched, so a plugin's cost and
blast radius end at the session that opted in.
