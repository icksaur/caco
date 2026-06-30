# Windows-proofing the workflow facade (rg degradation + path parity)

Focused fix spec. Parent: `docs/spec-budget.md` (the budget landed `caco_run_workflow` +
the `caco` facade; it was built/tested on Linux). Index of record: spec-budget.

## Goals

1. `caco.rg` degrades **gracefully and legibly** when rg is absent — a clear, actionable
   error (or no error at all, if we make rg always present), never a bare ENOENT.
2. `GrepMatch.file` and `globCore` paths are **POSIX `/`-separated on every platform**, so
   the facade contract is identical on Windows and Linux and matches real rg output.
3. No behavior change on Linux (where the diet was built and works).
4. The new facade tests pass on Windows for the right reason (correct contract), not by
   weakening assertions.

## Design

The diet routed reads/shell through the `caco` facade (`src/workflow/facade.ts`,
`src/workflow/cores.ts`). On Windows two gaps surface (measured live on this box):

| Facade method | Windows behavior | Verdict |
|---|---|---|
| `caco.sh` | Picks PowerShell via `resolveShell` (`shell.ts`); `echo` → code 0 | ✅ already handled |
| `caco.grep` | JS fallback runs (no rg needed), 32 matches | ⚠️ works but emits `\` paths |
| `caco.rg` | `spawn rg ENOENT` — raw, no fallback | ❌ hard-fails |

So `caco.sh`'s cross-platform TODO in tool-diet-spec is **already closed** by `shell.ts`
(PowerShell on Windows, bash/sh elsewhere). Two real gaps remain.

### Gap 1 — `caco.rg` hard-fails when ripgrep is absent
`facade.rg` (`facade.ts:60`) is a thin `execFileAsync('rg', args, …)` with no fallback.
On a box without `rg` on PATH it throws a bare `spawn rg ENOENT`. `caco.grep`/`grepCore`
already degrade to a pure-JS `jsGrep` on ENOENT (`cores.ts:146-154`), but the raw escape
hatch does not — so any workflow the model writes using `caco.rg` dies cryptically.

### Gap 2 — path-separator parity is broken on Windows (rg *and* JS)
`GrepMatch.file` is meant to be a stable, session-relative path the model can reuse
cross-platform. Today it is **native-separator** on Windows, and worse, the two code
paths disagree with real rg:

- `rgGrep` (`cores.ts:101`): `relative(base, resolve(base, file))` → `path.relative`
  returns `sub\b.txt` on Windows, **discarding rg's own `/`**.
- `jsGrep` (`cores.ts:133`): `relative(base, abs)` → also `sub\b.txt`.
- `globCore` (`cores.ts:157-166`): returns `validatePath().relative` → native `\`.
- The cores test's own `directRg` helper keeps rg's raw `/` (`sub/b.txt`).

Net: on Windows `caco.grep` returns `src\workflow\cores.ts`, but a direct `rg` invocation
(and Linux) returns `src/workflow/cores.ts`. The contract is platform-dependent. This is a
latent correctness bug **independent of whether rg is installed**: it breaks any consumer
that splits/matches on `/`, and forces every consumer to defensively re-normalize.
`frames.ts` already had to add a private `toPosix()` (`frames.ts:69-71`) precisely to paper
over this — evidence the raw contract is wrong, not the consumer.

It also explains the new Windows test failures (all POSIX-assuming). With rg **absent** on
this box, `workflow-cores` › "matches a direct rg --json invocation" fails first with
`spawn rg ENOENT` (the path `/`-vs-`\` mismatch only manifests once rg is installed); the
two assertion failures "restricts to a subtree via path" and "returns base-relative paths
even when opts.path is absolute" fail purely on the native-separator contract. The
remaining failure — `workflow-facade` › "runs a pipeline" (`ls | grep one`) — is a
Unix-shell assumption in the *test*, not product code (see Non-goals). (Review note: the
JS-fallback include-glob test passes; there is no second shell-test failure.)

### Gap 3 — transient console windows flash on every spawn (Windows UX)
The diet's facade/runner spawn child processes via `child_process` without
`windowsHide: true`, so on Windows each spawn flashes a transient console window:
`caco.sh` (PowerShell — `facade.ts:85`, the worst since C1 routes *all* shell here),
`caco.rg` (`facade.ts:67`), `rgGrep` (`cores.ts`), and the two workflow-node spawns
(`runner.ts` probe + entry). Running the test suite (many `runWorkflow`/`sh` calls) opens
a flood of windows; in normal use every workflow shell call flashes one. Node's
`windowsHide` defaults to `false`, and the rest of the codebase sets it explicitly
(`browser-connection.ts`, `git-edit-poller.ts`, `restart-manager.ts`, `routes/shell.ts`)
— the diet code simply omitted it. Note the **proven-safe combination**: `windowsHide:true`
with default `detached:false` is exactly what the browser-launch fix landed on for
PowerShell; and `restart-manager.ts:159` already runs detached node + `windowsHide:true`,
so the runner's detached node spawn is safe too (the browser detached+windowsHide gotcha
was PowerShell-host-specific, not node).

## Considerations

- **Why POSIX `/`, not native?** Two coherent contracts exist: native separators
  (matches `path.relative`) or POSIX `/` (matches rg + the frames contract + cross-platform
  stability for the model). POSIX wins: rg already emits `/`; `frames.ts` already chose it;
  and a model aggregating results shouldn't see `\` on one host and `/` on another for the
  same code. We normalize at the **source** (`cores.ts`) so every consumer inherits parity
  and `frames.toPosix()` becomes belt-and-suspenders.
- **Round-trip is safe (verified).** A model greps → gets `src/workflow/x.ts` → feeds it
  back to `caco.read`/`caco.index`. `validatePath` resolves via `path.resolve(base,
  requested)` (`path-utils.ts:43`), which accepts `/`-separated input on Windows. So the
  POSIX contract does not break grep→read round-tripping. Confirmed by review.
- **Contract scope — normalize ALL model-facing relative paths, not just grep/glob.**
  Review flagged that `readFileRangeCore` (`cores.ts:60`) and `indexCore`
  (`index/core.ts:70`) also return native `relative`/`validation.relative`, so a model would
  still see `src\...` from `caco.read(...).path` / `caco.index(...).path` while getting
  `src/...` from grep. To make the facade contract uniform, normalize those too (one shared
  `toPosix` helper). Small, and avoids mixed path styles from the same facade.
- **`caco.rg` is an escape hatch, not a guarantee.** spec-budget already frames rg as a
  "speed bonus (auto-fallback in grepCore), not a requirement." So Gap 1 does not demand a
  full JS re-implementation of rg's flag surface — a clear failure (Option A) is contract-
  faithful. Vendoring (Option B) is the stronger "never degrade" choice if we want rg
  everywhere without a manual/CI install.
- **rg resolver must NOT be naively cached (review, blocking).** A one-shot cache breaks
  two things: (a) the existing fallback tests that force rg absent by clearing `PATH`
  (`workflow-cores.test.ts:85-91,102-108`) — a cached positive resolution would stop
  exercising `jsGrep`; (b) a runtime `CACO_RG_PATH` set after first use in the long-lived
  Caco server — a cached negative would ignore it. Resolve per effective env key
  (`CACO_RG_PATH` + `PATH`) or expose a test-only reset; do not cache a single boolean.
- **Blast radius of the path change.** Only `cores.ts` (rgGrep, jsGrep, globCore, +read/index
  if we widen scope) changes output; `frames.ts` already normalizes so it is unaffected.
  Review confirmed `frames` is the only internal `grepCore` consumer. The `globCore` and the
  facade subtree tests assert native `join(...)` paths and must flip to `'sub/...'`.
- **No npm install in OneDrive.** Irrelevant here — the repo lives under a normal dev
  path (e.g. `C:\git\caco`), not the synced OneDrive workspace, so adding a dep (Option B)
  is safe.

## Options (Gap 1)

**A — Clear actionable error (minimal).** Detect rg once (cached); if absent, `caco.rg`
throws `WorkflowInputError("ripgrep not found on PATH — use caco.grep (JS fallback) or set
CACO_RG_PATH / install rg")`. Keeps rg honestly raw. ~10 lines. The model is already nudged
toward `caco.grep`.

**B — Vendor ripgrep (`@vscode/ripgrep`).** Bundle prebuilt per-platform binaries (~4MB
postinstall); resolve `rgPath` and feed it to **both** `rgGrep` and `facade.rg`. rg becomes
always-present: Gap 1 disappears, `caco.grep` always takes the fast rg path with full parity,
and CI/other boxes need no manual install. Cost: one dependency + a postinstall binary
download (proxy/airgap consideration on locked-down boxes).

**C — JS shim for `caco.rg`.** Parse common flags → route to `jsGrep`. Rejected: rg's flag
surface is large; the spec itself calls jsGrep "best-effort"; brittle for little gain.

**D — Configurable rg path (`CACO_RG_PATH`).** Resolve rg from an env/config override before
PATH. Small; complements A or B (lets you point at a system rg without touching PATH).

## Recommendation (DECIDED)

- **Gap 1 = Option B (vendor `@vscode/ripgrep`).** Resolution order:
  `CACO_RG_PATH` (explicit override, if it exists) → **vendored `rgPath`** (known-good,
  pinned) → `jsGrep` (always-present JS floor). **No PATH-scavenging** — vendoring removes
  the need and the system-rg `--json` version-skew risk. Resolver is **existence-checked per
  call** (`existsSync`), not a cached boolean, so it sidesteps the caching pitfall and never
  treats rg exit-code-1 ("no matches") as failure. `caco.rg` therefore works on Windows out
  of the box; the `WorkflowInputError` path remains only for the degenerate "vendored binary
  missing" case.
- **Gap 2 = normalize all four model-facing relative paths** to POSIX `/`:
  `caco.grep` (`GrepMatch.file`), `caco.glob`, `caco.read().path`, `caco.index().path`.

## Non-goals

- Re-implementing rg flags in JS (Option C).
- Fixing the **one** Unix-shell-assuming test (`workflow-facade` › "runs a pipeline" using
  `ls | grep one` at ~line 72-77; it asserts a bash pipeline against PowerShell). It tests the
  harness's shell assumptions, not product code; either gate on host dialect or leave for a
  separate test-portability pass. (Review confirmed there is no second shell-test failure.)

## Risks and Mitigations

- **Changing the path contract could break an in-flight consumer.** Audited: only `frames`
  consumes grepCore and it already `toPosix`-normalizes (no-op after this). Model-authored
  workflows benefit (stable `/`). Low risk.
- **Option B postinstall on locked-down/airgapped boxes** (binary download via proxy).
  Mitigation: keep `resolveRg()` returning `null` → graceful error path still exists even if
  the vendored binary fails to download; A+D remains the floor.
- **`CACO_RG_PATH` pointing at a non-rg binary.** Validate existence only; if it errors at
  exec, surface stderr in the thrown message.

## Acceptance

- `npm run build` green on Windows: `typecheck`, `lint:strict`, `knip`, **and** the 3
  previously-failing POSIX path tests now pass; new rg-degradation + posix-parity tests pass.
- Live on Windows via `caco_run_workflow`:
  - `caco.grep('emit',{path:'src/workflow'})` returns `src/workflow/...` (forward slashes).
  - `caco.rg([...])` with rg absent → clear `WorkflowInputError` (A+D) **or** succeeds via
    vendored binary (B).
  - `caco.sh('echo hi')` still code 0 (unchanged).
- Linux unaffected: `relative` already yields `/`; `toPosix` is a no-op there.
- Oracles: `tests/unit/workflow-cores.test.ts` — "emits POSIX (/) separators on every platform (rg and JS parity)", "restricts to a subtree via path", "returns base-relative POSIX paths even when opts.path is absolute"; `tests/unit/workflow-facade.test.ts` subtree/path assertions.

## Plan

| # | Step | Files | Oracle |
|---|------|-------|--------|
| 1 | POSIX path normalization in `rgGrep`, `jsGrep`, `globCore`, `readFileRangeCore` | `src/workflow/cores.ts` | `workflow-cores.test.ts` — POSIX assertions |
| 2 | Normalize `indexCore` path | `src/index/core.ts` | `workflow-cores.test.ts` |
| 3 | `resolveRg()` + vendor `@vscode/ripgrep`; update `facade.rg` + `grepCore`/`rgGrep` with injected rg seam | `src/workflow/facade.ts`, `src/workflow/cores.ts` | `workflow-facade.test.ts` `WorkflowInputError` case |
| 4 | Flip glob/subtree/path assertions to POSIX; replace `PATH=''` trick with `rg=null` seam; add rg-degradation + posix-parity tests | `tests/unit/workflow-cores.test.ts`, `tests/unit/workflow-facade.test.ts` | all pass |
| 5 | Update `facade.ts` `FACADE_API_SUMMARY`/`FACADE_DTS`; mark spec-budget portability items resolved | `src/workflow/facade.ts`, `docs/spec-budget.md` | - |

## Status
- [x] Spec reviewed (GPT-5.5)
- [x] Decision: Gap 1 = **B (vendor @vscode/ripgrep)**; Gap 2 = **normalize all four paths**
- [x] Gap 2 — cores + index POSIX normalization (grep/glob/read/index)
- [x] Gap 1 — vendor @vscode/ripgrep + resolveRg + caco.rg
- [x] Gap 3 — windowsHide:true on all facade/runner spawns (no console-window flashes)
- [x] Tests updated + added
- [x] Docs updated (facade summary, spec-budget portability)
- [x] Build green on Windows + live verify (incl. no transient windows)
