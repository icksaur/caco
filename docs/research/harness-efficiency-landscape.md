# Harness efficiency landscape

Survey date: 2026-07-01. Scope: opinionated coding-agent harnesses that wrap hosted or local LLMs and try to make agentic coding faster or cheaper at the tooling/scaffolding layer.

## Executive findings

The strongest published harness-level efficiency numbers are not from generic "summarize the transcript" features. They come from **changing the interface**: code-as-action for tool composition, bounded/retrieved code context instead of full-file reads, prompt-cache-aware context layout, and model routing/tiering. The best hard numbers found:

| Lever | Best published evidence | What it means for Caco |
|---|---:|---|
| Code-as-action for tool composition | Anthropic MCP example: 150k tokens -> 2k tokens, 98.7% reduction | Caco already has `caco_run_workflow`; next frontier is MCP/API progressive disclosure and durable skills/state |
| Context editing / stale tool clearing | Anthropic: 84% token reduction in a 100-turn web-search eval; +29% performance alone, +39% with memory | Add policy-driven stale observation clearing if SDK history permits; otherwise strengthen compaction handoff |
| Prompt caching | Anthropic: up to 90% cost and 85% latency reduction for long prompts; cached Sonnet input 10x cheaper in Manus pricing example | Caco cannot set Copilot SDK cache controls, but can maximize stable prefixes and avoid dynamic tool/schema churn |
| Learned model routing | RouteLLM: >85% cost reduction on MT Bench at 95% GPT-4 quality | Possible for subagents/workflows if SDK exposes model choice; main-loop routing needs quality gates |
| Repo maps / bounded retrieval | Aider: 1k-token default repo map with tree-sitter + graph ranking; Sourcegraph Cody ranks snippets with BM25 and other signals | Build ranked skeleton/search retrieval, not more full-file reads |
| Role tiering | Aider Architect/Editor: 85.0% pass rate vs 79.7% solo o1-preview; many pairings improve | Add explicit planner/editor/verifier model roles when multi-model routing is available |
| Token-efficient tools/editing | Anthropic token-efficient tool use: up to 70% output reduction, 14% average; Aider diffs avoid whole-file output | Caco already has patch/edit surfaces; can budget schemas and promote minimal-diff edits harder |

Important negative finding: shell-output compression alone is not enough. Caco's existing generic output shaper is valuable, but the larger surface is **read/context selection** and **turn-count reduction**. Prior local research already found tool-output compression systems claiming 60-95% savings, but independent replay suggested shell output can be only a few percent of total spend when native file reads dominate.

## Named harness map

| Harness/framework | Efficiency claim or proof | Mechanism | Evidence | Caco fit |
|---|---|---|---|---|
| Aider | Claims token-cost savings from repo maps and diff edits; publishes editing benchmarks | Tree-sitter repo map, graph/PageRank-like ranking, 1k default map budget, SEARCH/REPLACE and unified-diff edit formats, Architect/Editor role split | [Repo map docs](https://aider.chat/docs/repomap.html), [repo-map blog](https://aider.chat/2023/10/22/repomap.html), [edit formats](https://aider.chat/docs/more/edit-formats.html), [Architect/Editor benchmark](https://aider.chat/2024/09/26/architect.html) | Add ranked repo map and automatic skeleton-first retrieval; preserve patch/edit-first output |
| Claude Code / Anthropic | Proves context-editing and tool-use token reductions; documents subagent context isolation | Just-in-time grep/glob retrieval, compaction, context editing, memory tool, subagents with isolated contexts, Haiku subagents | [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), [context management](https://claude.com/blog/context-management), [subagents](https://code.claude.com/docs/en/sub-agents) | Copy subagent isolation policies and stale observation clearing; SDK may block native context editing |
| Claude Code Router | Claims lower cost through model substitution, not token reduction | Local Anthropic-compatible gateway routes default/background/think/longContext roles to different providers/models | [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router) | Useful pattern if Caco can route subagents/workflows by task class |
| OpenHands / CodeAct | Proves code actions can improve agent success | Executable Python code actions as unified action space | [CodeAct paper](https://arxiv.org/abs/2402.01030), [OpenHands README](https://github.com/All-Hands-AI/OpenHands) | Caco workflow tool is the same family; expand from local facade to composable API actions |
| Cline / Roo Code | Claims structured mode efficiency; Cline documents per-mode model tiering; Roo/Cline document auto-compact lineage | Plan/Act mode, deep planning, separate models per mode, auto-compact summaries near token limits | [Cline Plan and Act](https://docs.cline.bot/core-workflows/plan-and-act), [Cline auto-compact](https://docs.cline.bot/features/auto-compact) | Add explicit mode/model policy and plan artifacts for long tasks; Caco already has specs/plans by user preference |
| Continue | Claims configurable model specialization, no hard efficiency benchmark | Separate model roles: chat, autocomplete, edit, apply, embed, rerank | [Continue model roles](https://docs.continue.dev/customize/model-roles/intro) | Add first-class Caco roles: planner, editor, reviewer, retriever, summarizer |
| Cursor | Claims balanced intelligence/cost/reliability via Auto; publishes blended token prices | Auto routes to a lower-priced pool; Composer model pool; separate API pool | [Cursor models and pricing](https://cursor.com/docs/models-and-pricing) | Product-level routing analogy; Caco could expose "auto" policy if providers/models are selectable |
| Sourcegraph Cody | Claims speed/accuracy from ranked code context | RAG over Sourcegraph search; BM25 plus learned/tuned signals; global snippet ranking; local open-file context | [How Cody understands your codebase](https://sourcegraph.com/blog/how-cody-understands-your-codebase) | Build search/symbol/ranking layer over local repo; avoid full-file flooding |
| SWE-agent / mini-SWE-agent | Proves interface design matters on SWE-bench | Agent-Computer Interface: bounded file viewers, concise observations, edit/test feedback | [ACI paper](https://arxiv.org/abs/2405.15793), [SWE-agent README](https://github.com/SWE-agent/SWE-agent) | Tighten tool outputs as an interface, not just truncate them |
| Plandex | Claims large-task support through context/token management | Plans, loaded context items, tree-sitter project maps, token budgets, versioned diffs | [Plandex README](https://github.com/plandex-ai/plandex), [DeepWiki context/token notes](https://deepwiki.com/plandex-ai/plandex/5.2-context-and-token-management) | Project-level plan/context ledger could reduce rediscovery across turns |
| goose | Claims multi-model support; historical Lead/Worker mode used strong planner then cheaper worker | Provider/model routing, now planning mode; MCP extensions | [goose README](https://github.com/block/goose), [multi-model blog reference](https://github.com/block/goose/tree/main/documentation/blog/2025-06-16-multi-model-in-goose) | Copy failure-triggered escalation idea if verified in current docs |
| Codex CLI | Less public efficiency evidence; relevant because it standardizes local patch/apply workflow | Local coding agent, patch-oriented editing, configurable approvals/sandboxing | [Codex README](https://github.com/openai/codex) | Mostly confirms patch/edit interface and local harness norms |
| RA.Aid | Claims autonomous research/planning/implementation; integrates Aider | LangGraph task execution, memory management docs, optional Aider editing | [RA.Aid README](https://github.com/ai-christianson/RA.Aid) | Mostly a composition pattern; limited hard efficiency evidence |
| Tabby | RAG/codebase context, but sparse public agentic efficiency evidence | Self-hosted assistant, embeddings/retrieval, IDE context | [Tabby project](https://github.com/TabbyML/tabby) | Useful for local retrieval architecture, not a strong efficiency citation |
| Cloudflare Code Mode | Claims agents handle more tools and avoid intermediate-token waste | Convert MCP tools into TypeScript APIs; LLM writes code instead of direct tool calls | [Code Mode](https://blog.cloudflare.com/code-mode/) | Very close to Caco workflow tool; add MCP/tool API generation and progressive disclosure |
| Manus | Claims KV-cache hit rate is the production agent metric | Stable prompt prefix, append-only context, deterministic serialization, cache breakpoints, mask-not-remove tools | [Manus context engineering](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) | Caco can improve stable ordering even without SDK cache controls |

## Technique categories

### 1. Context compaction, summarization, and memory

**Idea.** Keep long-running tasks alive by removing stale observations or summarizing the transcript, while preserving durable decisions and task state outside the hot context.

**Who does it.**

- Claude/Anthropic: context editing automatically clears stale tool calls/results near context limits; memory tool stores facts in a client-side file system.
- Claude Code: compacts history and continues with the summary plus the five most recently accessed files.
- Cline/Roo lineage: auto-compact replaces old history with a comprehensive summary near context limits.
- Cognition/Devin: public comments emphasize prompt caching and long-codebase context; its "don't build multi-agents" essay favors single shared context plus compaction over independent workers.
- RA.Aid/Plandex: persistent memory/plans provide out-of-band state for multi-step work.

**Mechanism.**

- Summarize conversation state into a compact handoff.
- Clear stale tool results, especially old file reads and test outputs.
- Persist durable facts, plans, and unresolved issues to files or memory stores.
- Keep recent working files or anchors in context to avoid losing active edit state.

**Published evidence.**

- Anthropic context management reports +29% performance from context editing alone and +39% when combined with memory on an internal agentic-search eval. In a 100-turn web-search eval, context editing reduced token consumption by 84% and enabled workflows that otherwise failed from context exhaustion: [Claude context management](https://claude.com/blog/context-management).
- Anthropic's context-engineering post frames context as an attention budget and describes compaction preserving architectural decisions, unresolved bugs, and implementation details while discarding redundant tool outputs: [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).
- Cline documents auto-compact as summary generation rather than old truncation, with prompt-cache reuse so users mostly pay for summary output tokens: [Cline auto-compact](https://docs.cline.bot/features/auto-compact).

**Claim vs prove.** Anthropic proves with internal eval numbers. Cline/Roo mostly claim product behavior; no public benchmark found.

**Caco fit.** Partial. Caco has session history and output shaping, but not policy-driven stale-observation clearing. Add a "context editor" pass that deletes or replaces old shaped tool observations with retrieve handles, while preserving spec/plan/checkpoint state.

### 2. Retrieval, repo maps, and bounded code reads

**Idea.** Replace "read whole files until the model understands" with ranked structural maps and bounded reads. The harness owns file indexing, symbol extraction, snippet ranking, and line-window retrieval.

**Who does it.**

- Aider: tree-sitter repo map with key symbols/signatures and graph ranking.
- Sourcegraph Cody: search/RAG snippets ranked with BM25 plus tuned signals; local open-file context merged into global ranking.
- Claude Code: just-in-time glob/grep/file tools instead of stale pre-indexes.
- SWE-agent: bounded file viewer/search as part of ACI.
- Plandex: tree-sitter project maps and context-item budgeting.
- Continue/Tabby/Cursor/Cody: semantic/vector or hybrid codebase retrieval.

**Mechanism.**

- Extract symbol skeletons and definition signatures.
- Rank files/symbols using graph centrality, lexical search, embeddings, BM25, recency, open-file state, and current-task anchors.
- Give the model identifiers and exact line ranges first; require bounded reads for bodies.
- Keep retrieval dynamic enough to avoid stale indexes.

**Published evidence.**

- Aider sends a "concise map of your whole git repository" with important classes/functions/types/call signatures. It optimizes the map by ranking a dependency graph and defaults `--map-tokens` to 1k tokens: [Aider repo map docs](https://aider.chat/docs/repomap.html), [Aider repo-map blog](https://aider.chat/2023/10/22/repomap.html).
- Anthropic describes Claude Code's hybrid: `CLAUDE.md` up front, glob/grep just-in-time, bypassing stale indexing and complex syntax trees; it notes runtime exploration is slower than precomputed retrieval: [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).
- Sourcegraph Cody retrieves snippets from selected repositories, ranks them with BM25 plus tuned signals, merges with IDE-local context, then sends the top N snippets as prompt context: [Cody codebase context](https://sourcegraph.com/blog/how-cody-understands-your-codebase).
- SWE-agent's ACI paper reports 12.5% pass@1 on SWE-bench and 87.7% on HumanEvalFix, attributing gains to purpose-built interactive interfaces: [SWE-agent paper](https://arxiv.org/abs/2405.15793).

**Claim vs prove.** Aider and Cody document mechanisms but give limited direct token-savings numbers. SWE-agent proves interface quality, not token reduction. The qualitative consensus is strong.

**Caco fit.** High. Caco has an `index`/`frames` style runtime surface, but not an automatic ranked repo map or "skeleton before body" policy. This is the highest-leverage missing read-surface feature beyond the existing shaper/workflow.

### 3. Tool-output shaping and observation compression

**Idea.** Tool observations should be designed outputs, not raw stdout/stderr dumps. Preserve correctness with raw-output handles, but send only failure-focused summaries or relevant rows/snippets to the model.

**Who does it.**

- Caco: generic output shaper plus retrieve handles.
- Anthropic MCP/code-execution pattern: filter/aggregate in code before model observation.
- SWE-agent: ACI emphasizes concise, informative feedback.
- RTK/Headroom/Caveman ecosystem: proxies that compress shell/log/file/tool streams before the model sees them.
- Claude context editing: clears stale tool results later, after they stop mattering.

**Mechanism.**

- Shape build/test output around failing files, error lines, stack traces, and next actionable context.
- For large tables or API responses, filter in the execution environment and return only final rows/aggregates.
- Store raw bytes behind a retrieval handle for lossless recovery.
- Delete or compact stale observations after they have served their purpose.

**Published evidence.**

- Anthropic's MCP post states intermediate tool results can add 50,000 tokens for a 2-hour transcript, because each intermediate result flows through the model; code execution lets the model see five rows instead of 10,000 and return only final results: [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp).
- SWE-agent frames ACI around concise, informative feedback and reports benchmark gains from interface design: [SWE-agent paper](https://arxiv.org/abs/2405.15793).
- RTK/Headroom-style tools claim 60-95% reductions on compressed tool/log streams, but independent local research in this repo found shell-output compression can be a small share of total spend when native reads dominate: see `docs/research/harness-token-techniques-research.md`.

**Claim vs prove.** Anthropic proves the pattern in a constructed MCP scenario. RTK/Headroom claims are large but need task-level replay validation.

**Caco fit.** Already has the core shaper. Bigger add: shape native read/search outputs and stale observations, not just shell/test/build output.

### 4. Round-trip reduction and code-as-action

**Idea.** Each agent turn has fixed latency and causes cache replay on later turns. Let the model write a small program that performs local control flow, loops, filtering, joins, and multiple tool calls, then returns only the compact result.

**Who does it.**

- Caco: `caco_run_workflow`.
- Anthropic: code execution with MCP as code APIs.
- Cloudflare: Code Mode converts MCP tools into a TypeScript API.
- OpenHands/CodeAct: executable code actions as the agent action space.
- Aider Architect/Editor: adds a second inference step for quality, but reduces retries from edit-format failures.

**Mechanism.**

- Expose a safe facade/API to model-written code.
- Keep intermediate values in the execution environment.
- Return final JSON/text summary and raw handles.
- Use normal programming constructs for conditionals, loops, retries, joins, and local assertions.

**Published evidence.**

- Anthropic's MCP post gives the clearest number: loading tool definitions and passing intermediate results can cost 150,000 tokens; representing tools as a code API and returning only the final answer reduces it to 2,000 tokens, a 98.7% reduction: [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp).
- Cloudflare Code Mode reports that agents handle more tools and complex tools when presented as TypeScript APIs, and avoid copying each tool result through the model: [Cloudflare Code Mode](https://blog.cloudflare.com/code-mode/).
- CodeAct reports executable code actions outperform widely used alternatives by up to 20% success rate across tested LLM agents: [CodeAct paper](https://arxiv.org/abs/2402.01030).

**Claim vs prove.** Strong. Anthropic gives token numbers; CodeAct gives success-rate numbers; Cloudflare gives primary qualitative product evidence.

**Caco fit.** Already has V1. Next ideas: generate typed facades for external MCP servers, on-demand tool discovery, persistent workflow libraries/skills, and safety policies for side-effectful code.

### 5. Prompt caching and KV-cache exploitation

**Idea.** Hosted model APIs often charge cached input far less and serve it faster. Harnesses can maximize cache hits by stabilizing prompt prefixes, append-only history, deterministic serialization, and avoiding dynamic tool/schema churn.

**Who does it.**

- Anthropic API/Claude ecosystem: prompt caching, cache-aware rate limits, automatic longest-prefix matching.
- Manus: stable prefix, append-only context, deterministic serialization, cache breakpoints, "mask, don't remove" tools.
- Cursor: exposes cache-read/cache-write prices in its pools.
- Cognition/Devin: cited by Anthropic as using prompt caching for codebase context with lower cost/latency.

**Mechanism.**

- Put stable system prompt, tool descriptions, instructions, and docs before volatile user/session data.
- Do not include timestamps/random IDs in early prompt segments.
- Serialize JSON deterministically.
- Prefer stable tool lists with runtime masking over adding/removing tool schemas per turn, unless the removed schemas more than offset cache loss.
- Keep large reused codebase context behind cache breakpoints where APIs allow.

**Published evidence.**

- Anthropic reports prompt caching can reduce costs by up to 90% and latency by up to 85% for long prompts; cache-read tokens no longer count against Claude 3.7 Sonnet ITPM limits: [Token-saving updates](https://claude.com/blog/token-saving-updates).
- Manus reports Claude Sonnet cached input at $0.30/MTok versus uncached at $3/MTok, a 10x difference, and calls KV-cache hit rate the single most important production-agent metric: [Manus context engineering](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus).
- Cursor's pricing page makes cache economics visible: Auto pool cache read $0.25/MTok, input/cache-write $1.25/MTok; Anthropic API pool examples list cache reads at 0.1x input price: [Cursor models and pricing](https://cursor.com/docs/models-and-pricing).

**Claim vs prove.** Anthropic proves API-level savings for long prompts. Manus gives operational claims and pricing math. Cursor publishes prices, not benchmark impact.

**Caco fit.** Partial but constrained. The Copilot SDK may not expose `cache_control`, so Caco's realistic levers are stable prompt ordering, deterministic tool/schema serialization, avoiding volatile prefixes, and measuring schema churn.

### 6. Model routing and tiering

**Idea.** Use cheaper/faster models for easy or narrow tasks and stronger models for planning, reasoning, verification, or long-context cases.

**Who does it.**

- RouteLLM and FrugalGPT: query-level routing/cascades.
- claude-code-router: role/context routing between providers/models.
- Cline: Plan/Act with separate models.
- Continue: roles for chat/autocomplete/edit/apply/embed/rerank.
- Aider: Architect/Editor split.
- Cursor: Auto blended routing/pool.
- goose: historical Lead/Worker and current planning direction.
- Claude Code: subagents can use cheaper Haiku for explore/plan-style tasks.
- Amp: mode-based model selection (`deep`, `smart`, `rush`).

**Mechanism.**

- Pre-route: classify task difficulty and choose model.
- Cascade: ask cheap model first, verify confidence/quality, escalate if needed.
- Role tiering: strong planner, cheap editor/executor, specialized retriever/reranker.
- Failure-triggered fallback: let a cheap worker proceed until tool errors, syntax failures, or user corrections cross a threshold.

**Published evidence.**

- FrugalGPT reports matching best individual LLM performance with up to 98% cost reduction, or improving GPT-4 accuracy by 4% at same cost: [FrugalGPT](https://arxiv.org/abs/2305.05176).
- RouteLLM reports cost reductions over 85% on MT Bench, 45% on MMLU, and 35% on GSM8K while achieving 95% GPT-4 performance; MT Bench matrix-factorization router needs only 14% GPT-4 calls for 95% performance: [RouteLLM blog](https://www.lmsys.org/blog/2024-07-01-routellm/), [RouteLLM paper](https://arxiv.org/abs/2406.18665).
- Aider Architect/Editor hits 85.0% pass rate using o1-preview as Architect with o1-mini or DeepSeek as Editor, versus 79.7% solo o1-preview; many self-pairs improve over solo: [Aider Architect/Editor](https://aider.chat/2024/09/26/architect.html).
- Cline documents separate models for Plan and Act with cost/speed example pairings: [Cline Plan and Act](https://docs.cline.bot/core-workflows/plan-and-act).
- Cursor documents Auto choosing models that balance intelligence, cost efficiency, and reliability, with lower blended Auto/Composer prices than direct API-pool frontier models: [Cursor models and pricing](https://cursor.com/docs/models-and-pricing).

**Claim vs prove.** RouteLLM/FrugalGPT prove query routing on benchmarks. Aider proves role tiering on its code-editing benchmark. Product harnesses mostly claim.

**Caco fit.** Medium/high if SDK model selection is available per subagent/tool. Start with low-risk routing: cheap read-only explore/retrieval, expensive final reasoning, cheap deterministic edit application, strong reviewer/verifier.

### 7. Speculative, draft-then-verify, and verifier loops

**Idea.** Split generation into draft and verification. This can mean token-level speculative decoding inside a model server, or harness-level "cheap draft, strong verify/repair" loops.

**Who does it.**

- Speculative decoding research: small draft model + large verifier at token level.
- FrugalGPT: cheap responses escalated by a learned scorer/cascade.
- Aider: Architect/Editor separates reasoning and edit-format verification/application.
- goose historical Lead/Worker: failure-triggered fallback to the lead model.
- Code review/security-review subagents in harnesses: independent verifier after implementation.

**Mechanism.**

- Token-level speculative decoding: draft several tokens, verify in parallel with target model, preserve identical distribution.
- Harness-level draft/verify: cheap model proposes edit/answer; stronger model, tests, typecheck, or oracle validates and repairs/escalates.

**Published evidence.**

- Speculative decoding reports 2x-3x acceleration over standard T5X implementation with identical outputs: [Fast Inference from Transformers via Speculative Decoding](https://arxiv.org/abs/2211.17192).
- FrugalGPT and RouteLLM evidence above support query-level verify/escalate economics.
- Aider Architect/Editor evidence above supports role split for code edits.

**Claim vs prove.** Token-level speculative decoding is proven but not directly implementable by a harness over hosted APIs. Harness-level verifier loops have strong related evidence but need task-specific gates.

**Caco fit.** Add verifier-driven escalation where Caco has hard oracles: tests, typecheck, lint, patch application, code-review agent. Do not market hosted-API speculative decoding as a Caco lever.

### 8. Tool-schema and description budgeting

**Idea.** Tool schemas are a per-turn tax. Harnesses can lazy-load tool definitions, group tools behind a code API, trim descriptions, or expose schema detail progressively.

**Who does it.**

- Caco: `measure-tools.mts` and tool-schema diet in `docs/spec-budget.md`.
- Anthropic MCP code-execution: file tree of tools, read definitions on demand, `search_tools` with detail levels.
- Cloudflare Code Mode: TypeScript API instead of raw direct tool-call schemas.
- Manus: mask tools without changing the prompt prefix to preserve cache.
- Claude Code: subagents can restrict tool access; Explore/Plan skip some startup context.

**Mechanism.**

- Register fewer top-level tools.
- Move many operations behind one typed facade or filesystem API.
- Provide name-only -> description -> full schema progressive disclosure.
- Preserve cache by keeping ordering stable or masking unavailable tools.
- Measure schema bytes before/after merges.

**Published evidence.**

- Anthropic describes thousands of MCP tools costing hundreds of thousands of tokens before the agent reads the request, and proposes code APIs plus on-demand tool discovery: [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp).
- Cloudflare reports TypeScript APIs let agents handle more and more complex tools than direct MCP tool calls: [Code Mode](https://blog.cloudflare.com/code-mode/).
- Manus emphasizes stable prompt prefixes and avoiding dynamic tool changes because a one-token difference invalidates cache from that token onward: [Manus context engineering](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus).

**Claim vs prove.** Anthropic and Cloudflare provide strong qualitative evidence plus Anthropic's 98.7% constructed token example. Caco has direct local measurement for schema byte deltas.

**Caco fit.** Already has schema diet. Bigger add: progressive tool discovery and generated API docs for large optional tool groups.

### 9. Diff/edit formats and patch application

**Idea.** Do not ask the model to rewrite whole files. Ask for minimal edits in a familiar, robust format and let the harness apply/validate them.

**Who does it.**

- Aider: SEARCH/REPLACE, unified diff, editor-diff/editor-whole.
- Codex CLI and Copilot-style harnesses: patch/apply workflows.
- Anthropic `text_editor`: targeted edits for source/doc text.
- Continue: `apply` model role decides how to apply edits.

**Mechanism.**

- Output only changed hunks.
- Prefer formats strongly represented in training data, especially unified diff.
- Use exact-search replacement or AST-aware edit application when possible.
- Validate patch application and re-run oracles.

**Published evidence.**

- Aider documents whole-file mode as slow/costly because the model returns the entire file even for small edits; diff and udiff only return changed portions: [Aider edit formats](https://aider.chat/docs/more/edit-formats.html).
- Aider's unified-diff benchmark reduced GPT-4 Turbo "lazy coding" by 3x: SEARCH/REPLACE baseline 20% vs unified diff 61%; GPT-4-0613 improved 26% -> 59%: [Unified diffs make GPT-4 Turbo 3X less lazy](https://aider.chat/2023/12/21/unified-diffs.html).
- Anthropic token-saving updates say the `text_editor` tool reduces token consumption and latency while increasing accuracy: [Token-saving updates](https://claude.com/blog/token-saving-updates).

**Claim vs prove.** Aider provides direct edit benchmark evidence. Anthropic claims product improvement without public task-level numbers for `text_editor`.

**Caco fit.** Already has `apply_patch` and edit surfaces. Add stronger prompts/oracles that penalize whole-file rewrites and require minimal hunks.

### 10. Turn-count reduction and latency dominance

**Idea.** Token throughput is roughly bounded, but each turn also pays time-to-first-token, tool dispatch, and future cache replay. Reducing turns can dominate wall-clock latency even when output tokens increase.

**Who does it.**

- Caco: explicitly models round trips saved and cache replay in `docs/spec-budget.md`.
- Anthropic/Cloudflare: code execution avoids alternating model/tool/model/tool for loops and data plumbing.
- Claude subagents/background agents: isolate long exploration and return summaries; can run in parallel.
- Cline deep planning and Plandex plans: reduce rediscovery turns by committing a plan.

**Mechanism.**

- Batch independent reads/greps/shell calls.
- Run parallel subagents for independent research paths.
- Let code execute local loops/conditionals.
- Persist plans and checkpoints to avoid repeated "what was I doing?" turns.
- Avoid weak oracles that cause retry loops.

**Published evidence.**

- Anthropic MCP post explicitly says code execution saves time-to-first-token latency because the model does not need to evaluate an if-statement turn by turn: [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp).
- Cloudflare Code Mode states direct tool chaining wastes time, energy, and tokens by feeding every output through the neural network just to copy it to the next tool input: [Code Mode](https://blog.cloudflare.com/code-mode/).
- Anthropic multi-agent research reports multi-agent systems outperformed single-agent Opus 4 by 90.2% on an internal research eval, but used about 15x tokens versus chat and is less applicable to tightly sequential coding tasks: [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system).

**Claim vs prove.** Strong qualitative support; few harnesses publish turn-count benchmarks. Caco's own metrics can make this measurable.

**Caco fit.** Already central. Next add: automatic fan-out detection suggestions, parallel-read batching in tool guidance, and per-task "turns avoided" dashboards tied to actual oracles.

## Cross-cutting patterns

### Progressive disclosure beats giant upfront context

The best harnesses expose a small stable map first, then let the model ask for detail. Aider does this for code symbols; Anthropic does it for MCP tool schemas; Cody does it for ranked snippets; Caco can do it for repo structure, tool docs, applets, and command output.

### "Compression" must be loss-aware

Summaries save tokens but can delete the one line needed to fix a bug. The safer pattern is: compact by default, preserve raw bytes behind handles, and make the retrieval path cheap and obvious. Caco's output shaper has the right safety shape; extend it to reads and stale observations.

### Model routing needs oracles

Cheap models save money only if bad cheap outputs are caught. Routing works best when the harness has hard gates: patch applies, typecheck, tests, lint, exact output shape, reviewer verdicts. Avoid unconstrained cheap-model routing for final architectural decisions.

### Cache-aware design conflicts with dynamic tool hiding

Tool-schema diet says "register fewer tools"; cache alignment says "do not change the stable prefix." The harness needs measurements for both. Dynamic tool removal can save schema bytes but destroy cache reuse; stable tool sets with runtime masking can be cheaper in long sessions.

## Ranked shortlist: highest-leverage ideas Caco does not yet have

1. **Ranked repo map plus skeleton-first read policy.** Build a task-aware repo map from symbols, imports, references, recent files, grep hits, and open/edited files. Return line ranges and signatures first, bodies only on bounded reads. This attacks the read surface, not just shell output.

2. **Context editor for stale observations.** Replace old file reads, test output, and command logs with compact summaries plus retrieve handles once they are no longer recent. Preserve decisions, current files, failing locations, and plan state. This is the closest Caco-owned analogue to Anthropic context editing.

3. **Prompt-cache alignment audit.** Measure prompt prefix stability across turns: tool order, schema serialization, injected memory order, footer/session metadata, timestamps, random IDs. Even without SDK cache controls, stable prefixes are Caco-owned.

4. **Progressive tool discovery/API facade.** Keep rarely used tool schemas out of the hot path. Expose name-only discovery, on-demand full schemas, and a typed workflow API for large tool families. Caco's workflow tool can become the execution side of this.

5. **Model-role policy for subagents/workflows.** Define planner, explorer, editor, reviewer, summarizer, and verifier roles with configurable model tiers. Start where failure is recoverable: read-only exploration, summary generation, edit application, and review.

6. **Verifier-driven cheap-draft escalation.** Let cheaper workers attempt bounded edits or summaries; escalate only when patch application, typecheck/tests, schema validation, or review fails. This imports FrugalGPT/RouteLLM economics into coding tasks with hard oracles.

7. **Read/output shaping with structured handles.** Generalize the existing shaper from bash/test/build output to file reads, grep floods, GitHub API results, browser snapshots, and applet state. Use typed handles (`read`, `grep`, `logs`, `artifact`) and retrieval ranges.

8. **Turn-count budget gates.** Add per-task metrics for turns, prompt bytes, shaped bytes, workflow commands, and cache-replay estimate. Use the metrics to flag when an agent should have batched reads or used a workflow. This makes the latency thesis falsifiable.

## Sources

- Aider repo map docs: https://aider.chat/docs/repomap.html
- Aider repo-map blog: https://aider.chat/2023/10/22/repomap.html
- Aider edit formats: https://aider.chat/docs/more/edit-formats.html
- Aider unified-diff benchmark: https://aider.chat/2023/12/21/unified-diffs.html
- Aider Architect/Editor benchmark: https://aider.chat/2024/09/26/architect.html
- Anthropic effective context engineering: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Anthropic context management: https://claude.com/blog/context-management
- Anthropic token-saving updates: https://claude.com/blog/token-saving-updates
- Anthropic code execution with MCP: https://www.anthropic.com/engineering/code-execution-with-mcp
- Anthropic Claude Code subagents: https://code.claude.com/docs/en/sub-agents
- Anthropic multi-agent research system: https://www.anthropic.com/engineering/multi-agent-research-system
- Cloudflare Code Mode: https://blog.cloudflare.com/code-mode/
- CodeAct paper: https://arxiv.org/abs/2402.01030
- SWE-agent ACI paper: https://arxiv.org/abs/2405.15793
- FrugalGPT: https://arxiv.org/abs/2305.05176
- RouteLLM blog: https://www.lmsys.org/blog/2024-07-01-routellm/
- RouteLLM paper: https://arxiv.org/abs/2406.18665
- Speculative decoding: https://arxiv.org/abs/2211.17192
- Sourcegraph Cody context: https://sourcegraph.com/blog/how-cody-understands-your-codebase
- Cline Plan and Act: https://docs.cline.bot/core-workflows/plan-and-act
- Cline auto-compact: https://docs.cline.bot/features/auto-compact
- Continue model roles: https://docs.continue.dev/customize/model-roles/intro
- Cursor models and pricing: https://cursor.com/docs/models-and-pricing
- Claude Code Router: https://github.com/musistudio/claude-code-router
- OpenHands README: https://github.com/All-Hands-AI/OpenHands
- Codex README: https://github.com/openai/codex
- Plandex README: https://github.com/plandex-ai/plandex
- Plandex context/token notes: https://deepwiki.com/plandex-ai/plandex/5.2-context-and-token-management
- goose README: https://github.com/block/goose
- RA.Aid README: https://github.com/ai-christianson/RA.Aid
- Tabby: https://github.com/TabbyML/tabby
- Manus context engineering: https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
