# spec-prompt-trim

**Status:** draft, reviewed once (findings folded). Amends `spec-prompt-stable-prefix`,
which fixed the *order* of the system message; this fixes its *content*.

## Goals

The system message states each rule once, in the place that owns it, and stops
re-documenting tools whose descriptions the model already receives in the same
request. Caco keeps the four things only the prompt can say: that it renders rich
HTML in a browser, how to learn about itself, that it should offer
`caco-actions`, and the work-economy rules.

Baselines, kept distinct because they are easy to conflate:

- **static body** (the text in `src/prompts.ts`): **2,305 tokens** — the only figure
  this spec moves. Target ~1,400.
- **`systemTokens`** (body + runtime-injected memory, applets, and the user's
  `copilot-instructions.md`): 7,608.
- **tool definitions**: 7,644, addressed separately by `spec-builtin-defer`.

## Design

**The organising rule: each fact lives where it is enforced.** A tool's mechanics
belong in its description — the model gets both in the same request, so restating
them is pure duplication. Project conventions belong in `AGENTS.md`. Personal
style belongs in `~/.copilot/copilot-instructions.md`. Caco's own docs belong in
`caco_docs`. What remains is what none of those can carry: the rendering surface,
the economy rules, and the response-action contract.

This matches convention: pi lists tools **one line each** ("a tool appears in
Available tools only when the caller provides a one-line snippet") and pushes
project guidance to `AGENTS.md`; Codex has a formal `AGENTS.md` spec section. Caco
is the outlier — see `files/harness-prompts.md`.

**Duplication within the prompt, measured.** Four rules are stated repeatedly:

- "stop searching once you can name the change" — **3×** (Work Economy, DON'T list, Remember)
- "don't narrate in its own turn" — **4×** (Work Economy, DON'T, Batch Tool Calls, Remember)
- "don't re-view after an edit" — **2×**, near-verbatim including the `edit` parenthetical
- "don't re-read what's in context" — **2×**

`## Remember` is entirely a restatement of the other three and is deleted.

**Duplication against tool text, verified per item against the live descriptions.**

- `workflowNudge` (~230 tok) — shell routing, batching, fan-out, `peek`, `timeoutMs`:
  **all five** in `caco_run_workflow`.
- `## Tool Availability` (190 tok) — deferral, batch-in-one-call, next-turn
  availability, list-with-no-args: **all four** in `caco_enable_tools`.
- `## Reading Code Efficiently` (97 tok) — the `retrieve_output` handle format and
  narrowing, `index`'s skeleton behaviour: in both tools.

**One item in that section is NOT duplicated and must survive**: how to read the
`<deferred_tools>` runtime note. `caco_enable_tools`' description explains listing
and enabling but never mentions that block, so cutting the whole section would
remove the only explanation of a runtime message the model actually receives.

What else survives is *usage policy* a schema cannot express: prefer `index` before
a large read; prefer the workflow facade over per-file reads; a capability being
absent does not mean it does not exist. Policy stays, mechanics go — the nuance the
harness survey flags, since mature prompts do keep tool-usage policy.

**Negations become per-line.** `Don't:` followed by eight bare items means each line
read alone is a positive imperative ("paste back a diff/file/output you just
produced"), and the scoping header must survive eight lines of attention. Claude
Code writes each negation self-contained ("Don't add features…", "Don't narrate…").
Cost ~10 tokens. The list also shrinks to the four rules stated nowhere else.

**Style is a judgment call; placement is not.** pi is almost entirely DO, Claude Code
heavily DON'T. The two most-respected harnesses disagree on phrasing while agreeing
on placement, so this spec changes placement decisively and phrasing only where a
line is ambiguous read alone.

**The Memory section is wrong today.** It instructs use of `caco_memory`, which is
**currently deferred** — a tool the model cannot see, with no hint it is enableable.
Its how-to also duplicates the tool description. The one fact only the prompt can
carry is that **memory is already injected into context**, so the tool is for
*changing* it. That survives; the rest goes.

**The stop.sh guard STAYS in the system prompt.** The user asked for it to move to
`AGENTS.md`, and this spec deliberately declines. It is a footgun guard, not a
convention: "running stop.sh kills your own session" is irreversible, and the
failure is silent until it happens. `AGENTS.md` is repo-scoped and its loading is
not something a one-time probe can guarantee for every future session, whereas the
guard costs ~25 tokens. Asymmetric risk for negligible saving. Fuller Caco-dev
guidance still moves to `AGENTS.md`; only the guard is pinned.

**Relocation targets and their loading.** `~/.copilot/copilot-instructions.md` is
**confirmed loaded** — its content appears in every session's context — so the emoji
rule moves there, and the commit rule, which that file already states, is deleted
as a duplicate.

`AGENTS.md` is **unverified**, and the earlier reasoning here was aimed at the wrong
mechanism: `enableOnDemandInstructionDiscovery` is an opt-in flag Caco does not set,
so the on-demand-after-file-view path is **off**. Custom instructions are therefore
loaded by the eager path (`skipCustomInstructions` is likewise unset), which is what
the probe must actually test — eager session-start loading of a repo-root
`AGENTS.md`, not on-demand surfacing.

## Invariants

- **The stable prefix stays stable** — per-session content (cwd) remains last, after
  the body and memory, so sessions in different directories keep sharing the prefix
  (`spec-prompt-stable-prefix`). Every edit here is body-only.
- **Each rule is stated once** in the prompt body.
- **The four must-keeps survive**: browser/rich-HTML rendering, `caco_docs`
  self-discovery, the `caco-actions` contract, the work-economy rules.
- **No behaviour is deleted, only relocated** — anything cut is already in a tool
  description, already in `copilot-instructions.md`, or moved to a **named**
  `caco_docs` section in the same change.
- **A destructive-action guard is never relocated onto an unverified mechanism.**

## Considerations

- **This busts the prompt cache once, for every session.** The body is the shared
  prefix. One-time cost against a permanent per-turn saving; at ~900 tokens it
  repays within a couple of turns per session.
- **`prompts-stable-prefix.test.ts` pins current wording** — notably "explains
  deferral + the `caco_enable_tools` discover/enable loop, in the stable prefix",
  exactly the section being trimmed. That test encodes the old contract and must be
  updated deliberately, not deleted.
- **Custom-instruction injection position matters to the cache.** The stable-prefix
  invariant assumes injected instructions do not land ahead of the body; row 1
  checks this rather than assuming it, since moving text into
  `copilot-instructions.md` is only free if that text sits where memory does.
- **`caco_docs` is itself deferrable**, so a prompt that says "call `caco_docs`" must
  survive it being absent — which is why the absent≠nonexistent line is kept.
- **Media embeds have no tool and no schema.** The capability is unreachable if the
  line is simply deleted, so it moves to a **named** `caco_docs` section that the
  prompt points at by name, and an oracle asserts that section resolves.
- **Sub-agents and scheduled sessions read the same prompt.** Rules that only make
  sense for an interactive user are already scoped by wording; keep it that way.

## Risks and Mitigations

- **A diffuse behavioural regression** — the real risk, with no unit test. Mitigated
  by cutting only text proven duplicated in the same request, asserting the
  must-keeps, and shipping in reviewable slices.
- **A pointer rots** — the prompt names a `caco_docs` section that no longer exists →
  the pointer-resolvability oracle (row 2) catches it in the gate.
- **Rules creep back** → the dedup oracle fails the gate.
- **Token target drives meaning-losing cuts** → the target is observational, not a gate.

## Acceptance

- Observable: a fresh session batches reads, offers actions, renders HTML, and finds
  its own docs. **Operator signoff after a day of use** is the real check — there is
  no automated oracle for "the agent still behaves well", and this spec does not
  invent a proxy for one.
- Budgets: static body ≤ ~1,400 tokens (observational).
- Gates: `npm run build` green, including the updated stable-prefix suite.
- Oracles: rows 1–3 below. Each must **fail against today's prompt** before its
  change exists — a test that passes now is not pinning anything.

## Plan

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 0 | Probe whether a repo-root `AGENTS.md` is EAGERLY loaded at session start (distinctive marker, fresh session, ask if visible). Aimed at the eager path — `enableOnDemandInstructionDiscovery` is opt-in and unset, so on-demand is off. Result gates row 6's dev-guidance move only; the stop.sh guard stays regardless | `AGENTS.md` (probe only) | live session reports the marker | guard-never-relocated |
| 1 | Verify injected custom instructions land AFTER the body (where memory does), so relocating text into `copilot-instructions.md` cannot move content ahead of the cacheable prefix | - | inspect a built session's message order | stable-prefix |
| 2 | Add the falsifiable oracle suite: (a) **mechanic-token absence** — the body must not contain schema-owned literals (`timeoutMs`, `caco.reads`, `caco.peek`, `out_`, `emit(`); (b) **section absence** — no `## Remember`, no `## Reading Code Efficiently`; (c) **must-keep literals** — `caco-actions`, `caco_docs`, `<deferred_tools>`, and the HTML-rendering line; (d) **pointer resolvability** — every `caco_docs section="X"` named in the body returns non-empty content | `tests/unit/prompts-trim.test.ts`, `src/dev-docs-tool.ts` | all four fail against today's prompt | rule-stated-once, must-keeps-survive |
| 3 | Add a dedup assertion at CONCEPT level, not phrase level: for each of the four repeated rules, a regex family (e.g. `/re-?read/i` in a rule context) matches at most once in the body | `tests/unit/prompts-trim.test.ts` | fails today (each currently matches 2–4×) | rule-stated-once |
| 4 | Convert the DON'T list to per-line negations; cut the five items stated elsewhere, keeping the four unique ones; delete `## Remember` | `src/prompts.ts` | rows 2–3 | rule-stated-once |
| 5 | Strip tool mechanics: drop `workflowNudge`, most of `## Tool Availability`, and `## Reading Code Efficiently` — **retaining the `<deferred_tools>` explanation and the usage policy lines** | `src/prompts.ts`, `tests/unit/prompts-stable-prefix.test.ts` (update the deferral-wording assertion) | row 2a/2c; stable-prefix suite green | no-behaviour-deleted |
| 6 | Rewrite `## Memory` to the one fact the tool cannot carry (pre-injected; the tool changes it); stop directing an unconditional call to a deferrable tool | `src/prompts.ts` | assertion that no section directs an unconditional call to a deferrable tool | no-behaviour-deleted |
| 7 | Move the emoji rule to `copilot-instructions.md`; delete the commit rule (already there); move fuller Caco-dev guidance to `AGENTS.md` if row 0 passed. **Keep the stop.sh guard** | `src/prompts.ts`, `~/.copilot/copilot-instructions.md`, `AGENTS.md` | assertion that the guard is still present in the body | guard-never-relocated |
| 8 | Move capability prose (media embeds, schedules/MCP/hooks, self-modification, extensions) into **named** `caco_docs` sections, leaving one pointer line each | `src/prompts.ts`, `src/dev-docs-tool.ts` | row 2d proves each pointer resolves | no-behaviour-deleted |
| 9 | Measure the built body before/after and report | - | token delta (observational) | stable-prefix |

## Rationale

The prompt grew by accretion: each feature added a section, and each new rule was
stated wherever it was being thought about. Nothing in it is wrong — it is simply
said three times, in three places, two of which are also said by a tool schema in
the same request. The cut is therefore mostly mechanical. The genuinely delicate
parts are the three where losing text loses something real: the stop.sh guard (kept,
not moved), media embeds (no tool to discover them), and the `<deferred_tools>`
explanation (unique to the prompt, and easy to lose while deleting the section
around it).
