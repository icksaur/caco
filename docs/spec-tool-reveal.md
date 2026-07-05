# spec-tool-reveal

A Caco-owned on-demand tool mechanism: keep the long tail of tools **out of every
turn's request** (saving the per-turn schema tax), expose a cheap discovery catalog,
and let the agent **re-enable** tools live when it needs them. Replicates the SDK's
blocked native "defer/tool-search" using `excludedTools` + `session.rpc.options.update`,
which are client-controllable today. Motivated by `docs/spec-budget.md` (the biggest
unpaid cost is tool schemas shipped every turn; a big MCP server dwarfs Caco's ~20 KB).

## Goals

The operator (via the mcp-servers applet) can see exactly which tools are enabled vs
disabled per session. The agent, when it needs a disabled capability, discovers it
from the deferred-tool list (`caco_enable_tools` with no args), enables a batch in one call (`caco_enable_tools`), and
uses it — never blocked, with the enable's prompt-cache cost shaped (not gated) so it
batches. Optionally, unused tools auto-defer on cold session resume, where deferral is
free (no warm cache to bust). Net: fewer tokens/turn for sparsely-used tool sets, no
capability lost.

**The savings are strongly evidenced by the SDK's own accounting, then verified by B0.**
The SDK reports `toolDefinitionsTokens` ("Tokens consumed by tool definitions sent to
the model — *excludes deferred tools*") and `mcpToolsTokens` ("subset … *excludes
deferred tools*") on `SessionContextInfo`. That documents the *native deferred-tool*
path; our mechanism realizes deferral via `excludedTools` (a denylist filter), so B0
measures that the excludedTools path yields the same token drop before we rely on it.
The remaining design question is therefore not *whether* deferral saves tokens but
*when* it can cost more (revealing on a warm cache), which this spec bounds and — using
the same telemetry — measures.

## Design

Three subsystems, shippable in order. **Phase A is a prerequisite** (we cannot manage
tool state we cannot see).

### Phase A — mcp-servers applet fidelity (three tool states)

Today the applet shows *observed vs unobserved* (in the resolved turn set or not) but
**cannot show the enablement state**. There are **three axes** (a key correction):
- **enabled** — registered in the session and not excluded (the model sees it).
- **deferred** — registered but in `excludedTools` (SDK builtins via
  `DEFAULT_EXCLUDED_BUILTINS`, MCP tools, or any tool we move to this axis). **Live-
  toggleable** via `session.rpc.options.update` — this is what the reveal feature targets.
- **hard-disabled** — `DEFAULT_DISABLED_TOOLS`, which `filterDisabledTools`
  (`server.ts:251`) removes from the tool array **before** session creation. These
  never enter the SDK session and are **NOT** live-revealable (would require moving
  them to the deferred axis). Distinct from deferred; the applet must not conflate them.

Add:
- **Caco built-in tools as a server.** The current `Built-in` entry is
  `client.rpc.tools.list()` = SDK model builtins (view/grep/bash…). Caco's own
  `defineTool` tools (`caco_run_workflow`, `caco_docs`, …) are a distinct set; add a
  `Caco` pseudo-server listing them (name + description from the tool factories).
  **Note** hard-disabled Caco tools were filtered pre-registration, so the catalog is
  built from the *registered* set for enabled/deferred, plus the *known factory* set
  to also surface hard-disabled ones (marked non-revealable).
- **State marker.** Per tool, render one of four presentation states (single badge, no
  double-labeling): **active** (enabled + observed, shows its known token cost in the
  cost tint), **unobserved** (enabled but schema not yet resolved — grey, cost unknown),
  **deferred** (dynamically excluded this session — auto/manual defer — green, saving
  per-turn tokens, re-enableable live), **disabled** (grey `(disabled)`, no cost, NOT
  re-enableable). Keep the observed/unobserved distinction orthogonal only within the
  enabled axis.

**Policy-disabled vs dynamically-deferred (a required distinction).** Two populations
end up in `excludedTools`, and the applet + the enable path MUST NOT conflate them:
- **Policy-disabled** = permanent, application-layer, contributes no cost, NOT
  re-enableable: `DEFAULT_DISABLED_TOOLS` (hard-disabled Caco tools, filtered
  pre-registration) AND `DEFAULT_EXCLUDED_BUILTINS` (the shell family Caco excludes to
  force `caco_run_workflow`, plus platform-absent builtins like powershell-on-Linux /
  bash-on-Windows, which are listed but never enabled). These render **disabled** (grey)
  and `classifyTool` returns `'disabled'`; `caco_enable_tools`/`validateEnable` reject
  them ("disabled and not re-enableable"). Because the base resume seed re-applies them
  every resume, they are permanent in effect anyway — the rejection just makes it
  explicit and avoids a pointless one-turn cache-bust.
- **Dynamically-deferred** = session-level auto-defer (C2) or manual defer (D1); WAS
  contributing cost, now saving it; **re-enableable** live. Renders **deferred** (green).
- The discriminator is a `policyDisabled` key set (= `hardDisabled` ∪
  `excludedBuiltinNames()`), threaded into `classifyTool`/`validateEnable`. Builtins are
  never dynamically deferred (C2's candidate universe excludes them), so an excluded
  builtin is always policy-disabled; an excluded MCP/Caco-allowlist tool is always
  dynamic.

### Phase B — manual reveal (probe → catalog + enable)

**B0 — telemetry harness (not a go/no-go gate).** The core assumption — excluding a
tool removes its schema tokens — is **already answered** by the SDK's own accounting
(`toolDefinitionsTokens`/`mcpToolsTokens` are documented to *exclude deferred tools*).
B0 is therefore not a hard gate but a **measurement seam**, implemented by **extending
the metering funnels that already exist — never by adding a new subscription** (see the
single-metering-funnel invariant). Concretely:
- **Extend `dispatch-events.ts`** (its existing `assistant.usage` handler) to also
  extract `cacheWriteTokens` — today it captures input/output/cacheRead/reasoning only —
  and forward it to `recordUsage` (`session-throughput.ts`). This is the cache-bust
  oracle.
- **Stop dropping `toolDefinitionsTokens`.** The `session.usage_info` event already
  carries `toolDefinitionsTokens`/`systemTokens`/`conversationTokens`, but the existing
  websocket capture (`broadcastEvent` → `session-usage-cache.ts`) keeps only
  `tokenLimit`/`currentTokens`. Extend `SessionUsage` + the extraction to retain
  `toolDefinitionsTokens` — the "deferral shrinks the tool block" proof is a field we
  already receive and discard.
- **Add one pull for the MCP breakdown.** `mcpToolsTokens` lives only on
  `SessionContextInfo`, via `session.rpc.metadata.contextInfo({ promptTokenLimit: 0,
  outputTokenLimit: 0 })` (params required; `0` = runtime default; returns `null` when
  the session is uninitialized — treat null as "unknown", never `0`). Expose it as one
  `SessionManager.getContextInfo(sessionId)`; both B0 and the applet call it. No event
  subscription.
- Confirm, with real numbers, that (a) `session.rpc.options.update({ excludedTools })`
  mutates the live tool set with no resume and (b) excluding an MCP tool by
  `namespacedName` **drops `toolDefinitionsTokens`/`mcpToolsTokens`** by that tool's
  schema size. The SDK's accounting documents that *deferred* tools are excluded from
  those fields; B0 measures that our **`excludedTools` (denylist) path** produces the same
  drop — turning the assumption from documented-for-defer into verified-for-our-mechanism.
  Non-blocking: if the numbers don't move we learn the backend differs, but the feature is
  not predicated on B0 "passing."
- The same telemetry is the **coldness oracle** (`cacheReadTokens ≈ 0`) and the
  **cache-bust validator** used by Phases B and C (see Considerations → telemetry seam).

- **Deferred-tool discovery in `caco_enable_tools`.** Calling `caco_enable_tools`
  with no `names` returns the session's DEFERRED tools (`name` + one-line
  description, grouped by Caco/builtin/server) — the discover→enable loop on one
  tool. Heavy schemas stay out of the per-turn payload. (Superseded home: this was
  `caco_docs section="tools"`; see spec-enable-tools-discovery. `caco_docs` is now
  deferrable and `section="tools"` redirects here.)
- **`caco_enable_tools({ names })`.** Removes named tools from the session exclusion set
  and applies it live via the tool-state authority's `enable()` →
  `session.rpc.options.update({ excludedTools, toolFilterPrecedence: "excluded" })`
  (result `{ success: boolean }`). Always-present. **Never blocks agent work.**
  Contract:
  - **Atomic pre-validation:** every name must exist and be **deferred** (not
    hard-disabled, not already enabled). Any invalid name → whole call rejected, **no
    `options.update`** (a syntax mistake costs no cache-bust). Hard-disabled names are
    rejected with a message that they are not revealable. This is validation, not
    rate-limiting — a *valid* enable is never rejected.
  - **State mutates only on SDK success:** the session's active `excludedTools` (and the
    applet) update **only after** `options.update` resolves `{success:true}`. On throw
    or `{success:false}`, leave the exclusion set unchanged and return an error.
  - **Never-block, amortize by shaping (not gating):** the earlier draft's "reject a 2nd
    enable in the same turn" rule is **removed** — it blocked agent work and was also
    wrong on the economics (multiple enables *within one assistant message* all mutate
    `excludedTools` before the single next model request, so they cost **one** bust, not
    N). Instead the call is cheap-by-design: (a) the description strongly steers
    "enable the whole related family in one call"; (b) reveals are **sticky + monotonic
    within a warm session** (an enable only ever *adds* to the visible set; nothing
    re-defers until the next cold boundary), so at most one bust per family per session;
    (c) it **over-reveals** the family (enabling one MCP tool reveals its server's set)
    so a follow-up reveal is rarely needed. The description still warns that each enable
    busts the prompt-cache prefix for one turn.
  - **Churn is measured, never gated.** Using the `assistant.usage` stream, count actual
    tool-block mutations and the `cacheWriteTokens` spike each caused. Repeated warm
    reveals in a session are a **signal to defer less aggressively for that session's
    profile at its next cold boundary** — self-correcting feedback, never a runtime
    block.
  - Session-sticky: enabled tools stay enabled for the session's life.

### Phase C — deferred auto-expiry (usage-driven, cache-free seams)

Sparsely-used tools should auto-defer, but only where it is **free**. There are two
cache-free seams: (1) a **cold resume** (session absent from `activeSessions` →
recreated with no warm provider cache) and (2) **create** (a brand-new session has no
prefix at all). Applying an exclusion at either costs nothing (no prefix to bust).
Never auto-defer a warm session. (Create-time auto-defer is **C3**; see Plan — it is
what makes a short-lived process that never goes cold still get lean sessions.)

- **Usage signal (active-time, not calendar).** Calendar age is unreliable (a session
  idle overnight isn't "stale"). Track a monotonic **active-seconds clock** that
  advances with real tool-use activity, not wall-clock. **Realization
  (`tool-usage-store.ts`):** the clock advances lazily on each interaction by the real
  elapsed time since the previous tick, **capped per gap** at `MAX_ACTIVE_GAP_SECONDS`
  (5 min) — so an idle stretch (lunch, overnight, process-down) counts as at most one
  cap and does not age tools. In active work (some tool fires every few seconds/
  minutes) this tracks real elapsed time; it diverges from wall-clock only during
  genuine idle, which is exactly what we exclude. This is self-contained (no session-
  lifecycle coupling) and faithful to the "advances only while active" intent. On
  process restart the tick anchor resets to now, so downtime never advances the clock.
  Each tool invocation stamps the clock for that tool (**system-wide**, keyed by
  `ToolKey`; written from the R2 `tool.execution_start` seam via `stampToolUsage`).
  **v1 mechanism (flat threshold):** persist a single per-tool `lastUsedActiveSeconds`
  stamp; on **cold resume** only, defer tools whose stamp is older than the threshold.
  One number per tool, no decay math.
- **Threshold: 2 active-hours.** A tool unused for more than 2 active-clock hours is a
  defer candidate at the next cold resume. (Active hours, not wall-clock — an overnight
  idle doesn't age a tool.)
- **Eligibility (what auto-defer may hide).** Only these are candidates; everything else
  is always kept:
  - **All MCP-server tools** — the biggest per-turn cost.
  - **All SDK builtins** already in the excludable set (the existing shell family and any
    future ones).
  - **A fixed allowlist of Caco tools: `caco_docs`, the browser tools, the
    applet-state tools, and the surface tools.** No other Caco tool is
    auto-deferrable (the sole escape hatch `caco_enable_tools`, plus
    session/agent/memory/workflow/index/retrieve tools, stay always-on).
    `caco_docs` IS deferrable (its discovery role moved to `caco_enable_tools`
    no-args; see spec-enable-tools-discovery). `restart_server` lives in
    `applet-tools.ts` but is deliberately kept always-on (privileged control-plane
    action used mid-workflow; a single always-sent tool is cheaper than an enable
    round-trip before every restart). This allowlist lives beside
    `DEFAULT_EXCLUDED_BUILTINS` in `tool-registry.ts` (`DEFER_ELIGIBLE_CACO_TOOLS`),
    keyed by tool name.
- **Used-here is sticky (protection).** Any tool used in the resuming session's own
  history (the R2 per-session used set) is NOT deferred even if system-wide-stale —
  proven-relevant-here overrides the global verdict.
- **Deferred rationale (NOT v1):** a budget/bump/cap model (each use grants +N
  active-hours up to a ceiling) is a later refinement if the flat threshold misfires;
  it is intentionally out of the implementable v1 design.
- **Cold-only, via a pure seam.** Applying an exclusion is free only on a cold resume
  (no warm cache to bust). Express the decision as pure
  `computeColdResumeExclusions({ isCold, tools, lastUsed, nowActiveSeconds, threshold })`
  → the names to exclude, returning `[]` when `isCold` is false — so the "warm session
  is never auto-mutated" invariant is directly unit-testable, not just the age math.
  (Already implemented + tested in R1.)
- **Coldness is observable, not only inferred.** Three signals of increasing strength:
  (1) **turn 0** of a new session — definitionally cold; (2) **resume where
  `now − lastUsedAt > cache TTL`** (prefix evicted; we own `lastUsedAt`); (3)
  **ground truth** — the previous `assistant.usage` event's `cacheReadTokens ≈ 0`
  *proves* the last request was cold. v1 gates auto-defer on (1)/(2); the telemetry from
  B0 lets a later refinement gate on observed (3) so we never defer a session whose cache
  is actually still warm.
- **System-wide staleness verdict.** Usage is aggregated **system-wide** (a tool useful
  in one session is likely useful again anywhere); there is one staleness verdict per
  tool, not a per-session profile. The per-session used-here set only *protects* (never
  broadens) the deferral.

### Phase D — manual defer (mcp-servers applet)

Auto-defer (Phase C) is cold-only and free. The operator also needs a **deliberate,
immediate** defer — "I'm not using github this session, hide it now" — even on a WARM
session, accepting the one-time cost. This is an explicit override, not automation.

- **UI.** In the mcp-servers applet, a **defer toggle button next to each MCP server
  name**. Deferring hides that server's entire tool set (all its tools → `excludedTools`);
  toggling off re-enables them. **The button represents the system-wide manual DEFAULT
  for that server** (persisted preference), which is distinct from a given session's
  *effective* live state — an agent may have per-session-revealed a manually-deferred
  server via `caco_enable_tools`. The applet must label the toggle as the system-wide
  default (not claim a per-session truth it doesn't own), so the two never appear to
  disagree; the B0 banner already shows the effective live token cost.
- **Tooltip (required, explicit).** Must clearly state: this removes the server's tool
  definitions from every future turn (saving those tokens), AND **warns that applying it
  to a live/warm session busts the prompt cache — costing a one-time re-process of the
  entire context window on the next turn** (point at the B0 banner's cache-write/%miss so
  the cost is observable). Framed as: cheap on a cold/idle session, expensive mid-conversation.
- **Scope: system-wide, matching Phase C.** A manual server defer is persisted as a
  system-wide preference (like the usage store) so it (a) applies live to every currently
  active session via `setExcludedToolsLive` (each warm session pays one bust — the warning
  covers this) and (b) seeds into every future/resumed session's exclusion set. Un-defer
  reverses both. `ActiveSession.excludedTools` stays the single per-session runtime truth;
  the manual set is a seed input + a broadcast action, never a competing runtime store.
- **Interaction with `caco_enable_tools`.** The agent can still per-session reveal a
  manually-deferred tool with `caco_enable_tools` (a transient override for that session);
  the system-wide preference is unchanged and re-seeds future sessions. No conflict: enable
  mutates the session's live set; the manual preference only affects seeds + explicit toggles.

Mechanism choice: `excludedTools` + `session.rpc.options.update` over the SDK's native
`defer`/tool-search because the latter has no client-facing enable in the installed
SDK (verified through 1.0.5); this is the only client-controllable path today.

**Caco-tool exclusion probe (hard gate for the Caco-allowlist part only).** Deferral of
Caco `defineTool` tools via `excludedTools` is UNVERIFIED — `excludedTools` is proven for
builtins (`builtin:x`) and MCP (`server/tool`), but Caco tools may only be removable by
the pre-registration `filterDisabledTools` path. Before shipping Caco-tool auto-defer,
probe whether excluding a Caco tool by its name via `rpc.options.update({excludedTools})`
actually drops it (measure via `getContextInfo`/getCurrentMetadata). **If it does NOT,
Caco-tool defer is CUT from v1 entirely** — the pre-registration fallback is rejected
because it would make the "deferred" browser/applet/surface tools *hard-disabled*
(non-revealable) for that session, breaking the feature's core contract that a deferred
tool is always re-enableable via `caco_enable_tools`. A deferred tool that can't be
revealed is a different (worse) thing than deferral. MCP + builtin defer proceed
regardless (both proven excludable).

### Cross-cutting — the tool-state authority + single metering funnel

New responsibility (metering tool usage, capturing token/cache signals, deciding what to
defer/reveal) must **not** be smeared across `session-manager`, `dispatch-events`,
`workspace-api`, and `dev-docs-tool`. Two consolidation rules own it.

**One metering funnel.** All SDK-**event**-derived metrics (tokens, `cacheWrite`/
`cacheRead`, tool-call usage stamps, 429s) are captured in `dispatch-events.ts` →
`session-throughput.ts` / `session-usage-cache.ts`; all **pull** metrics are read
through dedicated `SessionManager` accessors (`getContextInfo` for the context-window
breakdown; a sibling accessor for cumulative `usage.getMetrics` only if a step needs
it), one accessor per RPC. No feature adds a second `session.on`/subscription for
metrics. This rule exists because event capture is *already* split across two consumers
(`applyDispatchEventEffects` and the websocket `broadcastEvent`); a third would be the
parallel funnel that silently diverges from the others.

**One tool-state authority, split by purpose (SRP, four modules — not one).** To keep
each concern with one purpose and prevent `session-tool-state.ts` from becoming a
dumping ground, the authority is **four small modules**, layered leaf-first:

- **`src/tool-key.ts` (leaf, pure).** The branded `ToolKey`
  (`string & { __brand: 'ToolKey' }`). **A `ToolKey` IS the exact string
  `excludedTools` matches** (verified empirically — see "Key discovery" below):
  builtin → `builtin:<modelName>`; MCP → `<modelName>` (the model-facing name, which the
  CLI has already server-prefixed into the flat tool namespace — e.g.
  `github-mcp-server-actions_get`); Caco → `<modelName>` (bare). Branding makes "forgot to
  route through the key producer" a *compile* error. **Builtin/Caco keys are derivable
  from the model-facing name synchronously; an MCP key is NOT reconstructable from
  `server`+`rawTool`** (the CLI's model-facing name is authoritative and irregular — e.g.
  `web_search` has no server prefix). MCP keys are therefore **discovered**, not built (see
  below). **Leaf on purpose:** the usage meter imports *only* this.
- **`src/tool-catalog.ts` (pure).** `CatalogTool`, `ToolCatalog = ReadonlyMap<ToolKey,
  CatalogTool>`, and `buildToolCatalog(sources) → ToolCatalog` — the single "what tools
  exist" view. Today no such view exists: `buildMcpServerPayload` stitches three sources
  ad-hoc (`cacoToolCatalog` + `listBuiltinTools()` + `listMcpTools(server)`). Now the
  applet payload, the deferred-tool list, and `validateEnable` all consume this one
  catalog instead of re-assembling sources.
  ```
  interface CatalogTool { key: ToolKey; name: string; description: string;
    origin: 'caco'|'builtin'|'mcp'; hardDisabled: boolean; parameters?: JSONSchema; }
  ```
- **`src/session-tool-state.ts` (pure decision core).** `classifyTool(key, { excluded,
  hardDisabled, policyDisabled }) → 'enabled'|'deferred'|'disabled'` (the single
  presentation-axis definition: hardDisabled or policyDisabled ⇒ `disabled`; a dynamic
  exclusion ⇒ `deferred`; else `enabled`); `validateEnable(keys, catalog, excluded,
  policyDisabled) → { ok; nextExcluded } | { error }` (atomic pre-validation, rejects
  policy-disabled as not re-enableable); `computeColdResumeExclusions(...)` (cold-only
  defer math). No I/O, no
  SDK, no state — the whole decision surface is unit-testable in isolation.
- **The stateful shell — folded INTO `src/session-manager.ts` (as built).** The spec
  originally proposed a separate `src/session-tool-authority.ts`; per the coupling review's
  documented escalation ("if lifecycle policy migrates into the authority, fold the shell
  into SessionManager and keep only the pure modules external"), it was folded in — because
  the exclusion set *is* session-lifecycle state (`ActiveSession.excludedTools`, already
  threaded through every create/resume/model-switch path). SessionManager owns:
  `getExcludedToolKeys` (read the single truth); `setExcludedToolsLive` (the ONLY
  success-gated `rpc.options.update` writer — mutates `ActiveSession.excludedTools` only on
  `{success:true}`); `enableTools` (resolve → reject hard-disabled → no-op already-enabled →
  `validateEnable` → apply, under a per-session reveal mutex); and the cold-resume seed path
  (Phase C). It consumes the pure modules; there is no second copy of the exclusion truth.
- **The three pure modules stay external** (`tool-key`, `tool-catalog`, `session-tool-state`)
  — no SDK, no state, fully unit-testable, imported by both SessionManager and the applet
  payload / catalog so nothing re-derives keys/state.

`workspace-api` (applet payload), `dev-docs-tool` (catalog) and the enable tool all
*route through* `buildToolCatalog` + `classifyTool` + `toolKey` instead of re-deriving
the tool universe or the three-axis state in three places.

### Key discovery (Phase K) — a prerequisite correction for MCP/Caco defer

**Problem (found by the C0 probe).** `excludedTools` matches a tool's **model-facing
name**. For builtins that's `builtin:<name>` and for Caco it's the bare tool name — both
synchronously derivable. But an **MCP tool's model-facing name is assigned by the CLI and
is NOT reconstructable** from the `mcpServerName`/`mcpToolName` that `mcp.listTools`
returns: it is *usually* `<server>-<rawTool>` but not always (observed: `web_search` is
exposed bare, with no server prefix). The R1 `toolKey` MCP form (`server/tool`) therefore
does **not** match `excludedTools` — MCP exclusion silently no-ops today (never caught
because only builtins were ever excluded before C0). This must be fixed before any MCP
defer (Phase C/D) can work, and it must **scale to arbitrary MCP servers**, not a
hardcoded name set.

**Design — discover keys from observation, never reconstruct.** The model-facing name is
authoritative from exactly two runtime sources Caco already sees:
- `getCurrentToolMetadata()` — every currently-loaded tool's `name` (model-facing) +
  `mcpServerName`/`mcpToolName` (raw).
- the `tool.execution_start` event — `toolName` (model-facing) + `mcpServerName`/
  `mcpToolName` (raw). (The R2 usage-stamp seam ALREADY receives these.)

Introduce a **key registry** (`src/tool-key-registry.ts`): a persisted, system-wide map
`(mcpServerName, mcpToolName) → modelFacingKey`, learned from both sources continuously.
The registry is the single authority that turns the catalog's raw MCP identities into real
exclusion keys. Rules:
- **MCP `ToolKey` = the learned model-facing name.** `toolKeyFromEvent` uses the event's
  `toolName` directly (it *is* the model-facing name) — trivially correct, no
  reconstruction. `getCurrentToolMetadata` populates the registry for all loaded tools.
- **You can only defer a tool whose key is known.** A tool is only a defer candidate after
  it has been observed at least once (its key learned). This is not a real limitation for
  auto-defer: Phase C defers **stale** (previously-used, now-unused) tools — which are by
  definition already observed. A never-observed tool costs nothing to leave enabled until
  first use, at which point it becomes learnable.
- **Deferred tools keep their learned key.** Once deferred, a tool is absent from
  `getCurrentToolMetadata`; the persisted registry retains its key so it can be displayed
  and re-enabled.
- **Builtin/Caco keys stay derivable** (no registry needed): `builtin:<name>` / bare name.
- **`toolKey({origin:'mcp', ...})` reconstruction is removed** — replaced by registry
  lookup; a catalog entry with no learned key is marked "unknown key" (not excludable yet),
  never given a fabricated `server/tool` key.

This replaces the current guess with measured truth and scales to any server, because the
CLI itself tells us each tool's name the first time we see it.

- **`caco_enable_tools` is the sole always-on escape hatch** (invariant): it both
  LISTS deferred tools (no-args) and re-enables them, so it must never be deferred,
  policy-disabled, or hard-disabled (incl. via `CACO_DISABLED_TOOLS`, guarded by
  `PROTECTED_TOOLS`). `caco_docs` is now an ordinary defer-eligible tool (see
  spec-enable-tools-discovery); discovery no longer depends on it.
- **Reveal targets the deferred axis only** (invariant): only registered-but-excluded
  tools are revealable; `DEFAULT_DISABLED_TOOLS` (filtered pre-registration) are not,
  and the applet/catalog must present them as a distinct non-revealable state.
- **State mutates only on SDK success** (invariant): the active `excludedTools` and
  applet only change after `rpc.options.update` returns `{success:true}`; a throw/false
  leaves state unchanged (and a failed/rejected enable never busts the cache).
- **Reveal/auto-defer is monotonic within a warm session** (invariant): the *agent
  reveal* path (`caco_enable_tools`) and the *auto-expiry* system never shrink a warm
  session's visible tool set — reveal only grows it, and auto-defer fires only on the
  cache-free seams (cold resume, create), never on a warm session. This caps
  agent/automation-driven warm cache-busts at ≤ one per revealed family per session.
  **Exception — operator manual defer (Phase D)** is a deliberate, explicitly-warned
  override that MAY re-defer (shrink) a warm session; it is out of scope of this
  monotonicity guarantee by design (the operator accepts the one-time cost via the tooltip
  warning). It does **not** cap total busts across *different* families revealed on
  separate turns — that multi-family, multi-turn cost is accepted (never block) and
  measured, not prevented (see Budgets). Monotonicity (agent/auto) is what makes
  automation-driven *re-defer* churn structurally impossible mid-session, so that churn is
  only ever *measured*, never *gated*.
- **`caco_enable_tools` never blocks** (invariant): a valid enable is always applied;
  rejection happens only for invalid input (unknown/hard-disabled/already-enabled), never
  as rate-limiting. Amortization is achieved by shaping (batching nudge, over-reveal,
  stickiness), not by gating.
- **Auto-defer only on cache-free seams** (invariant): a warm session's tool set is
  never mutated by the *expiry* system. Auto-defer applies only at a cold resume
  (`computeColdResumeExclusions` returns `[]` when not cold) and at create (a new
  session has no cache); both are cache-free. (Manual applet defer is a separate,
  explicit operator action that MAY mutate a warm session, with an explicit cost
  warning — see Phase D.)
- **Auto-defer eligibility is a fixed allowlist** (invariant): auto-defer may hide only
  MCP tools, excludable SDK builtins, and the named Caco allowlist
  (`DEFER_ELIGIBLE_CACO_TOOLS` = `caco_docs` + browser/applet/surface tools).
  `caco_enable_tools` (the sole escape hatch) and every other Caco tool are never
  auto-deferred; the resuming
  session's own used-here set is additionally protected.
- **Two axes stay distinct** (invariant): observed≠enabled. The applet must not conflate
  "not in this turn's resolved set" with "excluded from the model".
- **Reveal is live, not resume** (fact): `session.rpc.options.update` accepts
  `excludedTools` mid-session (verified in SDK types, `rpc.d.ts` `options.update` →
  `SessionUpdateOptionsResult`).
- **Single metering funnel** (invariant): all SDK-event-derived metrics are captured in
  `dispatch-events.ts` (→ `session-throughput.ts` / `session-usage-cache.ts`); all
  pull-metrics via dedicated `SessionManager` accessors (one per RPC, e.g.
  `getContextInfo`). No feature adds a second event subscription for metrics — a second
  funnel silently diverges from the first.
- **One tool key = the `excludedTools` string** (invariant): the usage-stamp key, the
  `excludedTools` entry, and the applet classification key are the SAME branded `ToolKey`
  for a given tool — and that key is exactly what the CLI's `excludedTools` denylist
  matches (the model-facing name; `builtin:<name>` for builtins). Builtin/Caco keys derive
  from the model-facing name; **MCP keys are looked up from the learned key registry
  (Phase K), never reconstructed** from `server`+`rawTool`. A key mismatch would make
  defer silently mis-fire — the exact failure C0 exposed — so an MCP tool with no learned
  key is marked "unknown/not-excludable-yet", never given a fabricated key.
- **One classifier / one state owner** (invariant): enabled/deferred/disabled is defined
  once (`classifyTool` in `session-tool-state.ts`, with a `policyDisabled` set separating
  permanent policy exclusions from dynamic defers) and consumed by the applet payload, the
  deferred-tool list (`formatDeferredTools`), and enable-validation; the per-session `excludedTools` truth and
  the sole success-gated live mutator (`setExcludedToolsLive`) live only in SessionManager.
- **One catalog assembly** (invariant): the "what tools exist" universe is built once by
  `buildToolCatalog` (keyed by `ToolKey`); the applet payload, the deferred-tool list,
  and `validateEnable` all consume that one `ToolCatalog` — none re-stitches
  `cacoToolCatalog` + `listBuiltinTools` + `listMcpTools` itself.
- **Exclusion-set lifecycle contract** (invariant): `ActiveSession.excludedTools` is the
  single per-session truth, seeded at create/resume (from the initial `excludedBuiltins` ∪
  the Phase-D manual preference ∪ Phase-C cold-resume auto-defer) BEFORE any read, and
  threaded through every recreate/model-switch path (create/resume/setModel already
  re-pass it). It is mutated live only by `setExcludedToolsLive`, and only on
  `{success:true}`. Concurrent reveals are serialized by a per-session mutex so the
  read-modify-write can't lose an update. Cold-resume auto-defer fires only on a genuinely
  cold resume; a warm session is never auto-mutated (manual Phase-D defer excepted).

## Considerations

- **Prompt-cache-bust cost.** A reveal changes the tool block (near the request front),
  invalidating the cached prefix from there → the whole history after it is re-billed at
  the input (~10×) rate that one turn. Amortized over the rest of the session; net-win
  only when the excluded set is large and sparsely revealed. Keep frequently-used tools
  always-on; default-exclude only the long tail. **The bust is now measurable, not just
  modeled** — the SDK's `assistant.usage` event reports per-call `cacheReadTokens` /
  `cacheWriteTokens`, so a reveal turn should show a `cacheWriteTokens` spike (fresh
  history re-cached) followed by normal `cacheReadTokens`-dominated turns. We still can't
  read the backend's tool-block placement from types, but we can read the realized cost.
- **Telemetry seam (the cost oracle for B and C).** Caco captures `assistant.usage` and
  `session.usage_info` through the **existing** funnels (`dispatch-events.ts` and the
  websocket `broadcastEvent`), and reads the MCP breakdown via one
  `SessionManager.getContextInfo` → `session.rpc.metadata.contextInfo({ promptTokenLimit:
  0, outputTokenLimit: 0 })` (null when uninitialized ⇒ "unknown", never `0`); it may
  also poll `session.rpc.usage.getMetrics()` through that same pull path. This gives:
  (a) proof that deferral shrinks `toolDefinitionsTokens`/`mcpToolsTokens` (the latter via
  `contextInfo` only); (b) the realized cache-bust of each reveal (`cacheWriteTokens`
  spike from `assistant.usage`); (c) an observed-coldness signal (`cacheReadTokens ≈ 0` ⇒
  last request was cold). All three feed decisions rather than being asserted. The
  `assistant.usage`/`session.usage_info` events are `ephemeral:true` (not persisted to
  the event log) — Caco must capture them live if it wants to retain them.
- **Reveal reliability is model-dependent.** The agent must reach for `caco_enable_tools`;
  the always-on catalog makes disabled tools *discoverable* (name+desc visible) rather
  than invisible — a strong nudge, but success varies by model (GPT-5.x vs Opus). Measure.
- **MCP filtering by namespacedName.** `excludedTools` must drop MCP tools by their
  `namespacedName` (e.g. `github-mcp-server/list_issues`); the SDK documents
  `namespacedName` as "for declarative filtering," but the spec must verify excluding an
  MCP tool by namespaced name actually removes its schema (not just blocks calls).
- **What is even excludable.** Confirm MCP tools accept `excludedTools` the same way SDK
  builtins do (`DEFAULT_EXCLUDED_BUILTINS` already excludes builtins via `excludedTools`).
- **Persistence.** Phase C usage stats + the Phase D manual-defer preference persist under
  `~/.caco/` (system-wide, like memory). The active-seconds clock is process-lifetime +
  persisted increment. **Live reveals mutate only the in-memory `excludedTools`** — a cold
  resume in a *fresh process* loses them and re-applies the seed (cold-resume auto-defer ∪
  manual-defer preference). This is a fact, not a bug: agent reveals are session-scoped;
  the durable defaults are the usage staleness + the manual preference.
- **featureFlags lead (out of scope).** `SessionUpdateOptionsParams.featureFlags` might
  enable the SDK's native tool-search; a probe could make Phase C unnecessary, but this
  spec does not depend on it.

## Risks and Mitigations

- Agent never re-enables a needed tool → always-on discovery + a system-prompt line pointing at `caco_enable_tools` (no-args lists deferred tools, then enable); measure reveal-rate on a benchmark.
- Reveal thrashing (N busts) → **not** gated (never block agent work); bounded by design instead: monotonic-within-warm + batching nudge + over-reveal cap it at ≤1 bust per family per session, and the `assistant.usage` stream *measures* any residual churn to tune defer-aggressiveness at the next cold boundary.
- Cache-bust overstated/understated → measured directly via `assistant.usage` (`cacheWriteTokens` spike on a reveal turn vs `cacheReadTokens`-dominated steady turns); ship Phase B behind the applet so the cost is observable before trusting it.
- Auto-defer removes a tool a cold session immediately needs → it's re-enableable in one call; only defer below a conservative threshold; never on warm sessions.
- MCP names not excludable → **RESOLVED by C0 probe:** `excludedTools` matches the
  model-facing name; MCP keys are discovered via the Phase-K registry (not the broken
  `server/tool` form). The old `server/tool` key silently no-op'd exclusion — the exact
  "measurement with no error path" the design feared; caught by the C0 probe before ship.
- **Unknown MCP key (never-observed tool)** → cannot be deferred until first observed
  (its model-facing name is only knowable from the CLI at load/use time). Accepted: a
  never-used tool isn't a defer target anyway; auto-defer only touches stale = observed
  tools. The registry persists learned keys so deferred tools stay re-enableable.
- **Caco tools not excludable via `excludedTools`** → C0 probe gates the Caco-allowlist part only; if it fails, Caco-tool defer is CUT from v1 (no non-revealable fallback). MCP + builtin defer proceed regardless.
- **Cross-session over-defer (accepted footgun)** → system-wide 2-active-hour staleness + used-here protection can still defer a tool the user relies on in a *different* session if it wasn't used in the resuming session's own history. This matches the operator's chosen criteria; it is **accepted and fully recoverable** — the agent reveals it in one `caco_enable_tools` call, or the operator manual-un-defers. Called out so it isn't read as a bug.
- **Manual defer of a warm session busts the whole window** → this is accepted and deliberate (operator override), NOT silent: the applet tooltip warns explicitly and the B0 banner shows the realized cache-write/%miss. Cheap on cold/idle sessions; the warning steers the operator to defer when not mid-conversation.
- **Stamp/exclusion key mismatch ⇒ auto-defer silently mis-fires** (defers a just-used tool, or never defers) → costs money with no error. Mitigated by a single `toolKey()` used by the meter, the exclusion set, and the classifier; assert-throw on an unresolvable key; and a seam test over dispatch → usage-store stamp → `coldResume` exclusion (not just the pure defer math).
- **Authority lifecycle mis-sequencing** (read-before-seed returns a false-empty exclusion set; `coldResume` on a warm session; `getExcluded` dropped on model-switch; stale state after end) → silent wrong tool set. Mitigated by the Authority-lifecycle-contract invariant: boundary assertions (unseeded read throws) + a lifecycle seam test. Escalation seam: if lifecycle *policy* migrates into the authority, fold the shell into SessionManager (keep the three pure modules external).

## Acceptance

- Observable (A): mcp-servers applet shows a `Caco` server (built-in Caco tools) and marks disabled tools greyed + `(disabled)`, distinct from `unobserved`.
- Observable (B): `caco_enable_tools` (no args) lists the deferred tools (name+desc); `caco_enable_tools({names})` makes a previously-deferred tool appear enabled in the applet and callable next turn, with no resume; an invalid-name call is rejected and the applet state is unchanged.
- Observable (C): after a tool goes unused past the active-time threshold, a **cold** resume shows it `(disabled)`; a warm session is never auto-changed.
- Budgets: a single `caco_enable_tools` call (any number of names) costs ≤1 cache-bust turn; steady turns after show the excluded schemas absent from the request. **Multi-family / multi-turn reveals are explicitly allowed, not prevented** — an agent that reveals different families across several turns pays one bust per such turn; this is accepted (never block agent work) and instead *measured* via `assistant.usage` and fed back to tune defer-aggressiveness at the next cold boundary.
- Gates: typecheck ×2, lint:strict, knip, full tests, build:client.
- Oracles:
  - Pure catalog builder → `buildToolCatalog` unit test: all origins present, keyed by `ToolKey`, no duplicates when the same tool appears via `tools.list` and the exclusion set; hard-disabled tools included with `hardDisabled:true`.
  - `caco_enable_tools` validation → unit test: unknown / already-enabled / hard-disabled names reject atomically (no exclusion mutation); a **valid** enable is never rejected (never-block); state changes only on `rpc.options.update` success (throw/`{success:false}` leaves it unchanged); a valid batch produces the expected new `excludedTools`; two valid enables in one turn both apply (monotonic, no rejection).
  - **`toolKey` / `classifyTool` (the single-key & single-classifier oracles):** `toolKey` unit test covering **all origins** — MCP tool ⇒ `server/tool`, SDK builtin ⇒ `builtin:x`, Caco tool ⇒ its key form, and the `tool.execution_complete` event shape (`toolName`/`mcpServerName`/`mcpToolName`) resolving to the *same* key its `excludedTools` entry uses; unresolvable ⇒ throws. `classifyTool` unit test — dynamic exclusion ⇒ deferred, hard-disabled or policy-disabled ⇒ disabled, else enabled — the one definition the applet/catalog/validation all import.
  - Tool state in the payload → extend `mcp-server-payload.test.ts` (via `classifyTool`: excluded ⇒ deferred; `DEFAULT_DISABLED` ⇒ hard-disabled; else enabled).
  - Phase C → the primary test is the **seam** dispatch-event → usage-store stamp → cold-resume exclusion (code-quality "test the seam"), plus the pure `computeColdResumeExclusions` units: `isCold:false` ⇒ `[]` (warm never mutated); `isCold:true` ⇒ eligible+stale (>2 active-hours) excluded, used-here + non-eligible (`caco_enable_tools`/session/agent/etc.) kept.
  - Phase D (manual defer) → endpoint unit test: deferring a server adds exactly that server's ToolKeys to `excludedTools` (applied live per active session, persisted system-wide); un-defer removes exactly those; a manually-deferred server survives into a freshly-seeded session. **Conflict-order oracle (pins no-dual-truth):** (1) manual defer → `caco_enable_tools` reveals it in one session, live, WITHOUT clearing the persisted preference; (2) a future session is still seeded deferred; (3) a later manual-defer broadcast re-hides the revealed session; (4) manual un-defer removes both the persisted preference AND the live exclusion. Visual: per-server toggle labelled as the system-wide default + the cost-warning tooltip.
  - **B0 telemetry (measurement, not gate):** a before/after showing an excluded MCP tool's tokens absent from `toolDefinitionsTokens`/`mcpToolsTokens` (read via one `SessionManager.getContextInfo` → `session.rpc.metadata.contextInfo({ promptTokenLimit: 0, outputTokenLimit: 0 })`); a reveal turn shows a `cacheWriteTokens` spike in `assistant.usage`. Recorded as evidence; Phase B proceeds regardless (the SDK's accounting already documents the drop for deferred tools; B0 confirms it for the `excludedTools` path).
  - By-construction/visual: applet render, `rpc.options.update` wiring, the cache-bust magnitude (measured, not asserted).

## Plan

| # | Step | Files | Oracle |
|---|------|-------|--------|
| A1 | Add `Caco` pseudo-server (Caco `defineTool` tools: name+desc) to `/api/mcp/servers` | `src/routes/workspace-api.ts`, `src/session-manager.ts` (list Caco tools) | payload test: Caco server present |
| A2 | Compute per-tool state inline (enabled/deferred/hard-disabled) — **as built in Phase A**; R1 retrofits this onto `classifyTool` | `src/routes/workspace-api.ts` | `mcp-server-payload.test.ts` (excluded ⇒ deferred; DEFAULT_DISABLED ⇒ hard-disabled) |
| A3 | Applet: grey `(disabled)` for policy-disabled (hard-disabled Caco + policy-excluded builtins), green `deferred` for dynamic defers, distinct from active/unobserved | `applets/mcp-servers/{script.js,style.css}` | visual |
| R0 | **SDK surface:** extend Caco `CopilotSessionInstance` with `rpc.options.update` + `rpc.metadata.contextInfo` (compile prerequisite for B0/B2; `rpc.usage.getMetrics` only if a later step needs cumulative metrics) | `src/session-manager.ts` | compiles (tsc) |
| R1 | **Create the tool-state modules (SRP split):** `src/tool-key.ts` (branded `ToolKey` + `toolKey`, leaf), `src/tool-catalog.ts` (`buildToolCatalog` + `CatalogTool`/`ToolCatalog`), `src/session-tool-state.ts` (pure `classifyTool`/`validateEnable`/`computeColdResumeExclusions`). Retrofit the Phase-A payload onto `buildToolCatalog` + `classifyTool` (removes the inline stitch/copy) | `src/tool-key.ts`, `src/tool-catalog.ts`, `src/session-tool-state.ts`, `src/routes/workspace-api.ts` | `toolKey` (all origins incl. event shape, unresolvable throws) + `classifyTool` + `validateEnable` + `buildToolCatalog` unit tests; payload test still green |
| R2 | **Tool-call metering audit** (gates C): extend `recordToolCall`/`dispatch-events` tool.execution_complete branch to carry the key via `toolKey()` (imports **only** `tool-key.ts`); assert-throw on unresolvable | `src/dispatch-events.ts`, `src/session-throughput.ts` | seam test: a tool call stamps under the same key `excludedTools` uses |
| R3 | Capture the two silently-dropped signals in the existing funnels: `cacheWriteTokens` (assistant.usage) + `toolDefinitionsTokens` (usage_info) | `src/dispatch-events.ts`, `src/session-throughput.ts` (`recordUsage` param), `src/session-usage-cache.ts` (`SessionUsage` field), `src/routes/websocket.ts` | unit: cacheWrite recorded on `recordUsage`; `toolDefinitionsTokens` retained in `SessionUsage` |
| B0 | **Telemetry harness** (measurement, not a gate): add one `SessionManager.getContextInfo` pull; measure excluded-MCP-tool token drop + reveal cache-bust from R3's captured signals — **no new subscription** | `src/session-manager.ts` (`getContextInfo`) | before/after `mcpToolsTokens` drop (via `contextInfo`) + `cacheWriteTokens` spike (evidence, non-blocking) |
| B1 | Deferred-tool discovery: `caco_enable_tools` no-args → `formatDeferredTools` (name+desc, grouped, deferred-only) from `buildToolCatalog` + `classifyTool`. **Superseded:** originally `caco_docs section="tools"` (now redirects); see spec-enable-tools-discovery | `src/tool-reveal-tool.ts`, `src/session-tool-state.ts` (`formatDeferredTools`), `src/dev-docs-tool.ts` (redirect) | pure formatter unit (deferred-only, exact output) |
| B2 | `caco_enable_tools` reveal — **as built:** authority folded INTO SessionManager (per the coupling-review escalation), `ActiveSession.excludedTools` = single truth, one success-gated `setExcludedToolsLive`; `enableTools` = resolve → reject hard-disabled → no-op already-enabled → `validateEnable` → apply; per-session reveal mutex; session-scoped catalog | `src/tool-reveal-tool.ts`, `src/session-manager.ts` (`enableTools`/`setExcludedToolsLive`/`getExcludedToolKeys`), `src/session-tool-state.ts` (`resolveEnableTargets`) | validation + success-gating + concurrent-compose + never-block no-op unit tests |
| B3 | System-prompt line: deferred tools exist; discover + enable via `caco_enable_tools` (no-args lists; batch enable, cache warning) | `src/prompts.ts`, tool description | by-construction |
| C0 | **Excludability probe — DONE (findings recorded):** `excludedTools` matches the model-facing name. Caco tools ARE droppable (bare name) ✓; builtins via `builtin:<name>` ✓; MCP via model-facing name (NOT `server/tool`) ✓; the name is not reconstructable (`web_search` exception) → keys must be discovered (Phase K). Caco-tool defer stays in v1 | investigation (probe removed after) | before/after token drop measured (Caco −238, MCP only on model-facing key) |
| K1 | **Key registry:** `src/tool-key-registry.ts` — persisted system-wide `(mcpServerName,mcpToolName)→modelFacingKey`, learned from `getCurrentToolMetadata` + `tool.execution_start`. **Fix `tool-key.ts`:** MCP key = registry lookup (remove `server/tool` reconstruction); `toolKeyFromEvent` MCP branch uses `evt.toolName` directly. Update R1/R2 tests to the model-facing MCP key form | new `src/tool-key-registry.ts`, `src/tool-key.ts`, `src/dispatch-events.ts` (learn on start-event), `src/session-manager.ts` (learn on getCurrentToolMetadata), tests | registry unit test (learn/persist/lookup); event key == excludedTools key (model-facing); an MCP exclusion via the learned key actually drops the tool (integration/probe-style) |
| K2 | **Catalog uses learned keys:** `buildToolCatalog` MCP entries resolve their `ToolKey` via the registry; entries with no learned key are flagged not-yet-excludable (shown, not fabricated). Applet/enable/defer consume real keys | `src/tool-catalog.ts`, `src/session-manager.ts` (`getToolCatalog`) | catalog test: MCP key = learned model-facing; unknown-key entry flagged, not `server/tool` |
| C1 | `DEFER_ELIGIBLE_CACO_TOOLS` allowlist (`caco_docs` + browser/applet-state/surface tools; `restart_server` deliberately excluded) + `isDeferEligibleCacoTool` + persistent system-wide usage store: lazy capped **active-seconds clock** (`MAX_ACTIVE_GAP_SECONDS`) + per-tool `lastUsedActiveSeconds` keyed by `toolKey`, fed from the R2 `tool.execution_start` seam (`stampToolUsage` beside `recordToolUse`). **Diagnosability:** `/servers` payload carries per-tool `ageActiveSeconds`/`deferEligible`/`stale`/`wouldDefer` (verdict from the shared `DEFER_STALE_THRESHOLD_ACTIVE_SECONDS`, so the applet view can't disagree with C2); the mcp-servers applet shows an age badge + "would defer" marker on every tool | `src/tool-registry.ts`, new `src/tool-usage-store.ts`, `src/dispatch-events.ts`, `src/routes/workspace-api.ts` (payload usage fields), `applets/mcp-servers/{script.js,style.css}` | store unit test (stamp/advance/cap/persist/reload-ignores-downtime); eligibility set; payload usage-fields test (fresh kept / stale would-defer / unlearned never-eligible / never-used maximally stale); applet age visual |
| C2 | Cold-resume auto-defer: `computeColdResumeAutoDefer` (gated by `isColdResume` = not a model switch AND `now − meta.lastUsedAt > COLD_RESUME_STALE_MS`) computes `computeColdResumeExclusions` over the eligible candidate universe (all learned MCP keys ∪ `DEFER_ELIGIBLE_CACO_TOOLS`; builtins already excluded via base seed), threshold **2 active-hours**, minus the session's used-here set, then unions into the resume `excludedTools` seed alongside the manual-defer set. Warm/model-switch never auto-mutated (create IS auto-deferred — see C3); decision logged (`[DEFER] cold-resume`) | `src/session-manager.ts` (resume seed path, `isColdResume`/`computeColdResumeAutoDefer`, shared `computeStaleDeferCandidates`), `src/tool-usage-store.ts` (`COLD_RESUME_STALE_MS`), `src/tool-key-registry.ts` (`allLearnedKeys`) | **seam test**: warm ⇒ []; model-switch ⇒ []; cold defers never-used + system-wide-stale eligible; a store-stamped tool stays fresh & kept; used-here kept; unlearned MCP never a candidate |
| C3 | **New-session auto-defer** (spec-new-session-auto-defer): the same staleness verdict applied at `create()` via `computeNewSessionAutoDefer` = shared `computeStaleDeferCandidates(∅)` — **no coldness gate** (a new session has no prefix cache), unioned into the create `excludedTools` seed alongside base + manual-defer. Extracts `computeStaleDeferCandidates(usedHere)` shared with C2. Lets a short-lived process that never goes cold still get lean sessions; decision logged (`[DEFER] new-session`) | `src/session-manager.ts` (`create` seed, `computeNewSessionAutoDefer`, `computeStaleDeferCandidates`) | unit: never-used⇒deferred, fresh(stamped)⇒kept, applies with no `lastUsedAt`/config (no gate), unlearned⇒skip; C2 regression stays green |
| D1 | **Manual defer (applet):** per-MCP-server defer toggle in mcp-servers applet; `setExcludedToolsLive` ADD path (`deferServer`), applied live to all active sessions + persisted system-wide seed; tooltip warns warm-session full-window cache cost | `applets/mcp-servers/{content.html,script.js,style.css}`, `src/routes/workspace-api.ts` (defer/undefer endpoint), `src/session-manager.ts` (`deferTools` broadcast), new system-wide manual-defer store | endpoint unit test (add/remove server tools to excluded); visual (button + tooltip) |

## Rationale

Phases A/B deliver a usable manual mechanism + full observability with modest risk;
Phase C automates deferral only where it is provably free (cold resume). The applet
(Phase A) is deliberately first so every later change is inspectable. The
`excludedTools`/`rpc.options.update` mechanism is the only client-controllable path while
the SDK's native `defer`/tool-search stays runtime-gated (see `spec-budget.md` future
levers; re-evaluate on SDK bumps and the `featureFlags` lead).
