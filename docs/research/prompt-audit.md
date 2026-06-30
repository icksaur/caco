# Prompt / tool-description token audit

Goal: cut input tokens spent on the system prompt + tool descriptions (shipped on
**every request**) without changing model behavior.

## Result

| Surface | Before | After | Saved |
| --- | --- | --- | --- |
| System prompt (`src/prompts.ts`) | ~1,661 tok | ~1,225 tok | ~436 |
| Tool descriptions (14 files) | ~4,098 tok | ~2,954 tok | ~1,144 |
| **Total per request** | | | **~1,580 tok** |

Measured by byte count at ~4 chars/token (`/tmp/measure-desc.mjs`).

## Method

- Disjoint-file fan-out: 4 parallel agents, one cluster each, shared rubric
  (`CUT` filler/marketing/schema-restatement/duplication/extra examples; `KEEP`
  every load-bearing constraint, footgun, and param semantic).
- Central review of the combined diff + a code-review pass scoped to *semantic
  loss only*, then full gates.

## Biggest wins

- **System prompt de-duplication.** Six sections re-described tools that already
  carry their own `description:` (the model sees that text anyway). Collapsed to
  one-line selection/orchestration hints. Kept env block, model-tier caps,
  `retrieve_output` handle syntax, `get_applet_state` first-turn hint, the
  no-stop.sh / no-emoji / git-facts rules.
- **`caco_offer_action`** (~293→~98): the system prompt's "Response Options"
  section already covers *when*; the tool keeps only the mechanical contract.
- **Multi-agent cluster** (task/swarm/delegate/send/create): each tool stated its
  own niche tersely instead of re-explaining the others. Kept the
  fire-and-forget (`send_caco_message`) vs waits-for-reply (`caco_session_delegate`)
  distinction and all tier/count caps.

## Invariants preserved

Model-tier caps, emit-once, surface stale-token retry+rebase, browser
"snapshot before targeting ids / ids re-number", eval operator-gating,
screenshot path-return, `render(surface)` contract, applet URL patterns,
"never run stop.sh". No tool/param renames; no handler changes.

## Gates

`tsc` (backend + frontend), `eslint`, `knip`, full suite (1119 tests) — all green.
