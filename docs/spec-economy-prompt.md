# Spec: economy prompt — fewer tool turns, less fresh input

## Goals

Make Caco's prompt surfaces drive **economical agent behavior** — fewer tool turns and
fewer fresh input tokens per turn — across all models (Claude, GPT-5.x, Gemini). The two
killers compound: fresh input ≈ (new content per turn) × (turn count), so cutting turns and
trimming per-turn content both pay off, multiplicatively.

Grounded in `docs/research/prompt-economy-research.md` (evidence-backed; sources cited there). This
spec turns that research into a concrete, layered, **measurable** change, honoring the hard
constraint that the worst offenders are un-annotatable.

## The hard constraint (verified)

Caco fully controls only three prompt surfaces; the repeat-call offenders are **not** among
the annotatable ones:

| Surface | Caco control | Re-sent every turn? | Notes |
|---|---|---|---|
| Caco system prompt (`buildSystemMessage`) | full (`mode:'replace'`) | yes, at position 0 | static; attention to it decays as the session grows |
| Caco memory (`formatMemoryForPrompt`) | full | once per create/resume, appended at the END | terse one-fact lines; *feels* sticky due to brevity, not position; NOT a per-turn refresher |
| **`caco_run_workflow` description** | full (`defineTool`) | **yes, re-attended every turn** | the ONLY high-frequency tool surface Caco owns |
| `view` / `edit` / `create` | **none** — SDK builtins (`str_replace_editor`); excludable but **not re-describable** | yes (theirs) | the **observed** repeat-call offenders (per dogfooding, not yet source-quantified per-tool) |

**Implication:** we cannot put a refresher *on* the offending tools. The economy guidance
must live where we DO control, and — crucially — `caco_run_workflow`'s description is both a
per-turn refresher AND a **redirect**: it can pull repeated `view`/`grep` reads toward a
single `caco.read`/`caco.grep` fan-out, attacking the repeat-`view` offender indirectly.
(There is no facade `edit`, so repeated `edit` can only be addressed by the static
two-phase-editing rule — accept this asymmetry.)

## Background: what already exists (do not duplicate)

- System prompt already has: "Batch Tool Calls", "Two-phase editing", workflow fan-out
  nudge, index-before-large-read, retrieve_output guidance.
- `caco_run_workflow` description already has batching guidance + the host-shell banner.
- Memory already injected once at session start.
- **Gaps** (from research): no explicit *exploration budget* (act-over-search/early-stop),
  no *context-reuse* rule (don't re-read what's already in the window; don't echo tool
  output back as prose), no *narration-as-its-own-turn* prohibition, economy rules buried
  mid-prompt (worst position per "Lost in the Middle"), a few `MUST`/CAPS imperatives that
  over-trigger newer Claude.

## Design

Layered placement, because no single spot stays salient for a whole long session.

### Layer 1 — lean "Work Economy" block, TOP of the system prompt (primacy)

Move the core economy directives to the very top (right after the one-line environment
note), as **terse one-liners** (memory-style salience, not prose), assembling the research
doc's A1 (exploration budget), A2 (terse-default + self-resolve), B1 (context reuse), C1
(narration budget), F1 (forbid-list). Proposed block:

```
## Work Economy (most important)
Get enough context fast, then act. Parallelize discovery and stop as soon as you can name
the exact change — prefer acting over another read. Trace only symbols you'll modify; widen
search only when validation fails or a real unknown appears. Default to terse: spend prose
only at phase boundaries and the final summary. Resolve uncertainty yourself and note
assumptions rather than handing back.
Don't:
- re-read a file/output/search result already in this conversation — refer to it
- re-view a file you just edited (edit matches unique text, not line numbers)
- paste back a diff/file/output you just produced — state the conclusion
- restate a plan already in the conversation
- emit a tool call to check state you can infer (but DO check required external UI/session
  state, e.g. first-turn `get_applet_state`)
- spend a whole turn on a progress note — fold it into your next tool batch
- ask the user to confirm an assumption you can reasonably make
- keep searching once you can name the exact change
```

**Confidence (from the research):** A1 (exploration budget), A2 (terse + self-resolve), B1
(context reuse), and C1 (narration budget) are evidence-backed. The **exact forbid-list
wording** and the **incremental value of the end recap (E1)** are measure-first hypotheses —
implement them, but treat them as the variables to A/B, not settled facts.

The existing detailed mechanics ("Batch Tool Calls", "Two-phase editing") stay where they
are (mid-prompt reference material), but the C1 narration clause there is replaced by the
stronger "a standalone note costs a full context replay; fold it into the next tool batch"
wording, and `MUST`/CAPS/bold are softened to plain imperative voice throughout.

### Layer 2 — `caco_run_workflow` description as the every-turn refresher + redirect

Because this description is re-attended **every turn**, add ONE compact economy line that
also **redirects the repeat-`view` offender** into the workflow:

```
Economy: prefer ONE workflow that caco.read/caco.grep-s many files over repeated view/grep
turns; don't re-read what's already in context; never spend a turn on narration alone.
```

This is the closest thing to "annotating the offender" we can do — the workflow is the
alternative to repeated `view`, so its always-fresh description is the right home for the
redirect. **Hard budget: ≤220 characters / ~≤50 tokens** (it is re-sent every turn AND
duplicates Layer 1/3, so its marginal words must stay tightly capped); prefer one sentence.

### Layer 3 — end-of-prompt recap (recency)

Per "Lost in the Middle" (beginning + end attended most), add a 3–4 line recap as the **last
main-prompt block, before the separately-appended `## User Memory`** (memory is appended once
per create/resume via SDK `mode:'append'`, so the recap is the last *authored* prompt content
the model reads before that memory tail) (E1):

```
## Remember
Batch independent tool calls into one response. Don't re-read what's already in context.
Don't narrate in a turn of its own. Act over searching once you know the change to make.
```

### Layer 4 (DEFERRED, measure-first) — periodic re-injection

The static prompt loses salience in very long sessions; the durable fix is re-injecting a
1-line economy reminder near recent context every N turns. **Caco has no per-turn injection
hook today** (the `<system_reminder>` tags are the platform's, not Caco's), so this is a
real feature, not a prompt edit, and it costs fresh input each time it fires. **Out of scope
for v1.** Only pursue if Layers 1–3, measured against the savings model, show turn count
still climbing in long sessions. If pursued: short reminder, gated on turn-count/context-size
threshold, injected at message dispatch.

### Compression (measure-first, low priority)

Research flags ~250–350 cached tokens recoverable by trimming the Capabilities / Applets /
Extensions / Self-Modification / Memory prose (lists the model gets from the tool registry
anyway). Low direct impact (cached), but sharpens attention on the rules that matter. Do this
**after** Layers 1–3 land and only if it doesn't dull any behavior. Never compress the
behavioral rules — trim lists, not behavior.

## Considerations

- **The offender/lever mismatch is the core tension.** The tools that repeat (view/edit)
  are exactly the ones we can't annotate; the tool we can annotate (workflow) isn't a
  repeat offender. The design resolves this only partially: workflow's description redirects
  repeat-*reads* into itself; repeat-*edits* are addressable solely via the static
  two-phase rule. Be honest that the edit-repeat lever is weaker than the read one.
- **Refresher cost.** Every word added to `caco_run_workflow`'s description and the system
  prompt is re-sent every turn (cached, but still occupies window + competes for attention).
  Keep the Layer-2 line ≤2 sentences; keep the top block terse.
- **Placement is a weak lever; salience is stronger.** Top vs bottom is marginal
  (measure-first). Terse one-liners (memory-style) likely help more than repositioning prose
  — the design leans on brevity, not just position.
- **Model-agnostic phrasing (hard requirement).** Plain imperative voice, no `MUST`/ALL-CAPS
  (over-triggers newer Claude per Anthropic), no contradictions (GPT-5 burns reasoning
  reconciling them), motivation in ≤1 clause. One directive per behavior, stated once.
- **No contradictions introduced.** Adding a terse-default must not conflict with the
  existing "keep the user informed / progress updates" guidance elsewhere — audit and
  reconcile (the narration-budget rule supersedes per-step narration).
- **Measurement is the acceptance oracle.** Caco's savings model already tracks, per session:
  virtual tool calls avoided, round trips saved, fresh input, turns. Use a **fixed benchmark
  task** (from `docs/spec-budget.md`) run before/after to compare turns-per-request and
  fresh-input — comparing the *same* task is the oracle; ad-hoc pre/post on different work is
  noise.
- **Reversibility.** All v1 changes are prompt text in `src/prompts.ts` + the workflow tool
  description; git-revertible, no schema/lifecycle impact.

## Acceptance

- **Structural:** the "Work Economy" block is at the TOP of the system prompt (terse
  one-liners, no `MUST`/CAPS); the `caco_run_workflow` economy redirect addition is **≤220
  characters / ~≤50 tokens** (hard budget — it is re-sent every turn and duplicates Layer 1/3,
  so its marginal words must stay tightly capped); an end recap is the last main-prompt block
  before the separately-appended memory; no remaining `MUST`/ALL-CAPS imperatives in the
  economy sections; no internal contradictions (terse-default vs keep-informed reconciled);
  the first-turn `get_applet_state` carve-out is preserved.
- **Behavioral (the real test) — measurement protocol, not a vibe.** Prompt behavior is
  nondeterministic, so a single before/after run is not an oracle. Required protocol:
  - **Controls:** one fixed model + version, fixed reasoning effort, fixed context tier,
    fresh sessions, metrics reset/snapshot per run (Caco savings model + `requestIn`,
    `requestTurns`, `requestToolFailures`, `requestWallMs`).
  - **Tasks:** run ALL fixed benchmark prompts B1–B5 from `docs/spec-budget.md` (note: B4
    there is a *precise single-file edit*, not multi-file — **add a real multi-file edit
    benchmark** if one is wanted as a target case; do not mislabel B4).
  - **Repetition:** ≥3 runs per task; compare **per-task medians**.
  - **Pass criterion:** **no per-task increase in `requestToolFailures`**, AND **no
    `requestTurns` regression** on any task — unless a turn increase is explicitly justified by
    a lower failure rate. `requestIn` should trend down or hold. (A turn-count regression that
    merely keeps fresh-input flat does NOT pass — turns are a primary goal, not a free
    variable.)
- **No regression:** existing batching / two-phase / workflow / index guidance still present
  (possibly relocated), not lost in the rewrite.
- Gates: typecheck ×2, lint:strict, knip, full tests (incl. prompt/system-message tests),
  build:client.

## Plan

1. **Top block** — insert the terse "Work Economy" block after the environment note;
   assemble A1/A2/B1/C1/F1 as one-liners.
2. **Narration clause** — replace the weaker "Do NOT narrate…" sentence with the
   "standalone note = full context replay; fold into next batch" wording.
3. **Soften imperatives** — convert `MUST`/ALL-CAPS/bold "Never/always" in the economy
   sections to plain imperative voice; audit for contradictions with keep-informed guidance.
4. **Workflow description** — add the ≤2-line economy redirect line to
   `caco_run_workflow`'s `DESCRIPTION` (`src/workflow/tool.ts`).
5. **End recap** — add the "## Remember" block as the last content before memory.
6. **Gates** + a before/after benchmark reading from the savings model on the fixed tasks.
7. **(Deferred)** compression pass; periodic re-injection feature — only if measurement
   warrants.

v1 is Layers 1–3 (static prompt + workflow-description refresher + end recap), phrased
model-agnostically and validated by a same-task before/after on the savings model. Periodic
re-injection and section compression are deferred, measure-first.
