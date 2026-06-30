# caco_run_workflow — code-execution orchestration (V2)

Status: draft. Roadmap item 3. Read with `docs/research/harness-token-techniques-research.md`.

## Goal

Cut token spend on multi-step **read/search/aggregate** work. Let the agent author
ONE TypeScript workflow that calls a read-oriented Caco facade locally — looping,
filtering, and aggregating in-process — and returns only a compact result plus a
raw-output handle. Intermediate tool results stay in the workflow process and never
round-trip through the model's context.

This is the Anthropic "code execution with MCP" lever (150k→2k tool-def tokens;
results stay local). It complements, not replaces, single tool calls.

## When it wins (and when not)

- **Wins:** fan-out reads/searches. "Find every call site of `foo` across these 40
  files and summarize" today = 40 `index`/`view` calls, each dumping output into
  context. As a workflow = 1 tool call, 1 compact result.
- **Does not win:** a single read or search — just use `view`/`grep`. The tool
  description must steer the model away from one-shot use.

## Threat model (the crux — read first)

The agent can **already** run arbitrary code via the SDK `bash` tool. `caco_run_workflow`
runs model-authored TS via `tsx` in the session cwd: **identical privilege and blast
radius to `bash`**. It is therefore *not* a new capability boundary and needs no
isolate for V1.

**Privilege parity, not approval parity (B1).** Workflows auto-run (D5) while `bash`
may be permission-gated, so the *authorization* surface differs even though the
*capability* is the same: this tool can silently execute arbitrary TS and subprocesses
behind a name that reads like "read/search/aggregate". Mitigate, not by sandboxing,
but by making the power explicit:
- The tool description states plainly: "runs arbitrary model-authored TypeScript and
  can spawn subprocesses (`sh()`); same power as the bash tool."
- The opt-in config flag's documented meaning is "allow auto-run of arbitrary code."
- Every run audit-logs the submitted `code` and any `sh()` commands (to the session
  activity/output store) so execution is never invisible.
- `isolated-vm` (auto-run safe because truly read-only) remains the deferred path if
  approval parity is later required.

**"Read-oriented", not "read-only" (B2).** The facade's first-class ops are reads, but
a workflow is plain TS: it can `import('fs')`, `import('child_process')`, open sockets,
or call `sh()`. V1 enforces **no** read-only restriction; the naming everywhere is
"read-oriented facade", and the spec/tool text never claims read-only as a safety
property.

### Decisions (resolved)

- **D1 Security:** fast ship — `bash`-parity trust, no isolate. This feature is for
  token savings, not a new security boundary.
- **D2 Language:** TS via `tsx` is the host. Python interop comes free through the
  `sh()` escape hatch (run `python3` when present) — **no direct Python dependency**.
- **D3 Surface:** `index/read/grep/glob/list/retrieve` + `rg` (ripgrep-backed) +
  `sh()`.
- **D4 Result contract:** `emit()` + result file.
- **D5 Approval:** auto-run, like `index`/`retrieve_output`.
- **D6 grep engine:** shell out to `rg` (host binary; present at `/usr/bin/rg` on
  Linux, used heavily by agents) with a pure-JS fallback when `rg` is absent.

## Slices (divisible — ship in order)

The "single source of truth" claim is only real if the shared cores actually exist
first. Today only `index` has a reusable Caco core (`treeSitterAdapter`); `view`,
`grep`, and `glob` live in the SDK runtime, not under `src/`. So:

- **Slice A — read cores + facade (no code execution).** Extract `readFileRangeCore`,
  `globCore`, `grepCore` (rg-backed + JS fallback), reuse `indexCore`. Build
  `src/workflow/facade.ts` on these. Existing tool handlers are refactored to format
  the *same* cores. Ship + test this slice on its own; it introduces zero
  arbitrary-code execution. Its oracles (core equality, grep==rg, path scope) make the
  drift-prevention claim true *before* the runner exists.
- **Slice B — runner + tool.** The `tsx` subprocess runner, result envelope, output
  budgeting, tool registration, prompt guidance, dogfood.
- **Slice C — savings metrics.** Per-session estimate of context tokens the tool
  avoided, surfaced in the footer usage tooltip. The child wraps the facade in a
  counting proxy (`observedBytes` = total read-payload bytes that would otherwise
  have entered context) and reports it in the result envelope. The tool computes
  `savedTokens = round(max(0, observedBytes − injectedBytes) / 4)` (a conservative
  lower bound; `injectedBytes` is the model-facing result text) and records it on
  `SessionThroughput.workflowSavedTokens`/`workflowRuns` (session-lifetime, not
  cleared by `resetRequest`). The frontend prices saved tokens at the active model's
  input rate (never hardcoded). Recorded only on the `emitted` outcome.

## Design — Part 1: the tool

`caco_run_workflow({ code, timeoutMs?, description? })`

1. Create a **per-run** scratch dir with a random id under Caco storage (NOT the repo),
   mode `0700`: `<STORAGE_ROOT>/workflows/<sessionId>/<runId>/`. Write `code` to
   `entry.mts` wrapped in a harness that imports the facade and exposes `emit(value)`.
2. Resolve an **absolute** `tsx` runner command at startup (not just package presence)
   and smoke-test it once; cache the result. Spawn it `detached: true`,
   `cwd = sessionCwd`, full env passthrough (consistent with the bash-parity
   threat model — the agent already has the host env via `bash`), on the per-run dir.
3. Enforce a wall-clock timeout (default 30s, cap 120s). On timeout, kill the whole
   process group: `process.kill(-pid, 'SIGTERM')`, grace period, then `SIGKILL`, so
   children spawned by `tsx`/`sh()` die too.
4. **Stream** stdout/stderr with a hard byte ceiling (`WORKFLOW_LOG_CAP`, e.g. 256 KB):
   spill to `output-store` incrementally; if the ceiling is exceeded, stop capturing
   (and optionally kill) — a runaway `console.log` can never exhaust the Caco process.
5. Read the result envelope from the result file (see contract). Apply
   **observation shaping** (`src/observe`) to the captured logs; store full raw via
   `output-store`; return: emitted value (size-capped) + shaped logs + a
   `retrieve_output` handle.
6. Clean up the per-run dir in `finally`; a startup/TTL sweep removes crash leftovers.
7. **Opt-in:** registered only when the config flag is set (default off), until the
   token delta clears the default-on threshold (see Acceptance).

**Result envelope contract (B4).** Resolves the prior ambiguity:
- The harness exposes `emit(value)`. Exactly **one** `emit` per run; a second `emit`
  throws (`emitMany` is explicitly out of scope for V1).
- `emit` writes `{ ok: true, value }` to a temp file then atomically renames it onto
  the result path. If `value` is not JSON-serializable (cycle, `BigInt`, `undefined`,
  function), `emit` throws a clear error captured as `{ ok: false, error }`.
- Process exits with no result file → tool returns a clear "workflow completed without
  calling emit()" error.
- Non-zero exit / uncaught throw → `{ ok: false, error }` with the stack, plus shaped
  logs.
- The runner reads the envelope, caps the serialized `value` at 16 KB, and stashes any
  overflow with a handle.

**Concurrency.** Per-run random dirs make concurrent workflows independent; a small
pool bounds simultaneous `tsx` processes. No shared result path, so no cross-run reads.

## Design — Part 2: the read-oriented facade

A typed module the harness imports (physical: `src/workflow/facade.ts`), built on the
Slice-A cores, **all path-scoped to `sessionCwd` via the existing `validatePath`**.
Each returns plain JS data (objects/arrays), NOT formatted-for-LLM strings, so the
script composes them freely:

| Fn | Returns | Core (shared with tool) |
|---|---|---|
| `index(path, {language?, maxEntries?})` | structural skeleton entries | `indexCore` (`treeSitterAdapter` + `formatIndex`) |
| `read(path, {range?})` | file text (optional `[start,end]` lines), size-capped | `readFileRangeCore` |
| `grep(pattern, {glob?, path?, flags?})` | `{file, line, text}[]` | `grepCore` (rg `--json`, JS fallback) |
| `rg(args)` | raw ripgrep stdout (power users) | `rg` binary |
| `glob(pattern)` | file paths | `globCore` |
| `list(path)` | dir entries | fs + `validatePath` |
| `retrieve(id, {range?, grep?})` | prior stored output | `output-store` |
| `sh(command, {input?, timeoutMs?})` | `{stdout, stderr, code}` | child process, `cwd=sessionCwd` |

`sh()` is the documented escape hatch: it spawns a subprocess in the session cwd,
giving Python interop (`sh('python3 -c …')`) and any host tooling **without a hard
dependency** — consistent with the `bash`-parity threat model. The typed read ops
remain the ergonomic default; `sh()` is the power tool.

**Single source of truth (B3).** The facade and the tool handlers both call the
Slice-A cores; the tool handler is *only* a formatter over the core. Tests assert
core equality (facade data) and that each tool's formatter consumes the same core — so
the facade cannot silently diverge from what `view`/`grep`/`index` return.

The facade ships a `.d.ts`; an API summary string is embedded in the tool description
and prompt so the model knows the surface without loading full defs.

## Considerations

- **tsx at runtime:** `tsx` is a devDependency (`node_modules/.bin/tsx`). Pruned-prod
  deployments may lack it, or run compiled JS without it on PATH. At startup, resolve
  an **absolute** runner command and run a tiny smoke script through it; only register
  the tool if that succeeds. Otherwise log clearly and skip registration.
- **rg at runtime:** `grepCore` prefers `rg --json` (robust parsing — filenames with
  colons/spaces/Unicode, no-trailing-newline, ignored files); when `rg` is absent it
  falls back to a pure-JS regex over `globCore`, and `rg()` returns a clear
  "ripgrep unavailable" error. Probe once, cache.
- **Python is optional:** reached only via `sh('python3 …')`; absence just means that
  call fails like any missing command — no startup coupling.
- **Log memory (B6):** stdout/stderr are streamed with a hard byte ceiling and spilled
  incrementally; capture stops (and may kill) past the ceiling, so the Caco process is
  bounded regardless of workflow output volume.
- **Budgets:** emitted-result cap (16 KB) + log ceiling + log shaping keep the
  model-facing payload bounded regardless of how much the workflow read internally.
- **Concurrency:** per-run random scratch dirs; a small pool bounds simultaneous `tsx`.
- **Scratch hygiene:** per-run dir removed in `finally`; startup/TTL sweep clears
  crash leftovers.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Arbitrary code, auto-run (== `bash` capability, weaker approval) | Scary tool description; flag means "allow auto-run arbitrary code"; audit-log code + `sh()` commands |
| `tsx` missing in prod | Resolve absolute runner + smoke-test at startup; register only if it works |
| `rg` missing | `grepCore` falls back to JS regex; `rg()` returns a clear unavailable error |
| Runaway loop | Wall-clock timeout + `detached` process-group kill (SIGTERM→SIGKILL) reaps children |
| Runaway log output | Streamed capture with hard byte ceiling; spill/stop past ceiling |
| Crash-before-emit / wrong result | Atomic temp+rename result file; "no emit" and "non-JSON value" are explicit errors |
| Concurrent-run collision | Per-run random scratch dir + unique result path; pool bound |
| Facade drifts from tools | Both call Slice-A cores; oracle asserts core equality and shared formatter |
| Token win unproven | Opt-in flag; default-on only past a measured reduction threshold |
| Path escape via facade | All facade reads go through `validatePath(sessionCwd, …)`; tested with `../../etc/passwd` |

## Acceptance (oracle-first)

| Behavior | Oracle | Type |
|---|---|---|
| `facade.read` data == the `readFileRangeCore` the tool formats | core equality; separately assert the tool handler consumes that core | reference |
| `facade.grep` == independent `rg` over a fixture tree | compare to direct `rg --json`; fixtures with colon/space/Unicode filenames, no-trailing-newline, ignored files, glob/path filters | independent reference |
| `grepCore` JS fallback == `rg` path | force `rg` unavailable; same result set on the same fixtures | reference |
| `facade.sh('python3 -c …')` round-trips stdout when python present | hand case; skipped when `python3` absent | property |
| Result envelope | one `emit` → JSON-identical value in result; second `emit` throws; non-JSON value → clear error; no emit → "completed without emit" error | round-trip + property |
| Model-facing payload ≤ cap; overflow recoverable | size assertion + `retrieve_output` round-trip returns full raw | invariant + round-trip |
| Log bound | workflow prints > ceiling; Caco memory stays bounded, capture stops, raw still retrievable | property |
| Path scope | `facade.read('../../etc/passwd')` rejected, same as tools | invariant |
| Timeout + child reap | infinite-loop and `sh('sleep 999')` workflows killed within `timeoutMs`; no surviving child | property |
| **Token delta** | dogfood a real fan-out vs the equivalent single-tool sequence; record tokens in/out | measured |

**Default-on threshold:** stays opt-in unless a real fan-out read task shows
**≥ 40% input-token reduction** vs the equivalent single-tool sequence with no worse
task quality. Otherwise it ships opt-in only.

The facade-vs-core equality is the load-bearing oracle: it pins "single source of
truth" at the *core* layer (plain data), not the formatter layer, so a bad impl can't
pass by returning LLM-formatted strings.

## Plan

**Slice A — read cores + facade (no code execution):**
1. Extract `readFileRangeCore`, `globCore`, `grepCore` (`rg --json` + JS fallback);
   wrap existing `indexCore`. Refactor the matching tool handlers to format these same
   cores. Path-scope everything via `validatePath`.
2. Write Slice-A oracle tests first: facade-data == core; grep == `rg --json`; JS
   fallback == rg path; path-scope rejection. (Computable right answers → test-first.)
3. Build `src/workflow/facade.ts` on the cores; add `rg`, `list`, `retrieve`, `sh`.
   Ship `.d.ts` + an API summary string.

**Slice B — runner + tool:**
4. Resolve absolute `tsx` runner + startup smoke-test. Runner: per-run random scratch
   dir, harness template, `detached` subprocess, timeout + process-group kill,
   streamed log capture with byte ceiling, result-envelope read (atomic temp+rename).
5. Output: shape logs via `src/observe`; cap emitted value; store raw + handle;
   audit-log code + `sh()` commands; `finally` cleanup + startup TTL sweep.
6. `createWorkflowTool(sessionCwd)` → `defineTool` with the "runs arbitrary code"
   description; register in `server.ts` **behind the config flag**; skip if `tsx`
   unavailable.
7. Prompt guidance: fan-out read/aggregate only; show the facade API + a worked
   example; **instruct workflows to aggregate locally and `emit()` compactly, not to
   print intermediate data**; steer away from single-call use.
8. Slice-B tests: result-envelope cases, log bound, timeout + child reap, budget /
   overflow round-trip.
9. Dogfood a real fan-out task; record token in/out delta vs single-tool baseline;
   promote to default-on only if ≥ 40% input-token reduction holds.

## Open questions

All resolved — see **Decisions (resolved)** above (D1–D6). No open forks remain;
this spec is ready for review and implementation.
