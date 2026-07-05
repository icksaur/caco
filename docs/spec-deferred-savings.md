# spec-deferred-savings

Status: Slice A + Slice B implemented; Slice C (accrual) in progress. Branch: `feature/tool-reveal-r0-r1`.
Depends on: Phases C1/C2/D1 (usage store, cold-resume auto-defer, manual defer) — all landed.

## Goals

Make deferral's payoff visible and priceable. Today a deferred tool shows only
"never used · deferred" with no cost, and the meta-context footer credits only
workflow + output-shaping savings — deferral contributes nothing. After this:

- A deferred tool in the mcp-servers applet reads e.g. **`deferred · ~200 tokens`**
  (its known per-turn definition size), not a bare "deferred".
- The context footer surfaces an **estimate of the per-turn definition tokens
  currently omitted by deferral** — a gross, clearly-estimated figure, with an
  honest unknown-count caveat.
- **(Slice C)** Those omitted definition tokens **accrue once per model round
  trip** into a session-lifetime total and **contribute to the credit headline**
  (priced at the cache rate). Deferral is only worthwhile if its payoff compounds
  every turn; the footer must reflect that, not just show an instantaneous rate.

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
per-turn, clearly-estimated line in the footer tooltip**. Concretely: `deferred
defs (est): ~X tok/turn omitted (N tools[, M unknown])`, where X = Σ known size of
the session's current dynamic exclusions. Pricing note: label it "priced at cache
rate" (tool defs sit in the cacheable prefix; most turns are warm); if credits are
shown, compute at the cache rate and mark "est". **Slice C (below) then accrues
this rate once per turn and folds the accrued credit value into the headline** —
the two honesty holes above are ACCEPTED as estimate-optimism (the headline is
already a sum of estimated classes), not solved.

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

**Slice C — accrued deferral credit (supersedes v1's "no accumulation").** v1
deliberately showed only the instantaneous per-turn rate to sidestep two honesty
holes. Slice C keeps the honesty caveats (below) but adds the missing accrual: the
per-turn omitted-definition estimate is **summed once per model round trip** and
its credit value is **folded into the net-credit headline** at the cache rate.

- **Accrual seam = the per-turn usage event.** `recordUsage` in
  `session-throughput.ts` fires exactly once per `assistant.usage` (one model round
  trip = one sent tool block). It reads the same `deferredDefsProvider` the snapshot
  uses and adds the current-turn `deferredDefsTokens` to a new session-lifetime
  accumulator `deferredDefsTokensAccrued`. This is a TURN accrual, not a request
  accrual — steering turns and subagent turns each omit the block and each accrue.
  Nothing is persisted across restart (matches every other `total*` counter).
- **Pricing = cache rate, folded into the headline.** Tool definitions sit in the
  cacheable prefix, so the accrued tokens price at the model's cache rate and are
  added to the cache class of `computeNetCreditsSaved` (the same class as
  window-replay + compounding). The credit headline therefore rises by
  `deferredDefsTokensAccrued × cacheRate / 1e6`. When rates are unknown (Auto), the
  accrued tokens add to the token-only glyph like every other class.
- **The gross per-turn line stays** (informational: "current rate"), and a new
  accrued line reports the lifetime total so the tooltip shows both rate and
  running sum.
- **Honesty caveats retained, not erased.** The two holes v1 cited still exist and
  are accepted, not solved: (1) "ever observed" ≠ "would be sent this turn" — the
  accrued figure is an OPTIMISTIC estimate of omitted-definition tokens, still
  labelled "est", never a proven lower bound; (2) the accrual does NOT net out the
  warm defer/reveal cache-write bust — a reveal turn still bills its bust through
  the normal in/cache/out counters, so on a reveal turn the headline can rise from
  accrual while the true cost was higher. This is the same optimism every other
  estimated class in the headline already carries; the copy says "est".

The rigorous measured version (tie to the SDK's `mcpToolsTokens`/
`toolDefinitionsTokens` delta and subtract measured cache-write busts) remains
future work; Slice C is the estimated-but-accrued figure the user asked for.

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
- **The footer figure is gross + estimated, not net + proven.** The per-turn line
  and the Slice-C accrued total are both "est. omitted definition tokens"; neither
  claims a proven lower bound. The accrued value contributes to the credit headline
  at the cache rate (Slice C) but does NOT net out the defer/reveal cache-bust —
  that cost is still billed through the normal in/cache/out counters. The estimate
  is optimistic by the same measure as every other estimated class in the headline.
- **Accrual is once per turn, never per request.** `deferredDefsTokensAccrued`
  increments exactly once per `recordUsage` (one model round trip). It is a
  session-lifetime `total*`-style counter, reset only by process restart, never by
  `resetRequest`.
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
  agent reveal cost a one-turn cache write. Slice C folds the accrued estimate into
  the headline at the cache rate but does NOT net out that bust — the reveal/defer
  turn still bills its cache-write through the normal in/cache/out counters, so the
  headline is optimistic on such a turn. Accepted as estimate-optimism (labelled
  "est"), same as every other estimated class in the headline.
- **Accrual reads the post-turn live set, not a send-time latch.** S8 accrues by
  calling the live `deferredDefsProvider` inside `recordUsage`, which runs at the
  `assistant.usage` event — after any mid-turn reveal/defer already mutated
  `excludedTools`. A tool revealed mid-turn (it WAS sent, busting cache) has already
  left the excluded set, so it is correctly NOT accrued that turn; a rare mid-turn
  manual defer is under-counted by one turn. This drift is bounded by one turn and
  absorbed by the estimate's optimism; no send-time latch is built (simplicity over
  a correctness a gross estimate does not warrant).
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
- **Inflated headline** (warm defer/reveal cache-bust ignored) → Slice C folds the
  accrued figure into `computeNetCreditsSaved` at the cache rate and ACCEPTS this
  optimism: the estimate is labelled "est", the reveal bust is still billed through
  the normal counters, and the headline is already a sum of estimated classes. The
  rigorous net-of-measured-bust headline (mcpToolsTokens delta) remains later work.
- **Garbage size from a one-off schema** → `recordToolSize` validates
  finite/positive and caps at a ceiling; last-valid-observed overwrites; surfaced
  as "≈/est", never billed.
- **Store growth** → bounded by the MCP key universe (one entry per learned key),
  mirroring the key registry; no eviction needed.

## Acceptance

- Observable (needs signoff): a deferred MCP tool shows `deferred · ~N tokens` in
  the applet (and a deferred Caco-allowlist tool shows its local size); the footer
  tooltip gains a gross per-turn line `deferred defs (est): ~X tok/turn omitted (N
  tools · M unknown)` AND a Slice-C accrued line reporting the lifetime sum. The
  credit headline INCLUDES the accrued deferral value (cache rate). With a nonzero
  cache rate, ≥1 known-size deferred definition, and ≥1 accrued turn, the ↯ glyph is
  non-zero (an all-unknown deferred set or a zero cache rate leaves it unchanged).
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
| S7 | Footer: surface the gross line `deferred defs (est): ~X tok/turn omitted (N · M unknown)` in the savings tooltip | `public/ts/context-footer.ts` (`ThroughputData` fields, `renderSaved`) | render unit: tooltip line shows X/N/M with "est" | footer figure gross+estimated |

**Slice C — accrue omitted defs per turn + fold into credit headline (this update).**

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| S8 | Add `deferredDefsTokensAccrued` session-lifetime counter; in `recordUsage` add the current-turn `deferredDefsProvider` tokens to it (once per turn); expose in `blank()`/snapshot | `src/session-throughput.ts` | unit: N `recordUsage` calls with provider=K accrue N×K; no provider ⇒ 0; a `resetRequest` does NOT clear it | accrual once per turn, never per request |
| S9 | Footer: add `deferredDefsTokensAccrued` to `ThroughputData`; price it at the cache rate inside `computeNetCreditsSaved` (new `deferredDefs` field on `SavedTokens`, cache class); add an accrued tooltip line; token-only glyph includes it when rates unknown | `public/ts/context-footer.ts`, `public/ts/saved-pricing.ts` | pricing unit: `deferredDefs` priced at cache rate; render unit: accrued line + headline rises by accrued×cacheRate | footer figure gross+estimated; accrual once per turn |

Out of scope (later spec): a measured net-of-cache-bust "credits saved by
deferral" tied to the SDK's `mcpToolsTokens`/`toolDefinitionsTokens` delta and net
of measured defer/reveal cache-write busts. Slice C accrues the ESTIMATE and
prices it optimistically; it does not measure the bust.

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

