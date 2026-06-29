# spec-ast-index-tool

Cheaper/faster agent code-nav: read structure, not whole files. Two shipped
primitives (`index`, `caco.frames`) plus the open call-graph work. ~78% of agent
tokens flow through file reads, so skeleton-then-bounded-read is the top lever
(Tilth: −40% cost/correct; Maki: +59 tok/turn, −224 tok/turn on reads).

## Goals

A: from a path, get a declaration skeleton with exact `[start-end]` ranges →
bounded `view_range` instead of dumping the file. B: from a symbol, get its
definition + ranked callers in one call. C (open): outgoing callees / call graph.
Win only materializes if the prompt is suggestive enough that agents reach for
these before broad reads — phrasing is part of scope.

## Design

**Per-file index (`index` tool, DONE).** `web-tree-sitter` WASM, one adapter for
TS/JS/C++/C#. Pure `(path, bytes) → IndexResult`; on-demand, stateless, no crawl,
no result cache (re-parse current bytes → never stale). Runtime: `Parser.init()`
once + per-grammar `Language.load()` cached, single-flight, fault-isolated; 1 MiB
parse cap (oversized → range-read hint). `src/index/` core/extractors/format/
runtime/tree-sitter-adapter/types.

**Symbol nav (`caco.frames`, DONE).** definitions + ranked `incoming` callers +
snippets in one workflow call. Mechanism: index for the def, scoped `grep` for
call-sites, name-match link (Aider repo-map style, not semantic) — `confidence:
exact|heuristic`. Uses `grep`/`glob`/`read`/`index` (grepCore prefers vendored
`rg`, auto-falls back to pure JS) — no `rg`/`sh` *requirement*, Windows-portable.
`outgoing` deferred (needs semantic resolution, below).

**Call graph (OPEN, C).** Honest callees need scope/type/import resolution, so
they are a semantic job, not name-match (per graph-reads/caco-frames specs): TS
compiler API (already a dep) + Roslyn for C#. Name-match only honestly serves
*incoming* aggregation — the per-file tags → symbol table → PageRank repo map
(Aider style) extends frames' incoming, portable on WASM but blind to overloads.
Outgoing/callees and any cross-file edge claim ride the semantic adapters.
Repo-wide persistence stays out — crawl/staleness/locking reintroduce every risk
per-file design removed.

## Invariants

- WASM-only, no native `.node`; portable via `npm install` (Windows work box).
- Index pure/read-only; trees+results not retained; outside-cwd paths rejected.
- frames/graph correctness must not *require* `rg`/`sh` (grepCore JS fallback); rg is a speed bonus.

## Considerations

- **Prompt suggestiveness is load-bearing.** Tool saves nothing unused; `index`
  desc nudges "before broad reads"; `frames` lives in the facade summary. Open: a
  graph nudge needs the same. Unmeasured across models.
- Name-match graph is noisy (overloads/dynamic dispatch) — gate on dogfooding
  before semantic build.
- Event-loop stall under fan-out bounded by parse cap; worker pool is the v2 path.

## Risks and Mitigations

- Call-graph backend uncertainty → ship name-match first, measure cross-file hunting, only then Roslyn/TS-API.
- Agents assume a persistent repo index → tool desc says per-file, no crawl.
- Roslyn install on locked Windows → keep semantic adapter optional, wasm default.

## Acceptance

- Observable: `index`/`frames` output materially smaller than full files, ranges support targeted reads.
- Gates: typecheck ×2, lint:strict, knip, full tests, build:client.
- Oracles: `index-tool.test.ts` (1-based range/property invariants + unsupported/size/budget), `frames.test.ts` (def+incoming, confidence, path/CRLF). Outgoing graph: golden callee set vs hand-traced semantic fixture (per language).

## Plan

| # | Step | Files | Oracle | Status |
|---|------|-------|--------|--------|
| 1 | per-file index tool, 4 lang families (TS/JS/C++/C#; TSX own grammar) | `src/index/*`, `src/index-tool.ts` | index-tool.test range/property | done |
| 2 | frames v1 def+incoming | `src/index/frames.ts` | frames.test | done |
| 3 | verify view_range roundtrip (index range → view returns that decl) | view tool | test: index decl range → view text contains label | open |
| 4 | dogfood; exit when traces show index/frames before broad reads on ≥N tasks, no read-token regression | — | bench tokens/turn | open |
| 5 | outgoing callees — semantic (TS-API), C# later | new TS adapter | callee golden vs hand-traced | open |
| 6 | graph prompt nudge | `prompts.ts`/facade summary | bench unchanged | open |
| 7 | semantic v2 fidelity (Roslyn) only if misses cost reads | new adapters | golden vs IDE | open |
| 8 | repo-level persistent index | separate spec | — | deferred |

## Rationale

Per-file primitive proven; frames collapses index+read chains. Call graph is the
real backend uncertainty: name-match honestly serves only *incoming* aggregation;
honest *outgoing* callees need semantic resolution (TS-API, then Roslyn). Repo-wide
index stays a future spec — its mutable shared state is the cost per-file design avoids.
