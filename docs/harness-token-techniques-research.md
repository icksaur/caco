# Harness token/speed techniques — research aggregation

Research into how the *same* model gets faster/cheaper/better through harness
technique. Five parallel GPT-5.5 scatter searches: HN thread 48588755, rtk-ai,
"code execution as orchestration", cross-tool survey, caching/compaction.

## The one number that reorders everything

Independent replay (Codepointer, 614M tokens / $926): shell-output compression
tools (RTK / Headroom / Caveman) saved **0.5–3.7% of total spend**, because
**~78% of tokens flow through native file *Read* tools, not shell**. RTK only
touched 22% of tool-output tokens.

**Conclusion:** the win is in *reads* (indexing, bounded structural access) and
*cache alignment* — **not** shell-output compression. The user's instinct that
"tool output compression" is a top lever is half-right: it matters for the
*read/test/lint* surface, marginally for shell.

## Cross-tool consensus (what the best harnesses agree on)

| Technique | Consensus | Reported impact | Caco status |
|---|---|---|---|
| Bounded reads (range/grep-first, never dump whole files) | Universal | 78% of tokens; biggest surface | Partial — SDK `view`/`grep` support ranges; not enforced as default |
| AST repo map / code skeleton | Strong (Aider, Cursor, Cline, Claude Code) | Tilth: −40% cost/correct, 76→86% acc, −25% turns; Cursor +12.5% acc | **Spec'd** (`docs/spec-ast-index-tool.md`), not built |
| Prompt-cache alignment (stable prefix/order) | Strong (Anthropic/OpenAI/Claude Code) | OpenAI: −80% latency, −90% input cost; cache read = 0.1× | Prefix is stable; **but cache_control not exposed by Copilot SDK** |
| Tool-output compression w/ raw recovery | Strong (RTK, Roo, Cline, Claude Code hooks) | Logs: 10k→100s tokens; total spend only 0.5–3.7% | SDK spill-to-disk @20KB only; no failure-aware shaping |
| Context compaction / new-task handoff | Strong | Essential for long runs | **Have it** (SDK `infiniteSessions` 0.80/0.95 + `history.compact`) |
| Diff/patch edits (not full rewrites) | Strong | Smaller outputs, safer | **Have it** (`edit`, `apply_patch`) |
| Subagents for context isolation | Strong | Keeps noise out of coordinator | **Have it** (task/delegate/swarm) |
| Code-execution orchestration | Emerging, promising | Anthropic 150k→2k tool-def tokens (98.7%); CodeAct +20% success | None |
| Model routing (cheap model for grunt work) | Strong | Cline 10–100× routine cost | Partial (multi-model sessions) |

## Caco lever reality (through the Copilot SDK)

The Copilot SDK exposes **no** `cache_control` / `prompt_cache_key`. Caching is
governed by GitHub's proxy. Caco's only caching lever is **prompt stability** —
which it already honors (memory injection is stable key-value, no timestamps).
Anthropic context-editing / memory tool are direct-API only, unreachable here.

So Caco's open frontier = the **read surface** + **observation shaping**, both
of which Caco fully owns at the tool layer.

## The "10% that gets 90%" — three core abilities

1. **AST index / code-nav tool** (highest leverage; already spec'd).
   Skeleton with exact line ranges → bounded reads instead of whole-file dumps.
   Attacks the 78% read surface directly. Build TS/JS first, then C++/C#.

2. **Failure-preserving observation shaping with a recovery handle.**
   At Caco's tool boundary, compact test/build/lint/grep output to
   *what-failed-and-where*; store the raw output keyed by id; expose a
   `retrieve(id)` so nothing is silently lost. Cheap, owns the tool layer.

3. **`caco_run_workflow` (code-execution orchestration) — V2.**
   One tool: model writes TS/Python against a curated *read-only* facade of
   existing Caco tools, run in the existing sandbox; loop/filter/aggregate
   locally, return only the compact result + handle to raw. Biggest token
   numbers but highest operational cost (sandboxing model code, approval
   semantics). Read-only, opt-in, measured first.

## Explicitly NOT worth copying

- Shell-command rewrite proxies / TOML filter ecosystems (RTK): 0.5–3.7% spend,
  brittle, semantic-loss risk, vanity savings dashboards.
- Full MCP "Code Mode" platform up front.
- Model routing as a headline feature (SDK-dependent, not "same model").

## Sources (selected)

- HN 48588755 "Token Compression Illusion" + Codepointer independent replay.
- Anthropic: "Code execution with MCP", "Writing tools for agents", prompt
  caching, context-editing, compaction docs.
- Aider repo-map, Cursor search, Roo/Cline tool docs, Tilth README.
- rtk-ai.app + github.com/rtk-ai/rtk source.
