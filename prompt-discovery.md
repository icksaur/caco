# Custom instruction loading across Caco runtimes

> **Superseded by `instruction-loading-results.md`** (2026-08-09), which
> reproduces the table below under stricter controls, extends it to
> `copilot-instructions.md` in every location, and answers the open questions:
> the cause is `systemMessage: { mode: 'replace' }`, and the "stale copy"
> observation is a per-process instruction cache. Kept for its method notes.

Findings from a canary probe run on 2026-08-09. Not a spec. This answers
`docs/spec-prompt-trim.md` row 0, which asks whether a repo-root `AGENTS.md` is
eagerly loaded at session start, and marks it unverified.

## Result

| Runtime | Global `~/.copilot/copilot-instructions.md` | Repo `AGENTS.md` |
|---|---|---|
| `task` sub-agent, general-purpose | yes | yes, read from disk at spawn |
| `task` sub-agent, explore | no | no |
| Session from `create_caco_session` / delegate | **no** | **no** |
| The interactive session running the probe | yes | yes, but stale |

A session created through `create_caco_session` receives **no custom
instructions of any kind** — not the repo's `AGENTS.md`, and not the user's
global `copilot-instructions.md`. It is not a discovery problem scoped to
`AGENTS.md`.

## Method, for re-running

Canary protocol. Write an unguessable token into the candidate file, then ask a
runtime to report it **without using any tool**. A correct answer proves
injection; tool use invalidates the trial.

1. Build a fixture repo containing `AGENTS.md`, `.github/copilot-instructions.md`,
   `CLAUDE.md`, `README.md`, and `docs/NOTES.md`, each holding a distinct token.
   `git init` it — the fixture must be a repo.
2. Place one token at line 2 and another at end of file, to separate "not loaded"
   from "loaded but truncated".
3. Ask the runtime to report each token or say ABSENT, insisting on no tool use.
4. Falsify: revert the file and confirm a newly spawned runtime reports ABSENT.

Two wording traps, both hit on the first attempt:

- Asking about "startup context" invites a false negative, because injected
  instructions may land after the conversation body. Ask the runtime to search
  its **entire** context including blocks injected since its last turn.
- An agent with no instructions confabulates rather than abstaining. `explore`
  on Haiku answered a project budget question with `200000`, a context-window
  number presented as a project rule. Always include a control question whose
  true answer is known.

Do not run canaries against a live shared repo. The first round mutated
`city/AGENTS.md` while another session was editing that repo concurrently.
Nothing was lost, but the revert could have destroyed concurrent edits.

## Disproven

- **On-demand surfacing after a file view.** A created session viewed a Go
  source file, then still reported every `AGENTS.md` string ABSENT. The SDK
  describes this path as surfacing instructions after successful file views; it
  did not fire.
- **Wrong working directory.** `session-manager.ts` passes `workingDirectory:
  cwd` at session creation, so the SDK is told the right directory.
- **An opt-out flag.** Neither `skipCustomInstructions` nor
  `enableOnDemandInstructionDiscovery` is set anywhere in `src/`.

So the cause is none of the obvious three. The SDK is given a correct cwd and no
opt-out, and still no instruction source reaches the session.

## Open questions

- Why does the interactive session have both instruction sources when a session
  created by `create_caco_session` in the *same* directory has neither? The two
  creation paths differ in something that matters. This is the thread to pull.
- Does passing a custom `systemMessage` suppress the SDK's own instruction
  assembly? Both paths pass one, so this alone does not explain the split, but it
  is worth ruling out.
- Is the interactive session's copy refreshed only on compaction or resume? Its
  content matched the file as of an earlier commit and never picked up canaries
  written during the session, while sub-agents spawned in the same window did.
  If so, editing `AGENTS.md` never updates the session doing the editing.
- Does `resumeSession` behave differently from `createSession` here?

## Impact

Standing reviewer sessions are created through this path, so they have been
running without the user's global rules — including the instruction that a
reviewer session never modifies files, and the commit-message policy. Reviews
delegated to them ran on model priors instead.

The failure is silent in both directions: the session cannot tell it is missing
instructions, and the caller cannot tell either. Whatever the fix, a session that
loads no instruction sources should say so.

Gate `docs/spec-prompt-trim.md` row 7 on this. Moving Caco-dev guidance out of
the system prompt and into `AGENTS.md` would silently drop it for every delegate
session and every `explore` sub-agent.
