# Tool diet — reduce tool-call count and output

## Goal

Cut the two costs that dominate agent latency and spend:
1. **Calls** — every tool call = one reasoning pass on the critical path + a result
   that is re-sent (cached) every later turn. Fewer calls = fewer round trips.
2. **Output** — large/raw tool output floods context and the re-sent prompt.

Latency model: per turn ≈ `TTFT + reasoning_decode + output_decode + tool_exec + RTT`.
`reasoning_decode` dominates and is serial, so **N sequential calls ≈ N reasoning
passes**. Collapsing decided, independent fan-out into one `caco_run_workflow` removes
N−1 passes. That is the biggest speed lever Caco can pull.

Non-goal: removing tools that carry genuine lifecycle/interactivity (bash sessions,
browser, agents/sessions) or low static cost + high utility (index, retrieve).

## Current surface (measured)

~30 tools across 18 files, ~115 KB of description text paid on every turn. Heaviest
description files: applet (18KB), browser (16KB), dev-docs (11KB), agent (9KB),
swarm (8KB), roadmap (7KB), surface (6KB).

The `caco` facade inside `caco_run_workflow` already mirrors the read surface:
`read`→view, `grep`→grep, `glob`→glob, `index`→index, `retrieve`→retrieve_output,
plus `sh` (shell) and `rg` (raw) escape hatches; one `emit` returns a compact result.

## Workstreams

Each item is tagged **DECIDED** (do it), **SPEC** (design first), or **RESEARCH**
(prove viability before committing). Order: cheap decided removals → specs → research →
the risky output cut last (gated on measurement).

### A. Reduce calls — remove expensive tools

| Item | Tag | Tools affected | Notes |
|---|---|---|---|
| A1. Remove session-context applet (notes, roadmap, "context dashboard") | DECIDED | `get_roadmap`, `update_roadmap`, `session_note` + the applet | Too expensive for its value. Audit back-refs first (does anything read the persisted roadmap/notes on resume? does the surface "roadmap" style depend on it?). Migrate any must-keep state. |
| A2. Keep Session Surface | DECIDED (no-op) | `caco_get_surface`, `caco_get_surface_changes`, `caco_mutate_surface`, `caco_clear_surface_changes`, `caco_set_surface_style` | High utility at work; cost acceptable there. Leave as-is. |
| A3. Replace `caco_offer_action` with output-parsed UI | RESEARCH→SPEC | `caco_offer_action` | Keep the feature, try to kill the tool call. Define an unambiguous fenced markup the assistant emits inline; the frontend parses it post-stream and renders the same buttons. **Do not assume safe:** removing the typed tool schema removes the contract that makes the model reliably produce the right shape — measure reliability (does the model emit the markup when wanted, never spuriously?) before committing. Must not collide with prose/code fences or break on partial streams. Remove the tool only once parity AND reliability are shown. |
| A4. Audit the remaining tools for diet candidates | RESEARCH | all others | Score each by static cost (desc bytes) × utility × call frequency. Candidates to scrutinize: dev-docs (11KB), extensions, mcp-auth, memory, session-history-sql, embed_media, applet howto/usage. Produce a keep/trim/remove table. |
| A5. Cheap wins before removals: trim descriptions, consolidate tool groups | RESEARCH | applet (18KB), browser (16KB), surface (6KB) groups | Lowest-risk static-cost cut: shorten verbose description text and consider consolidating the 6 browser / 6 applet / 5 surface tools behind fewer entry points. Pure prompt-byte savings with no capability loss; do before the riskier removals. |

### B. Reduce calls — add multi-target tools

| Item | Tag | Notes |
|---|---|---|
| B1. `multi_edit` (edit many files / many hunks in one call) | RESEARCH (low priority) | Today each edit is a call + reasoning pass. **But SDK `parallel_tool_calls` may already capture most of this** — the model can emit N edits in one response. Only build if D1 edit-latency data proves batched edits beat parallel calls. Deprioritize until then. |
| B2. Graph reads (call graph, dependency graph) | RESEARCH | Frame as **extending the existing `index`/tree-sitter tool** (`ast-index-tool-spec.md`), not a new tool. One call returns compact graph edges instead of N greps+reads. Output must be edges, not file bodies. |

### C. Reduce output — route reads through the workflow facade

| Item | Tag | Notes |
|---|---|---|
| C1. Blacklist tools the facade already covers | RESEARCH (risky) | Exclude bulk-read tools so reads route through `caco_run_workflow`, whose raw bytes never enter context. **Boundary = "3+ independent reads to compute one answer," NOT forced single reads.** Forcing a trivial single read through a JS workflow adds output-token cost and removes interactive "read A → decide B" round trips that are genuine work. Likely outcome: nudge/route the fan-out case, keep cheap single-file `view`/`grep` available. Use SDK `excludedTools` only if a nudge proves insufficient. **Gate on D1.** |

### D. Measurement — make the diet empirical (prerequisite)

| Item | Tag | Notes |
|---|---|---|
| D1. Per-request metrics + fixed benchmark harness | DECIDED | Two parts. **(a) Metrics:** the throughput accumulator tracks in/cache/out but not turn count, `reasoningTokens` (the SDK usage event carries it), tool-call count, failed calls, wall-clock-to-idle, or workflow code bytes. Add all of these per request; surface key ones in the footer tooltip. **(b) Harness:** a small set of *fixed* benchmark tasks (e.g. a known fan-out search, a multi-file edit) run before/after each diet change. Compare whole-request aggregates across the fixed tasks — comparing turn counts on the *same* task is the oracle; ad-hoc "count turns pre/post" on different work is too noisy. This gates A3/C1 and the A-series. |

## Considerations

- **Re-send compounding undercounted.** The savings badge measures one-time bytes; the
  real win is bytes × remaining turns (cached re-send). D1's turn count exposes this.
- **Output tokens vs cached input.** Tool calls cost output tokens (most expensive per
  token), but a result re-sent over many turns may cost more in aggregate cached input.
  D1 lets us stop guessing.
- **Dependent vs independent fan-out.** Workflow only wins for *decided, independent*
  reads. Exploratory "read A then decide B" needs the round trip; don't blacklist that
  away. C1 must preserve a path for it.
- **Removal blast radius.** A1 removes persisted state (roadmap/notes). Audit every
  reader before deleting — explicit inventory: system-prompt nudges that mention them,
  the `/sessions/:id/roadmap` route, the notes routes, session search/indexing, any
  model/tool aliases, the surface "roadmap" style, checkpoints, and the
  context-dashboard UI applet. Migrate any must-keep state first.
- **offer_action parsing robustness.** A3's markup must be unambiguous and survive
  partial streams; define a fenced sentinel, not a loose heuristic.

## Acceptance

- **D1:** on a *fixed* benchmark task, the post-change run shows fewer inference turns
  and/or fewer tool-call result bytes than the pre-change run (oracle: same task, count
  completed turns / `assistant.usage` events and summed result bytes, compared pre/post).
- **A1:** roadmap/notes tools and applet gone; no broken reader; gates green.
- **A3:** buttons render from inline markup with zero `caco_offer_action` calls; old
  tool removed; visual parity confirmed.
- **C1:** measured net reduction in result bytes entering context on a fan-out task
  with no increase in failed reads; interactive single-read path still available.
- Each removal: `typecheck ×2`, `lint:strict`, `knip` (no dead exports), full tests.

## Plan (ordered)

1. **D1 metrics + benchmark harness** first — without it the rest is guesswork.
   (DECIDED, low risk.)
2. **A5 cheap wins** — trim description text / consolidate tool groups for pure
   prompt-byte savings, no capability loss. (RESEARCH, low risk, do early.)
3. **A1 remove session-context applet** — biggest cheap removal; audit the full reader
   inventory, migrate, delete, verify. (DECIDED.)
4. **A4 tool audit** — produce keep/trim/remove table; fold decided removals here.
5. **A3 offer_action replacement** — research reliability of inline markup vs typed
   tool first; spec → implement → remove tool only on parity + reliability.
6. **B2 graph reads** (extend `index`); **B1 multi_edit** only if D1 edit data proves
   value over parallel tool calls.
7. **C1 facade routing** — last, gated on D1 numbers; nudge/route the 3+-independent-read
   fan-out case, keep cheap single reads; reach for `excludedTools` only if needed.

Each non-trivial workstream gets its own feature spec (`docs/<slug>-spec.md`) and a
background spec review before implementation. This document is the index of record.

## Future / portability

- **Cross-platform `caco.sh` (TODO).** `caco.sh` runs via Node `exec`, whose default
  shell is `/bin/sh` on Unix and `cmd.exe` on Windows — so a bash command emitted by the
  model fails on Windows, and vice versa. Now that C1 routes all shell through `caco.sh`,
  this is the portability gap to close. Needs: (a) pick the right shell per platform
  (bash/sh on Unix, PowerShell on Windows), and (b) tell the model which shell dialect to
  write for (expose the platform/shell in the facade or prompt) — picking the binary
  alone isn't enough since the *command syntax* differs. Until then, Caco shell wrapping
  assumes a Unix-like shell. Deferred; revisit before any Windows use.
- **`caco.frames` portability (in spec).** The planned code-navigation helper
  (`docs/caco-frames-spec.md`) must use only the JS/WASM facade primitives
  (`caco.grep`/`glob`/`read`/`index`), never `caco.rg` or `caco.sh`-with-bash, so it works
  on Windows without `rg`/`git`/`bash`. `rg` is a speed bonus (auto-fallback in
  `grepCore`), not a requirement.
