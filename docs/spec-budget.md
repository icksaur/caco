# spec-budget

Caco's "budget" system: cut the two costs that dominate agent latency/spend
(round trips and re-sent bytes) and make those costs + savings visible. This is
the document of record; it absorbs the former `tool-diet-spec`, `tool-diet-audit-spec`,
`tool-diet-bench`, and the cost/usage-display specs (`model-billing`,
`session-throughput`, `transparent-usage`). Open workstreams live in §Plan; their progress is transient.

## Goals

- **Save round trips.** Every turn is one reasoning pass on the critical path
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

**Billing rates & live signals.** Model rates derive from the SDK
`billing.tokenPrices` `{inputPrice, outputPrice, cachePrice, batchSize}` (batchSize
= 1M, so price ≈ credits/Mtok) via `src/model-billing.ts` — the single source of
truth for billing display + throughput pricing. The legacy `billing.multiplier` is
dead (absent → renders 1×); a separate `longContext` tier `{…, contextMax}` prices
large windows, falling back to flat rates when absent. The footer also surfaces
per-request token I/O from `assistant.usage` events and a **429 rate-limit count**
(`recordRateLimit`, fed by `model.call_failure` `statusCode === 429` in
`dispatch-events.ts`) so a stuck/throttled session is visible at a glance.

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
| 6 | Graph reads via `index` | `spec-ast-index-tool` | edges not bodies | pending |
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

## Future levers (research-backed)

From `docs/research/harness-efficiency-landscape.md`. Recorded here so they are not
forgotten. Caco has two mechanisms today: the **generic output shaper** (cuts input
tokens from tool output) and **`caco_run_workflow`** (spends output tokens to cut round
trips + keep raw bytes out of context). The negative finding that reframes everything:
**shell-output shaping is only a few % of spend when native file *reads* dominate** —
the bigger surfaces are **read/context selection** and **turn-count reduction**.

### Top published evidence (best hard numbers found)

| Lever | Best published number | Caco status |
|---|---|---|
| Code-as-action for tool composition | Anthropic MCP: 150k→2k tokens (98.7%) | have (workflow); extend to API/MCP facade |
| Context editing (clear stale observations) | Anthropic: 84% token cut over 100 turns; +29% perf alone | missing |
| Prompt caching (stable prefixes) | up to 90% cost / 85% latency on long prompts; cache input ~10× cheaper | partial — prefix stability is ours |
| Learned model routing | RouteLLM: >85% cost cut at 95% GPT-4 quality | missing (sub-agent routing feasible) |
| Repo map / bounded retrieval | Aider: 1k-token tree-sitter + PageRank map | partial — `index`/`caco.frames` exist, not policy |
| Role tiering (planner/editor) | Aider Architect/Editor: 85.0% vs 79.7% solo | missing |
| Token-efficient tools/editing | Anthropic: up to 70% output cut (14% avg); diffs over whole-file | have edit surfaces; budget schemas harder |

### Ranked shortlist (ideas beyond shaper + workflow)

| # | Idea | One-line |
|---|------|----------|
| 1 | Skeleton-first read policy | Ranked repo map; signatures+ranges first, bodies only on bounded reads |
| 2 | Context editor for stale observations | Replace old reads/logs with summary+handle; keep window full of *relevant* context |
| 3 | Prompt-cache alignment audit | Keep the prompt prefix byte-stable turn-to-turn to maximize cache hits |
| 4 | Progressive tool discovery / API facade | Keep rarely-used schemas out of the hot path; workflow is the execution side |
| 5 | Model-role policy | planner/explorer/editor/reviewer/verifier → model tiers |
| 6 | Verifier-driven cheap-draft escalation | Cheap worker drafts; escalate only when an oracle (typecheck/test/review) fails |
| 7 | Structured shapers with typed handles | Generalize shaping to reads/grep/GitHub/browser/applet state |
| 8 | Turn-count budget gates | Per-task metrics flag when a batch/workflow should have been used |

### Expansion (per idea)

**1. Skeleton-first read policy.** Two parts: a **system-prompt directive** ("before a
broad read, `index` the file / `caco.frames` the symbol; then `view_range` only the
ranges you need") + the **tooling that makes it cheap** — which we already shipped
(`index` per-file skeletons, `caco.frames` def+callers). The gap is *policy + a ranked
repo map*: given a task, surface the likely-relevant symbols/files (imports, refs,
recent edits, grep hits) as signatures+ranges first, bodies on demand. Attacks the
dominant *read* surface, not shell output. Mostly prompt + wiring of existing primitives.

**2. Context editor (≠ auto-compaction).** Auto-compaction waits until near the limit,
then **summarizes the whole transcript** — lossy, late, and it degrades everything.
Context *editing* is surgical and continuous: as the session runs, **replace individual
stale observations** (an old file read now edited, superseded test output, a resolved
command log) with a compact `summary + retrieve handle`, while **preserving decisions,
the plan, current files, and failing locations**. Net effect (your insight, exactly):
you reach the full context window filled with *relevant* content instead of stale
scrollback — better results *and* fewer tokens. **SDK caveat (needs investigation):**
the Copilot SDK owns conversation history; Caco may not be able to mutate past turns
in place. Feasible avenues to verify: (a) an SDK history-edit API if one exists; (b)
do it at the **resume boundary** — recreate-via-resume with an edited history (we
already recreate on model/provider switch); (c) intercept tool *results* in the
observation hook and store a lean form before they enter history. This is a design
spike, not a known-mechanism — flag it as such.

**3. Prompt caching = prefix stability (potentially the biggest, cheapest win).** Yes,
cached input is already priced ~10× cheaper — but the *mechanism* that decides whether
you get that rate is subtle. Providers cache a **prefix** of the prompt up to a
breakpoint; a cache hit requires that prefix to be **byte-identical** to the previous
turn. If anything early in the prompt changes — tool order, JSON-schema serialization,
injected-memory order, a timestamp, session metadata, a random id — the cache is
**invalidated from the change point onward**, and everything after it is re-billed at
the full input rate. So the lever is: **keep the front of the prompt identical every
turn.** Caco's system prompt is `mode:'replace'` at position 0 and memory is appended
at the *end* (both already cache-friendly) — but we have never *audited* prefix
stability. If any per-turn churn sits early in the prompt, we are silently paying full
rate on the whole tail. Even without SDK cache-control knobs, **prefix content/ordering
is 100% Caco-owned.** ⚠️ This directly conflicts with idea #4's dynamic tool-hiding —
churning the tool list wrecks the cache prefix. Audit first (measure cache-hit rate vs
prompt-prefix diffs across turns); the potential saving is large.

**4. Progressive tool discovery / API facade (evolution of workflow).** Correction to a
prior assumption: the SDK **does** expose tool names — `rpc.tools.list()` (used by
`listAllTools`, `session-manager.ts`), returning name + description. What it does **not**
expose is *mid-session mutation* — the tool set is fixed at create/resume, no
`setTools`. So true "hide schema, reveal on demand mid-turn" is not possible. What *is*:
(a) fold more tool *families* behind the **workflow facade** so their schemas leave the
per-turn hot path (the facade is one schema for N operations — the 98.7% code-as-action
number lives here); (b) **lazy-register** rarely-used groups (browser, mcp-auth) only at
resume when enabled (already Plan rows L1/L2). Note the tension with #3: lazy
registration changes the tool list between sessions, which is fine (new prefix per
resume) but must never churn *within* a session.

**5. Model-role policy.** Largely what you said: auto-select model by capability/cost,
and trust the agent's `task`-tool model choice — so it's mostly **convention + defaults +
prompt**, not a new mechanism. Two flavors: **main-loop routing** (cheap model for grunt,
expensive for reasoning) is risky and needs quality gates — defer; **sub-agent/workflow
routing** is safe and available today (the `task` tool already takes a per-agent model).
The "policy" = documented role→tier defaults (explorer/summarizer→cheap, editor/
reviewer→mid, planner→top) the agent applies when spawning sub-agents.

**6. Verifier-driven cheap-draft escalation.** Your read is right: it's `task` with an
economic twist. `workflow` already does the "caller writes the output filter explicitly"
case (good for small tasks with known output). This idea covers the *other* case — a
cheap worker attempts a bounded edit/summary, and we **escalate to an expensive model
only when a hard oracle fails** (patch didn't apply, typecheck/test failed, schema
invalid, review rejected). The oracle is what makes it safe (FrugalGPT economics with a
real gate). You correctly identify the hard part: **the escalation criteria** — cheap
for grunt, but detecting "the one interesting result buried in a status dump" reliably
is the difficult design, and a wrong criterion either wastes the expensive model or
ships a bad cheap result.

**7. Structured shapers (acknowledged high-risk).** Agreed — shapers are hard to write
and risky (a bad shaper hides the load-bearing line). The bounded-risk design we already
use: the format shaper's output is a **superset of the generic floor** (by construction,
not by test), and **every shape keeps a `retrieve_output` handle** so nothing is ever
truly lost (and we just fixed `retrieve_output` to be exempt from re-shaping). Any new
shaper (reads/grep/GitHub/browser) must inherit both guards. Lower priority than 1–3
precisely because of the authoring risk you note.

**8. Turn-count budget gates.** Cheapest to add, and it makes the "fewer tokens ≈ less
time" thesis **falsifiable**: per task, track turns / prompt bytes / shaped bytes /
workflow commands / cache-replay estimate (we already log most of these), and flag when
an agent *should* have batched reads or used a workflow. Turns dominate latency (each
replays the window), so a turn-count gate is the metric that tells us whether any of
1–7 actually helped.

## Rationale

History: V1 trimmed/removed tools and proved savings; V2 deepened the model from
one-time output to four billing classes. Portability work (cross-platform
`caco.sh`, vendored `rg`, POSIX paths) is done. Absorbed (2026-06) the cost/usage
specs `model-billing` (SDK token-price rates, dead multiplier), `session-throughput`
(per-request token I/O + 429 count), and `transparent-usage` (footer/session-list
consumption display) — all shipped; their still-true facts live in §Design. Detail
specs: `economy-prompt-spec`, `workflow-savings-model-spec`, `offer-action-inline-spec`,
`spec-ast-index-tool`.
