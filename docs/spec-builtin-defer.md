# spec-builtin-defer

**Status:** draft. Extends `spec-tool-reveal` phase C and
`docs/archive/spec-defer-default-inversion.md` (which did this for Caco tools).

## Goals

SDK built-in tools become defer-eligible, so an unused one costs nothing per turn
instead of costing forever. Today builtins are all-or-nothing: hard-excluded
(gone permanently, not re-enableable) or sent every turn. There is no middle.

Measured live on this instance: **8 enabled builtins cost 4,867 tokens/turn** —
more than all 6 enabled Caco tools (2,948). Every one reports
`deferEligible: false`.

`task` 1723 · `skill` 705 · `str_replace_editor` 679 · `grep` 583 ·
`read_agent` 395 · `list_agents` 329 · `glob` 277 · `web_fetch` 176

`grep`/`glob` (860 combined) duplicate `caco.grep`/`caco.glob`, already reachable
inside `caco_run_workflow`, and are handled by exclusion rather than deferral (see
Design). `task` is the single most expensive definition in the
session — and it is *inflated by the operator's own custom agents*: a bare session
measures 793 tokens, this one 1,723, because `.github/agents` entries are appended
to the same description.

## Design

**Extend the inversion, do not invent a mechanism.** `NEVER_DEFER_BUILTINS` names
the builtins that must always be sent; every other non-policy-excluded builtin
joins the candidate universe in `computeStaleDeferCandidates`, keyed by
`builtinKey(name)`. The staleness rule, the cold-seam gating, the live recompute,
and the `caco_enable_tools` recovery path are all reused unchanged.

**The candidate source must be synchronous.** `computeStaleDeferCandidates` is sync
and runs inside create/resume; `listBuiltinTools()` is an async client RPC, so it
cannot be called there. Mirror the Caco solution exactly: a
`setBuiltinToolNames(names)` / `getBuiltinToolNames()` pair on `SessionManager`,
populated once from the first successful `listBuiltinTools()` (the `/servers`
payload already performs that call). An empty cache yields no builtin candidates,
which over-sends rather than over-hides — the same safe direction as an
unregistered Caco catalog, and the reason this needs no await.

**Builtins ride the live recompute, never the latch.** The persisted auto-defer
latch takes MCP keys only, because its sole clear path is a per-MCP-server operator
un-defer. `Built-in` is a pseudo-server with no such control, so a latched builtin
would strand deferred forever — the identical stranding the Caco rule avoids, and
the one `isPseudoServer` now refuses to create. Builtin keys therefore go into
`staleCacoLive`-style live staleness only, and the existing Caco-key purge extends
to builtin keys so any already-latched entry heals itself. (Verified 2026-08-05:
`~/.caco/auto-defer.json` is currently `[]`, so no migration debt exists today.)

**Protect only `str_replace_editor`.** It is the SDK's sole view/edit/create tool
and Caco ships no replacement — `DEFAULT_EXCLUDED_BUILTINS` already documents this
as the reason it is not excluded. Deferring it would leave the agent unable to
edit a file until it noticed and re-enabled, mid-task. Everything else is
recoverable in one round trip and governed by usage.

Deliberately **not** protected, with reasons:
- `task` — expensive and periodic, not continuous. Exactly the profile deferral
  is for.
- `read_agent` / `list_agents` — reactive, needed when a background agent
  completes. Same trade already accepted for `caco_herd_state`: autocontinue
  usually makes the enable round-trip automatic, and 724 tokens every turn for a
  rare event is the worse deal.
- `skill` — a discovery-adjacent tool, but unlike `caco_docs` its *availability*
  is announced by the `<available_skills>` block in context, not by the tool
  definition. Deferring it does not hide the skills; it only defers the invoker.
  The asymmetry with `caco_docs` is deliberate and worth stating: `caco_docs` is
  protected because deferral makes it INVISIBLE (nothing else announces it), whereas
  a deferred `skill` still has its skills advertised every turn. The cost is that
  the skill contract says "invoke IMMEDIATELY as your first action", which a deferred
  invoker turns into enable-then-invoke. **Row 1 must verify the `<available_skills>`
  block is present independently of the tool definition before deferring `skill`;
  if it is not, `skill` joins the protected set.**

**`grep` and `glob` are hard-excluded, not deferred** — the one place this spec
uses the older mechanism, and deliberately. Deferral is *passive*: it fires only
when a tool goes stale, so a `grep` reached for even occasionally never ages out
and its 583 tokens are paid forever. Exclusion is the only option that changes
behaviour, which is exactly why the shell family was excluded rather than left to
usage — `tool-registry.ts` states the rule as "route all shell through `caco.sh`
inside `caco_run_workflow`". Search is the same shape: `caco.grep`/`caco.glob`
already exist in the facade, and one workflow call can run five searches where five
`grep` calls each cost a round trip. Turns dominate tokens, so forcing the batched
path is worth more than the 860 tokens it also saves.

**The stated blocker is discharged.** That same comment parks search/read tools
behind "a separate future effort (`index_multiread`)". `spec-caco-frames` describes
itself as "the pragmatic unification of B2 (graph) and `index_multiread`", and
`caco.frames` has shipped — so the general read-reducer that grep/glob were waiting
on now exists. Nothing is being pre-empted.

**Reversibility differs from deferral, and that is the trade.** A deferred tool is
one `caco_enable_tools` call away; an excluded builtin needs a config edit or
`CACO_EXCLUDED_BUILTINS` plus a restart, and classifies `disabled` (not
re-enableable) in the applet. The agent cannot undo it mid-task. That is acceptable
for search precisely because the capability is not lost — only the route changes —
whereas the same move on `str_replace_editor` would remove an ability outright.

**Parity is via three facade calls, not one.** `caco.grep` is a strict subset of
builtin `grep`: no `-A/-B/-C` context, no `count` mode, no multiline, no type
filter. The gaps are covered by `caco.rg(args[])` (raw ripgrep — full parity by
construction) and `caco.peek(path, anchors, context)` (±context around literal
anchors, which is the actual use case `-C` serves when editing). One real
behavioural difference must be documented rather than papered over: facade tree
searches are **rooted at the session directory**, so an external tree needs
`caco.rg(['pat','/abs'])` or `caco.sh`.

**Policy-excluded builtins are untouched.** `classifyTool` checks
`policyDisabled` before the dynamic set, so a hard-excluded builtin classifies
`disabled`, never `deferred`, and cannot be re-enabled. That precedence is what
keeps the shell family and `ask_user` permanently gone rather than one enable call
away, and this spec must not weaken it.

**Two SDK settings that look relevant did not help, with a caveat.**
`SubagentSettings.disabledSubagents` and `SessionOpenOptions.disabledSkills` both
exist and Caco wires neither. Measured directly against the SDK (`rpc.tools.list`,
three fresh sessions): `task` stayed 793 tokens and `skill` 640 in every case, with
an identical persona list — consistent with the doc wording, which says disabled
subagents "cannot be dispatched" and says nothing about the description.

**The scope of that result is narrower than it looks.** Those sessions were bare,
so `task` was at its 793-token floor; the probe therefore shows the settings do not
remove BUILT-IN personas, and does NOT establish anything about the ~930 tokens
that operator-defined `.github/agents` entries append. If a future attempt wants to
shrink `task` in place, the open question is whether `disabledSubagents` suppresses
a CUSTOM agent's block — untested here, and worth one probe before assuming either
way. What is settled: these settings are not a substitute for not sending the
definition.

**Cost is measured, not estimated.** The `/servers` payload already carries a live
`tokenCost` per tool, so the before/after is read from the running instance rather
than computed from a heuristic.

## Invariants

- **The escape hatch is always reachable** — `caco_enable_tools` is a Caco tool and
  already protected; deferring builtins cannot strand a session.
- **Policy beats deferral** — a `policyDisabled` builtin classifies `disabled` and
  is never re-enableable, regardless of the candidate set.
- **The agent can always edit a file** — `str_replace_editor` is never deferrable.
- **One eligibility predicate** — the applet badge and the resume-time decision
  call the same function with the same arguments (the invariant that drifted twice
  during the Caco inversion; builtins must not introduce a third call site).
- **Warm sessions are never auto-mutated** — deferral applies at cold resume and
  create only.

## Considerations

- **`task` is inflated by the operator's own custom agents** (793 → 1,723 here).
  Deferring it therefore saves more for operators who define more agents — the
  opposite of the usual "power users pay less" instinct, and worth stating so the
  measured number is not mistaken for a constant.
- **A deferred `task` costs a round trip at the moment work is delegated**, which
  is a natural pause point (the agent is already deciding to hand off), unlike
  `str_replace_editor` where the pause lands mid-edit.
- **`web_fetch` at 176 tokens** is close to the noise floor; it defers with the
  rest rather than earning a special case.
- **Builtin keys are prefixed** (`builtin:bash`), and the exclusion seed already
  uses that form. The candidate list must use `builtinKey(name)`, not the bare
  model-facing name, or the exclusion silently does nothing.

## Risks and Mitigations

- **A builtin the agent needs goes quiet mid-task** → only `str_replace_editor`
  has no acceptable pause point, and it is protected; everything else is one
  `caco_enable_tools` call, and the deferred-tool listing names it.
- **Weakening the policy-disabled precedence** → an oracle asserts a
  policy-excluded builtin still classifies `disabled`, not `deferred`.
- **Saving less than measured** because a tool is used often enough to stay fresh
  → that is the mechanism working; the floor is "no worse than today".
- **Search reach silently narrows** once `grep` is gone, because facade tree searches
  are rooted at the session directory → the exclusion rationale names
  `caco.rg(['pat','/abs'])` as the external-tree route, and the workflow tool
  description already documents it; row 6 updates the prompt so the agent is not
  directed at a tool it no longer has.
- **Sub-agents lose search** if their toolsets do inherit `excludedTools` → row 5
  verifies this BEFORE the exclusion lands, because the failure is silent: an
  `explore` dispatch would simply return worse answers.

## Acceptance

- Observable: the mcp-servers applet shows the newly-eligible builtins marked
  "would defer", and a fresh session's Built-in token total drops from 4,867 by
  the total of whichever are stale. Observational, not a gate — no fixture pins a
  live token count.
- Gates: `npm run build` green.
- Oracles: per-row below; each must fail before its change exists.

## Plan

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 0 | Confirm the `<available_skills>` block is emitted independently of the `skill` tool definition; if it is not, add `skill` to the protected set before proceeding | - | live inspection of a session's context | - |
| 1 | Add `NEVER_DEFER_BUILTINS` (`str_replace_editor`) + `isDeferEligibleBuiltin(name, {policyDisabled})`, mirroring the Caco predicate | `src/tool-registry.ts`, `tests/unit/tool-registry.test.ts` | hand table: `str_replace_editor` ⇒ false; a policy-excluded builtin ⇒ false; `task`/`grep`/`glob` ⇒ true; **exact `NEVER_DEFER_BUILTINS` membership pinned** so a later edit cannot silently drop a protection | edit-always-available, policy-beats-deferral |
| 2 | Add `setBuiltinToolNames`/`getBuiltinToolNames` (sync cache, populated from the first `listBuiltinTools()`); add builtin keys to the candidate universe in `computeStaleDeferCandidates` via `builtinKey(name)`; extend the existing Caco-key latch purge to builtin keys | `src/session-manager.ts`, `src/routes/workspace-api.ts` (populate the cache), `tests/unit/caco-defer-candidates.test.ts` | ref-impl: fixture builtin list ⇒ expected candidate keys, **every one `builtin:`-prefixed**; a policy-excluded builtin is never emitted as a candidate **even when maximally stale**; empty cache ⇒ no builtin candidates; a latched builtin key is purged | one-predicate, warm-never-mutated, builtins-never-latched |
| 3 | Thread the verdict into the `/servers` payload's builtin branch through the SAME predicate; update the load-bearing comments in `workspace-api.ts` and `session-manager.ts` that currently assert builtins are never dynamically deferred | `src/routes/workspace-api.ts`, `src/session-manager.ts`, `tests/unit/mcp-server-payload.test.ts` | payload test: `deferEligible` matches enumeration for edit / policy-excluded / ordinary builtins | one-predicate |
| 4 | Verify a policy-excluded builtin still fails `validateEnable`, so widening the candidate set cannot make one re-enableable | `tests/unit/session-tool-state.test.ts` | `validateEnable('builtin:bash')` ⇒ not ok, with the disabled reason | policy-beats-deferral |
| 5 | **Verify sub-agents keep their own search tools** before excluding anything: the `explore` agent advertises `grep/glob/view/bash/powershell` while Caco already excludes the shell family from sessions, which suggests sub-agent toolsets are SDK-side and independent of `excludedTools` — confirm, since a wrong answer here silently degrades every `explore` dispatch | - | dispatch an `explore` sub-agent after the exclusion and confirm it can still search | - |
| 6 | Add `builtin:grep` + `builtin:glob` to `DEFAULT_EXCLUDED_BUILTINS` with the routing rationale; update the batching line in `src/prompts.ts` that still names `grep`/`glob` as things to fire in parallel, and the `## Reading Code Efficiently` guidance if it points at them | `src/tool-registry.ts`, `src/prompts.ts`, `tests/unit/tool-registry.test.ts`, `tests/unit/prompts*.test.ts` | exclusion list contains both keys, `builtin:`-prefixed; a prompt assertion that the batching guidance no longer directs the agent at an excluded tool | policy-beats-deferral |
| 7 | Record the refuted SDK settings so they are not retried | this file, `src/tool-registry.ts` comment | - | - |
| 8 | Measure before/after on a fresh session; confirm the deferred-tools reminder names the deferred builtins on a background-agent wake | - | operator-visible token drop; reminder present in the wake flow | - |

## Rationale

The Caco inversion argued that an allowlist of what *may* defer makes forgetting
cost permanent per-turn rent. Builtins are the same argument one level further
out: they have no deferral at all, so the only tool for an expensive-but-rare
builtin is amputation. `ask_user` was amputated for exactly this reason (~800
tokens, never wired up) — a reasonable call that deferral would have made
unnecessary, because a tool nobody calls simply goes quiet on its own.
