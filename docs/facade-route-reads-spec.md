# Spec: route reads through caco_run_workflow (C1)

## Goal

Force fan-out **search/read** through `caco_run_workflow` by excluding the
built-in tools its facade already covers losslessly. Two wins:

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

### Proposal A — exclude `grep` + `glob` by default (RECOMMENDED)

Set `excludedTools: ['builtin:grep', 'builtin:glob']`. Search must go through the
workflow (`caco.grep`/`caco.rg`/`caco.glob`), keeping hit lists out of context.
Single-file view and edit (via `str_replace_editor`) and shell (`bash`) are
untouched, so the common read-A-then-edit loop and test runs are unaffected. Lowest
risk; captures the document-search win the user validated.

### Proposal B — also exclude `bash` (opt-in, behind config)

Add `builtin:bash` (and its lifecycle tools). Routes one-shot shell (git status/diff,
quick commands) through `caco.sh` too — more context kept out, but at real cost:
no streaming a long test/build, no background/detached processes, no interactive
stdin, and the failure-focused output shaping (`retrieve_output`) no longer applies
(the workflow caps logs differently). Offer as a config opt-in, **off by default**,
for users who accept the tradeoff. The user leans toward "bash/git/view are well
suited" — B is where that lands, but it should be a deliberate switch, not the default.

### Proposal C — prompt-nudge only, exclude nothing

Strengthen the system prompt to prefer `caco_run_workflow` for 3+ reads, but keep
the built-ins. Rejected as the highlight: the D1 benchmark already had the workflow
available with a nudge and the model never used it. Without removing the alternative,
behaviour does not change. Kept only as the fallback if A measurably hurts.

## Recommended design: Proposal A, configurable

- A single source: `DEFAULT_EXCLUDED_BUILTINS = ['builtin:grep', 'builtin:glob']` in
  `src/tool-registry.ts` (next to A5's disable switch), unioned with a
  `CACO_EXCLUDED_BUILTINS` env override (comma-separated, same parsing as
  `CACO_DISABLED_TOOLS`). This lets the user add `builtin:bash` (Proposal B) or clear
  the list without a code change.
- `server.ts` passes the resolved list to `createSessionState({ ..., excludedTools })`.
  The existing plumbing carries it to every create/resume.
- **Prompt:** update the workflow nudge to state that `grep`/`glob` are unavailable and
  that search/fan-out reads go through `caco_run_workflow` (`caco.grep`/`caco.rg`/
  `caco.glob`); single-file view stays on the normal view tool. This prevents the
  model from flailing when it reaches for a now-absent tool.

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
  `view` command therefore stay on the built-in path. C1 is about search, not single
  reads.
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

- **Behavioural oracle (the gate):** run the fixed D1 benchmark
  (`docs/tool-diet-bench.md`) before and after enabling Proposal A, same prompts.
  Expected: B1/B2 (fan-out search) collapse to a single `caco_run_workflow` call
  (`requestToolCalls` ≈1, `requestWorkflowCodeBytes` > 0) with no rise in
  `requestToolFailures`; B3 (single view) and B4 (edit) unchanged (they never used
  grep/glob); overall input/cache tokens per fan-out request drop. If failures rise or
  the model stalls, A is rejected → fall back to C.
- **Capability check:** a search that previously used `grep` returns the same answer
  via the workflow (the doc-search example reproduced).
- **Config check:** `CACO_EXCLUDED_BUILTINS=""` restores `grep`/`glob`;
  `CACO_EXCLUDED_BUILTINS=builtin:bash` (Proposal B) additionally removes bash. Unit
  test on the parse/merge helper.
- Gates: typecheck ×2, lint:strict, knip, full tests, build:client.

## Plan (ordered)

1. **Config helper** (`src/tool-registry.ts`): `DEFAULT_EXCLUDED_BUILTINS` +
   `excludedBuiltinNames()` (defaults ∪ `CACO_EXCLUDED_BUILTINS`), reusing the A5
   parse pattern. Unit tests.
2. **Wire server.ts:** pass `excludedTools: [...excludedBuiltinNames()]` into
   `createSessionState`. Confirm it threads to create + resume + model-switch resume
   (it already reads `active.excludedTools`).
3. **Prompt:** note that `grep`/`glob` route through `caco_run_workflow`; keep view/edit
   on the normal tools. Make the facade search methods explicit.
4. **Benchmark gate:** run the D1 fixed benchmark before/after; record in this spec.
   Proceed only if the behavioural oracle passes.
5. **Document** the `CACO_EXCLUDED_BUILTINS` switch (and Proposal B opt-in) in
   `docs/response-actions.md`'s sibling or the tool-diet docs; note the measurement gap.

Proposal A is the highlight; B is a documented opt-in; C is the fallback if the
benchmark shows the model can't absorb the exclusion.
