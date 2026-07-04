# spec-deferred-savings

Status: draft (feature). Branch: `feature/tool-reveal-r0-r1`. Depends on: Phases
C1/C2/D1 (usage store, cold-resume auto-defer, manual defer) — all landed.

## Goals

Make deferral's payoff visible and priceable. Today a deferred tool shows only
"never used · deferred" with no cost, and the meta-context footer credits only
workflow + output-shaping savings — deferral contributes nothing. After this:

- A deferred tool in the mcp-servers applet reads e.g. **`deferred · ~200 tokens`**
  (its known per-turn definition size), not a bare "deferred".
- The context footer surfaces an **estimate of the per-turn definition tokens
  currently omitted by deferral** — a gross, clearly-estimated figure, distinct
  from the net-credit headline (see Footer claim for why it is NOT folded into net
  credits in v1), with an honest unknown-count caveat.

The enabling fact, **scoped to MCP tools**: an MCP tool's definition size is
knowable only when its schema was **observed** (resolved into a turn and sent to
the model) — its `input_schema` is assigned by the CLI and not locally available.
A deferred/never-used MCP tool has no local schema, so MCP sizes must be
**captured while the tool is enabled** and **persisted system-wide** for reuse
when deferred. Caco tools and SDK builtins are NOT subject to this: their schemas
are locally available (Caco via the `cacoCatalog` `parameters`; builtins via
`tools.list`), so their sizes are computed directly with no observed-size cache.
Since C2/D1 only ever dynamically defer MCP tools ∪ the Caco allowlist (never
builtins, which are policy-disabled), the observed-size cache is an MCP-only
concern; Caco-allowlist deferred tools price from the local catalog.

## Design

**Size source.** `estimateToolTokens` already computes a tool's per-turn cost from
its full serialized JSON definition (name + description + schema) ÷ 4. It lives in
`routes/workspace-api.ts`. Extract it verbatim to a leaf module so the capture
path and the payload share ONE definition (no second estimator). During
extraction the old site re-imports from the leaf (or the leaf re-exports through
it) so existing `estimateToolTokens` importers/tests are updated in the same step,
not left dangling.

**Size store (new, `src/tool-size-store.ts`) — MCP keys only.** Persisted system-wide
`Map<ToolKey, number>` = last-observed per-turn token size, at
`~/.caco/tool-size.json`. Mirrors `tool-key-registry` / `tool-usage-store`
mechanics: lazy load, best-effort persist (log-not-throw; it feeds a hot-ish
path), test resets. API: `recordToolSize(key, tokens)` (write on change),
`getToolSize(key)`, `getToolSizes()` (the map), `_resetToolSizeStoreForTest`.

**Capture seam.** MCP sizes are learned exactly where MCP keys are already learned:
wherever a `getCurrentToolMetadata()` snapshot is consumed. Add
`recordObservedSizes(metadata)` beside the existing `learnFromMetadata(observed)`
calls (the `/servers` route and `SessionManager.getToolCatalog`). Record ONLY MCP
entries (those carrying `mcpServerName`+`mcpToolName`), keyed by the SAME
model-facing `ToolKey` the registry learns (so the size store and the exclusion
set share a key space); non-MCP metadata is skipped (Caco/builtin sizes come from
the local catalog, not this store). For each such entry with an `input_schema`,
compute `estimateToolTokens` and `recordToolSize`. Only ENABLED tools appear in
the metadata (deferred ones are absent), so a size is only ever learned from a
real observation — never fabricated. Because the store is persistent and
system-wide, one observation in any session prices that tool forever
(self-healing, like the key registry).

**Store hygiene.** `recordToolSize` rejects non-finite / ≤0 / absurd values (cap
at a sane ceiling, e.g. 100k tokens) so a one-off garbage schema can't poison the
figure; last-valid-observed wins on change. Entries are bounded by the MCP tool
universe (one per learned MCP key), which is small and already mirrored by the key
registry — no eviction policy needed; if it ever matters, it can be pruned in
lockstep with the key registry.

**Applet reuse.** `buildMcpServerPayload` already computes `tokenCost` from
live-observed schema for enabled tools. Add `knownTokenCost: number | null`: for
MCP tools, the size-store value for the key (independent of current observation);
for Caco-allowlist tools, the estimate from the local `cacoCatalog` parameters. So
a DEFERRED tool (no live schema) still carries its known size. `stateBadge`
renders `deferred · ~N tokens` when `knownTokenCost != null`, else plain
`deferred` (size not yet learned). Applies to the green deferred state only;
active tools keep their live `tokenCost`.

**Footer figure (design-heavy; gated behind the applet slice).** Deferred tool
definitions are absent from the prompt each turn. The naive claim — Σ(known size
of live dynamic exclusions), accumulated as net credits saved — has TWO honesty
holes the v1 must avoid:

1. **"Ever observed" ≠ "would be sent this turn."** A persisted size proves the
   tool was once resolved into a turn, NOT that it would be in *this* turn's sent
   tool block (the CLI may itself tool-search / defer). So Σ known deferred size is
   an *estimate of omitted known-definition tokens*, NOT a proven lower bound on
   tokens saved. Copy must say "est. omitted", never "≥ saved".
2. **Net credits ignore the defer/reveal cache-bust.** A warm **manual** defer (D1)
   or an agent reveal busts the prompt cache that turn (a cache-WRITE cost); a cold
   auto-defer (C2) is free. Folding a positive savings term straight into the
   single net-credit headline could make it *rise* on a turn the action was net
   expensive.

v1 resolution (honest and still useful): present the figure as a **gross,
per-turn, clearly-estimated line in the footer tooltip — NOT folded into the
net-credit headline**. Concretely: `deferred defs (est): ~X tok/turn omitted
(N tools[, M unknown])`, where X = Σ known size of the session's current dynamic
exclusions. This is a *current-turn rate*, not a cumulative accumulator, so it
needs no per-turn accumulation seam and cannot double-count or misattribute
cache-bust costs. Pricing note: label it "priced at cache rate" (tool defs sit in
the cacheable prefix; most turns are warm) rather than asserting a token *class*;
if credits are shown, compute at the cache rate and mark "est".

Deferred to a later spec (explicitly out of v1 scope): a cumulative,
net-of-cache-bust "credits saved by deferral" headline. It requires (a) tying the
claim to a measured signal — the `SessionContextInfo.mcpToolsTokens` /
`toolDefinitionsTokens` delta, which is the SDK's ground-truth current
definition-token count — and (b) subtracting the measured cache-write busts caused
by defer/reveal. Both are real work with unresolved semantics; the gross per-turn
line delivers the user-visible payoff without them.

Because v1 shows a **current-turn** figure, the footer reads the session's live
dynamic-exclusion set + known sizes at snapshot time (the same
`SessionContextInfo`/throughput path the banner already uses); no
dispatch-events accumulation and no `deps` injection are required for v1. "Live
dynamic exclusions" = the session's `excludedTools` MINUS the policy set
(`excludedBuiltinNames()`) — only C2/D1 defers, never policy-disabled builtins —
reusing the exact policy/dynamic split from the 4-state classifier.

## Invariants

- **One token-estimate definition.** After extraction, `estimateToolTokens` has a
  single home; the payload and the capture path both import it. No re-derivation.
- **MCP sizes are observed, never fabricated.** An MCP key gets a size only from a
  real `getCurrentToolMetadata` entry carrying a schema. An MCP tool with no
  observation has `knownTokenCost: null` and is counted "unknown", never priced as
  0-or-guess. (Caco-allowlist sizes come from the local catalog and are always
  known; builtins are policy, never dynamically deferred, so never priced here.)
- **Size store is keyed by the model-facing `ToolKey`.** The size store and the
  exclusion set share one key space, so a deferred key looks up its size directly.
  Only MCP entries are recorded; bare/un-normalized names are never stored.
- **Policy vs dynamic split is reused, not re-implemented.** The footer's
  "deferred dynamic tools" set = live `excludedTools` − `excludedBuiltinNames()`,
  matching `classifyTool`'s policy/dynamic rule. Policy-disabled tools contribute
  ZERO to the figure.
- **The footer figure is gross + estimated, not net + proven.** v1 surfaces an
  "est. omitted definition tokens / turn" figure, kept OUT of the net-credit
  headline; it never claims a proven lower bound and never silently absorbs the
  defer/reveal cache-bust cost.
- **Persistence is best-effort.** A failed size-store write logs and continues; a
  lost size only makes a tool show "unknown" until re-observed. Never throws into
  a request/turn path.

## Considerations

- **Cold-resume unknowns dominate first.** After a cold auto-defer, most deferred
  MCP tools are never-observed → no cached size → the figure is small with a large
  unknown count. That is the honest state; it self-heals as tools are observed
  while enabled in any session. Copy says "est." / "unknown", never "complete".
- **"Ever observed" ≠ "would be sent this turn"** (the core over-claim risk): the
  figure is an estimate of *omitted known definitions*, not a measured saving.
  v1 keeps it gross and clearly-labeled to stay honest; the measured version
  (mcpToolsTokens delta) is deferred.
- **Cache-bust asymmetry.** Cold C2 auto-defer is free; warm D1 manual defer and
  agent reveal cost a one-turn cache write. v1 does not fold the figure into net
  credits, so it can't misrepresent a net-expensive warm action as a gain.
- **Schema drift.** A server updating a tool changes its size; re-observation
  overwrites the cached value. Last-valid-observed wins; no versioning needed.
- **Pricing label.** Tool defs sit in the cacheable prefix (warm turns → cache
  read), so a credit estimate is priced at the cache rate and marked "est",
  rather than asserting a token class per turn.

## Risks and Mitigations

- **Over-claiming** (pricing tools that would not actually have been sent) →
  present the figure as GROSS "est. omitted", not a net saving; restrict to the
  session's ACTUAL live dynamic exclusions with a known size; surface the unknown
  count. The rigorous measured version (mcpToolsTokens delta) is deferred, not
  faked.
- **Inflated net-credit headline** (warm defer/reveal cache-bust ignored) → do NOT
  fold the figure into `computeNetCreditsSaved` in v1; it is a separate tooltip
  line. The cumulative net headline is a later spec that must subtract measured
  cache-write busts.
- **Garbage size from a one-off schema** → `recordToolSize` validates
  finite/positive and caps at a ceiling; last-valid-observed overwrites; surfaced
  as "≈/est", never billed.
- **Store growth** → bounded by the MCP key universe (one entry per learned key),
  mirroring the key registry; no eviction needed.

## Acceptance

- Observable (needs signoff): a deferred MCP tool shows `deferred · ~N tokens` in
  the applet (and a deferred Caco-allowlist tool shows its local size); the footer
  tooltip gains a gross line like `deferred defs (est): ~X tok/turn omitted (N
  tools · M unknown)`. The net-credit headline is UNCHANGED by this figure.
- Budgets: n/a (telemetry only; one map lookup per observed tool + one sum at
  snapshot time).
- Gates: `npm run typecheck`, `npm run lint:strict`, `npx knip`, `npx vitest run`,
  `npm run build:client`, `node tools/check-spec-conformance.mjs` — all green.
- Oracles: see Plan (store round-trip; estimator parity after extraction;
  payload knownTokenCost for a deferred key; footer gross-figure computation).

## Plan

**Slice A — applet known-size (ship independently; low risk).**

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| S1 | Extract `estimateToolTokens` verbatim to a leaf module; update the old call site to import from the leaf (or re-export through it) so existing importers/tests move in-step | new `src/tool-size.ts`, `src/routes/workspace-api.ts` | existing `estimateToolTokens` tests green against the new import; ref-impl parity unchanged | one token-estimate definition |
| S2 | `tool-size-store.ts` (MCP keys): persisted `Map<ToolKey,number>` + `recordToolSize` (validate finite/>0/≤ceiling) / `getToolSize` / `getToolSizes` / reset | new `src/tool-size-store.ts` | store unit: write→read; last-valid-wins; reject non-finite/≤0/huge; persist-fail logs-not-throws; reload | best-effort persistence; store keyed by model-facing ToolKey |
| S3 | Capture MCP sizes beside key-learning: `recordObservedSizes(metadata)` at both `learnFromMetadata` sites; record ONLY entries with `mcpServerName`+`mcpToolName`+`input_schema`, keyed by the model-facing name | `src/routes/workspace-api.ts`, `src/session-manager.ts` (`getToolCatalog`) | unit: MCP entry w/ schema records `estimateToolTokens`; non-MCP or schema-less entry records nothing | MCP sizes observed, never fabricated |
| S4 | Payload `knownTokenCost`: MCP from size store; Caco-allowlist from local `cacoCatalog` params; builtins n/a | `src/routes/workspace-api.ts` (`buildMcpServerPayload` + `/servers` wiring) | payload test: deferred MCP key with cached size ⇒ `knownTokenCost=N`; deferred+uncached ⇒ null; deferred Caco-allowlist ⇒ local estimate | MCP sizes observed, never fabricated; policy tools contribute nothing |
| S5 | Applet: `stateBadge` shows `deferred · ~N tokens` when `knownTokenCost!=null`, else plain `deferred` | `applets/mcp-servers/script.js` | visual signoff | - |

**Slice B — footer gross figure (gated on Slice A + this design; medium risk).**

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| S6 | Compute the CURRENT-turn gross figure at snapshot time: `deferredDefsTokens` = Σ known size of the session's live dynamic exclusions (`excludedTools` − `excludedBuiltinNames()`), `deferredDefsCount`, `deferredDefsUnknown`. No accumulation, no dispatch seam | `src/session-manager.ts` (helper reading excluded set + size store + cacoCatalog), `src/routes/*` snapshot/telemetry path | unit: sum counts only dynamic-exclusion known sizes; a policy builtin contributes 0; an uncached MCP key bumps unknown, not tokens | policy/dynamic split reused; gross+estimated not net+proven |
| S7 | Footer: surface the gross line `deferred defs (est): ~X tok/turn omitted (N · M unknown)` in the savings tooltip; do NOT fold into `computeNetCreditsSaved` | `public/ts/context-footer.ts` (`ThroughputData` fields, `renderSaved`) | render unit: tooltip line shows X/N/M with "est"; net-credit headline unchanged by the figure | footer figure gross+estimated, not net+proven |

Out of v1 scope (later spec): a cumulative net-of-cache-bust "credits saved by
deferral" headline, tied to the measured `mcpToolsTokens`/`toolDefinitionsTokens`
delta and net of measured defer/reveal cache-write busts.

## Rationale (skippable)

The size store is deliberately a third sibling to `tool-key-registry` and
`tool-usage-store` rather than a field bolted onto either: each answers one
question about a ToolKey (identity / recency / size), and keeping them separate
keeps each store single-purpose and independently testable. It is MCP-only
because Caco and builtin schemas are locally available — no observation needed —
so caching them would duplicate a source of truth.

Slice A (S1–S5) delivers the applet payoff with near-zero risk and ships on its
own. Slice B is split out and reframed after review: the initial design
(accumulate Σ known deferred size as net credits saved) had two honesty holes —
a persisted size proves "ever observed", not "would be sent this turn" (so it is
an *estimate of omitted definitions*, not a proven saved lower bound), and
folding it into the net-credit headline would ignore the warm defer/reveal
cache-write bust (making a net-expensive manual defer look like a gain). v1
therefore shows a **gross, current-turn, clearly-estimated** figure kept OUT of
the net headline. The rigorous cumulative net claim — tying to the SDK's measured
`mcpToolsTokens` delta and subtracting measured cache-write busts — is deferred to
its own spec rather than shipped half-honest.

