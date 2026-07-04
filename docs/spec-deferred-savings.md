# spec-deferred-savings

Status: draft (feature). Branch: `feature/tool-reveal-r0-r1`. Depends on: Phases
C1/C2/D1 (usage store, cold-resume auto-defer, manual defer) — all landed.

## Goals

Make deferral's payoff visible and priceable. Today a deferred tool shows only
"never used · deferred" with no cost, and the meta-context footer credits only
workflow + output-shaping savings — deferral contributes nothing. After this:

- A deferred tool in the mcp-servers applet reads e.g. **`deferred · ~200 tokens`**
  (its last-known per-turn definition size), not a bare "deferred".
- The context footer's savings headline **claims deferred-tool savings** as a
  cumulative cache-class saving, with an honest lower-bound caveat ("≥ X tok; M
  deferred tools of unknown size").

The enabling fact: a tool's definition size is knowable only when its schema was
**observed** (sent to the model). A deferred tool's schema is not sent, and a
never-used tool was never observed — so sizes must be **captured while a tool is
enabled** and **persisted system-wide**, then reused when the tool is deferred.

## Design

**Size source.** `estimateToolTokens` already computes a tool's per-turn cost from
its full serialized JSON definition (name + description + input_schema) ÷ 4. It
lives in `routes/workspace-api.ts`. Extract it verbatim to a leaf module so the
capture path and the payload share ONE definition (no second estimator).

**Size store (new, `src/tool-size-store.ts`).** Persisted system-wide
`Map<ToolKey, number>` = last-observed per-turn token size, at
`~/.caco/tool-size.json`. Mirrors `tool-key-registry` / `tool-usage-store`
mechanics: lazy load, best-effort persist (log-not-throw; it feeds a hot-ish
path), test resets. API: `recordToolSize(key, tokens)` (write on change),
`getToolSize(key)`, `getToolSizes()` (the map), `_resetToolSizeStoreForTest`.

**Capture seam.** Sizes are learned exactly where MCP keys are already learned:
wherever a `getCurrentToolMetadata()` snapshot is consumed. Add
`recordObservedSizes(metadata)` beside the existing `learnFromMetadata(observed)`
calls (the `/servers` route and `SessionManager.getToolCatalog`). For each entry
with an `input_schema`, compute `estimateToolTokens` and `recordToolSize`. Only
ENABLED tools appear in the metadata (deferred ones are absent), so a size is
only ever learned from a real observation — never fabricated. Because the store
is persistent and system-wide, one observation in any session prices that tool
forever (self-healing, like the key registry).

**Applet reuse.** `buildMcpServerPayload` already computes `tokenCost` from
live-observed schema for enabled tools. Add `knownTokenCost: number | null` =
the size-store value for the tool's key (independent of current observation), so
a DEFERRED tool (no live schema) still carries its last-known size. `stateBadge`
renders `deferred · ~N tokens` when `knownTokenCost != null`, else plain
`deferred` (size not yet learned). Applies to the green deferred state only;
active tools keep their live `tokenCost`.

**Footer claim (the design-heavy slice).** Deferred tool definitions are absent
from the cacheable prompt prefix every turn, so each turn saves ≈ Σ(size of
currently-deferred DYNAMIC tools) cache-class tokens. This is a **counterfactual**
saving (what it WOULD have cost), exactly like the existing workflow/shaping
figures — the measured throughput already reflects the smaller prefix, so this is
additive claiming, not double-spend. Model:

- Per assistant turn (the `assistant.usage` seam that already fires
  `caco.throughput`), accumulate `deferredToolTokensSaved += Σ known deferred
  size` (cache class) and store the latest `deferredToolsUnknownCount` = deferred
  dynamic tools with no cached size.
- "Deferred dynamic tools" = the session's live `excludedTools` MINUS the policy
  set (`excludedBuiltinNames()`) — i.e. only C2/D1 defers, never policy-disabled
  builtins (which were never a cost the user could have avoided; they are always
  off). This reuses the exact policy/dynamic split from the 4-state classifier.
- Surface `deferredToolTokensSaved` as a new cache-class term in `SavedTokens`
  (`saved-pricing.ts`) folded into `computeNetCreditsSaved`, and add a footer
  tooltip line: `deferred tools (accum est): N tok saved [· M unknown]`.

The per-turn sum needs the session's live excluded set; to avoid a
dispatch-events→session-manager import cycle, inject it via the existing
dispatch `deps` object (`deps.deferredToolSavings(sessionId) -> {knownTokens,
unknownCount}`), implemented in the wiring layer that already owns both stores.

## Invariants

- **One token-estimate definition.** After extraction, `estimateToolTokens` has a
  single home; the payload and the capture path both import it. No re-derivation.
- **Sizes are observed, never fabricated.** A key gets a size only from a real
  `getCurrentToolMetadata` entry carrying a schema. A tool with no observation has
  `knownTokenCost: null` and is counted as "unknown", never priced as 0-or-guess.
- **Policy vs dynamic split is reused, not re-implemented.** The footer's
  "deferred dynamic tools" set = live `excludedTools` − `excludedBuiltinNames()`,
  matching `classifyTool`'s policy/dynamic rule. Policy-disabled tools contribute
  ZERO claimed savings.
- **Counterfactual, not double-count.** Claimed deferred savings are additive to
  the footer's existing counterfactual savings; they never reduce or reinterpret
  measured spend.
- **Persistence is best-effort.** A failed size-store write logs and continues; a
  lost size only makes a tool show "unknown" until re-observed. Never throws into
  a request/turn path.

## Considerations

- **Cold-resume unknowns dominate first.** After a cold auto-defer, most deferred
  tools are never-used → no cached size → the footer claim is a small lower bound
  with a large unknown count. That is the honest state; it self-heals as tools are
  observed while enabled in any session. The footer copy must say "≥" / "unknown",
  never imply completeness.
- **Turn definition.** Accumulate once per `assistant.usage` (the same event that
  advances `totalTurns`), so deferred savings and turn count stay consistent; no
  accumulation on tool-call sub-iterations.
- **Schema drift.** A server updating a tool changes its size; re-observation
  overwrites the cached value. Last-observed wins; no versioning needed.
- **Size ≈ cache-class.** Most turns are warm (prefix cache-read), so tool defs
  are cache-class; a cold turn would make them input-class. v1 claims them wholly
  as cache-class (the common case, and the cheaper rate — conservative for the
  credit headline).

## Risks and Mitigations

- **Over-claiming** (pricing tools that would not actually have been present) →
  restrict the claimed set to the session's ACTUAL live dynamic exclusions, and
  price only keys with a real observed size; surface the unknown count so the
  number is legibly a lower bound.
- **Import cycle** (dispatch-events ↔ session-manager) → inject the per-turn sum
  through the dispatch `deps` object, matching the existing `cacoToolNames` seam.
- **Double-count across turns** → accumulate strictly once per `assistant.usage`;
  seam test asserts N turns ⇒ N× the per-turn sum.
- **Stale/huge size from a one-off schema** → last-observed-wins overwrite; the
  estimate is already a ÷4 approximation surfaced as "≈/est", not billed.

## Acceptance

- Observable (needs signoff): a deferred github tool shows `deferred · ~N tokens`
  in the applet; the footer savings tooltip gains a "deferred tools (accum est): N
  tok saved · M unknown" line and the headline credit rises accordingly.
- Budgets: n/a (telemetry only; no request-path latency beyond one map lookup per
  observed tool + one sum per turn).
- Gates: `npm run typecheck`, `npm run lint:strict`, `npx knip`, `npx vitest run`,
  `npm run build:client`, `node tools/check-spec-conformance.mjs` — all green.
- Oracles: see Plan (store round-trip; estimator parity after extraction;
  payload knownTokenCost for a deferred key; per-turn accumulation seam).

## Plan

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| S1 | Extract `estimateToolTokens` verbatim to a leaf module; re-export/import at the old call site | new `src/tool-size.ts` (or add to `tool-catalog.ts`), `src/routes/workspace-api.ts` | existing `estimateToolTokens` tests still green (moved import); ref-impl parity unchanged | one token-estimate definition |
| S2 | `tool-size-store.ts`: persisted `Map<ToolKey,number>` + `recordToolSize`/`getToolSize`/`getToolSizes`/reset | new `src/tool-size-store.ts` | store unit: write→read; overwrite (last wins); persist-fail logs-not-throws; reload | best-effort persistence |
| S3 | Capture sizes beside key-learning: `recordObservedSizes(metadata)` at both `learnFromMetadata` call sites | `src/routes/workspace-api.ts`, `src/session-manager.ts` (`getToolCatalog`) | unit: a metadata entry with schema records `estimateToolTokens`; no-schema entry records nothing | sizes observed, never fabricated |
| S4 | Payload `knownTokenCost` from size store for every tool (esp. deferred) | `src/routes/workspace-api.ts` (`buildMcpServerPayload` + `/servers` wiring) | payload test: a deferred key with a cached size ⇒ `knownTokenCost=N`; unobserved uncached ⇒ null | sizes observed, never fabricated |
| S5 | Applet: `stateBadge` shows `deferred · ~N tokens` when `knownTokenCost!=null` | `applets/mcp-servers/script.js` | visual signoff | - |
| S6 | Per-turn accumulation: `deferredToolTokensSaved` (cache class) + `deferredToolsUnknownCount` in throughput; increment on `assistant.usage` via `deps.deferredToolSavings` | `src/session-throughput.ts`, `src/dispatch-events.ts`, wiring (deps), `src/session-manager.ts` (`deferredToolSavings` helper) | **seam test**: dispatch N `assistant.usage` with a known-size deferred set ⇒ accumulator = N×Σ; policy-disabled builtin contributes 0; unknown tool bumps unknownCount not tokens | policy/dynamic split reused; counterfactual not double-count; accumulate once per turn |
| S7 | Footer: fold `deferredToolTokensSaved` into `SavedTokens`/`computeNetCreditsSaved` (cache class) + tooltip line with unknown count | `public/ts/saved-pricing.ts`, `public/ts/context-footer.ts` (`ThroughputData`, `priceSaved`, `renderSaved`) | pricing unit: cache-class term raises net credits by `tokens×cache/1e6`; footer line renders "≥/unknown" copy | counterfactual not double-count |

## Rationale (skippable)

The size store is deliberately a third sibling to `tool-key-registry` and
`tool-usage-store` rather than a field bolted onto either: each answers one
question about a ToolKey (identity / recency / size), and keeping them separate
keeps each store single-purpose and independently testable. The footer claim is
sequenced last (S6/S7) because it carries the only real design risk
(accumulation semantics, honesty); S1–S5 deliver the applet payoff with near-zero
risk and can ship even if the footer claim is deferred. An alternative to
cumulative accumulation — showing a standing "saving ~X tok/turn" rate — was
rejected because the footer's established idiom is cumulative credits, and the
user asked to "claim ... savings," i.e. a running total.
