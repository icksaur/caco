# Model Routing — Survey

Investigation into routing prompts to cheaper models automatically. Seeded by
Warp's Agent CLI ("auto-routing based on task complexity", custom YAML routers).
Four parallel research streams; detail files listed at the bottom.

Prices below are **live from this instance** (`GET /api/models`, 2026-08-04), in
credits per MTok. The cheap model the user had in mind is `gpt-5.6-luna`.

## Verdict

**Route. The premise that stopped this idea is wrong.**

The concern was: "switching models busts the cache." That is true — every switch
is a cold prefix, confirmed across all three providers (cache is keyed per exact
model; no cross-model reuse exists anywhere). **But it does not matter, because
the price spread between models is larger than the cache discount.**

The cache discount is uniformly **10×** across this catalog (every model's cache
rate is exactly its input rate ÷ 10). The spread between the cheapest and dearest
model is **25×**. So:

> **The 10× rule:** routing a turn from model F to model C is profitable on prefix
> ingestion *even with a total cache miss* iff `C_input < F_input / 10` — i.e. iff
> C is more than 10× cheaper than F.

`gpt-5.6-luna` costs **20**/MTok cold. `claude-opus-5` costs **50**/MTok *warm*.
The cheap model reading the entire conversation from scratch is **2.5× cheaper
than the frontier model reading it from cache.** Cache-busting is free here; it is
paid for many times over by the rate difference.

## The economics, with real numbers

Against `claude-opus-5` (input 500 / cache 50 / output 2500):

| Candidate | cold input vs Opus warm cache | Beats warm prefix outright? | Otherwise needs output ≥ |
|---|---|---|---|
| `gpt-5.6-luna` | 20 vs 50 | **yes — wins at any context size** | — |
| `gpt-5-mini` | 25 vs 50 | **yes — wins at any context size** | — |
| `gpt-5.4-mini` | 75 vs 50 | no | 1.22% of context |
| `claude-haiku-4.5` | 100 vs 50 | no | 2.50% of context |
| `gemini-3.6-flash` | 150 vs 50 | no | 5.71% of context |
| `claude-sonnet-5` | 200 vs 50 | no | 10.0% of context |

The general condition for a cheap turn to beat staying on the warm frontier:

```
P·(C_in − F_cache)  <  O·(F_out − C_out)
```

where P = context tokens, O = output tokens. When `C_in < F_cache` the left side
is negative and the cheap model wins unconditionally. Otherwise it wins once the
answer is long enough — note even Haiku clears its bar at 2.5% of context, which
a substantive answer usually does.

One question routed to Luna instead of Opus-5:

| Scenario | Luna (cold) | Opus-5 (warm) | Saved |
|---|---|---|---|
| 20k context, 1k answer | 0.52 | 3.50 | 2.98 (85%) |
| 100k context, 1k answer | 2.12 | 7.50 | 5.38 (72%) |
| 100k context, 4k answer | 2.48 | 15.00 | 12.52 (83%) |
| 400k context, 2k answer | 8.24 | 25.00 | 16.76 (67%) |

This matches the user's intuition that a Luna one-shot tops out around 5 credits.

### The real risk is time, not switching

Returning to the frontier model costs **45 credits at 100k context** if its cache
has gone cold — which would erase eight Luna detours. But two things defuse it:

1. **Prefix caching is incremental.** After the detour the conversation is
   `[system + history + lunaQ + lunaA]`. The frontier model's existing cache still
   covers `[system + history]`; only the small delta is fresh. Switching back is
   cheap.
2. **Cache expiry is wall-clock, not switch-triggered** (Anthropic 5 min default).
   A cheap answer takes seconds. The detour does not age the frontier cache
   meaningfully, and any expiry that does occur would have happened anyway.

So the rule is *don't ping-pong across long idle gaps*, not *don't switch*.

**Unverified and worth measuring:** whether Caco's own `setModel` path perturbs
the prompt (model name in the system message, per-model tool arrays) in a way that
busts the *return* prefix. That is a local, cheap experiment — see Open Questions.

## What the literature says

- **Routing (decide up front) is mature; cascading (run cheap, then maybe strong)
  is not.** RouteLLM reports 35–85% cost cuts at 95% quality, and critically its
  routers **transfer to a new (strong, weak) model pair without retraining** —
  which answers our "the catalog changes every few weeks" objection. All its
  benchmarks are chat/QA/math, **none are agentic coding**.
- **Escalation from a partial agent trajectory is unstudied.** Every quantified
  cascade result (FrugalGPT ≤98%, AutoMix +89%) is single-turn QA. The cascade
  cost identity is `c_cheap + c_strong` on every deferral — in an agent loop the
  wasted cheap work is not one call but N turns of tool use. **Any agentic
  escalation claim would be Caco-original and unbacked.**
- **Failure detection is the blocker.** Self-reported confidence is poorly
  calibrated, and the Copilot SDK exposes **no logprobs** (verified: zero matches
  in the repo), killing token-uncertainty deferral outright.
- **The safest case is exactly the one the user named:** answering from material
  already in context. Extraction/comprehension is where small models are closest
  to frontier. The caveat is RULER — they collapse on *multi-hop* and aggregation
  over long context. Gate on task type and context length, not just "is it a
  question."

## What products actually do

Nobody routes per-message mid-conversation in an agent harness. The granularity
is **per-conversation-start**, **per-mode**, or **per-subagent**:

- **Warp** locks the model at conversation start; its custom routers live in
  `~/.warp/custom_model_routers/` (`type: complexity` or `type: prompt`,
  natural-language rules, first-match-wins).
- **GitHub Copilot** — most relevant to us — states it routes *only along cache
  boundaries*, and that switching mid-session "has shown increased cost without
  ample improvements in quality."
- **Aider** splits architect (strong, plans) from editor (cheap, applies).
  **Cline/Roo** split Plan vs Act. **Claude Code** delegates to subagents.
- **Nobody ships automatic difficulty-triggered mid-task escalation.**
- Negative evidence: Cline #12172 — cache settings leaking across a Plan→Act model
  switch cause hard API errors. Model switching is a real source of bugs.

Note the divergence: Copilot's "switching mid-session costs more" claim is about
*its own* routing on a premium-request plan. Our numbers say the opposite for
*this* instance, because we are on token pricing with a 25× spread. Both can be
true; the billing regime decides.

## Billing regime — resolved

There are two Copilot regimes and they give opposite answers:

- **Premium-request** — billed per user-initiated request × per-model multiplier,
  cache-agnostic. Token economics would be irrelevant.
- **Token-based (AI credits)** — per-MTok input/cache-read/cache-write/output.

**This instance is effectively on token pricing:** all 21 models report
`multiplier: 1` (no differentiation), while per-MTok prices differ 25×. So the
arithmetic above is the one that governs. Caco's own `requestCredits` is pure
token math and applies **no multiplier and no cache-write premium** — correct for
this regime, but it would silently misreport under the other one.

## Cost attribution — what is missing today

`UsageRecord` is keyed by `sessionId` alone. There is **no parent/child/root
linkage anywhere** in the record or the durable store, so "what did this task cost
including its delegates?" is currently unanswerable.

- The inline `task` tool is **already correct** — it runs inside the parent's
  dispatch loop, so its usage accrues to the parent record. No work needed.
- `create_caco_session`, `caco_session_delegate`, and herd children each run their
  own dispatch and emit their own records, unlinked. The parent *is* known at
  dispatch time (`fromSession` on the message route, plus `parentSessionId` /
  `orchestratedBy` / `herdOriginParent` in meta) but is dropped before the record
  is built.

Recommended shape (consistent with OpenTelemetry GenAI, Langfuse, and profiler
self-vs-cumulative convention): attribute **by dispatch, not by session** — tag
each record with `originSessionId` + `dispatchId` at write time, resolve roots and
rollups **at query time**, and present **"self X · with delegates Y"** rather than
silently swapping the number. Attribution is not a clean tree — an acquired herd
child or a delegate peer does its own work too — which is exactly why per-dispatch
tagging beats per-session parenting. Carry an explicit `incomplete` flag so
unpriced (Auto) descendants never read as zero.

## Recommended direction for Caco

Ordered by value-to-risk, not by ambition:

1. **Route sub-agents, not conversations.** A sub-agent pays a cold prefix
   regardless of model, so choosing a cheap one is nearly free — the single
   highest-return change, and it needs no classifier. Much of Caco already accepts
   a model override; the gap is a sensible default per agent type.
2. **Add cost attribution before any routing.** Without it, routing cannot be
   evaluated — savings in the parent would be invisible spend in a child. This is
   a prerequisite, not a follow-up.
3. **Offer explicit cheap-model routing for in-context questions**, gated on
   `C_input < F_cache` (currently Luna and gpt-5-mini) and on context length.
   Start user-invoked, not automatic.
4. **Only then consider a classifier**, and prefer an embedding/semantic router
   over a trained one — no training data, instant re-tune when the catalog churns.
5. **Do not build mid-task escalation yet.** No external evidence, no confidence
   signal available, and the cost identity is unforgiving.

Because this is single-user and self-hosted, always surface which model answered
and allow a one-click redo on the frontier model. That converts a silent quality
regression into a visible, reversible optimization — the cheapest possible
mitigation for the one risk that the economics cannot address.

## Open questions (each is a cheap local experiment)

- Does `setModel` perturb the prompt enough to bust the *return* prefix? Measure
  `cacheReadTokens` on the turn after a switch-back.
- Does a sub-agent or an internal dispatch incur a premium request? Probe
  `usage.getMetrics` before/after a sub-agent run.
- Real quality floor: build a small internal eval of Caco questions-over-context
  labeled "did Luna's answer hold up?" No external benchmark transfers here.

## Detail files

Full research with citations, in the session folder:

- `routing-landscape.md` — 10+ products, mechanics and config schemas, plus user-reported failure modes.
- `routing-techniques.md` — RouteLLM, FrugalGPT, AutoMix, cascade math, confidence signals, implementability ranking.
- `routing-cache-economics.md` — provider cache semantics, both billing regimes, break-even derivations.
- `routing-cost-attribution.md` — current Caco state by file and line, plus a spec-ready data model.
