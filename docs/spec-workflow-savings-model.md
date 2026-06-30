# Spec: deeper workflow savings estimate (round trips, cache replay, compounding, net cost)

## Goals

Caco's biggest, least-visible win is `caco_run_workflow`: it collapses an
`index → view → grep → read …` chain into **one** model round trip. Each tool call the
agent *didn't* make is a round trip that would have **replayed the entire context window**
as input on the wire (mostly cache-read) and cost a generation. Today we only credit the
workflow with the **one-time output-bytes it kept out of context**
(`estimateSavedTokens = (observedBytes − injectedBytes)/4`), priced at the **input** rate.
That undersells the feature badly — it ignores (a) the round trips saved, (b) the
window-replay those round trips would have cost, and (c) the *compounding* cache cost of
carrying that output forward on every later turn.

This spec defines a richer, **defensible** savings model: token savings split by billing
class (fresh-input vs cache), round trips saved, a net **credits** figure priced with the
model's three real rates, and a **ballpark time saved** derived from this session's own
measured turn latency. Overestimation is a real risk; the design's guards are: (a) the
**net headline counts only the context savings that hold even against parallel tool calls**
(the bulk output a workflow keeps out of context entirely — parallel calls still inject every
result); (b) the window-replay term, which *parallel calls could also avoid*, is shown as a
separate, clearly-labelled "if these had run as sequential tool calls" figure and is **not**
in the net headline; (c) the dominant cache term is billed at the **cache** rate (≈10× cheaper
than input); and (d) everything is shown as a transparent breakdown, never a single inflated
number.

Non-goal: a real tokenizer (we keep the rough `BYTES_PER_TOKEN = 4`), cross-session/durable
persistence (in-memory per session, like the existing accumulators; lost on restart), or
changing how shaping savings are measured (those stay exact).

## Background: what exists today

- `wrapFacadeForAccounting` (facade.ts) calls `account(value)` on every facade method; the
  harness (`runner.ts buildHarness`) sums returned bytes into `__observedBytes` and writes
  it in the result envelope. **It does not count how many calls were made.**
- `runWorkflow` surfaces `observedBytes` on `WorkflowRunResult`. `tool.ts` computes
  `estimateSavedTokens(observedBytes, injectedBytes)` and calls
  `recordWorkflowSavings(sessionId, saved)` → `workflowSavedTokens += saved`,
  `workflowRuns += 1` (session-lifetime; never request-reset).
- `recordUsage` already receives `inputTokens` (the **total prompt size** = the live context
  window W) on every model round trip, and increments `requestTurns`/`totalTurns`.
- `markRequestComplete` stamps `requestWallMs` (wall time of the last request only).
- Footer (`context-footer.ts`): `renderSaved` shows `↯(workflowSavedTokens + shapingSavedTokens)`
  and prices it with `estimateSavedCredits` at the **input** rate only. `estimateCost`
  already prices a request's in/cache/out with the model's `inputPerMtok`, `cachePerMtok`,
  `outputPerMtok`. So three-rate pricing is already a proven pattern in the footer.

## Design

Inputs available per run:
- `C` = commandCount (facade calls in the run) — **new**, from the accounting hook.
- `O` = observedBytes, `I` = injectedBytes (emitted value + shaped logs bytes).
- `K` = workflowCodeBytes (the script the model wrote — already tracked as
  `requestWorkflowCodeBytes`; pass the per-run value).
- `W` = current context-window tokens ≈ the most recent `recordUsage` inputTokens — **new**,
  captured as `lastInputTokens`. `0` when no round trip has happened yet (don't fabricate).
- Constants: `BYTES_PER_TOKEN = 4`; `AVG_TOOLCALL_TOKENS` (rough output cost of one tool-call
  arg block the model would otherwise have emitted, default ~40); `AVG_ROUNDTRIP_MS` fallback.

Derived (all token quantities are bytes ÷ BYTES_PER_TOKEN where byte-based):

1. **Virtual tool calls avoided vs round trips saved.** `virtualToolCallsAvoided = max(0, C − 1)`
   — one workflow stands in for C facade calls (breadth; **display only**). This is **not**
   equated with model round trips: the SDK/model can emit independent tool calls **in parallel**
   in one response, so a 50-call fan-out would *not* have been 49 sequential round trips. Define
   a separate, conservative `roundTripsSaved = ceil(virtualToolCallsAvoided ×
   WORKFLOW_SEQUENTIAL_FRACTION)` where `WORKFLOW_SEQUENTIAL_FRACTION` is env-tunable
   (default **0.5**, i.e. assume half of the collapsed calls would have been forced sequential
   by data dependencies). `roundTripsSaved` drives only the **optimistic** window-replay and
   time lines below — never the net headline. (No "49 round trips saved" claim is made.)

2. **Window-replay saved (cache class) — optimistic, NOT in net headline.** Had the
   `roundTripsSaved` calls run sequentially, each would have re-sent the window W, ~entirely
   cache-read: `cacheReplaySaved = roundTripsSaved × W`. Billed at the cache rate. Shown as an
   "if sequential" figure with the parallel-calls caveat, because parallel tool calls could
   also avoid most of it — so it is excluded from the defensible net headline.

3. **One-time context saved (input class) — net headline.** Bulk facade output that never
   entered context at all: `freshSaved = max(0, O − I)/BYTES_PER_TOKEN`. This holds **even
   against parallel tool calls** (they still inject all N results), so it anchors the net
   headline. Equals today's `workflowSavedTokens` (kept, back-compat); billed at the input rate.

4. **Compounding (cache class) — net headline, with a one-turn deferral to avoid
   double-counting.** Those `freshSaved` tokens are now permanently absent from the window, so
   **subsequent** round trips re-save them at the cache rate. **Critical:** `freshSaved` (term 3)
   already prices the *first* time that output would have entered the prompt; if it began
   compounding on the very next turn we would charge the same tokens twice. So `freshSaved`
   enters a **pending bucket** on workflow completion and is promoted into the running
   `avoidedContextTokens` **only after the next `recordUsage`** — compounding therefore starts on
   the **second** subsequent turn. Per round trip: add the (already-promoted)
   `avoidedContextTokens` to `cacheCompoundSaved`, then promote any pending. Linear in
   (later turns × avoided context), matching per-turn cache-read billing.
   **Deviation from the user's sketch:** the user proposed
   `cachedInputTokensSaved = virtualToolCalls × cumulativeInputTokensSaved` per turn, which
   compounds multiplicatively and explodes super-linearly. The linear, deferred accrual above
   captures the same "savings keep paying off every turn" intuition without indefensible numbers.

5. **Net output cost (output class, signed) — net headline.** The model spent
   `K/BYTES_PER_TOKEN` output tokens writing the script, but avoided emitting
   `virtualToolCallsAvoided` tool-call arg blocks:
   `netOutputSpent = K/BYTES_PER_TOKEN − virtualToolCallsAvoided × AVG_TOOLCALL_TOKENS`. May be
   **negative** (the workflow was cheaper to write than the calls it replaced — an extra win).
   Subtracted from the net headline so it is honest, not upside-only. `K` is **this run's**
   `Buffer.byteLength(code)` (the tool handler's `code` arg), NOT the request-cumulative
   `requestWorkflowCodeBytes`.

### Pricing → credits

Using the active model's three rates (same source as `estimateCost`). The **net headline**
is the defensible figure (context savings that survive parallel tool calls), minus output cost:
```
netCreditsSaved = (freshSaved · inputPerMtok
                   + cacheCompoundSaved · cachePerMtok) / 1e6
                  − (netOutputSpent · outputPerMtok) / 1e6
```
The **optimistic** window-replay figure is priced and displayed separately, never folded in:
```
ifSequentialCreditsSaved = (cacheReplaySaved · cachePerMtok) / 1e6   // "if calls were sequential"
```
Both return `null` (tokens still shown, no credit figure) when rates are unknown (e.g. Auto).
`netCreditsSaved` may be **negative** (a costly workflow); the UI must say so explicitly (see
surfacing) rather than show a savings glyph.

### Time saved (ballpark, explicitly rough)

`avgTurnMs = totalWallMs / totalTurns` (both session-lifetime; `totalWallMs` is a **new**
accumulation in `markRequestComplete`). `timeSavedMs = roundTripsSaved × avgTurnMs` (the
**conservative** `roundTripsSaved`, not `virtualToolCallsAvoided`). Labelled `~rough` and
capped, because `avgTurnMs` includes tool-execution and workflow runtime, not just model/API
latency — a long test/build inside a request would otherwise inflate it. Falls back to
`AVG_ROUNDTRIP_MS` until at least one request has completed.

## Where it lives

- **New** `src/workflow/savings-model.ts`: a pure `estimateWorkflowSavings(input)` →
  `WorkflowSavingsBreakdown` (`{ virtualToolCallsAvoided, roundTripsSaved, freshInputTokensSaved,
  cacheReplayTokensSaved, netOutputTokensSpent }`). No I/O, no session state — just the per-run
  math (items 1–3, 5). Compounding (item 4) and pricing/time are session-stateful and live in
  throughput. Keep `estimateSavedTokens` (savings.ts) as the `freshInputTokensSaved` primitive
  it already computes; the new module wraps it and adds the rest.
- **`src/workflow/runner.ts`**: harness counts facade calls (`__commandCount += 1` in
  `__account`) and writes `commandCount` in the envelope; `WorkflowRunResult.commandCount`
  surfaced (default 0 for old envelopes).
- **`src/session-throughput.ts`**: new session-lifetime fields
  `workflowRoundTripsSaved`, `workflowVirtualCallsAvoided`, `workflowCacheReplaySaved`,
  `workflowCacheCompoundSaved`, `workflowOutputDelta` (signed), running `avoidedContextTokens`,
  `pendingAvoidedContext` (the one-turn deferral bucket), `lastInputTokens`, `totalWallMs`.
  `recordUsage` (one model round trip): set `lastInputTokens = inputTokens`, then
  `cacheCompoundSaved += avoidedContextTokens`, then promote `pendingAvoidedContext` into
  `avoidedContextTokens` and zero the pending bucket (so freshSaved compounds from the *second*
  later turn, never the first). New `recordWorkflowSavingsV2(sessionId, breakdown)` accumulates
  the per-run fields and adds `freshInputTokensSaved` to `pendingAvoidedContext`;
  `workflowSavedTokens` must keep meaning = cumulative `freshInputTokensSaved` (footer
  back-compat). `markRequestComplete` adds the request's wall to `totalWallMs`. All new fields in
  `blank()`, `snapshot()`, and **preserved across `resetRequest`** *except* `lastInputTokens` and
  `pendingAvoidedContext`, which are **reset on a fresh send** (a new request must not price W
  against the prior request's prompt, and a dangling pending bucket must not leak across sends);
  `requestTurns > 0` additionally gates use of W. Steering (no reset) preserves them.
- **`tool.ts`**: only when `result.outcome === 'emitted'` (a failed/no-emit workflow delivered
  no compact result, so it records no savings; an emitted-then-timed-out run still records,
  since it emitted), build the `estimateWorkflowSavings` input from `result.observedBytes`,
  `result.commandCount`, the injected-output bytes, **this call's** `Buffer.byteLength(code)`,
  and the live window (`lastInputTokens`, or 0 when `requestTurns === 0`); record via V2.
- **Surfacing** (`public/ts/context-footer.ts` + `/throughput` snapshot): extend
  `ThroughputData`; replace the input-only `estimateSavedCredits` with a class-aware pricer
  (input for fresh, cache for compounding, output for the delta). Headline `↯` shows the **net
  credits saved** with the token total in the tooltip; when `netCreditsSaved < 0` show an
  explicit "−Ncr (net cost)" wording, not a savings glyph. Tooltip breaks down: virtual calls
  avoided, fresh-input tokens, compounding tokens, the output delta, a separate
  "if sequential: ~X cr / Y tokens" window-replay line (with the parallel-calls caveat), and
  `~time saved`. Shaping (exact) line stays.

## Considerations

- **Why cache rate for the dominant term.** A round trip re-sends the whole prompt, but the
  system prompt + history are cache-stable, so the provider bills it as cache-read. Pricing
  the `R × W` replay at the input rate would overstate by ~10×; cache rate is the honest,
  conservative choice and is the main guard against the "too good to be true" reaction.
- **commandCount semantics.** Every facade call counts as one virtual tool call, including
  cheap ones (`list`). A 50-file read loop legitimately saved 49 round trips — that breadth
  is the point, and it's real. A sanity cap (`MAX_VIRTUAL_TOOLCALLS_PER_RUN`, env-tunable,
  default high e.g. 1000) bounds a pathological run from dominating the headline.
- **W proxy accuracy.** `lastInputTokens` is the prompt size as of the previous round trip,
  not the exact bytes at workflow time, but within a turn it is the right order of magnitude.
  When unknown (`0`), the replay + compounding terms are simply `0` — we never invent a window.
- **Compounding could still feel large** over a long session (many turns × avoided context).
  Mitigation: it is strictly linear and each increment is a real cache-read that *would* have
  occurred; the tooltip shows it as a separate line so a skeptic sees the assumption.
- **Back-compat.** `workflowSavedTokens` keeps its exact current meaning and the `↯` token
  total still includes it + shaping; only the *credit* pricing gets richer and new lines are
  added. No existing field changes meaning.
- **Shell-output overlap (caco.sh).** For `caco.sh`, the counterfactual direct shell output
  would itself have been **shaped** by the observation hook (and that trim is already credited
  as `shapingSavedTokens`). So a workflow's `caco.sh` bytes are not purely marginal — crediting
  all of them as `freshSaved` slightly overlaps with what shaping would have saved. v1
  documents this in the tooltip ("workflow `sh` savings vs a shaped baseline are approximate");
  a future refinement could discount shell-method `freshSaved` by the shaper's expected ratio.
- **No mid-session / lifecycle concerns.** Pure additions to an in-memory accumulator + a
  pure math module + a frontend render change. Nothing persisted, nothing registered.
- **Estimate, labelled.** Every new figure is shown as `est.`/`~`; the breakdown is the
  honesty mechanism. We are deliberately moving from *undersell* toward *fair*, not toward
  *oversell*.

## Acceptance

- **Math oracle (pure):** `estimateWorkflowSavings` unit tests with hand-computed numbers for
  `virtualToolCallsAvoided`, `roundTripsSaved` (= `ceil((C−1) × WORKFLOW_SEQUENTIAL_FRACTION)`),
  `freshInputTokensSaved`, `cacheReplayTokensSaved (= roundTripsSaved × W)`, and
  `netOutputTokensSpent` (incl. a **negative** net-output case, a `C ≤ 1` zero case, and a
  `W = 0` case).
- **Compounding double-count oracle (BLOCKING-2 guard):** after one recorded workflow and **one**
  later `recordUsage`, `workflowCacheCompoundSaved === 0`; after a **second** later `recordUsage`,
  it equals `freshInputTokensSaved`; after N, `(N−1) × freshInputTokensSaved`. Asserts the
  one-turn deferral and linearity (not multiplicative).
- **Round-trip honesty oracle (BLOCKING-1 guard):** a workflow with `C` independent calls reports
  `virtualToolCallsAvoided === C−1` but `roundTripsSaved` strictly less (default half), and the
  net headline does **not** include `cacheReplaySaved`.
- **Pricing oracle:** with fixed input/cache/output rates, assert `netCreditsSaved` equals the
  hand-computed value, that the compounding term uses the **cache** rate (not input), and that
  `cacheReplaySaved` is priced only into the separate "if sequential" figure. Include a
  **negative** `netCreditsSaved` case and an **Auto** (rates unknown → `null`) case.
- **Time oracle:** with a known `totalWallMs`/`totalTurns`, assert `timeSavedMs =
  roundTripsSaved × avgTurnMs`, the `AVG_ROUNDTRIP_MS` fallback before any request, and that the
  figure is labelled rough/capped.
- **W reset oracle:** `lastInputTokens` and `pendingAvoidedContext` are **cleared on a fresh send**
  (`resetRequest`) but **preserved through steering**; W is treated as 0 when `requestTurns === 0`.
- **Failure policy:** a `no-emit`/`error` workflow records **no** savings; an emitted-then-timed-out
  run **does** record.
- **Per-run code bytes:** with two workflows in one request, each run's `netOutputSpent` uses that
  call's `Buffer.byteLength(code)`, not the request-cumulative `requestWorkflowCodeBytes`.
- **Plumbing:** a workflow that makes K facade calls reports `commandCount == K` through the
  envelope → `WorkflowRunResult`; an old envelope without the field yields `0` (no throw).
- **Back-compat:** `workflowSavedTokens` after a run still equals
  `estimateSavedTokens(observed, injected)`; the footer `↯` token total is unchanged for a
  pure-shaping session.
- **Frontend:** `tsc -p tsconfig.frontend.json` passes with the extended `ThroughputData` and
  class-aware pricer; a `netCreditsSaved < 0` render shows explicit net-cost wording, not a
  savings glyph; Auto (unknown rates) shows tokens without a credit figure.
- Gates: typecheck ×2, lint:strict, knip, full tests, build:client.

## Plan

1. **commandCount plumbing** — harness `__commandCount`, envelope field,
   `WorkflowRunResult.commandCount`; runner test.
2. **`savings-model.ts`** — pure `estimateWorkflowSavings` (virtual vs conservative round trips,
   fresh, replay, net output); math + round-trip-honesty oracle tests first.
3. **throughput accumulators** — new fields + `recordUsage` (W capture, compounding accrual,
   pending→avoided promotion) + `pendingAvoidedContext` deferral + `lastInputTokens`/pending
   reset-on-fresh-send + `markRequestComplete` `totalWallMs` + V2 record path; throughput tests
   (compounding double-count guard, time, back-compat, reset vs steering).
4. **tool.ts wiring** — emitted-only recording, per-run code bytes, assemble inputs, record V2.
5. **Surfacing** — `ThroughputData` fields, class-aware pricer, net-credits headline (+ negative
   net-cost wording), breakdown tooltip with the separate "if sequential" replay line and
   `~time saved`.
6. **Gates.**

v1 is the four token classes + net credits + ballpark time; a real tokenizer and durable
persistence are explicit non-goals.
