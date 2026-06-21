# Tool diet — audit (A4) + cheap wins (A5)

## Goal

Cut the per-turn tool-schema tax. Every registered tool's name + description +
parameter JSON-schema is sent (and re-sent, cached) on every model turn, and each
extra tool widens the model's choice space (slower, more misfires). Reduce both the
**byte cost** and the **tool count** without losing capability.

## Measured cost (live, this commit)

34 caco tools = **24.8 KB ≈ 6,200 tokens every turn** (descriptions 12.9 KB +
parameter schemas 11.9 KB). Param schemas cost nearly as much as descriptions, so
trimming `.describe()` strings and optional params matters as much as prose.

| Group | Tools | descB | paramB | totalB | Verdict |
|---|---|---|---|---|---|
| surface | 5 | 2219 | 1825 | 4044 | KEEP feature, **consolidate 5→3** |
| browser | 6 | 1363 | 2612 | 3975 | KEEP, **lazy-register** (own slice) |
| workflow | 1 | 2326 | 508 | 2834 | KEEP, **trim desc** |
| agent | 4 | 1320 | 1265 | 2585 | KEEP, trim; audit `list_models` |
| applet | 6 | 1074 | 1353 | 2427 | **fold howto→dev-docs**, trim |
| dev-docs | 1 | 747 | 496 | 1243 | KEEP (absorbs discovery docs) |
| index | 1 | 695 | 526 | 1221 | KEEP |
| delegate | 1 | 588 | 492 | 1080 | KEEP |
| memory | 2 | 518 | 427 | 945 | **merge 2→1** |
| retrieve | 1 | 435 | 508 | 943 | KEEP |
| swarm | 1 | 430 | 423 | 853 | KEEP |
| mcp-auth | 1 | 226 | 536 | 762 | **lazy-register** |
| session-history | 1 | 424 | 272 | 696 | KEEP |
| offer-action | 1 | 320 | 296 | 616 | **handled by A3** |
| display | 1 | 65 | 252 | 317 | KEEP (embed_media) |
| extensions | 1 | 167 | 119 | 286 | KEEP (dynamic discovery) |

## A4 — keep / trim / remove / consolidate

**Keep as-is:** index, retrieve, dev-docs, delegate, swarm, session-history, display,
workflow (trim only). These are distinct, load-bearing, and reasonably priced.

**Consolidate (fewer tools, same capability). Hard rule: every consolidation must
show NET byte savings against the *full merged* description + JSON-schema, not just
the removed tools' bytes — verified with `scripts/measure-tools.mts` before/after.**

| # | Change | Tools | Net saving — verify |
|---|---|---|---|
| C1 | Merge `caco_get_memory` + `caco_set_memory` → one `caco_memory` with an explicit `action: 'read' \| 'set' \| 'delete'` enum (NOT arg-presence overloading — that misfires) | 2→1 | measure; reject if merged schema ≥ sum |
| C2 | Fold `caco_clear_surface_changes` + `caco_set_surface_style` into `caco_mutate_surface` via an explicit `operation` discriminator (not "optional combo"). This moves fields into the heaviest kept surface tool, so the saving is NOT obvious | 5→3 | **measure the exact merged schema**; keep only if net-negative bytes AND round-trip + behavior probe pass |
| C3a | Fold `caco_applet_howto` (static creation docs) into a `caco_dev_docs` `applets` section | 1→0 | static text move; safe |
| C3b | `caco_applet_usage` and `caco_extensions` are **dynamic discovery** (list installed applets / loaded extensions), NOT static docs. Do NOT fold into static dev-docs. Either keep them, or only fold if `caco_dev_docs` gains dynamic sections that call the same runtime listing code | — | needs dynamic dev-docs; otherwise KEEP |

**Lazy/conditional registration (biggest *potential* win — but feasibility-gated):**

The SDK builds the tool list **only at session create/resume**; it exposes no
mid-session tool-mutation API (verified: no `setTools`/`updateTools` on the session
interface). So tools cannot appear mid-turn. This reshapes L1/L2:

| # | Change | Feasibility |
|---|---|---|
| L1 | Register the 6 **browser** tools only when a persisted "browser-enabled" flag is set for the session. The group then appears **from the next resume**, not mid-turn | Feasible only as a create/resume-time decision. Keeping just `caco_browser_ensure_running` always-present does NOT expose `navigate/snapshot/action` in the same turn — the model calls ensure_running, and the rest appear on the following resume. Decide whether that 1-turn latency is acceptable, or gate the whole group on a config flag the user sets. ~4 KB/turn off every non-browser session. |
| L2 | Register **mcp-auth** `register_mcp_server` only at create/resume when MCP servers are configured | Feasible at create/resume; ~762B off sessions with no MCP. |

L1/L2 change registration logic (server.ts `toolFactory` + a persisted flag) and are
follow-on slices measured via D1; L1 needs its own mini-spec to resolve the resume-time
UX.

**Audit notes (no change yet):** `list_models` (380B) overlaps `create_caco_session`
docs; candidate to fold later. `caco_browser_eval` is disabled-by-default — keep but
trim. `offer-action` is being removed by A3 (separate todo). Low-value-by-intuition
tools — `embed_media`, `caco_session_store_sql`, `swarm`/`delegate` — must be judged by
**D1 per-tool call telemetry**, not guesswork: add a per-tool call counter to the
metrics log first, observe real usage, then cut/conditionalize the genuinely unused.

## A5 — cheap wins (low risk, do first)

| # | Change | Target |
|---|---|---|
| T1 | Trim verbose **descriptions** to essentials. Heaviest: workflow (2326B), surface, agent, applet. Keep the workflow facade API list (load-bearing) but compress prose. | desc 12.9 KB → ≤ 9.5 KB |
| T2 | Trim **parameter `.describe()`** strings and drop redundant optional-param prose. Heaviest: browser (2612B), surface (1825B), applet (1353B), agent (1265B). | paramB 11.9 KB → ≤ 9 KB |
| T3 | Apply C1 (memory merge) and C3a (fold static applet-howto into dev-docs) — both mechanical, byte-measured | 2 tools removed |

A5 = T1 + T2 + the consolidations that **measure net-negative** (C1, C3a, and C2 only
if its merged schema proves smaller). Target after A5: **~30 tools, ≤ 19 KB
(~4,750 tokens/turn)** — but every consolidation is **conditional on a measured byte
drop**, not assumed. Do the mechanical merges first, then trim, benchmarking each
batch. L1/L2 (resume-time conditional registration) follow as measured slices.

## Considerations

- **Descriptions are guidance, not contract.** Over-trimming can make the model
  misuse a tool. Trim prose and examples, never the one sentence that says *when* to
  use it. Re-read each trimmed description as if seeing the tool cold.
- **Param schemas drive structured-output correctness.** Keep enums/types; cut only
  redundant `.describe()` text, not constraints.
- **C2/C3 change call sites.** Folding clear/set-style into mutate, and discovery
  tools into dev-docs, changes the documented contract — update API.md, the surface
  cookbook, and any prompt nudge. The model must still discover the folded paths.
- **Kept feature (surface).** C2 must preserve every existing capability (ack-only,
  style set, script/style set) — just behind `caco_mutate_surface`. Verify the surface
  applet round-trips.
- **L1 hazard.** If browser tools are absent when the model first needs them, it can't
  start the browser. Trigger registration on first browser intent (e.g. a lightweight
  always-present `caco_browser_ensure_running`, with the other 5 lazy), or register
  the whole group when a browser config/flag is present. Decide in the L1 slice.
- **Measurement.** Re-run the byte measurement after each change; capture D1 benchmark
  rows (turns/tokens) before and after to confirm no behavioral regression.

## Acceptance

- **Byte oracle:** `scripts/measure-tools.mts` instantiates every tool factory and
  sums `description` + `z.toJSONSchema(parameters)` bytes per group. Run before/after
  each change; after A5: total ≤ 19 KB and tool count ≤ 30. Caveat: this measures the
  *registered schema*, not the actual wire payload / cached-token cost — it is a
  regression guard, not ground truth. Validate it **once** against the SDK request log
  (or `rpc.tools.list`) to confirm registered bytes track wire bytes, then trust deltas.
- **Net-byte rule (per consolidation):** a merge ships only if the byte oracle shows the
  merged tool's full description + schema is smaller than the tools it replaces.
- **Capability + behavior oracle:** every folded/merged path works AND the model uses
  it correctly. Unit tests for the merged handlers (memory read/set/delete via the
  `action` enum — prove read never deletes; surface ack-only + style set + mutate
  round-trip) PLUS a model-behavior probe (a real prompt that should trigger each merged
  path, checked via D1 that it fires without misfire/failure).
- **No-regression oracle:** D1 benchmark prompts (`docs/tool-diet-bench.md`) show no
  increase in turns or failures on the same tasks pre/post each trimming batch.
- Each change: typecheck ×2, lint:strict, knip, full tests, build:client.

## Plan (ordered)

1. **`scripts/measure-tools.mts`** (byte oracle) — committed; capture baseline (34
   tools, 24.8 KB) and validate once against the SDK request log / `rpc.tools.list`.
2. **Add per-tool call telemetry** to the D1 metrics log so low-value tools
   (`embed_media`, `caco_session_store_sql`, `swarm`/`delegate`) are judged by real
   usage, not intuition.
3. **C1 — merge memory** → one `caco_memory` with explicit `action` enum; tests prove
   read/set/delete don't cross-fire; measure net-negative bytes.
4. **C3a — fold static `caco_applet_howto`** into a `caco_dev_docs` `applets` section;
   keep `caco_applet_usage`/`caco_extensions` (dynamic) unless dev-docs gains dynamic
   sections.
5. **C2 — surface consolidation** (only if measured net-negative): fold clear +
   set-style into `caco_mutate_surface` via an `operation` discriminator; verify
   round-trip + behavior probe; update surface cookbook + API.md.
6. **T1 + T2 — trim descriptions and param schemas**, one heavy group per batch,
   benchmarking each batch against D1.
7. **Re-measure + D1 benchmark**; record before/after in this spec.
8. **L2 (mcp-auth)** then **L1 (browser)** as separate resume-time conditional-
   registration slices; L1 gets its own mini-spec for the resume-latency UX.

Each non-trivial slice gets a background spec/code review before/after per workflow.
