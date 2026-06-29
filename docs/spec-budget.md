# spec-budget

Caco's "budget" system: cut the two costs that dominate agent latency/spend
(round trips and re-sent bytes) and make those costs + savings visible. This is
the document of record; it absorbs the former `tool-diet-spec`, `tool-diet-audit-spec`,
and `tool-diet-bench`. Open workstreams live in §Plan; their progress is transient.

## Goals

- **Save round trips.** Every tool call is one reasoning pass on the critical path
  whose result is re-sent (cached) every later turn. `caco_run_workflow` collapses
  decided, independent fan-out into one round trip — the biggest lever. Fewer
  registered tools and trimmed descriptions cut the per-turn schema tax too.
- **Show cost to the user.** The footer surfaces accumulated tokens, AI-credit
  cost, round trips, and an estimated savings figure with a transparent
  breakdown — never a single inflated number.
- **Stay honest.** Savings are estimates, labelled as such; the net headline only
  counts savings that survive even if the calls had run in parallel.

## Design

Three subsystems, all in-memory per session (nothing persisted across restart).

**1. Workflow savings (round-trip lever).** A workflow run reports four signals:
`observedBytes` (facade output that would have entered context), `injectedBytes`
(the emitted result actually re-entered), `commandCount` (facade calls), and
`codeBytes` (script the model wrote). Pure math in `savings-model.ts` turns these
into a breakdown; session math + pricing live in `session-throughput.ts`. Four
billing classes: fresh-input (one-time output kept out of context), cache-compound
(those absent tokens save cache re-read on every later turn, deferred one turn to
avoid double counting), cache-replay (window each avoided round trip would have
re-sent), and signed output-delta (script tokens minus avoided tool-arg tokens).
As built, `priceSaved` sums fresh+shaping at input rate, replay+compound at cache
rate, minus output-delta at output rate — i.e. the footer net figure currently
includes replay. (The "if sequential / exclude replay" split is the deeper goal
in `workflow-savings-model-spec`, not yet in the footer.) Mechanism: rough
`BYTES_PER_TOKEN = 4`, not a real tokenizer — chosen for zero-dep estimation.

**2. Output shaping (byte lever).** Large bash/test/build output is trimmed to a
failure-focused summary; exact bytes saved ÷ 4 accrue as `shapingSavedTokens`.
Unlike workflow savings this is an exact measurement.

**3. Tool-schema diet (per-turn tax).** Each registered tool's name + description
+ JSON-schema is re-sent every turn. `scripts/measure-tools.mts` sums those
bytes; consolidation/trimming reduce them. Hard rule: a merge ships only if the
merged schema measures net-negative vs the tools it replaces.

Cost/savings render in the footer (`context-footer.ts`): `estimateCost` prices
session in/cache/out at model rates; `priceSaved` prices net credits by class;
glyph `↯` = net credits saved (negative shows `↯−Ncr`), tooltip = the full
arithmetic. `⟲N` = round trips. Rates unknown (Auto) → tokens shown, no credit figure.

## Invariants

- `freshInputTokensSaved` is billed once: it enters a pending bucket and only
  compounds from the **second** later round trip. Never both fresh and cache same turn.
- A consolidation ships only if `measure-tools.mts` shows net-negative bytes.
- Request-scoped counters reset on a fresh send; session-lifetime totals + savings never reset mid-session.

## Considerations

- Reset timing: `resetRequest` (fresh dispatch, not steering) clears request
  in/cache/out, turns, 429s, round-trips-saved, `lastInputTokens`,
  `pendingAvoidedContext`. Steering (`sendStream`) preserves them. Savings/totals
  are session-lifetime, lost only on restart.
- `W` (window proxy) = prior round trip's prompt tokens; 0 until `requestTurns>0`
  so a fresh send never prices replay on a stale window.
- Workflow only wins for decided, independent fan-out; exploratory "read A then
  decide B" needs the round trip — never route that away.
- `caco.sh` bytes overlap shaping's baseline; crediting all as fresh slightly
  double-counts — documented, not yet discounted.
- Descriptions are guidance not contract: over-trimming misfires. Cut prose, keep
  the one sentence that says *when* to use a tool, and all enums/types.

## Prompt considerations (drive workflow use)

Only three surfaces are Caco-controlled; the repeat offenders (`view`/`edit`,
SDK builtins) aren't annotatable. Levers: top "Work Economy" block (primacy), the
`caco_run_workflow` description re-attended every turn (redirects repeat-`view`
into one fan-out), end "Remember" recap (recency). See `economy-prompt-spec.md`.
This is **not portably measurable** — phrasing effects vary per model — so it's
tuned, not gated; the savings model is the only objective read.

## Risks and Mitigations

- Oversell → breakdown tooltip + headline excludes replay; cache-class dominant term billed ~10× cheaper.
- Over-trim a description → re-read cold; keep when-to-use sentence; D1 failure rate guards.
- Estimate drift → `measure-tools` validated once vs SDK request log, then trusted as a regression delta.

## Acceptance

- Observable: footer `↯` shows net credits + breakdown; negative shows `↯−Ncr`; tooltip math reconciles.
- Budgets: post-diet ≤30 tools, ≤19 KB schema; no per-task turn/failure regression on B1–B5.
- Gates: typecheck ×2, lint:strict, knip, full tests, build:client.
- Oracles: `workflow-savings-model.test.ts` pins the pure 4-class math + deferral; footer pricing/replay-exclusion are NOT yet test-covered (by-construction). `measure-tools.mts` runs the byte delta (23 tools / ~21.6 KB registered). `bench-report.mjs` averages all rows; same-task before/after is manual (snapshot the log between runs).

## Plan

| # | Step | Files | Oracle | Status |
|---|------|-------|--------|--------|
| 1 | Per-request metrics + bench harness | `request-metrics-log.ts`, `bench-report.mjs`, `tool-diet-bench` prompts | same-task turns/bytes pre/post | done |
| 2 | Savings model (4 classes, net headline) | `savings-model.ts`, `session-throughput.ts`, footer | `workflow-savings-model.test.ts` | done |
| 3 | A5 trim descriptions/schemas, merge memory, fold applet-howto | tool factories | `measure-tools.mts` net-negative | done |
| 4 | Per-tool call telemetry; cut genuinely unused | metrics log | usage data not intuition | pending |
| 5 | offer_action → inline markup | `offer-action-inline-spec` | parity + reliability | see spec |
| 6 | Graph reads via `index` | `ast-index-tool-spec` | edges not bodies | pending |
| 7 | C1 facade routing (gate D1); L1/L2 lazy register | resume-time | net byte drop | pending |

## Benchmark prompts (fixed — do not edit casually)

Run before/after each diet change; same task across runs is the oracle. Each
completed request appends a row to `~/.caco/metrics/requests.jsonl`; report via
`scripts/bench-report.mjs`.

| ID | Prompt | Exercises |
|---|---|---|
| B1-fanout-search | "Which source files under `src/` import from `./session-throughput.js`? List the paths only." | independent fan-out reads |
| B2-count-aggregate | "Count `defineTool(` calls per file under `src/`, report the total." | read + aggregate |
| B3-single-read | "Show me the `recordUsage` function in `src/session-throughput.ts`." | single read (must not regress) |
| B4-multi-edit | "Rename local `entry` to `t` in `recordRateLimit` only, `src/session-throughput.ts`." | precise single edit |
| B5-explore | "Explain how a request's wall-clock time is measured end to end." | exploratory round trips |

## Rationale

History: V1 trimmed/removed tools and proved savings; V2 deepened the model from
one-time output to four billing classes. Portability work (cross-platform
`caco.sh`, vendored `rg`, POSIX paths) is done. Detail specs: `economy-prompt-spec`,
`workflow-savings-model-spec`, `offer-action-inline-spec`, `ast-index-tool-spec`.
