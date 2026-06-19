# Failure-preserving observation shaping + raw recovery

## Goal

When the agent runs a noisy shell-class command (test / build / lint / grep),
its output is mostly passing/progress noise. Replace large output at Caco's tool
boundary with a compact **what-failed-and-where** summary, store the full raw
output under a Caco-owned id, and expose a `retrieve` tool so nothing is lost.
Lower per-turn read tokens and slow context growth without hiding failures.

## What this is (plain terms)

The command still runs in full. Caco intercepts the *result text the model sees*.
If it is large, Caco keeps the lines that signal failure (FAIL markers,
`file:line`, error codes, summary line), drops the bulk, and appends
`[raw: <id> — retrieve for full output]`. The agent reads ~hundreds of tokens
instead of thousands; if it needs everything, it calls `retrieve(id)`.

This is the *command-output* analogue of the `index` tool (which shaped *file
reads*). Together they attack Caco's two big token surfaces: reads and observations.

## Design — Part 1: Caco layer

**Interception.** SDK `SessionHooks.onPostToolUse(input, invocation)` returns
`{ modifiedResult?, additionalContext?, suppressOutput? }`. Register it on the
session and thread it into `createSession` *and* `resumeSession` exactly where
`largeOutput` is threaded today (`src/session-manager.ts`).

- The hook fires only for `resultType === 'success'`. `onPostToolUseFailure`
  fires for `'failure'` but is reduced to `error: string` and can return **only**
  `additionalContext` — it cannot replace result text (SDK-documented). Whether a
  non-zero shell exit is `'success'` or `'failure'` is the make-or-break question
  (see Spike).
- Scope by `toolName`: shape only shell-class tools (the SDK shell/bash tool).
  Never shape Caco's own tool results (`index`, applets, surface, etc.) or
  already-small output.

**Raw store.** Reuse the existing `src/output-store.ts` (`storeOutput(cwd, data,
{ type: 'raw' })` → opaque random id `out_…`; `getOutput(id)` → bytes). Do **not**
build a parallel content-addressed store for V1. Store the raw output *before*
mutating the result. Retrieve is by opaque id (unguessable random); reuse the
store's existing per-session directory + pruning.

**Retrieve tool.** `src/observe/retrieve-tool.ts` → `defineTool('retrieve_output')`.
- Args: `{ id, range?: [start,end], grep?: string }`. Returns raw (optionally
  line-ranged or grep-filtered) so the agent recovers detail without re-dumping
  the whole blob. Same size caps as any tool output. Prefer a session-scoped
  lookup; if using the store's global-by-opaque-id `getOutput`, that is
  acceptable only because ids are unguessable random tokens.

**Result mutation contract.** When returning `modifiedResult`, preserve
`resultType`, `error`, `binaryResultsForLlm`, and `toolTelemetry` unchanged —
compact **only** `textResultForLlm`. `sessionLog` is left as-is in V1 (no shaped/
raw policy). A test must assert untouched fields survive.

**Budgets/constants.** `SHAPE_THRESHOLD_BYTES` (only shape above this),
`SHAPED_OUTPUT_CAP_BYTES` (soft — see size/failure conflict below), `MAX_FAILURES`
(cap on preserved failure entries).

## Design — Part 2: shapers (the "known-output" parsers)

A shaper is a self-contained module, not a loose function. Adding one is purely
additive — no core change — which is the whole maintainability story.

```
interface Shaper {
  id: string;
  detect(raw: string, ctx: { toolName: string; argv?: string }): number; // 0 = no match, higher = stronger
  shape(raw: string): { shaped: string; preserved: number; dropped: number };
}
```

**Registry & selection.** Shapers live in `src/observe/shapers/<id>.ts` and
self-register in an array. The boundary runs every `detect`, picks the highest
score > 0, else falls back to `generic`. One file + one registry line + one golden
fixture = a new shaper. No edits to the hook, store, or other shapers.

**Safety invariant (the key to maintainability).** `generic` is the correctness
floor: head/tail + elision + handle, lossless-recoverable, can never hide a
failure. Every format shaper is a pure *optimization* on top and must satisfy
`failureSignals(format.shape(raw)) ⊇ failureSignals(generic.shape(raw))` for its
fixtures — enforced by a shared test harness. Consequence: a stale or broken
format parser (e.g. a tool changed its output format) degrades to **generic**, never
to data loss. This is what keeps the long tail of parsers from becoming the RTK
brittleness trap — a wrong shaper costs savings, never correctness.

**What V1 ships:**

| Shaper | Status | Covers |
| --- | --- | --- |
| generic | V1 | everything, incl. C++/C# toolchains we can't yet dogfood |
| ts-test-build | V1 | `tsc`, `eslint`, `vitest`/`jest` — Caco's own toolchain (dogfoodable today) |

Keeps (ts-test-build): `file:line`, error/warning codes, `FAIL`/`✗` names,
assertion diff (`expected`/`received`), `npm ERR!`, summary/exit line. Drops:
passing lines, progress bars, clean files.

**What we do *not* ship up front.** We do not need a shaper for every tool Caco's
users run. Because `generic` already gives safe, recoverable savings for any
format, format shapers are added **data-driven**, when traces show a tool's output
dominates tokens. Fast-follow candidates, each added when dogfoodable:

| Shaper | Platform | When |
| --- | --- | --- |
| cpp-test-build (gcc/clang, ctest/gtest, cmake) | C++ | home dogfood, after V1 |
| dotnet-test-build (msbuild, `dotnet test`/xUnit) | C# | office dogfood next week |

grep/rg is deferred indefinitely — it is usually *successful search data*, not
failure noise; `generic` recovery handles it conservatively.

**Versioning/brittleness.** Format detection keys on stable markers (exit summary
lines, `error TSxxxx`, `✓/✗`), not layout. A shaper that stops matching simply
stops being selected (→ generic). Golden fixtures pin behavior in CI; updating a
shaper for a new tool version = update its fixture, the invariant guards the rest.

**Size vs failure-preservation.** `SHAPED_OUTPUT_CAP_BYTES` is a *soft* target, not
a hard invariant. Failure preservation wins: keep up to `MAX_FAILURES` failure
entries (each = name + message + location + diff snippet) plus totals, then attach
the retrieve handle with an omitted-count note. If even the capped failure set
exceeds the soft cap, the shaped output may exceed it — never drop a failure to fit.

Rules: never drop a failure-signal line within the kept set; when unsure, keep. The
generic shaper is always recoverable via the handle.

## Considerations

- **Supersedes blind byte cap.** Today's SDK `largeOutput` spill (20KB → SDK
  saved-file stub, SDK-owned path) is blind and unrecoverable by Caco. This
  feature is the semantic replacement with a Caco-owned recovery handle.
- **Disabling SDK `largeOutput` requires a generic Caco backstop.** The hook is
  scoped to shell-class tools, but disabling the SDK cap removes the only bound on
  *every other* large successful tool output. So if the spike leads to disabling
  it, `onPostToolUse` must apply a **generic** size cap + raw-store handle to
  *all* successful text results (shell-class → semantic shaping; everything else →
  generic head/tail + handle). Otherwise keep SDK `largeOutput` enabled as the
  backstop and shape only what the hook sees raw. Acceptance must prove a large
  *non-shell* success result is still bounded.
- **Ordering risk.** If SDK large-output processing runs *before* `onPostToolUse`,
  the hook receives a stub, not raw text. Decided by the spike.
- **Conservative by default.** Failure lines are sacred; the handle guarantees
  full recovery; shaping is opt-in by size + tool name.
- **Concurrency / fan-out.** Hook fires per session; store keyed per session;
  content-addressed ids. Stateless shapers. Safe for parallel agents.
- **Cost.** Shaping is local CPU (negligible). Win compounds like the index tool:
  smaller observations → slower window growth → fewer compactions.

## Risks

| Risk | Mitigation |
| --- | --- |
| Non-zero exit arrives as `'failure'` (can't replace text) | Spike decision gates; if so, V1 adds `additionalContext` + retrieve handle, or defers to a different boundary |
| Hook sees post-spill stub, not raw | Spike confirms; disable SDK largeOutput **with** generic backstop, or keep it and shape only raw-visible output |
| Disabling largeOutput unbounds non-shell tools | Generic cap + handle for all successful text results, not just shell-class; acceptance test on a non-shell large result |
| Size cap vs preserve-every-failure conflict | Cap is soft; keep up to `MAX_FAILURES` + totals + handle; never drop a failure to fit |
| Over-aggressive shaping hides a failure | Expected-span oracle (not regex-only); conservative keep-on-doubt; always attach handle |
| Shell tool name differs across SDK versions | Detect by name allowlist + size/heuristic gate, not name alone |
| Raw store growth | Reuse `output-store.ts` (per-session dirs + existing pruning) |
| Shaping a tool that must stay verbatim | Allowlist shell-class tools for semantic shaping; never format-shape Caco tools |

## Code analysis

- `src/session-manager.ts` create args ~L546, resume args ~L686 — add `hooks`
  beside `largeOutput`. `SessionConfigBase.hooks?: SessionHooks` covers both.
- SDK types: `SessionHooks`, `PostToolUseHookInput/Output`, `ToolResultObject`
  (`textResultForLlm`, `resultType`, `error`, `sessionLog`).
- Existing `sdkLargeOutputConfig()` helper is the coexistence lever.
- Existing `src/output-store.ts` (`storeOutput`/`getOutput`, `type: 'raw'`, opaque
  `out_…` ids, per-session dirs, pruning) is the raw-recovery backend — reuse it.

## Acceptance (oracles)

- **Failure-signal superset (primary).** For each golden raw fixture (real
  failing `npm test`, `tsc`, `eslint` captures), assert the shaped output retains
  fixture-specific **expected spans**, not just regex tokens: the failing
  test/target name, the primary error message, the actionable `file:line` if
  present, a relevant diff/`expected`/`received` snippet, the final summary/exit
  status, and the raw retrieve id. (Avoids the weak-oracle trap of "output is
  small" and the regex-only blind spot of missing diffs/stack frames.)
- **Capped large failure set.** For a fixture with more failures than
  `MAX_FAILURES`, assert: all failures up to the cap are present, plus an
  omitted-count note and the retrieve handle (size cap may be exceeded — see
  size/failure rule).
- **Non-shell backstop.** A large *non-shell* successful tool result is still
  bounded (proves the largeOutput-coexistence decision is honored).
- **Format ⊇ generic (safety invariant).** For each format shaper's fixtures,
  assert its preserved failure signals are a superset of what `generic` preserves —
  a format shaper can never lose a failure relative to the floor.
- **Round-trip.** `retrieve(id)` returns the raw byte-identical (no range/grep).
- **Field preservation.** `modifiedResult` leaves `resultType`, `error`,
  `binaryResultsForLlm`, `toolTelemetry` unchanged; only `textResultForLlm` differs.
- **Size.** Shaped output ≤ `SHAPED_OUTPUT_CAP_BYTES` except when failure
  preservation requires more; below `SHAPE_THRESHOLD_BYTES` passes through untouched.
- **Determinism.** Same raw → same shaped across runs.
- Typecheck, lint:strict, knip, full vitest green.

## Plan

- [ ] **Spike (blocking design):** register a logging-only `onPostToolUse` +
      `onPostToolUseFailure`; run a passing and a *failing* shell command; record
      (a) does the hook see full raw `textResultForLlm`, (b) failing-command
      `resultType`, (c) the shell tool name(s). Write findings into this spec.
      **Decision gates:**
      - Non-zero exit is `'success'` → proceed with hook-based shaping (replace text).
      - Non-zero exit is `'failure'` but `error` carries full raw text → V1 can only
        add `additionalContext` (hidden guidance) + retrieve handle, not replace the
        visible result; record whether that meets the goal or defer.
      - Non-zero exit is `'failure'` and `error` is already spilled/truncated → this
        interception point cannot meet the goal; stop and pick a different boundary.
- [ ] Decide SDK `largeOutput` coexistence from spike; if disabling it, add the
      generic backstop path for all successful text results.
- [ ] Reuse `output-store.ts` for raw recovery (store before mutate); confirm
      opaque-id retrieve.
- [ ] Shaper interface + registry (`detect`/`shape`, self-registering array) +
      generic head/tail/elide shaper with soft cap.
- [ ] `ts-test-build` shaper (tsc/eslint/vitest/jest) with golden fixtures.
- [ ] Oracle tests: expected-span superset + capped-failure-set + non-shell
      backstop + round-trip + field-preservation + size + determinism.
- [ ] Wire `onPostToolUse` into create+resume; gate by tool name + size; preserve
      non-text result fields.
- [ ] `retrieve_output` tool (id, range?, grep?) + register in tool factory.
- [ ] Prompt guidance: outputs may be shaped; use `retrieve_output(id)` for full
      detail.
- [ ] Typecheck, lint, knip, tests.
- [ ] Dogfood on Caco's own test/build/lint output; record token delta.
