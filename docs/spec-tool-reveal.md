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
from a catalog (`caco_docs`), enables a batch in one call (`caco_enable_tools`), and
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
- **State marker.** Per tool, render **enabled** (normal), **deferred** (greyed +
  `(disabled)`, revealable), **hard-disabled** (greyed + `(off)`, not revealable).
  Keep the existing observed/unobserved orthogonal (a deferred tool is unobserved).

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

- **Catalog in `caco_docs`.** `caco_docs section="tools"` returns every tool as
  `camel_case_name` + one-line description (enabled + deferred + hard-disabled),
  grouped by Caco/builtin/server, with each tool's state. Heavy schemas stay out of
  the per-turn payload.
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

### Phase C — deferred auto-expiry (usage-driven, cold-resume-only)

Sparsely-used tools should auto-defer, but only where it is **free**: on a **cold
resume** (session absent from `activeSessions` → recreated with no warm provider
cache), applying an exclusion costs nothing (there is no prefix to bust). Never
auto-defer a warm session.

- **Usage signal (active-time, not calendar).** Calendar age is unreliable (a session
  idle overnight isn't "stale"). Track a monotonic **active-seconds clock** that
  advances only while ≥1 SDK session is active. Each tool invocation stamps the clock
  for that tool (system-wide, keyed by tool/namespacedName). **v1 mechanism (flat
  threshold):** persist a single per-tool `lastUsedActiveSeconds` stamp; on **cold
  resume** only, defer tools whose stamp is older than one threshold. One number per
  tool, no decay math.
- **Deferred rationale (NOT v1):** a budget/bump/cap model (each use grants +N
  active-hours up to a ceiling) is a later refinement if the flat threshold misfires;
  it is intentionally out of the implementable v1 design.
- **Cold-only, via a pure seam.** Applying an exclusion is free only on a cold resume
  (no warm cache to bust). Express the decision as pure
  `computeColdResumeExclusions({ isCold, tools, lastUsed, nowActiveSeconds, threshold })`
  → the names to exclude, returning `[]` when `isCold` is false — so the "warm session
  is never auto-mutated" invariant is directly unit-testable, not just the age math.
- **Coldness is observable, not only inferred.** Three signals of increasing strength:
  (1) **turn 0** of a new session — definitionally cold; (2) **resume where
  `now − lastUsedAt > cache TTL`** (prefix evicted; we own `lastUsedAt`); (3)
  **ground truth** — the previous `assistant.usage` event's `cacheReadTokens ≈ 0`
  *proves* the last request was cold. v1 gates auto-defer on (1)/(2); the telemetry from
  B0 lets a later refinement gate on observed (3) so we never defer a session whose cache
  is actually still warm.
- **Per-session vs system-wide.** Usage is aggregated **system-wide** (a tool useful in
  one session is likely useful again). A per-session override is a Phase-C+
  consideration, not v1.

Mechanism choice: `excludedTools` + `session.rpc.options.update` over the SDK's native
`defer`/tool-search because the latter has no client-facing enable in the installed
SDK (verified through 1.0.5); this is the only client-controllable path today.

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
  (`string & { __brand: 'ToolKey' }`) + `toolKey(tool|event) → ToolKey`. Branding makes
  "forgot to route through `toolKey()`" a *compile* error, not a runtime mis-key
  (leverage-1). Forms: MCP `server/tool`, builtin `builtin:x`, Caco `caco:x`; resolving
  the `tool.execution_complete` event shape (`toolName`/`mcpServerName`/`mcpToolName`)
  yields the *same* key the tool's `excludedTools` entry uses; an unresolvable input
  **throws**. **Leaf on purpose:** the usage meter (`dispatch-events`/`session-throughput`)
  imports *only* this — so metering never depends on the catalog or the shell.
- **`src/tool-catalog.ts` (pure).** `CatalogTool`, `ToolCatalog = ReadonlyMap<ToolKey,
  CatalogTool>`, and `buildToolCatalog(sources) → ToolCatalog` — the single "what tools
  exist" view. Today no such view exists: `buildMcpServerPayload` stitches three sources
  ad-hoc (`cacoToolCatalog` + `listBuiltinTools()` + `listMcpTools(server)`). Now the
  applet payload, the `caco_docs` catalog, and `validateEnable` all consume this one
  catalog instead of re-assembling sources.
  ```
  interface CatalogTool { key: ToolKey; name: string; description: string;
    origin: 'caco'|'builtin'|'mcp'; hardDisabled: boolean; parameters?: JSONSchema; }
  ```
- **`src/session-tool-state.ts` (pure decision core).** `classifyTool(key, { excluded,
  hardDisabled }) → 'enabled'|'deferred'|'off'` (the single 3-axis definition);
  `validateEnable(keys, catalog, excluded) → { ok; nextExcluded } | { error }` (atomic
  pre-validation); `computeColdResumeExclusions(...)` (cold-only defer math). No I/O, no
  SDK, no state — the whole decision surface is unit-testable in isolation.
- **`src/session-tool-authority.ts` (the only stateful, SDK-touching module).** Holds the
  authoritative per-session `excludedTools` truth (keyed by `ToolKey`); `enable(sessionId,
  keys)` = `validateEnable` → `rpc.options.update` → mutate **only on `{success:true}`**;
  `coldResume(sessionId)` = compute `isCold` + pure fn + apply; `seed`/`getExcluded`/
  `clear` for lifecycle. It *reads* usage stamps; it does **not** subscribe to events, do
  token accounting, or write applet state.

**The `getSession(id)` seam is write-only.** SessionManager owns one authority instance
and injects a `getSession(id)` accessor purely so the shell can issue the
`rpc.options.update` write without importing SessionManager (breaks the cycle). This is
deliberately narrow: the authority holds **no** create/resume/end/model-switch policy. If
lifecycle *policy* ever needs to migrate into the authority, that is the signal to instead
fold the shell *into* SessionManager as a private unit and keep only the three pure
modules external — the injection is acceptable exactly while the authority stays
lifecycle-ignorant.

`workspace-api` (applet payload), `dev-docs-tool` (catalog) and the enable tool all
*route through* `buildToolCatalog` + `classifyTool` + `toolKey` instead of re-deriving
the tool universe or the three-axis state in three places.

## Invariants

- **`caco_enable_tools` and `caco_docs` are never excluded** (invariant): the escape
  hatch and the catalog must always be visible, or the agent can't recover a capability.
- **Reveal targets the deferred axis only** (invariant): only registered-but-excluded
  tools are revealable; `DEFAULT_DISABLED_TOOLS` (filtered pre-registration) are not,
  and the applet/catalog must present them as a distinct non-revealable state.
- **State mutates only on SDK success** (invariant): the active `excludedTools` and
  applet only change after `rpc.options.update` returns `{success:true}`; a throw/false
  leaves state unchanged (and a failed/rejected enable never busts the cache).
- **Reveal is monotonic within a warm session** (invariant): while a session is warm,
  the visible tool set only ever *grows* — `caco_enable_tools` adds, and nothing
  re-defers until the next cold boundary. This caps the warm cache-bust at ≤ one per
  *revealed family* (over-reveal collapses repeated same-family reveals into one bust).
  It does **not** cap total busts across *different* families revealed on separate turns
  — that multi-family, multi-turn cost is accepted (never block) and measured, not
  prevented (see Budgets). Monotonicity is what makes *re-defer* churn structurally
  impossible mid-session, so churn is only ever *measured* (feedback to next
  cold-boundary defer aggressiveness), never *gated*.
- **`caco_enable_tools` never blocks** (invariant): a valid enable is always applied;
  rejection happens only for invalid input (unknown/hard-disabled/already-enabled), never
  as rate-limiting. Amortization is achieved by shaping (batching nudge, over-reveal,
  stickiness), not by gating.
- **Auto-defer only on cold resume** (invariant): a warm session's tool set is never
  mutated by the expiry system — enforced by `computeColdResumeExclusions` returning
  `[]` when not cold.
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
- **One tool key** (invariant): the usage-stamp key, the `excludedTools` entry, and the
  applet classification key are all produced by a single `toolKey()` returning the
  **branded `ToolKey` type** — for **every** tool origin (MCP `server/tool`, SDK builtin
  `builtin:x`, Caco `caco:x`, and the `tool.execution_complete` event shape that carries
  `toolName`/`mcpServerName`/`mcpToolName`). Branding makes "used a raw string instead of
  `toolKey()`" a compile error; an unresolvable input **throws** (never stamps/excludes
  under a fallback). A key mismatch would make auto-defer silently mis-fire — defer a
  just-used tool or never defer — costing money with no error path (a "measurement with no
  error path" smell).
- **One classifier / one state owner** (invariant): enabled/deferred/off is defined once
  (`classifyTool` in `session-tool-state.ts`) and consumed by the applet payload, the
  `caco_docs` catalog, and enable-validation; the per-session `excludedTools` truth and
  the success-gated `enable()` mutation live only in `session-tool-authority.ts`.
- **One catalog assembly** (invariant): the "what tools exist" universe is built once by
  `buildToolCatalog` (keyed by `ToolKey`); the applet payload, the `caco_docs` catalog,
  and `validateEnable` all consume that one `ToolCatalog` — none re-stitches
  `cacoToolCatalog` + `listBuiltinTools` + `listMcpTools` itself.
- **Authority lifecycle contract** (invariant): the per-session state in
  `session-tool-authority.ts` has a strict, asserted lifecycle — the main hidden coupling
  risk. (1) **Seed before read:** the exclusion set is `seed()`ed (from the initial
  `excludedBuiltins`) at session create/resume *before* any catalog/payload/enable read;
  a read for an unseeded session throws (never returns an empty set that reads as "nothing
  excluded"). (2) **`coldResume()` fires exactly once on a cold resume and never on a warm
  resume/model-switch** — the cold decision is made at one call site in the resume path,
  not scattered. (3) **`getExcluded(id)` is preserved through every recreate/model-switch
  path** (create/resume/setModel) by reading from the authority, not by copying a field.
  (4) **`clear(id)` on session end**, so a later cold resume in the same process starts
  from seed, not stale state. These four are enforced by assertions at the authority
  boundary + a lifecycle seam test, not by convention.

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
- **Persistence.** Phase C usage stats persist under `~/.caco/` (system-wide, like
  memory). The active-seconds clock is process-lifetime + persisted increment. **Live
  reveals mutate only the in-memory `excludedTools`** — a cold resume in a *fresh process*
  loses them and re-applies the cold-resume defer set. This is a fact, not a bug:
  monotonic-within-warm is explicitly session/process-scoped.
- **featureFlags lead (out of scope).** `SessionUpdateOptionsParams.featureFlags` might
  enable the SDK's native tool-search; a probe could make Phase C unnecessary, but this
  spec does not depend on it.

## Risks and Mitigations

- Agent never re-enables a needed tool → always-on catalog + a system-prompt line pointing at `caco_docs section="tools"` / `caco_enable_tools`; measure reveal-rate on a benchmark.
- Reveal thrashing (N busts) → **not** gated (never block agent work); bounded by design instead: monotonic-within-warm + batching nudge + over-reveal cap it at ≤1 bust per family per session, and the `assistant.usage` stream *measures* any residual churn to tune defer-aggressiveness at the next cold boundary.
- Cache-bust overstated/understated → measured directly via `assistant.usage` (`cacheWriteTokens` spike on a reveal turn vs `cacheReadTokens`-dominated steady turns); ship Phase B behind the applet so the cost is observable before trusting it.
- Auto-defer removes a tool a cold session immediately needs → it's re-enableable in one call; only defer below a conservative threshold; never on warm sessions.
- MCP names not excludable → Phase A/B verification gate before Phase C automation.
- **Stamp/exclusion key mismatch ⇒ auto-defer silently mis-fires** (defers a just-used tool, or never defers) → costs money with no error. Mitigated by a single `toolKey()` used by the meter, the exclusion set, and the classifier; assert-throw on an unresolvable key; and a seam test over dispatch → usage-store stamp → `coldResume` exclusion (not just the pure defer math).
- **Authority lifecycle mis-sequencing** (read-before-seed returns a false-empty exclusion set; `coldResume` on a warm session; `getExcluded` dropped on model-switch; stale state after end) → silent wrong tool set. Mitigated by the Authority-lifecycle-contract invariant: boundary assertions (unseeded read throws) + a lifecycle seam test. Escalation seam: if lifecycle *policy* migrates into the authority, fold the shell into SessionManager (keep the three pure modules external).

## Acceptance

- Observable (A): mcp-servers applet shows a `Caco` server (built-in Caco tools) and marks disabled tools greyed + `(disabled)`, distinct from `unobserved`.
- Observable (B): `caco_docs section="tools"` lists all tools (name+desc); `caco_enable_tools({names})` makes a previously-disabled tool appear enabled in the applet and callable next turn, with no resume; an invalid-name call is rejected and the applet state is unchanged.
- Observable (C): after a tool goes unused past the active-time threshold, a **cold** resume shows it `(disabled)`; a warm session is never auto-changed.
- Budgets: a single `caco_enable_tools` call (any number of names) costs ≤1 cache-bust turn; steady turns after show the excluded schemas absent from the request. **Multi-family / multi-turn reveals are explicitly allowed, not prevented** — an agent that reveals different families across several turns pays one bust per such turn; this is accepted (never block agent work) and instead *measured* via `assistant.usage` and fed back to tune defer-aggressiveness at the next cold boundary.
- Gates: typecheck ×2, lint:strict, knip, full tests, build:client.
- Oracles:
  - Pure catalog builder → `buildToolCatalog` unit test: all origins present, keyed by `ToolKey`, no duplicates when the same tool appears via `tools.list` and the exclusion set; hard-disabled tools included with `hardDisabled:true`.
  - `caco_enable_tools` validation → unit test: unknown / already-enabled / hard-disabled names reject atomically (no exclusion mutation); a **valid** enable is never rejected (never-block); state changes only on `rpc.options.update` success (throw/`{success:false}` leaves it unchanged); a valid batch produces the expected new `excludedTools`; two valid enables in one turn both apply (monotonic, no rejection).
  - **`toolKey` / `classifyTool` (the single-key & single-classifier oracles):** `toolKey` unit test covering **all origins** — MCP tool ⇒ `server/tool`, SDK builtin ⇒ `builtin:x`, Caco tool ⇒ its key form, and the `tool.execution_complete` event shape (`toolName`/`mcpServerName`/`mcpToolName`) resolving to the *same* key its `excludedTools` entry uses; unresolvable ⇒ throws. `classifyTool` unit test — excluded ⇒ deferred, hard-disabled ⇒ off, else enabled — the one definition the applet/catalog/validation all import.
  - Tool state in the payload → extend `mcp-server-payload.test.ts` (via `classifyTool`: excluded ⇒ deferred; `DEFAULT_DISABLED` ⇒ hard-disabled; else enabled).
  - Phase C → the primary test is the **seam** dispatch-event → usage-store stamp → `coldResume` exclusion (code-quality "test the seam"), plus the pure `computeColdResumeExclusions` units: `isCold:false` ⇒ `[]` (warm never mutated); `isCold:true` ⇒ stale tools excluded, recently-used kept.
  - **B0 telemetry (measurement, not gate):** a before/after showing an excluded MCP tool's tokens absent from `toolDefinitionsTokens`/`mcpToolsTokens` (read via one `SessionManager.getContextInfo` → `session.rpc.metadata.contextInfo({ promptTokenLimit: 0, outputTokenLimit: 0 })`); a reveal turn shows a `cacheWriteTokens` spike in `assistant.usage`. Recorded as evidence; Phase B proceeds regardless (the SDK's accounting already documents the drop for deferred tools; B0 confirms it for the `excludedTools` path).
  - By-construction/visual: applet render, `rpc.options.update` wiring, the cache-bust magnitude (measured, not asserted).

## Plan

| # | Step | Files | Oracle |
|---|------|-------|--------|
| A1 | Add `Caco` pseudo-server (Caco `defineTool` tools: name+desc) to `/api/mcp/servers` | `src/routes/workspace-api.ts`, `src/session-manager.ts` (list Caco tools) | payload test: Caco server present |
| A2 | Compute per-tool state inline (enabled/deferred/hard-disabled) — **as built in Phase A**; R1 retrofits this onto `classifyTool` | `src/routes/workspace-api.ts` | `mcp-server-payload.test.ts` (excluded ⇒ deferred; DEFAULT_DISABLED ⇒ hard-disabled) |
| A3 | Applet: grey + `(disabled)` for deferred, `(off)` for hard-disabled, distinct from unobserved | `applets/mcp-servers/{script.js,style.css}` | visual |
| R0 | **SDK surface:** extend Caco `CopilotSessionInstance` with `rpc.options.update` + `rpc.metadata.contextInfo` (compile prerequisite for B0/B2; `rpc.usage.getMetrics` only if a later step needs cumulative metrics) | `src/session-manager.ts` | compiles (tsc) |
| R1 | **Create the tool-state modules (SRP split):** `src/tool-key.ts` (branded `ToolKey` + `toolKey`, leaf), `src/tool-catalog.ts` (`buildToolCatalog` + `CatalogTool`/`ToolCatalog`), `src/session-tool-state.ts` (pure `classifyTool`/`validateEnable`/`computeColdResumeExclusions`). Retrofit the Phase-A payload onto `buildToolCatalog` + `classifyTool` (removes the inline stitch/copy) | `src/tool-key.ts`, `src/tool-catalog.ts`, `src/session-tool-state.ts`, `src/routes/workspace-api.ts` | `toolKey` (all origins incl. event shape, unresolvable throws) + `classifyTool` + `validateEnable` + `buildToolCatalog` unit tests; payload test still green |
| R2 | **Tool-call metering audit** (gates C): extend `recordToolCall`/`dispatch-events` tool.execution_complete branch to carry the key via `toolKey()` (imports **only** `tool-key.ts`); assert-throw on unresolvable | `src/dispatch-events.ts`, `src/session-throughput.ts` | seam test: a tool call stamps under the same key `excludedTools` uses |
| R3 | Capture the two silently-dropped signals in the existing funnels: `cacheWriteTokens` (assistant.usage) + `toolDefinitionsTokens` (usage_info) | `src/dispatch-events.ts`, `src/session-throughput.ts` (`recordUsage` param), `src/session-usage-cache.ts` (`SessionUsage` field), `src/routes/websocket.ts` | unit: cacheWrite recorded on `recordUsage`; `toolDefinitionsTokens` retained in `SessionUsage` |
| B0 | **Telemetry harness** (measurement, not a gate): add one `SessionManager.getContextInfo` pull; measure excluded-MCP-tool token drop + reveal cache-bust from R3's captured signals — **no new subscription** | `src/session-manager.ts` (`getContextInfo`) | before/after `mcpToolsTokens` drop (via `contextInfo`) + `cacheWriteTokens` spike (evidence, non-blocking) |
| B1 | `caco_docs section="tools"` full catalog from `buildToolCatalog` + `classifyTool` (name+desc+state, grouped) | `src/dev-docs-tool.ts` (consumes `tool-catalog` + `session-tool-state`) | pure catalog-builder unit test |
| B2 | **Create `src/session-tool-authority.ts`** (stateful shell, owns per-session excludedTools + `seed`/`getExcluded`/`clear`); `caco_enable_tools` → `enable()` = `validateEnable(..., buildToolCatalog(), ...)` → `rpc.options.update` → mutate-on-success; **never blocks**; monotonic within warm session. SessionManager owns the instance + injects `getSession` (write-only seam) | new `src/session-tool-authority.ts`, new `src/tool-reveal-tool.ts` (thin wrapper), `src/session-manager.ts` (own instance, seed on create/resume, recreate reads `getExcluded`) | validation unit test (reject atomic incl. hard-disabled; valid enable never rejected; two-in-turn both apply; state only on success) |
| B3 | System-prompt line: deferred tools exist; discover via `caco_docs`, enable via `caco_enable_tools` (batch, cache warning) | `src/prompts.ts`, tool description | by-construction |
| C1 | Active-seconds clock + per-tool `lastUsedActiveSeconds` keyed by `toolKey` (persisted, system-wide) | new `src/tool-usage-store.ts` | store unit test |
| C2 | `coldResume()` wires `computeColdResumeExclusions` (cold-only) into the resume path; assert the **authority lifecycle contract** (seed-before-read, coldResume once on cold only, `getExcluded` preserved through recreate/model-switch, `clear` on end) | `src/session-tool-authority.ts` (`coldResume`), `src/session-manager.ts` (resume/setModel/end), tool-usage-store | **lifecycle seam test**: seed→read; cold resume calls `coldResume` once (warm/model-switch never); model-switch preserves `getExcluded`; end clears; + dispatch → stamp → `coldResume` (warm ⇒ `[]`; cold ⇒ stale excluded, recently-used kept) |

## Rationale

Phases A/B deliver a usable manual mechanism + full observability with modest risk;
Phase C automates deferral only where it is provably free (cold resume). The applet
(Phase A) is deliberately first so every later change is inspectable. The
`excludedTools`/`rpc.options.update` mechanism is the only client-controllable path while
the SDK's native `defer`/tool-search stays runtime-gated (see `spec-budget.md` future
levers; re-evaluate on SDK bumps and the `featureFlags` lead).
