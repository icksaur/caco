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

## Spike findings (resolved, 2026-06-19)

Live run against the SDK (`claude-haiku-4.5`) settled the three blocking unknowns:

1. **Failing shell command → `resultType: 'success'`.** `bash -c 'echo x; exit 3'`
   fired `onPostToolUse` with `resultType: 'success'`; the exit code is in the text
   (`<shellId: 1 completed with exit code 3>`). So shaping happens entirely in
   `onPostToolUse` and **can** return `modifiedResult`. The failure-hook limitation
   does **not** bite for shell tools.
2. **Tool names confirmed:** `bash` (runner) and `read_bash` (async output) both
   carry command output; async bulk output arrives via `read_bash`.
3. **The lever is an env var, not the session `largeOutput` config.** The shell
   tool truncates its own output at `COPILOT_LARGE_OUTPUT_THRESHOLD_BYTES`
   (default `20480`), saving overflow to a `/tmp/copilot-tool-output-*` file and
   handing the hook only a blind preview + path — *before* `onPostToolUse`, and
   independent of `largeOutput.enabled`. Setting `largeOutput.enabled=false` did
   **not** change this. Raising `COPILOT_LARGE_OUTPUT_THRESHOLD_BYTES` to `2000000`
   made the hook receive the **full raw 334 KB** for both `bash` and `read_bash`.

**Design decisions from the spike:**
- Caco sets `COPILOT_LARGE_OUTPUT_THRESHOLD_BYTES` to a bounded ceiling
  (`OBS_RAW_CEILING_BYTES`, ~1–2 MB) before the runtime starts, so the hook sees
  raw text up to that ceiling and becomes the single bounding authority. Above the
  ceiling the runtime still truncates (memory/transport safety net).
- Because raising the threshold also stops the runtime pre-truncating **non-shell**
  tool output (`view`/`grep`/custom), `onPostToolUse` **must** apply a generic
  size cap + raw-store handle to *every* successful text result over
  `SHAPE_THRESHOLD_BYTES` (shell-class → semantic shaping; others → generic
  head/tail + handle). This is the mandatory backstop.
- The session `largeOutput` config is now irrelevant to this feature; leave the
  existing `sdkLargeOutputConfig()` as-is.

## Design — Part 1: Caco layer

**Interception.** SDK `SessionHooks.onPostToolUse(input, invocation)` returns
`{ modifiedResult?, additionalContext?, suppressOutput? }`. Register it on the
session and thread it into `createSession` *and* `resumeSession` exactly where
`largeOutput` is threaded today (`src/session-manager.ts`). Set
`COPILOT_LARGE_OUTPUT_THRESHOLD_BYTES = OBS_RAW_CEILING_BYTES` on the runtime env
before `client.start()`.

- The hook fires only for `resultType === 'success'`, which (per spike) covers
  failing shell commands. `onPostToolUseFailure` is the reduced `error: string`
  path used only for genuine tool-infrastructure failures; not needed for V1.
- Scope by `toolName`. The runtime's own shell-tool set (verified in
  `@github/copilot` app.js) is **`bash`, `powershell`, `local_shell`** (runners),
  plus the async output readers **`read_bash`, `read_powershell`**. A long
  test/build started `async` returns its bulk *through the reader*, not the runner,
  so the allowlist must include the readers. Companions `stop_*`/`list_*` and all
  of Caco's own tools (`index`, applets, surface, …) are never shaped, nor is
  already-small output. Detect by this name allowlist **plus** a size gate — never
  name alone (Spike confirms current names; versions can rename).

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
- **Disabling SDK `largeOutput` requires a generic Caco backstop.** The hook is
  scoped to shell-class tools, but raising the runtime threshold (the actual lever,
  per spike) stops the runtime pre-truncating *every* tool, so `onPostToolUse` must
  apply a **generic** size cap + raw-store handle to *all* successful text results
  (shell-class → semantic shaping; everything else → generic head/tail + handle).
  Acceptance must prove a large *non-shell* success result is still bounded.
- **Ordering (resolved by spike).** Runtime truncation runs *before* the hook and
  is gated by `COPILOT_LARGE_OUTPUT_THRESHOLD_BYTES`, not `largeOutput.enabled`.
  Raising that env var to `OBS_RAW_CEILING_BYTES` gives the hook raw text up to the
  ceiling.
- **Conservative by default.** Failure lines are sacred; the handle guarantees
  full recovery; shaping is opt-in by size + tool name.
- **Concurrency / fan-out.** Hook fires per session; store keyed per session;
  content-addressed ids. Stateless shapers. Safe for parallel agents.
- **Cost.** Shaping is local CPU (negligible). Win compounds like the index tool:
  smaller observations → slower window growth → fewer compactions.

## Risks

| Risk | Mitigation |
| --- | --- |
| Non-zero exit treated as failure | Resolved: spike shows shell non-zero exit is `resultType: 'success'`; shaping in `onPostToolUse` returns `modifiedResult` |
| Hook sees truncated stub, not raw | Resolved: raise `COPILOT_LARGE_OUTPUT_THRESHOLD_BYTES` to `OBS_RAW_CEILING_BYTES`; hook then sees full raw up to the ceiling |
| Raised threshold unbounds non-shell tools | Mandatory generic cap + handle for all successful text results; acceptance test on a non-shell large result |
| Size cap vs preserve-every-failure conflict | Cap is soft; keep up to `MAX_FAILURES` + totals + handle; never drop a failure to fit |
| Over-aggressive shaping hides a failure | Expected-span oracle (not regex-only); conservative keep-on-doubt; always attach handle |
| Shell tool name differs across SDK versions | Allowlist `bash`/`powershell`/`local_shell`/`read_bash`/`read_powershell` (verified) + size gate, not name alone; spike re-confirms |
| Async command output bypasses shaping | Include the `read_*` reader tools in the allowlist — that is where async bulk output arrives |
| Raw store growth | Reuse `output-store.ts` (per-session dirs + existing pruning) |
| Shaping a tool that must stay verbatim | Allowlist shell-class tools for semantic shaping; never format-shape Caco tools |

## Code analysis

- `src/session-manager.ts` create args ~L546, resume args ~L686 — add `hooks`
  beside `largeOutput`. `SessionConfigBase.hooks?: SessionHooks` covers both.
- SDK types: `SessionHooks`, `PostToolUseHookInput/Output`, `ToolResultObject`
  (`textResultForLlm`, `resultType`, `error`, `sessionLog`).
- Existing `sdkLargeOutputConfig()` is unrelated to this feature (spike); leave it.
- Runtime truncation lever: env `COPILOT_LARGE_OUTPUT_THRESHOLD_BYTES` (default
  20480), set to `OBS_RAW_CEILING_BYTES` before `client.start()` in `ensureClient`.
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

- [x] **Spike (blocking design):** DONE — see "Spike findings" above. Non-zero
      shell exit is `resultType: 'success'`; tool names `bash`/`read_bash`
      confirmed; the truncation lever is `COPILOT_LARGE_OUTPUT_THRESHOLD_BYTES`,
      and raising it lets the hook see full raw text.
- [x] Decision: raise `COPILOT_LARGE_OUTPUT_THRESHOLD_BYTES` to
      `OBS_RAW_CEILING_BYTES`; `onPostToolUse` is the single bounding authority with
      a mandatory generic backstop for all tools.
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
