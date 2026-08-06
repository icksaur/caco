# spec-prompt-trim

**Status:** draft. Amends `spec-prompt-stable-prefix` (which fixed the *order* of the
system message; this fixes its *content*).

## Goals

The system message states each rule once, in the place that owns it, and stops
re-documenting tools whose descriptions the model already receives in the same
request. Caco keeps the four things only the prompt can say: that it renders rich
HTML in a browser, how to learn about itself, that it should offer
`caco-actions`, and the work-economy rules.

Measured: the static body is **2,305 tokens** (system total 7,608 incl. runtime
memory/applets/instructions). Target ~1,400 static, with no behaviour lost.

## Design

**The organising rule: each fact lives where it is enforced.** A tool's mechanics
belong in its description — the model gets both in the same request, so restating
them is pure duplication. Project conventions belong in `AGENTS.md`. Personal
style belongs in `~/.copilot/copilot-instructions.md`. Caco's own docs belong in
`caco_docs`. What remains in the prompt is what none of those can carry: the
rendering surface, the economy rules, and the response-action contract.

This matches the convention across harnesses: pi lists tools as **one line each**
("a tool appears in Available tools only when the caller provides a one-line
snippet") and pushes project guidance to `AGENTS.md`; Codex has a formal
`AGENTS.md` spec section. Caco is currently the outlier — see `files/harness-prompts.md`.

**Duplication is measured, not asserted.** Four rules are stated repeatedly *within*
the prompt today:

- "stop searching once you can name the change" — **3×** (Work Economy, DON'T list, Remember)
- "don't narrate in its own turn" — **4×** (Work Economy, DON'T, Batch Tool Calls, Remember)
- "don't re-view after an edit" — **2×**, near-verbatim including the `edit` parenthetical
- "don't re-read what's in context" — **2×**

`## Remember` is entirely a restatement of the other three and is deleted; its job
is done by stating each rule once, well-placed.

**Tool-text duplication, verified against the live descriptions.** Every item below
was confirmed present in the tool's own description via `GET /api/mcp/servers`:

- `workflowNudge` (~230 tok) — shell routing, batching, fan-out, `peek`, `timeoutMs`:
  **all five** already in `caco_run_workflow`.
- `## Tool Availability` (190 tok) — deferral, batch-in-one-call, next-turn
  availability, list-with-no-args: **all four** already in `caco_enable_tools`.
- `## Reading Code Efficiently` (97 tok) — the `retrieve_output` handle format and
  narrowing, and `index`'s skeleton behaviour: already in both tools.

What survives from these is only the *policy* a schema cannot express: **prefer
`index` before a large read**, and **prefer the workflow facade over per-file
reads**. Policy stays; mechanics go. This is the one nuance the harness survey
flags — mature prompts do keep tool-*usage policy*, just not tool docs.

**Negations become per-line.** `Don't:` followed by eight bare items means each
line read alone is a positive imperative ("paste back a diff/file/output you just
produced"), and the scoping header must survive eight lines of attention. Claude
Code — the most heavily tuned prompt available — writes each negation
self-contained ("Don't add features…", "Don't narrate…"). Cost is ~10 tokens.

The list also shrinks to the rules stated nowhere else: don't emit a tool call to
check inferable state, don't ask the user to confirm an assumption you can make,
don't restate a plan, don't paste back output you just produced.

**Style is a judgment call; placement is not.** pi is almost entirely DO, Claude
Code is heavily DON'T. The two most-respected harnesses disagree on phrasing while
agreeing on placement, so this spec changes placement decisively and phrasing only
where a line is ambiguous read alone.

**The Memory section is currently wrong.** It instructs the agent to use
`caco_memory`, which is **deferred right now** — a tool the model cannot see, with
no hint it is enableable. Its how-to also duplicates the tool description. What
only the prompt can say is that **memory is already injected into context**, so the
tool is for *changing* it, not reading it. That single fact survives; the rest goes.

**Relocation targets, with their loading verified separately.**
`~/.copilot/copilot-instructions.md` is **confirmed loaded** (its content appears in
every session's context), so the emoji rule moves there and the commit rule — which
that file **already states** — is simply deleted as a duplicate.

`AGENTS.md` is **not confirmed**. The SDK exposes instruction discovery as
"on demand after successful file views… combined with `skipCustomInstructions` and
the runtime-side `ON_DEMAND_INSTRUCTIONS` feature flag", and Caco sets none of
those options. On-demand-after-a-file-view is materially weaker than
loaded-at-session-start, so the relocation cannot be assumed.

This matters more than a normal relocation because the rule in question is a
**footgun guard, not a convention**: "never run stop.sh/start.sh — use
`restart_server`; running stop.sh kills your own session." If it silently fails to
load, an agent working in this repo kills the user's live session. Row 0 verifies
loading before anything moves, and if it fails the guard **stays in the prompt** —
it is ~25 tokens and the failure it prevents is severe.

## Invariants

- **The stable prefix stays stable** — per-session content (cwd) remains last, after
  the body and memory, so sessions in different directories keep sharing the prefix
  (`spec-prompt-stable-prefix`). Every edit here is body-only.
- **Each rule is stated exactly once** in the prompt body — the property that
  regresses, and the one this spec makes machine-checkable.
- **The four must-keeps survive**: browser/rich-HTML rendering, `caco_docs`
  self-discovery, the `caco-actions` contract, and the work-economy rules.
- **No behaviour is deleted, only relocated** — anything cut from the prompt is
  either already in a tool description, already in `copilot-instructions.md`, or
  moved to `caco_docs`/`AGENTS.md` in the same change.
- **A safety guard is never relocated on an unverified mechanism.**

## Considerations

- **This busts the prompt cache once, for every session.** The body is the shared
  prefix, so the first turn after deploy re-writes it everywhere. That is a
  one-time cost against a permanent per-turn saving; at ~900 tokens saved it repays
  within a couple of turns per session.
- **The existing `prompts-stable-prefix.test.ts` pins current wording** — notably
  "explains deferral + the `caco_enable_tools` discover/enable loop, in the stable
  prefix", which is exactly the section being trimmed. That test encodes the old
  contract and must be updated deliberately, not deleted.
- **`caco_docs` is itself deferrable**, so a prompt that says "call `caco_docs`" must
  survive it being absent. The Tool Availability rule (a capability being absent
  does not mean it does not exist) is what makes that safe, and is therefore one of
  the few lines in that section worth keeping.
- **Media embeds have no tool and no discoverability.** Deleting the line makes the
  capability unreachable, so it moves to `caco_docs` rather than being cut.
- **Sub-agents and scheduled sessions read the same prompt.** A rule that only makes
  sense for an interactive browser user (e.g. offering actions) is already scoped by
  wording; keep it that way.

## Risks and Mitigations

- **A diffuse behavioural regression** — the real risk, and the one with no unit
  test. Mitigated by: cutting only text proven duplicated elsewhere in the same
  request; keeping all four must-keeps under explicit assertions; and shipping in
  reviewable slices rather than one rewrite.
- **The safety guard is lost** → row 0 gates it; failure means it stays.
- **Rules creep back in** → the dedup oracle asserts single-statement, so a future
  edit that re-adds a rule fails the gate.
- **Token target drives cuts that lose meaning** → the target is a consequence, not
  a gate; Acceptance treats the count as observational.

## Acceptance

- Observable: a fresh session behaves the same — batches reads, offers actions,
  renders HTML, finds its own docs. **Operator signoff** after a day of use is the
  real check; there is no automated oracle for "the agent still behaves well", and
  this spec does not pretend otherwise.
- Budgets: static body ≤ ~1,400 tokens (observational, not a gate).
- Gates: `npm run build` green, including the updated stable-prefix suite.
- Oracles: the dedup assertion and the must-keep assertions below; each must fail
  before its change exists.

## Plan

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 0 | **Verify `AGENTS.md` is actually loaded into a session** (write a distinctive marker into a repo-root `AGENTS.md`, start a session there, ask whether the marker is visible). If not loaded, drop row 6's relocation and keep the stop.sh guard in the prompt | `AGENTS.md` (probe only) | live session reports the marker | safety-guard-never-relocated-unverified |
| 1 | Add the dedup + must-keep oracle: each canonical rule appears at most once in the body; the four must-keeps are present | `tests/unit/prompts-trim.test.ts` | rule-phrase table vs the built message; fails on today's prompt | rule-stated-once, must-keeps-survive |
| 2 | Convert the DON'T list to per-line negations and cut the five items stated elsewhere, keeping the four unique ones | `src/prompts.ts` | dedup oracle; each retained line contains its own negation | rule-stated-once |
| 3 | Delete `## Remember`; fold "stop searching once you can name the change" into Work Economy only | `src/prompts.ts` | dedup oracle | rule-stated-once |
| 4 | Strip tool mechanics: drop `workflowNudge`, most of `## Tool Availability`, and `## Reading Code Efficiently`, keeping only the usage POLICY (index-before-large-read, prefer the facade, absent≠nonexistent) | `src/prompts.ts`, `tests/unit/prompts-stable-prefix.test.ts` (update the deferral-wording assertion) | assertion that the retained lines are policy, not mechanics; stable-prefix suite green | rule-stated-once, no-behaviour-deleted |
| 5 | Rewrite `## Memory` to the one fact the tool cannot carry (memory is pre-injected; the tool changes it), and stop instructing use of a possibly-deferred tool | `src/prompts.ts` | assertion that the section does not direct an unconditional call to a deferrable tool | no-behaviour-deleted |
| 6 | Move the emoji rule to `~/.copilot/copilot-instructions.md`; delete the commit-message rule (already there); relocate the stop.sh guard per row 0's verdict | `src/prompts.ts`, `~/.copilot/copilot-instructions.md`, `AGENTS.md` (if row 0 passed) | assertion that the prompt no longer states rules the instructions file owns | no-behaviour-deleted |
| 7 | Move capability prose (media embeds, schedules/MCP/hooks sales, self-modification, extensions) into `caco_docs`, leaving one pointer line | `src/prompts.ts`, `src/dev-docs-tool.ts` | `caco_docs` returns the moved content; prompt retains a pointer | no-behaviour-deleted |
| 8 | Measure the built message before/after and report | - | token delta (observational) | stable-prefix |

## Rationale

The prompt grew by accretion: each feature added a section, and each new rule was
stated wherever it was being thought about. Nothing here is wrong — it is simply
said three times, in three places, two of which are also said by a tool schema in
the same request. The cut is therefore mostly mechanical, and the only genuinely
delicate parts are the two where losing text loses a capability: the stop.sh guard
(a safety rule behind an unverified loading mechanism) and media embeds (a feature
with no tool to discover it).
