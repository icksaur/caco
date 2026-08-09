# spec-memory-frozen-in-startup-prompt

**Status:** draft, reviewed once (the review caught a cache regression the change would
have introduced, and corrected the test plan).

Deleting a memory entry does not affect sessions created afterwards. The entry keeps
appearing in new sessions' system prompts until the server is restarted, and any session
created while it existed carries it in its history permanently.

## Goals

A memory edit takes effect on the next session created, with no restart. The memory block
in a new session's system prompt reflects `memory.json` as it is at creation time, not as
it was when the process started. Unfreezing it must not cost prompt-cache sharing: with the
same memory and the same installed applets, two creations still produce byte-identical
prompts.

## Design

### Root cause

The system prompt is built **once per process** and the memory block is baked inside it:

* `server.ts:210` — `SYSTEM_MESSAGE = await buildSystemMessage()`, at startup.
* `server.ts:297` — passed to `createSessionState({ systemMessage: SYSTEM_MESSAGE, … })`.
* `session-state.ts:160` — `createSession` uses `resolveSystemMessage(this._config.systemMessage, cwd)`, the frozen snapshot.
* `prompts.ts:108` — `+ formatMemoryForPrompt()` sits **inside** the string that snapshot captured.

`formatMemoryForPrompt()` reads `memory.json` fresh on every call and `readMemory()` has no
cache, so the store itself is never stale. The staleness is entirely in the one-shot
capture: memory is a *dynamic* input embedded in a value treated as *static*. The docstring
on `buildSystemMessage` says so outright — "Called at server startup and cached" — which was
true of everything in the prompt except the memory block.

Confirmed on the running instance. `memory.json` was emptied to `{}` at 10:40:25; a session
born at 10:40:39 — 14 seconds later, first event `session.start`, no `parentSessionId` —
received a system message containing both `ssg-session-scope` and
`ssg-document-abstraction-direction`. Neither had been in the store for two days. The
snapshot dated from that process's startup.

### The path that is already correct

Two other paths build the same prompt and neither is stale:

* `session-manager.ts:1037` (create-with-a-given-id, the never-messaged reopen) calls
  `resolveSystemMessage(await buildSystemMessage(), cwd)` — fresh.
* `session-manager.ts:1068` (resume) calls `formatMemoryForPrompt()` fresh and appends it
  as `mode:'append'`.

So the correct pattern already exists in the codebase; the ordinary create path is the
outlier. The fix makes it match rather than inventing anything.

### Change 1 — build fresh at create

Build the system message at creation time in `session-state.ts` and **delete the frozen
snapshot** — `SYSTEM_MESSAGE` in `server.ts` and `systemMessage` on `SessionStateConfig`.
Line 160 is that field's only reader, so once it reads fresh the field is dead weight, and
leaving it would preserve a second, stale source of the same value for someone to reach for
later.

The field is not an injection seam. Its only non-test supplier is `server.ts`, and the two
tests that set it (`session-state.test.ts`, `session-state-transition.test.ts`) do so only
to satisfy the config shape; they assert on the resolved value, not on injection. Both must
be updated to stub the fresh build instead — see the Plan.

Cost is one `buildSystemMessage()` per session creation. It is async only because it
enumerates applets, and session creation already awaits SDK session construction and MCP
loading, so this is not on any hot path. It is emphatically not per-turn.

### Change 2 — stable applet ordering (required by Change 1, not optional)

Rebuilding unfreezes the **whole** prompt, not just memory. The applet section is the other
dynamic input, and today `listApplets()` (`applet-store.ts:306`) sorts by `updatedAt`
descending — recency order, which is right for the applet UI and wrong for a cached prompt
prefix. Under Change 1 alone, editing any applet would silently reorder the slug list and
bust the shared prefix for every session created afterwards.

So `buildAppletSection` must sort slugs by a **stable key** (slug, alphabetically) rather
than inheriting the recency ordering. `listApplets` itself is unchanged — its consumers
want recency. Only the prompt takes a stable view.

With that, the honest invariant is: same memory **and** same installed applet set ⇒
byte-identical prompt. Editing an applet's contents no longer perturbs it; installing or
removing one does, correctly.

### Determinism audit

Recorded so a future change does not have to re-derive it. Prompt generation contains no
`Date`, no `Math.random`, and no unsorted map iteration: `formatMemoryForPrompt` already
sorts its keys explicitly (for exactly this reason, per `spec-prompt-stable-prefix`), and
the home directory and `WORKFLOW_ENABLED` are process constants. The only drift risk is
**ordering policy** on the applet list, which Change 2 closes. There is no nondeterministic
generation to guard against.

### Not fixed: history already written

The SDK persists the system message into each session's `events.jsonl`. A session created
while a memory entry existed keeps that text in its history for good, and a later resume
replays it. Deleting the memory cannot retroactively clean those sessions.

This is inherent to the transcript being an append-only record and is out of scope. The
practical consequence for the operator is that a poisoned session must be replaced rather
than repaired; only sessions created after the fix are clean.

## Acceptance

* A session created after a memory write sees the post-write memory block, with no restart.
* A session created after the last memory entry is deleted has no `## User Memory` section.
* With memory and the installed applet set unchanged, two creations produce byte-identical
  system prompts — including after an applet's contents are edited, which changes its
  `updatedAt` but must not reorder the prompt.
* No frozen system-message snapshot remains: `SessionStateConfig` has no `systemMessage`
  field and `server.ts` holds no module-level `SYSTEM_MESSAGE`.
* `listApplets` keeps returning recency order for its existing consumers.

## Plan

| # | Change | Oracle |
|---|--------|--------|
| 0 | `buildAppletSection` sorts slugs stably | With two applets whose `updatedAt` order is the reverse of their slug order, the section lists them by slug. Red before the sort |
| 1 | Prefix stability under an applet edit | Two `buildSystemMessage()` calls, with one applet's `updatedAt` bumped between them, return identical content. Red before row 0 — this is the regression the fix would otherwise ship |
| 2 | `session-state.ts` creates with `resolveSystemMessage(await buildSystemMessage(), cwd)` | The create path calls the builder rather than reading a captured value. Because the existing harness mocks `prompts.js` wholesale, the mock must expose a `buildSystemMessage` spy whose return value CHANGES between calls; the oracle is that create reflects the second value. Red before the change, which would return the frozen first value |
| 3 | Memory freshness end to end | Against a redirected memory path (`homedir` mocked before `memory-tool` is imported, since `MEMORY_FILE` is resolved at module load), a write-then-build shows the new entry and a delete-then-build shows no `## User Memory`. This exercises the real `formatMemoryForPrompt`, so it must NOT use the `prompts.js` mock |
| 4 | Remove `SYSTEM_MESSAGE` / `SessionStateConfig.systemMessage`; update `session-state.test.ts` and `session-state-transition.test.ts` to stub the fresh build instead of setting the field | Typecheck + knip green with no unused field and no remaining reader of a captured prompt |
| 5 | Full gate | `npm run build`, 10 phases |

Mutation-check: restore the frozen snapshot at the create call site and rows 2/3 must go
red; revert the applet sort and rows 0/1 must go red; make `formatMemoryForPrompt` emit
unsorted keys and row 1 must go red.

## Testability

Row 2 works within the existing `session-state.test.ts` harness once its `prompts.js` mock
gains a `buildSystemMessage` spy. Row 3 cannot use that harness — it needs the real
`memory-tool`, whose `MEMORY_FILE` is computed from `homedir()` at module load, so the test
must mock `os` before importing and therefore belongs in its own file.
