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
uses it — with the enable's prompt-cache cost made explicit so it batches. Optionally,
unused tools auto-defer on cold session resume, where deferral is free (no warm cache
to bust). Net: fewer tokens/turn for sparsely-used tool sets, no capability lost.

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

**B0 — SDK probe first (hard gate).** Before building the reveal UI, verify the core
assumption with a before/after `getCurrentToolMetadata` (+ request/token evidence):
(a) `session.options.update({excludedTools})` mutates the live tool set with no resume;
(b) excluding an MCP tool by `namespacedName` actually **drops its schema from the
request** (the savings), not merely blocks calling it. If (b) fails, the feature saves
no tokens and Phase B stops here.

- **Catalog in `caco_docs`.** `caco_docs section="tools"` returns every tool as
  `camel_case_name` + one-line description (enabled + deferred + hard-disabled),
  grouped by Caco/builtin/server, with each tool's state. Heavy schemas stay out of
  the per-turn payload.
- **`caco_enable_tools({ names })`.** Removes named tools from the session exclusion set
  and applies it live via `session.options.update({ excludedTools,
  toolFilterPrecedence: "excluded" })`. Always-present. Contract:
  - **Atomic pre-validation:** every name must exist and be **deferred** (not
    hard-disabled, not already enabled). Any invalid name → whole call rejected, **no
    `options.update`** (a syntax mistake costs no cache-bust). Hard-disabled names are
    rejected with a message that they are not revealable.
  - **State mutates only on SDK success:** the session's active `excludedTools` (and the
    applet) update **only after** `options.update` resolves `{success:true}`. On throw
    or `{success:false}`, leave the exclusion set unchanged and return an error.
  - **Enforced batching (not just advisory):** a **second** successful enable within the
    same request/turn (tracked by dispatch correlation id) is **rejected** with a
    message to batch — so the agent physically cannot drip-feed reveals and pay N
    cache-busts. The description also warns that each enable busts the prompt-cache
    prefix for one turn. One valid batch ⇒ exactly one bust.
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
  always-on; default-exclude only the long tail. **Treat the bust as a modeled cost to
  measure, not asserted** — Caco can't confirm from types where the backend places the
  tool block or that Copilot honors prefix caching like Anthropic/OpenAI direct.
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
- Reveal thrashing (N busts) → atomic validation + batch-or-pay warning; consider rejecting a second enable within the same turn.
- Cache-bust overstated/understated → measured via the throughput model (a reveal turn should show a spike in fresh-input vs cached); ship Phase B behind the applet so the cost is observable before trusting it.
- Auto-defer removes a tool a cold session immediately needs → it's re-enableable in one call; only defer below a conservative threshold; never on warm sessions.
- MCP names not excludable → Phase A/B verification gate before Phase C automation.

## Acceptance

- Observable (A): mcp-servers applet shows a `Caco` server (built-in Caco tools) and marks disabled tools greyed + `(disabled)`, distinct from `unobserved`.
- Observable (B): `caco_docs section="tools"` lists all tools (name+desc); `caco_enable_tools({names})` makes a previously-disabled tool appear enabled in the applet and callable next turn, with no resume; an invalid-name call is rejected and the applet state is unchanged.
- Observable (C): after a tool goes unused past the active-time threshold, a **cold** resume shows it `(disabled)`; a warm session is never auto-changed.
- Budgets: a reveal costs ≤1 cache-bust turn (batched); steady turns after show the excluded schemas absent from the request.
- Gates: typecheck ×2, lint:strict, knip, full tests, build:client.
- Oracles:
  - Pure catalog builder (all tools, name+desc+state, grouped) → unit test.
  - `caco_enable_tools` validation → unit test: unknown / already-enabled / hard-disabled names reject atomically (no exclusion mutation); a second enable in the same turn is rejected; state changes only on `options.update` success (throw/`{success:false}` leaves it unchanged); a valid batch produces the expected new `excludedTools`.
  - Tool state in the payload → extend `mcp-server-payload.test.ts` (excluded ⇒ deferred; `DEFAULT_DISABLED` ⇒ hard-disabled; else enabled).
  - Phase C → pure `computeColdResumeExclusions` unit test: `isCold:false` ⇒ `[]` (warm never mutated); `isCold:true` ⇒ stale tools excluded, recently-used kept.
  - **B0 gate (blocking):** a measured before/after showing an excluded MCP tool's schema absent from the request (via `getCurrentMetadata` + token evidence) — Phase B does not proceed if this fails.
  - By-construction/visual: applet render, `options.update` wiring, the cache-bust magnitude (measured, not asserted).

## Plan

| # | Step | Files | Oracle |
|---|------|-------|--------|
| A1 | Add `Caco` pseudo-server (Caco `defineTool` tools: name+desc) to `/api/mcp/servers` | `src/routes/workspace-api.ts`, `src/session-manager.ts` (list Caco tools) | payload test: Caco server present |
| A2 | Compute per-tool state: enabled / deferred / hard-disabled | `src/routes/workspace-api.ts` | `mcp-server-payload.test.ts` (excluded ⇒ deferred; DEFAULT_DISABLED ⇒ hard-disabled) |
| A3 | Applet: grey + `(disabled)` for deferred, `(off)` for hard-disabled, distinct from unobserved | `applets/mcp-servers/{script.js,style.css}` | visual |
| B0 | **Hard gate:** probe that `options.update` mutates live + excluding an MCP tool by namespacedName drops its schema from the request | investigation via `getCurrentMetadata` + request/token evidence | before/after schema-drop measurement (blocks B if it fails) |
| B1 | `caco_docs section="tools"` full catalog (name+desc+state, grouped) | `src/dev-docs-tool.ts` | pure catalog-builder unit test |
| B2 | `caco_enable_tools({names})`: atomic validate → success-gated live `options.update`; reject 2nd enable/turn | new `src/tool-reveal-tool.ts`, `src/session-manager.ts` (setExcludedTools live) | validation unit test (reject atomic incl. hard-disabled + repeat-in-turn; state only on success) |
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
