# spec-tool-reveal

A Caco-owned on-demand tool mechanism: keep the long tail of tools **out of every
turn's request** (saving the per-turn schema tax), expose a cheap discovery catalog,
and let the agent **re-enable** tools live when it needs them. Replicates the SDK's
blocked native "defer/tool-search" using `excludedTools` + `session.options.update`,
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
  toggleable** via `session.options.update` — this is what the reveal feature targets.
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
B0 is therefore not a hard gate on whether the feature works, but a **measurement seam**
that turns the cost model from asserted to observed, and validates it end-to-end:
- Subscribe to the SDK's `assistant.usage` event (per API call: `cacheReadTokens`,
  `cacheWriteTokens`, `cost`, `apiCallId`) and `session.usage_info` (aggregate
  `toolDefinitionsTokens`, `systemTokens`, `conversationTokens`, `currentTokens`). For
  the **MCP-specific** breakdown, read `session.rpc.metadata.contextInfo()` →
  `SessionContextInfo`, which carries **both** `toolDefinitionsTokens` and
  `mcpToolsTokens` (the fields whose docs say "excludes deferred tools").
  `session.rpc.usage.getMetrics()` provides cumulative per-model
  `cacheReadTokens`/`inputTokens`, `lastCallInputTokens`, `totalPremiumRequestCost` —
  but **not** `mcpToolsTokens` (that lives only on `SessionContextInfo`).
- Confirm, with real numbers, that (a) `session.options.update({excludedTools})` mutates
  the live tool set with no resume and (b) excluding an MCP tool by `namespacedName`
  **drops `toolDefinitionsTokens`/`mcpToolsTokens`** (read via `metadata.contextInfo`) by
  that tool's schema size. The SDK's accounting documents that *deferred* tools are
  excluded from those fields; B0 measures that our **`excludedTools` (denylist) path**
  produces the same drop — this is what turns the assumption from documented-for-defer
  into verified-for-our-mechanism. Non-blocking: if the numbers somehow don't move we
  learn the backend differs, but the feature is not predicated on B0 "passing."
- The same telemetry is the **coldness oracle** and the **cache-bust validator** used by
  Phases B and C (see Considerations → telemetry seam).

- **Catalog in `caco_docs`.** `caco_docs section="tools"` returns every tool as
  `camel_case_name` + one-line description (enabled + deferred + hard-disabled),
  grouped by Caco/builtin/server, with each tool's state. Heavy schemas stay out of
  the per-turn payload.
- **`caco_enable_tools({ names })`.** Removes named tools from the session exclusion set
  and applies it live via `session.options.update({ excludedTools,
  toolFilterPrecedence: "excluded" })`. Always-present. **Never blocks agent work.**
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

Mechanism choice: `excludedTools` + `session.options.update` over the SDK's native
`defer`/tool-search because the latter has no client-facing enable in the installed
SDK (verified through 1.0.5); this is the only client-controllable path today.

## Invariants

- **`caco_enable_tools` and `caco_docs` are never excluded** (invariant): the escape
  hatch and the catalog must always be visible, or the agent can't recover a capability.
- **Reveal targets the deferred axis only** (invariant): only registered-but-excluded
  tools are revealable; `DEFAULT_DISABLED_TOOLS` (filtered pre-registration) are not,
  and the applet/catalog must present them as a distinct non-revealable state.
- **State mutates only on SDK success** (invariant): the active `excludedTools` and
  applet only change after `options.update` returns `{success:true}`; a throw/false
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
- **Reveal is live, not resume** (fact): `session.options.update` accepts `excludedTools`
  mid-session (verified in SDK types).

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
- **Telemetry seam (the cost oracle for B and C).** Caco subscribes to `assistant.usage`
  and `session.usage_info`, reads `session.rpc.metadata.contextInfo()` for the MCP-
  specific breakdown, and can poll `session.rpc.usage.getMetrics()`. This gives:
  (a) proof that deferral shrinks `toolDefinitionsTokens`/`mcpToolsTokens` (the latter via
  `metadata.contextInfo` only); (b) the realized cache-bust of each reveal
  (`cacheWriteTokens` spike from `assistant.usage`); (c) an observed-coldness signal
  (`cacheReadTokens ≈ 0` ⇒ last request was cold). All three feed decisions rather than
  being asserted. The `assistant.usage`/`session.usage_info` events are `ephemeral:true`
  (not persisted to the event log) — Caco must capture them live if it wants to retain
  them.
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
  memory). The active-seconds clock is process-lifetime + persisted increment.
- **featureFlags lead (out of scope).** `SessionUpdateOptionsParams.featureFlags` might
  enable the SDK's native tool-search; a probe could make Phase C unnecessary, but this
  spec does not depend on it.

## Risks and Mitigations

- Agent never re-enables a needed tool → always-on catalog + a system-prompt line pointing at `caco_docs section="tools"` / `caco_enable_tools`; measure reveal-rate on a benchmark.
- Reveal thrashing (N busts) → **not** gated (never block agent work); bounded by design instead: monotonic-within-warm + batching nudge + over-reveal cap it at ≤1 bust per family per session, and the `assistant.usage` stream *measures* any residual churn to tune defer-aggressiveness at the next cold boundary.
- Cache-bust overstated/understated → measured directly via `assistant.usage` (`cacheWriteTokens` spike on a reveal turn vs `cacheReadTokens`-dominated steady turns); ship Phase B behind the applet so the cost is observable before trusting it.
- Auto-defer removes a tool a cold session immediately needs → it's re-enableable in one call; only defer below a conservative threshold; never on warm sessions.
- MCP names not excludable → Phase A/B verification gate before Phase C automation.

## Acceptance

- Observable (A): mcp-servers applet shows a `Caco` server (built-in Caco tools) and marks disabled tools greyed + `(disabled)`, distinct from `unobserved`.
- Observable (B): `caco_docs section="tools"` lists all tools (name+desc); `caco_enable_tools({names})` makes a previously-disabled tool appear enabled in the applet and callable next turn, with no resume; an invalid-name call is rejected and the applet state is unchanged.
- Observable (C): after a tool goes unused past the active-time threshold, a **cold** resume shows it `(disabled)`; a warm session is never auto-changed.
- Budgets: a single `caco_enable_tools` call (any number of names) costs ≤1 cache-bust turn; steady turns after show the excluded schemas absent from the request. **Multi-family / multi-turn reveals are explicitly allowed, not prevented** — an agent that reveals different families across several turns pays one bust per such turn; this is accepted (never block agent work) and instead *measured* via `assistant.usage` and fed back to tune defer-aggressiveness at the next cold boundary.
- Gates: typecheck ×2, lint:strict, knip, full tests, build:client.
- Oracles:
  - Pure catalog builder (all tools, name+desc+state, grouped) → unit test.
  - `caco_enable_tools` validation → unit test: unknown / already-enabled / hard-disabled names reject atomically (no exclusion mutation); a **valid** enable is never rejected (never-block); state changes only on `options.update` success (throw/`{success:false}` leaves it unchanged); a valid batch produces the expected new `excludedTools`; two valid enables in one turn both apply (monotonic, no rejection).
  - Tool state in the payload → extend `mcp-server-payload.test.ts` (excluded ⇒ deferred; `DEFAULT_DISABLED` ⇒ hard-disabled; else enabled).
  - Phase C → pure `computeColdResumeExclusions` unit test: `isCold:false` ⇒ `[]` (warm never mutated); `isCold:true` ⇒ stale tools excluded, recently-used kept.
  - **B0 telemetry (measurement, not gate):** a before/after showing an excluded MCP tool's tokens absent from `toolDefinitionsTokens`/`mcpToolsTokens` (read via `session.rpc.metadata.contextInfo()` → `SessionContextInfo`); a reveal turn shows a `cacheWriteTokens` spike in `assistant.usage`. Recorded as evidence; Phase B proceeds regardless (the SDK's accounting already documents the drop for deferred tools; B0 confirms it for the `excludedTools` path).
  - By-construction/visual: applet render, `options.update` wiring, the cache-bust magnitude (measured, not asserted).

## Plan

| # | Step | Files | Oracle |
|---|------|-------|--------|
| A1 | Add `Caco` pseudo-server (Caco `defineTool` tools: name+desc) to `/api/mcp/servers` | `src/routes/workspace-api.ts`, `src/session-manager.ts` (list Caco tools) | payload test: Caco server present |
| A2 | Compute per-tool state: enabled / deferred / hard-disabled | `src/routes/workspace-api.ts` | `mcp-server-payload.test.ts` (excluded ⇒ deferred; DEFAULT_DISABLED ⇒ hard-disabled) |
| A3 | Applet: grey + `(disabled)` for deferred, `(off)` for hard-disabled, distinct from unobserved | `applets/mcp-servers/{script.js,style.css}` | visual |
| B0 | **Telemetry harness** (not a gate): subscribe to `assistant.usage`/`session.usage_info`, read `metadata.contextInfo` (for `mcpToolsTokens`), poll `usage.getMetrics`; record excluded-MCP-tool token drop + reveal cache-bust spike | new usage-telemetry seam in `src/session-manager.ts` | before/after `toolDefinitionsTokens`/`mcpToolsTokens` drop (via `contextInfo`) + `cacheWriteTokens` spike (evidence, non-blocking) |
| B1 | `caco_docs section="tools"` full catalog (name+desc+state, grouped) | `src/dev-docs-tool.ts` | pure catalog-builder unit test |
| B2 | `caco_enable_tools({names})`: atomic validate → success-gated live `options.update`; **never blocks** a valid enable; monotonic within warm session | new `src/tool-reveal-tool.ts`, `src/session-manager.ts` (setExcludedTools live) | validation unit test (reject atomic incl. hard-disabled; valid enable never rejected; two-in-turn both apply; state only on success) |
| B3 | System-prompt line: deferred tools exist; discover via `caco_docs`, enable via `caco_enable_tools` (batch, cache warning) | `src/prompts.ts`, tool description | by-construction |
| C1 | Active-seconds clock + per-tool `lastUsedActiveSeconds` (persisted, system-wide) | new `src/tool-usage-store.ts` | store unit test |
| C2 | `computeColdResumeExclusions` (cold-only) wired into resume path | `src/session-manager.ts` (resume), tool-usage-store | pure test: warm ⇒ `[]`; cold ⇒ stale tools; recently-used kept |

## Rationale

Phases A/B deliver a usable manual mechanism + full observability with modest risk;
Phase C automates deferral only where it is provably free (cold resume). The applet
(Phase A) is deliberately first so every later change is inspectable. The
`excludedTools`/`options.update` mechanism is the only client-controllable path while
the SDK's native `defer`/tool-search stays runtime-gated (see `spec-budget.md` future
levers; re-evaluate on SDK bumps and the `featureFlags` lead).
