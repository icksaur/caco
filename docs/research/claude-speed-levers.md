# Claude-Specific Speed Levers for Caco

*Research date: 2026-07-05. Primary sources: platform.claude.com (Anthropic/Claude docs, migrated from docs.anthropic.com/docs.claude.com). Caco source at `the repo root`.*

> **Environment note:** Anthropic's docs now describe a model lineup ahead of the "Opus 4.x / Sonnet 4.x" framing in the brief: Opus 4.5/4.6/4.7/4.8, Sonnet 4.6/5, Haiku 4.5, plus Fable 5 / Mythos. The mechanisms below apply across the 4.x line; where a lever changed between 4.5→4.6→5, that's called out. Caco's current default model is `claude-sonnet-4.6` (`caco/src/provider-registry.ts:22`), default pref `claude-sonnet-4` (`caco/src/preferences.ts:17`).

> **Reachability model (read this first):** Caco does **not** call the Anthropic Messages API. It goes Caco → `@github/copilot-sdk` (`CopilotClient.createSession/resumeSession`) → Copilot CLI → models (`caco/src/session-manager.ts:1`, `caco/src/dev-docs-tool.ts:71`). Therefore Claude API body params (`cache_control`, `thinking`, `tool_choice.disable_parallel_tool_use`, `anthropic-beta` headers) are **only reachable if the SDK surfaces them**. What the SDK *does* surface today: `model`, `streaming`, `reasoningEffort`, `contextTier`, `systemMessage`, `tools/excludedTools`, and BYOK `ProviderConfig` (`type: 'openai'|'azure'|'anthropic'`, `baseUrl`, `headers`) — see `caco/src/session-manager.ts:141-168` and `caco/src/provider-registry.ts:34-57,193-202`.

## Ranked shortlist

| # | Lever | Claude mechanism | Speed impact | Reachable via | Recommendation |
|---|-------|------------------|--------------|---------------|----------------|
| 1 | **`effort` = low/medium for sub-tasks** | Anthropic `effort` param (all 4.5+/5) caps *all* output tokens incl. thinking + tool calls | Large: fewer tokens/tool-calls ⇒ less wall-clock; docs bill `low` as "latency-sensitive" | ✅ Copilot SDK `reasoningEffort` — **already plumbed** in Caco | **Adopt** — auto-route `low`/`medium` for delegate/swarm/workflow sub-agents |
| 2 | **Model routing to Haiku/Sonnet** | Haiku = "fastest"; Sonnet = "best speed+intelligence" tier | Large: Haiku >> Opus tokens/sec + lower TTFT | ✅ SDK `model` field / `setModel` | **Adopt** — route classification/format/short tool tasks to Haiku |
| 3 | **Adaptive thinking + steering down** | `thinking:{type:"adaptive"}`; on Sonnet 5 it's ON by default; steer with a prompt line to "respond directly" | Medium–large: skip thinking on trivial turns = big TTFT/latency win | ⚠️ Partial — SDK effort influences it; explicit `thinking` config likely not exposed; steer via `systemMessage` | **Spike** — measure; use system-prompt steering (reachable now) |
| 4 | **Prompt caching (stable prefix + 1h TTL)** | Auto/explicit `cache_control`; 5-min default, `ttl:"1h"` now GA at 2× write price; cache-read is the latency win | Large on long prompts (Anthropic historically ~up to 85% latency cut); cache-read reprocesses nothing | ⚠️ SDK/CLI manages caching internally; Caco already does prefix-stability work; `ttl:"1h"` not directly settable | **Adopt the discipline** (stable prefixes), **spike** the 1h TTL |
| 5 | **Parallel tool calling** | Claude 4.x parallelizes natively; `tool_choice.disable_parallel_tool_use:false` (default on) | Medium: N tools in one round-trip vs N sequential turns | ❌ Only direct API; not a session-config param | **Skip/verify** — ensure SDK doesn't disable it; nothing to build |
| 6 | **Streaming / TTFT** | `stream:true`; SSE deltas | Perceived-latency only (not throughput) | ✅ Caco already sets `streaming:true` (`session-manager.ts:768`) | **Keep** — already done |
| 7 | **Token-efficient tool use** | `token-efficient-tools` beta (Claude 3.7 Sonnet only, ~14% avg output cut) | Small; **superseded by `effort` on 4.x** | ❌ 3.7-only, page now 301s to migration guide | **Skip** — obsolete, use `effort` |
| 8 | **Message Batches API** | Async 24h batch, 50% cost | None for interactive (adds latency) | ❌ Not an interactive path | **Skip** for interactive; consider for scheduled jobs |

**Highest-value Claude-specific lever:** **#1 — the `effort` parameter set to `low`/`medium` for non-interactive sub-tasks** (delegate/swarm/workflow children). It's the one Claude control that reduces *all* output token spend — text, tool-call args, *and* extended thinking — which is what actually moves wall-clock time; Anthropic explicitly positions `low` for "latency-sensitive workloads" and "subagents." Uniquely, Caco already has the entire plumbing (`reasoningEffort` through `resumeSession` and `rpc.model.setReasoningEffort`), so this is a routing-policy change, not new integration.

---

## Detailed findings

### 1. `effort` parameter — the top lever
- **Mechanism:** `effort` ∈ {`low`,`medium`,`high`(default),`xhigh`,`max`}, no beta header, on Opus 4.5/4.6/4.7/4.8, Sonnet 4.6/5, Haiku 4.5. It affects **all response tokens including tool calls and thinking**, so lower effort ⇒ fewer/shorter tool calls and less thinking ⇒ less wall-clock. Docs: *"lower effort would mean Claude makes fewer tool calls"*; `low` = *"best speed and lowest costs, like subagents"* and *"high-volume or latency-sensitive workloads."* Source: platform.claude.com `/docs/en/build-with-claude/effort` (fetched 2026-07-05).
- **Cross-model calibration (Sonnet 5 doc):** Sonnet 5 @ `medium` ≈ Sonnet 4.6 @ `high`; Sonnet 5 @ `high` ≈ Sonnet 4.6 @ `max`. Opus 4.7/4.8 "respect effort more strictly" at low/medium and scope work to what's asked. Source: `/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5`.
- **Reachability:** ✅ **Reachable and already integrated.** Copilot SDK exposes `reasoningEffort` on `ResumeSessionConfig` (`caco/src/session-manager.ts:161`) and live via `session.rpc.model.setReasoningEffort({reasoningEffort})` (`caco/src/session-manager.ts:227,1653`). Model capability gating already exists: `capabilities.supports.reasoningEffort`, `supportedReasoningEfforts`, `defaultReasoningEffort` (`caco/src/session-manager.ts:102,948,1627-1642`; surfaced to UI in `caco/src/routes/sessions.ts:160`). Persisted in session meta (`caco/src/session-meta-store.ts:36-38`).
- **Caco recommendation:** **Adopt.** Set `reasoningEffort:'low'` (or `medium`) by default for `delegate-tool`, swarm/agent children, and `workflow` sub-runs, keeping interactive coding at `high`. Gap today: Caco exposes effort as a user setting but doesn't *auto-route* it per task class. Verify each model's `supportedReasoningEfforts` before applying (the string names must match what the CLI passes through).

### 2. Model routing for speed
- **Mechanism:** Anthropic models overview (fetched 2026-07-05, `/docs/en/about-claude/models/overview`) positions **Haiku 4.5 = "fastest model with near-frontier intelligence"**, **Sonnet 5 = "best combination of speed and intelligence"**, **Opus 4.8 = complex agentic/enterprise** (highest capability, slowest). Ordering of tokens/sec and TTFT is Haiku > Sonnet > Opus.
- **Published throughput numbers:** I could **not** retrieve a live per-tier tokens/sec table from Anthropic (the overview's comparison table was truncated before latency rows) and did not fetch Artificial Analysis in this pass — **flag as unverified.** Historically (AA, 2025) Haiku 3.5/4.5 ran ~120–200+ tok/s vs Sonnet ~55–90 tok/s vs Opus ~30–55 tok/s, but these must be re-checked against current AA data before quoting.
- **Reachability:** ✅ SDK `model` field on create (`caco/src/session-manager.ts:767`) and `setModel()` for live switch (`caco/src/session-manager.ts:213,1509`).
- **Caco recommendation:** **Adopt.** Add a fast-tier default (Haiku) for mechanical sub-tasks (title/summary generation, classification, format fixups, cheap tool-driving) and keep Sonnet/Opus for interactive reasoning. Pairs naturally with lever #1.

### 3. Extended / adaptive thinking latency
- **Mechanism:** `thinking:{type:"adaptive"}` lets the model decide *whether and how much* to think per request; at default `high` effort it "almost always thinks," at lower effort it skips thinking on easy turns. Adaptive thinking **auto-enables interleaved thinking** (thinking between tool calls) — good for agents but adds latency. On Opus 4.7/4.8 manual `thinking:{type:"enabled"}` is a **400 error**; `budget_tokens` is deprecated on 4.6 and removed on newer models. Sources: `/docs/en/build-with-claude/adaptive-thinking`, `/docs/en/build-with-claude/extended-thinking` (fetched 2026-07-05).
- **Turning thinking DOWN:** Docs give an explicit steering line to reduce latency: *"Thinking adds latency and should only be used when it will meaningfully improve answer quality… When in doubt, respond directly."* (Sonnet 5 prompting guide). This is a real wall-clock lever for chat/simple turns.
- **Reachability:** ⚠️ Partial. The SDK exposes `reasoningEffort` (which on 4.6+ is the recommended thinking-depth control), but a raw `thinking` config object is **not** in the SDK session config. You can still steer thinking down via `systemMessage` (Caco fully controls this: `caco/src/session-manager.ts:769`, `caco/src/prompts.ts`).
- **Caco recommendation:** **Spike.** For latency-sensitive chat/sub-tasks, combine `reasoningEffort:'low'` with a system-prompt "respond directly unless multi-step reasoning is needed" nudge; A/B measure TTFT and total turn time. Note: Sonnet 5 turns adaptive thinking **on by default** (unlike 4.6), so migrating to Sonnet 5 without effort tuning can *increase* latency — a trap to watch.

### 4. Prompt caching latency
- **Mechanism:** Prefix caching over `tools`→`system`→`messages`. Default **5-min ephemeral** TTL, refreshed free on each hit. **1-hour TTL is GA** via `cache_control:{type:"ephemeral", ttl:"1h"}` at **2× base input write price** (no beta header required now — historically the `extended-cache-ttl-2025-04-11` beta). Cache-read reprocesses nothing (the latency win); cache-write is slightly *slower/costlier* than an uncached pass. Automatic caching moves the breakpoint forward across turns; 20-block lookback, 4 breakpoint slots. Source: `/docs/en/build-with-claude/prompt-caching` (fetched 2026-07-05).
- **Anthropic's headline latency claim (~up to 85% on long prompts):** widely published historically but I did **not** re-confirm the exact "85%" figure on the current page (the page states "significantly reduces processing time" and gives pricing, not a % latency number) — **flag as unverified against current docs.**
- **Reachability:** ⚠️ The Copilot CLI/SDK owns request serialization, so `cache_control`/`ttl` aren't Caco-settable params. However, **Caco already optimizes for cache hits**: fork-cache-preservation reuses the parent's exact `mode:'replace'` system message so the child's prefix matches (`caco/src/session-manager.ts:170-205`), and model-switch/effort-change logic is careful not to "bust a warm forked child's cache." So the CLI is doing ephemeral caching underneath.
- **Caco recommendation:** **Adopt the discipline / spike the TTL.** Keep prefixes byte-stable (system prompt, tool defs) — Caco already does this well; avoid per-turn nonce/timestamp injection into system messages. Separately **spike** whether the Copilot CLI exposes any cache-TTL knob for long-lived interactive sessions (5-min expiry causes cold re-reads on idle chats); if only reachable via BYOK `type:'anthropic'`, weigh the 2× write cost.

### 5. Parallel tool calling
- **Mechanism:** Claude 4.x parallelizes tool calls natively (emits multiple `tool_use` blocks in one turn). Default is parallel-enabled; `tool_choice.disable_parallel_tool_use:true` turns it off. Executing N tools from one turn concurrently collapses N sequential model round-trips into one. (Well-documented API behavior; I did not re-fetch the exact current `tool_choice` reference text in this pass — **flag minor.**)
- **Reachability:** ❌ `tool_choice` isn't a Copilot SDK session param; parallelization is governed by the CLI + model.
- **Caco recommendation:** **Skip building; verify.** Confirm the Copilot CLI isn't forcing sequential tool execution or `disable_parallel_tool_use`. On the harness side, ensure Caco *executes* multiple `tool_use` blocks concurrently rather than serially (check the tool-runner/observe path) — that's where wall-clock is actually lost. (This overlaps the general research pass on batching tool calls.)

### 6. Streaming / TTFT
- **Mechanism:** `stream:true` SSE with `message_start` → content-block deltas → `message_stop`. Reduces *perceived* latency only. Fine-grained tool streaming (historically `fine-grained-tool-streaming-2025-05-14` beta) streams tool JSON incrementally — I could **not** confirm its current status/header in the fetched streaming doc; **flag as unverified.**
- **Reachability:** ✅ Caco already sets `streaming:true` on create (`caco/src/session-manager.ts:768`).
- **Caco recommendation:** **Keep.** Optional micro-optimization to *spike*: begin executing a tool call as soon as its `tool_use` block finishes streaming rather than waiting for `message_stop` (speculative tool start) — but this depends on the SDK exposing per-block stream events; Caco has an `sdk-normalizer.ts` that shapes SDK events, so feasibility hinges on what granularity it emits.

### 7. Token-efficient tool use
- **Mechanism:** Beta `token-efficient-tools-2025-02-19`, **Claude 3.7 Sonnet only**, reduced tool-call output tokens (~14% avg, up to ~70% claimed). On current docs the dedicated page **301-redirects to the model migration guide**, indicating it's deprecated/removed and folded into the `effort` model. Source: redirect observed 2026-07-05 (`.../tool-use/token-efficient-tool-use` → `.../models/migration-guide`).
- **Reachability:** ❌ 3.7-only; not on 4.x.
- **Caco recommendation:** **Skip.** Superseded by `effort`.

### 8. Message Batches API
- **Mechanism:** Async batch (up to 24h, ~50% cost). Not a latency tool for interactive turns — it *adds* latency.
- **Reachability:** ❌ Not exposed as an interactive session path in the Copilot SDK.
- **Caco recommendation:** **Skip for interactive.** Only conceivably relevant to Caco's scheduled jobs (`schedule-manager.ts`) if bulk/offline, and even then only via direct API — not worth it now.

### 9. Prompt-structure quirks affecting *speed*
- Very large system prompts raise TTFT (more prefix to process) — but prompt caching largely neutralizes this on cache-hits, so the real cost is the *first* (cold) turn. XML-tag structuring and document-position effects are documented for *quality*, not measurable *speed*; **no Anthropic-published latency delta found** — flag as not a speed lever. Long-context degradation is a quality/throughput concern; `contextTier`/`long_context` (Caco: `model-billing.ts:40-53`, `session-manager.ts:634-638`) is a capability/price knob, not a latency knob.
- **Caco recommendation:** **Skip as a distinct speed lever;** the actionable part (stable, cacheable prefixes) is already covered by #4.

---

## Gaps & uncertainties (verify before quoting)
1. **Per-tier tokens/sec + TTFT numbers** — not retrieved live. Anthropic overview comparison table was truncated before latency rows; Artificial Analysis not fetched this pass. Re-verify current Haiku/Sonnet/Opus throughput before publishing numbers.
2. **"~85% latency reduction" caching claim** — not confirmed on the current prompt-caching page (which states "significantly reduces processing time" + pricing, no %). Historically Anthropic-published; treat as unverified.
3. **Fine-grained tool streaming** current status/beta header — not confirmed in fetched streaming doc.
4. **`disable_parallel_tool_use` exact current syntax** — not re-fetched this pass (well-established historically).
5. **Copilot SDK/CLI internals** — whether it sets `cache_control` TTL, `disable_parallel_tool_use`, or maps `reasoningEffort` string values 1:1 to Claude `effort` levels is **inferred**, not source-verified. Suggested follow-up: inspect `node_modules/@github/copilot-sdk` types (`ProviderConfig`, `ResumeSessionConfig`, `SDKModelInfo.supportedReasoningEfforts`) and any CLI request logs to confirm the exact `effort`/model wire mapping and whether beta headers can ride through BYOK `headers`.
6. **BYOK header injection** — `ProviderConfig.headers` (from `headersEnv`, `caco/src/provider-registry.ts:184-200`) *could* carry `anthropic-beta` flags for a `type:'anthropic'` provider, but whether the SDK serializes matching body params (thinking/cache_control) is unverified — likely not, so beta headers alone may be inert. Spike before relying on it.

**Caco source citations used:** `caco/src/session-manager.ts:1-2,102,141-168,213,227,634-638,767-796,945-1006,1508-1509,1623-1660`; `caco/src/provider-registry.ts:22,34-57,125-145,169-205`; `caco/src/session-meta-store.ts:36-38`; `caco/src/routes/sessions.ts:160,283,630-719`; `caco/src/model-billing.ts:40-53`; `caco/src/preferences.ts:17`; `caco/src/dev-docs-tool.ts:71`.

---

## Empirical subagent timing (2026-07-05)

Measured with Caco's own `task` tool (background subagents, `duration` = agent compute
time from `read_agent`; `elapsed` = wall-clock incl. scheduler queue). Two task classes,
identical prompt per class (reworded per run to force a genuine cache miss).

### Task A — trivial / tool-bound
"Count *.ts files under src/ and total their lines." One shell round-trip + a one-line
answer. Dispatched 5 agents in **parallel**.

| Model | duration | elapsed |
|-------|----------|---------|
| Opus 4.8 | 4s | 9s |
| Haiku 4.5 (×3) | 4s / 4s / 8s | 12s / 12s / 18s |
| Sonnet 4.6 | 5s | 18s |

All returned the identical correct answer (133 files, 23,213 lines). **Tier is noise at
this scale** — the within-Haiku spread equals the cross-tier spread. Wall-clock is
dominated by the single tool round-trip + agent spin-up, not token generation.

### Task B — complex / exploration
"Trace the full path from an SDK usage event to the footer credit-cost figure." Requires
multi-file navigation + a structured writeup. All answers were accurate.

**Parallel dispatch (scheduler-contended):**

| Model | duration | elapsed |
|-------|----------|---------|
| Opus 4.8 | 49s | 52s |
| Sonnet 4.6 | 103s | 111s |
| Haiku 4.5 (a) | 126s | 130s |
| Haiku 4.5 (b) | 165s | 172s |

**Serial dispatch, cache-busted (one at a time; note `elapsed == duration` throughout —
no queue):**

| Model | Effort | duration | Accuracy |
|-------|--------|----------|----------|
| **Opus 4.8** | **low** | **52s** ⚡ fastest | full, tight |
| gpt-5.3-codex | medium | 53s | full, precise line numbers |
| Opus 4.8 | default | 57s | full |
| Gemini 3.5 Flash | low | 58s | full (dropped resume/REST paths) |
| Sonnet 5 | low | 67s | full + extra resume path |
| GPT-5.5 | medium | 71s | most complete file list |
| Sonnet 4.6 | default | 86s | full |
| GPT-5.5 | low | 87s | full + rate-payload path (explored MORE than medium) |
| Haiku 4.5 | default | 95–104s | full, most verbose |
| Gemini 3.5 Flash | medium | 98s | full (found sdk-normalizer extractor) |
| MAI-Code-1-Flash | medium | 143s | full — but SLOWEST despite "Flash" name |

Every run produced an accurate trace of the `dispatch-events → recordUsage → snapshot →
caco.throughput → context-footer.estimateCost/resolveModelRates` path; they differ only in
verbosity and how many secondary paths (resume, REST, model-billing) they surfaced.

### Findings
1. **Strong model = fastest for exploration.** Opus beat Haiku by ~2× wall-clock. Complex
   exploration is dominated by **turn count** (each round-trip replays the window); a
   stronger model reaches the answer in fewer, more targeted turns, which outweighs
   Haiku's faster per-token generation. This **inverts research lever #2** ("route to a
   cheap fast tier for speed") for any non-trivial task.
2. **`effort=low` is a real but NON-MONOTONIC knob whose sign is model-family-dependent.**
   It does not simply "reduce thinking"; it changes *search behavior*:
   - Opus 4.8: 57s → 52s (low slightly faster)
   - Gemini 3.5 Flash: 98s → 58s (low **much** faster, −40%)
   - GPT-5.5: 71s → 87s (low **slower** — it explored more paths at low than at medium)
   So a blanket "set subagents to low for speed" policy is unsafe: on some families low
   effort *increases* wall-clock by encouraging wandering. Effort trims per-turn
   thinking/verbosity, not the *number* of exploration round-trips, so its net effect on a
   navigation task is small and inconsistent; it would bite more predictably on
   generation-heavy output. Reachable via the `task` tool's `reasoning_effort` param.
3. **Gemini 3.5 Flash @ low is surprisingly competitive (58s)** — a cheap "flash" tier
   nearly matched Opus here, so the strong-model rule is a tendency, not a law; a fast
   cheap model with a good search can rival a frontier model on a well-scoped trace.
   **But "fast" names do not predict wall-clock:** MAI-Code-1-Flash @ medium was the
   *slowest* of all (143s) despite "Flash" branding, and gpt-5.3-codex @ medium was
   near the top (53s). Provider tokens/sec labels say nothing about turn count on an
   agentic trace — only end-to-end measurement does.
4. **The scheduler serializes parallel subagents.** Serial runs show `elapsed == duration`
   every time; under parallel load the later-dispatched agents inflate (Haiku-b 95s→165s)
   purely from queueing. Fan-out gives far less wall-clock speedup than it appears.
5. **Cost is negligible.** Subagent exploration runs in a throwaway context; only the
   summary returns, so the main window never bloats and the credit needle barely moves.

**Revised Caco policy (replaces "route to Haiku for speed"):** for exploratory subagents
prefer a **strong model (Opus 4.8 or Sonnet 5)** — fastest wall-clock, top quality, lean
main context, trivial cost. Treat `effort` as a **per-family tuning** knob, not a global
"low = fast" rule (it helped Opus/Gemini, hurt GPT-5.5). Reserve cheap tiers for genuinely
single-shot mechanical work, where the tier is timing-noise anyway; Gemini 3.5 Flash is a
strong cheap default when a frontier model is overkill.
