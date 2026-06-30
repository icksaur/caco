# Spec: route reads through caco_run_workflow (C1)

## Goals

Bias fan-out **search/read** toward `caco_run_workflow` by excluding the built-in
search tools its facade covers losslessly, so search output stays out of the model's
context (and re-sent cache) and decided fan-outs collapse to one workflow call.

**Important caveat up front:** excluding the search *tools* is a NUDGE, not an absolute
forcing function, because `bash` (kept, for lifecycle/streaming/test runs) can still run
`rg`/`grep`/`find`. The only configuration that truly *forces* facade routing also
excludes `bash` ("strict read diet"), which costs live shell/test ergonomics. So the
default is measured, not assumed (see Recommended design + Acceptance).

Two intended wins:

1. **Context savings:** raw search/read output (grep hit lists, globbed paths,
   file bodies) never enters the model's context — only the workflow's compact
   `emit()` does. This is the larger, compounding win (those bytes are otherwise
   re-sent cached every later turn).
2. **Fewer round trips:** a decided fan-out (e.g. "is there a doc about X?")
   collapses from N grep/glob/read calls into one workflow call. The user observed
   exactly this in practice: that question was a one-shot ~0.5 s turn with a single
   tool call when routed through the workflow.

The D1 benchmark is the motivation: Sonnet reached for built-in `grep`/`view`
directly and **never** chose `caco_run_workflow`, even on the fan-out tasks that are
its sweet spot. Offering the workflow is not enough; removing the alternatives is the
forcing function.

Non-goal: removing edit/lifecycle capability. The facade is read-only; writes,
streaming, and interactive shell stay on their built-in tools.

## Mechanism (already plumbed, never used)

The SDK `SessionConfig.excludedTools` accepts `builtin:<name>` patterns and disables
those tools. Caco already threads `excludedTools` end to end
(`SessionStateConfig.excludedTools` → session config → every create/resume in
`session-manager.ts`), but `server.ts` calls `createSessionState` **without** it, so
it is always empty. C1 populates it. This is the SDK-side parallel to A5's
`CACO_DISABLED_TOOLS` (which post-filters Caco's own `defineTool` tools; built-ins are
not in that array, so they need this separate path).

## Empirical findings (verified live, 2026-06-21)

Tested `bash` tool vs `caco.sh` to check the claimed bash-only advantages. Most are
**myths** — the real costs of excluding bash are narrower than first written:

| Claimed bash advantage | Verdict | Evidence |
|---|---|---|
| Interactive stdin | **MYTH — neither has it.** `bash` tool stdin is "not a tty"; `read` gets immediate EOF. Input must be piped/heredoc'd in both. `caco.sh` is identical (also non-tty). | `read -t 1` → EOF rc=1; `tty` → "not a tty" on both paths |
| Streaming | **MYTH for scripts.** Streaming is just stdout text; `caco.sh` captures it fully and the script parses it. `bash` tool's only edge is `read_bash` polling for *partial* output of a still-running command (progress watching), not different content. | slow emitter captured identically by both |
| Background / detached | **MYTH — `caco.sh` CAN do it.** A `setsid`-detached process launched from `caco.sh` **survived** the workflow's process-group teardown. | marker file written 2 s after the workflow exited |
| Non-zero exit handling | Equivalent — `caco.sh` returns `{code, stderr}`, never throws | `exit 7` → `{code:7, stderr:"…"}` |

**The genuine, narrow costs of excluding `bash` (Proposal B):**
1. **Foreground commands are capped at the workflow timeout** (default 30 s, cap 120 s).
   Verified: `sleep 5` under a 2 s workflow timeout was killed. A long test/build that
   you run in the foreground and wait on inline cannot exceed 120 s via `caco.sh`. (Work-
   around: detach with `setsid` + poll a logfile from a later `caco.sh`; or raise
   `WORKFLOW_TIMEOUT_CAP_MS`.)
2. **No live progress polling.** `caco.sh` blocks and returns the full output at the end;
   `read_bash` can show partial output mid-run. Matters for *watching* a long command,
   not for a script that parses the result.
3. **Output-shaping integration.** The observe hook shapes built-in `bash`/test output
   into failure-focused summaries with `retrieve_output` handles; `caco.sh` uses the
   workflow's own log caps (256 KB) instead.

Net: the interactive/streaming/background objections do **not** hold. The only real loss
from a strict (bash-excluded) diet is **long foreground runs (>120 s) and live progress
watching** — both addressable (detach+poll, or a higher cap). This makes Proposal B more
viable than the original draft implied.


## Tool inventory (live, 15 SDK built-ins)

| Built-in | Facade equivalent | Verdict |
|---|---|---|
| `grep` | `caco.grep` / `caco.rg` | **Exclude** — pure search, lossless |
| `glob` | `caco.glob` | **Exclude** — pure search, lossless |
| `bash` (+ `read_bash`/`stop_bash`/`list_bash`) | `caco.sh` (one-shot only) | **Opt-in** — `sh` covers one-shot, but excluding bash loses streaming, background/detached processes, and interactive stdin; and output-shaping/`retrieve_output` only applies to the built-in bash path |
| `str_replace_editor` | `caco.read` (view only) | **Keep** — it is also the EDIT tool (view/str_replace/create); excluding it removes editing. File reads ride along here |
| `web_fetch` | — (no facade fetch) | **Keep** — not covered |
| `report_intent`, `skill`, `ask_user`, `task`, `read_agent`, `list_agents`, `fetch_copilot_cli_documentation` | — | **Keep** — orchestration/UX, not reads |

So the cleanly facade-covered, zero-loss exclusions are exactly **`grep` and
`glob`**. `bash` is high-value but lossy; everything else stays.

## Proposals

### Proposal A — exclude `grep` + `glob` by default (a NUDGE, not a forcing function)

Set `excludedTools: ['builtin:grep', 'builtin:glob']`. This removes the model's
**first-choice** search tools, biasing it toward the workflow facade
(`caco.grep`/`caco.rg`/`caco.glob`). Single-file view and edit (`str_replace_editor`)
and shell (`bash`) are untouched, so the read-A-then-edit loop and test runs are
unaffected. Lowest risk.

**Honest limitation — bash is an open escape hatch.** Because `bash` stays, the model
can still search with `bash: rg ...` / `grep` / `find` / `ls` and get **nothing** out
of context. So A does **not** *force* facade routing — it only removes the most obvious
alternatives and hopes the model picks the workflow over shelling out. Whether it
actually does is unknown and MUST be measured (the benchmark explicitly fails A if the
model substitutes `bash` search — see Acceptance). Treat A as "remove first-choice
search tools; expected to route through the workflow," not "search must go through the
workflow."

### Proposal B — "strict read diet": exclude `grep` + `glob` + `bash` (the only real force)

Add `builtin:bash` (and `read_bash`/`stop_bash`/`list_bash`). This is the **only**
configuration that genuinely forces search/read fan-out through the facade, because it
closes the bash escape hatch. **Per the empirical findings above, the cost is far
smaller than the original draft claimed:** interactive stdin, streaming, and
background/detached are NOT lost (they're myths or `caco.sh` covers them). The only real
loss is **(1) long foreground runs >120 s** (the workflow timeout cap — a long test/build
you wait on inline) and **(2) live progress polling** and **(3) failure-focused output
shaping**. Given that, B is genuinely viable — but the >120 s test/build case is common
enough that B should ship as an **opt-in** (or paired with a higher `WORKFLOW_TIMEOUT_CAP_MS`
and a detach+poll convention for long runs), not flipped on blindly. The user's
"bash/git/view are well suited" instinct lands here, and the findings support it.

### Proposal C — prompt-nudge only (status quo, already failed)

Strengthen the prompt to prefer the workflow, exclude nothing. **Demoted:** this is
effectively the current state, and the D1 benchmark already showed the model ignores
the nudge. Listed only for completeness; not a real option.

## Design

Per the owner: **the primary driver is unbounded `bash`/`powershell` output**, and
read/search tools are a *separate* concern (a future `index_multiread` that reads many
snippets with logic). So C1 ships as **shell wrapping**, not search exclusion:

- **Exclude the shell built-ins** (`bash`, `read_bash`, `stop_bash`, `list_bash`, and the
  `powershell`/`local_shell` equivalents) so all shell runs through `caco.sh` inside a
  workflow — bounding output and letting the model emit only the relevant slice, and
  batching multi-command sequences into one call.
- **Keep `grep`/`glob`/`view`** for now. They consume context but are a deliberate,
  separate future effort (`index_multiread`); this change stays focused on shell.
- **Raise `WORKFLOW_TIMEOUT_CAP_MS` to 130 s** (advertise 120 s in the tool description —
  10 s wiggle room for rough math) so wrapped test/build commands have headroom.
- The empirical findings make this low-cost: interactive stdin / streaming /
  background-detach are not real losses; only long (>120 s) foreground runs and live
  progress polling are, and those are rare / addressable (detach + poll).
- Risk is minimal and fully reversible: Caco is a personal tool the owner maintains; the
  exclusion is one config line, revertible via `CACO_EXCLUDED_BUILTINS`.

- A single source: `DEFAULT_EXCLUDED_BUILTINS` (the shell set) in `src/tool-registry.ts`,
  unioned with a `CACO_EXCLUDED_BUILTINS` env override (comma-separated, same parsing as
  A5's `CACO_DISABLED_TOOLS`). Adding `builtin:grep,builtin:glob` later is a config edit.
- `server.ts` passes the resolved list to `createSessionState({ ..., excludedTools })`;
  the existing plumbing carries it to every create/resume/model-switch resume.
- **Workflow tool description + prompt:** state that shell runs via `caco.sh` (bash/
  powershell are not separate tools); a single shell command is a one-line workflow
  (`emit(await caco.sh('git status'))`); set `timeoutMs` (up to 120 s) for slow commands;
  detach long runs with `setsid` and poll a logfile.

## Considerations

- **Reliability is the whole risk.** Excluding `grep`/`glob` only helps if the model
  reliably writes correct facade code instead. The D1 benchmark showed it did NOT
  proactively choose the workflow — so A is a behavioural bet that *forcing* it works.
  The user has one strong positive data point (the 0.5 s doc-search). This MUST be
  measured before/after (acceptance below); if the model flails (writes broken
  workflows, retries, or asks the user), fall back to C.
- **Single trivial search now costs a workflow.** A one-off grep becomes a few lines
  of JS in a child process — slightly heavier for a lone lookup, but the user accepts
  this ("I don't ship Caco widely") and the context win dominates over a session.
- **Capability is preserved, not removed.** `caco.rg`/`caco.grep`/`caco.glob` (and
  `caco.sh` running `rg`) do everything the built-ins did; only the *route* changes,
  and raw output stays out of context. Nothing becomes impossible.
- **`str_replace_editor` cannot be excluded** (it is the edit tool); file reads via its
  `view` command therefore stay on the built-in path. C1 is scoped to *search*, not
  single reads. **Unsolved leak (acknowledged):** even with search excluded, the model
  can still read many files one-by-one via `view`, dumping each body into context. C1
  does not address multi-file read fan-out — that would need either a routing of `view`
  (impossible without losing edit) or a separate "read many files" tool/nudge. Out of
  scope here; noted as a remaining context leak.
- **Byte measurement gap.** `scripts/measure-tools.mts` only sizes Caco's `defineTool`
  tools; it cannot see SDK built-in schema bytes. The schema saving from excluding
  `grep`/`glob` is real but unmeasured by our oracle — validate via the D1
  request-token metrics (input/cache deltas) instead.
- **Output-shaping interaction.** The observe hook shapes built-in `bash`/test output;
  workflow output uses its own caps. Excluding only `grep`/`glob` (Proposal A) leaves
  shaping fully intact for shell/test runs — another reason A is the safe default and
  B is opt-in.
- **No SDK mid-session tool mutation.** Like L1/L2 in A5, the exclusion is fixed at
  create/resume. Changing `CACO_EXCLUDED_BUILTINS` takes effect on the next session/
  resume, not mid-turn. Acceptable (it is a deployment setting).
- **`availableTools` vs `excludedTools`.** The SDK also offers an allowlist
  (`availableTools`). `excludedTools` is the right tool here (subtractive, composes
  with the default set); no need for an allowlist.

## Acceptance

- **Behavioural oracle (the gate):** run an EXPANDED search benchmark before and after
  enabling Proposal A, same prompts each run. The current 5-prompt D1 set is too thin
  for a change that affects every search; add search cases: (a) trivial single grep,
  (b) doc-lookup ("is there a doc about X?"), (c) multi-glob, (d) read-after-search
  across multiple files, (e) "find all usages of symbol Y", (f) a no-match search,
  (g) an ambiguous/open-ended search. Capture per-request metrics (turns, tool calls,
  failures, workflow code bytes, input/cache tokens).
- **Explicit FAIL criteria for Proposal A (any one → reject A, fall back to strict
  opt-in or no-exclusion):**
  1. any fan-out search is answered with `bash`/`rg`/`grep`/`find` instead of a
     `caco_run_workflow` call (the escape-hatch substitution);
  2. workflow code failures increase (model writes broken facade scripts);
  3. tool-call count or retries rise materially vs the pre-change run on the same prompt;
  4. answer quality regresses (wrong/incomplete results);
  5. the expected input/cache token savings do not appear on fan-out requests.
- **Capability check:** a search that previously used `grep` returns the same answer via
  the workflow (the doc-search example reproduced).
- **Config check:** `CACO_EXCLUDED_BUILTINS=""` restores `grep`/`glob`;
  `CACO_EXCLUDED_BUILTINS=builtin:grep,builtin:glob,builtin:bash` selects the strict
  diet. Unit test on the parse/merge helper.
- **Measurement honesty:** `scripts/measure-tools.mts` only sizes Caco's `defineTool`
  tools, so the schema-byte saving from excluding built-ins is NOT measurable by our
  oracle and must not be claimed as a hard number. The real, falsifiable evidence is the
  D1 input/cache token delta on fan-out requests; if that delta is absent, the change
  did nothing (fail criterion 5).
- Gates: typecheck ×2, lint:strict, knip, full tests, build:client.

## Plan

1. **Config:** `WORKFLOW_TIMEOUT_CAP_MS` → 130 s (real) + `WORKFLOW_TIMEOUT_ADVERTISED_MS`
   = 120 s (description). [done]
2. **Config helper** (`src/tool-registry.ts`): `DEFAULT_EXCLUDED_BUILTINS` (the shell set)
   + `excludedBuiltinNames()` (defaults ∪ `CACO_EXCLUDED_BUILTINS`), reusing the A5 parse
   pattern. Unit tests. [done]
3. **Wire server.ts:** pass `excludedTools: excludedBuiltinNames()` into
   `createSessionState`; it threads to create + resume + model-switch resume (already
   reads `active.excludedTools`). [done]
4. **Workflow tool description + prompt:** shell runs via `caco.sh` (bash/powershell are
   not separate tools); a single command is a one-line workflow; set `timeoutMs` (≤120 s)
   for slow commands; detach+poll for longer. Advertise 120 s cap. [done]
5. **Verify** in a fresh session post-restart: `bash` absent from the tool list; a shell
   task succeeds via `caco.sh`; the agent does not stall. Dogfood in this repo's own
   session (it loses `bash` too).
6. **Benchmark (optional follow-up):** run the search benchmark for the token/round-trip
   delta. Note the byte-oracle can't see built-in schema bytes; evidence is the D1 token
   delta on shell-heavy requests.

Reverting is one edit (`CACO_EXCLUDED_BUILTINS=""` or trim `DEFAULT_EXCLUDED_BUILTINS`).
Adding `builtin:grep,builtin:glob` later (the read-tool effort) is the same switch.
