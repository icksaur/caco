# Spec: route reads through caco_run_workflow (C1)

## Goal

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

### Proposal B — "strict read diet": exclude `grep` + `glob` + `bash` (the only real force, opt-in)

Add `builtin:bash` (and `read_bash`/`stop_bash`/`list_bash`). This is the **only**
configuration that genuinely forces search/read fan-out through the facade, because it
closes the bash escape hatch. The cost is real and large: no streaming a long
test/build, no background/detached processes, no interactive stdin, and the
failure-focused output shaping (`retrieve_output`) no longer applies (the workflow caps
logs differently). **Off by default**, exposed as an opt-in for users who accept losing
live shell/test ergonomics in exchange for true context discipline. The user's
"bash/git/view are well suited" instinct lands here — but it is a deliberate switch, not
a safe default.

### Proposal C — prompt-nudge only (status quo, already failed)

Strengthen the prompt to prefer the workflow, exclude nothing. **Demoted:** this is
effectively the current state, and the D1 benchmark already showed the model ignores
the nudge. Listed only for completeness; not a real option.

## Recommended design: ship A only if it measures clean; else strict opt-in

Do **not** exclude `bash` globally — the lifecycle/test/streaming loss is too steep for
a default. Sequence:

1. Try **Proposal A** (exclude `grep`+`glob`) and run the expanded benchmark.
2. **If A measures clean** (the model routes search through the workflow and does NOT
   substitute `bash` search — see Acceptance fail criteria) → ship A as the default.
3. **If A shows bash substitution or regressions** → default to **no exclusion** (keep
   the prompt nudge) and ship **Proposal B as a documented opt-in** ("strict read
   diet"), since B is the only configuration that truly forces routing.

Implementation is the same either way (a configurable exclusion list); only the default
contents differ based on the measurement.

- A single source: `DEFAULT_EXCLUDED_BUILTINS` in `src/tool-registry.ts` (next to A5's
  disable switch), unioned with a `CACO_EXCLUDED_BUILTINS` env override (comma-separated,
  same parsing as `CACO_DISABLED_TOOLS`). The env lets the user select the strict diet
  (`builtin:grep,builtin:glob,builtin:bash`) or clear the list without a code change.
  This is NOT over-engineering: rollback and a strict opt-in both need it.
- `server.ts` passes the resolved list to `createSessionState({ ..., excludedTools })`.
  The existing plumbing carries it to every create/resume/model-switch resume.
- **Prompt:** state which search tools are unavailable and that search/fan-out reads go
  through `caco_run_workflow` (`caco.grep`/`caco.rg`/`caco.glob`); single-file view stays
  on the normal view tool. Under Proposal A, also instruct NOT to substitute `bash rg`/
  `grep`/`find` for search (use the workflow) — this is the only lever that makes A more
  than a nudge without removing bash.

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

## Plan (ordered)

1. **Config helper** (`src/tool-registry.ts`): `DEFAULT_EXCLUDED_BUILTINS` +
   `excludedBuiltinNames()` (defaults ∪ `CACO_EXCLUDED_BUILTINS`), reusing the A5
   parse pattern. Unit tests.
2. **Wire server.ts:** pass `excludedTools: [...excludedBuiltinNames()]` into
   `createSessionState`. Confirm it threads to create + resume + model-switch resume
   (it already reads `active.excludedTools`).
3. **Prompt:** state which search tools are unavailable and that search/fan-out reads go
   through `caco_run_workflow`; under Proposal A, explicitly instruct NOT to substitute
   `bash rg`/`grep`/`find`. Make the facade search methods explicit.
4. **Expanded benchmark gate (decides the default):** run the expanded search benchmark
   before/after with `DEFAULT_EXCLUDED_BUILTINS = [grep, glob]`. Evaluate the FAIL
   criteria. If clean → keep grep+glob as the default. If bash substitution or
   regressions appear → set the default to `[]` (no exclusion) and ship the strict diet
   (`grep,glob,bash`) as a documented `CACO_EXCLUDED_BUILTINS` opt-in. Record results in
   this spec.
5. **Document** the `CACO_EXCLUDED_BUILTINS` switch + the strict-diet opt-in in the
   tool-diet docs; note the measurement gap (built-in schema bytes invisible to the
   oracle; evidence is the D1 token delta).

Default contents are chosen by the step-4 measurement, not assumed.
