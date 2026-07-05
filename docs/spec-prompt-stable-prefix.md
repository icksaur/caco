# spec-prompt-stable-prefix

Status: draft. Branch: `feature/tool-reveal-r0-r1` (or a fresh branch off master).

## Goals

Maximize cross-session prompt-cache prefix reuse by making Caco's system message
**byte-identical across sessions up to the last possible point**. The provider
(Copilot backend) caches prompt prefixes by content hash and shares them **across
conversations** — proven live: a second session with the same cwd/model read ~97%
of its opening prompt from a first session's cache on turn one. But caching stops at
the FIRST differing byte, and today the only per-session-variable token —
`{{SESSION_CWD}}` — sits at line ~60 of a ~150-line system message, *before* the
entire capabilities/applets/batching/guidelines body AND the tools array. Result:
two sessions in different directories share **0%** of the ~13k-token prefix.

After this: per-session-variable content moves to the END of the system message, so
sessions in different directories still share the whole stable body + tool
definitions; and system-wide content (memory) serializes deterministically so it
never busts the shared prefix spuriously.

## Evidence (measured, this repo)

Three fresh sessions, model `claude-opus-4.6`, trivial "pong" message, first turn
`cacheReadTokens` from `/api/sessions/:id/throughput`:

| Session | Differs from A by | Cache read (turn 1) | Prefix shared |
|---|---|---:|---:|
| A (created first, cold) | — | 0 (wrote 13,414) | 0% (nothing to share yet) |
| B (same cwd + model) | nothing | 12,994 | ~97% |
| C (different cwd only) | `{{SESSION_CWD}}` | **0** | **0%** |

C proves the tools array + full body sit AFTER the cwd token in the wire prompt: one
early per-session byte throws away the entire cacheable prefix. Moving cwd last
recovers it.

## Design

**Only `{{SESSION_CWD}}` is per-session.** Audited `buildSystemMessage`
(`src/prompts.ts`): every other interpolation is host- or process-constant
(`process.env.HOME`, `getHostShell().label`, `WORKFLOW_ENABLED`) or system-wide and
stable (`buildAppletSection`, memory). `{{SESSION_CWD}}`, replaced per session by
`resolveSystemMessage`, is the sole per-session token, and it is early.

**Move the cwd to the end.** Remove the `- **Current directory**: {{SESSION_CWD}}`
line from the early `## Environment` block and emit it as the LAST content of the
system message, after the memory block, under a short `## Session Context` heading.
The `{{SESSION_CWD}}` placeholder + `resolveSystemMessage` replacement are unchanged
— only its POSITION moves. The model still receives the cwd; it is informational
("but not limited to this") and tool calls pass explicit paths, so relocating it is
semantically safe.

**Order the tail deterministically: stable body → memory → cwd.** Memory is
system-wide (identical across concurrent sessions) and changes only on edit; cwd is
per-session. Placing memory BEFORE the trailing cwd line means two concurrent
sessions in different directories share the entire body AND memory, diverging only
at the final cwd line. Sort memory keys so identical memory content always
serializes to identical bytes (today `formatMemoryForPrompt` uses `Object.keys`
insertion order, so a `set`/`delete` reorders keys and busts the tail).

**Scope.** System-message assembly + memory serialization only. The tools array
(SDK-positioned) and the SDK's own preamble/identity are out of Caco's control and
unchanged. The `## Environment` block keeps Runtime/Interface/Scope/Home (all
host-constant); only the cwd line leaves it.

## Invariants

- **One per-session token, and it is last.** After this change the system message is
  byte-identical across all sessions except the trailing `## Session Context` cwd
  line. No per-session content precedes any stable body or the memory block.
- **Deterministic serialization.** Identical memory content produces identical bytes
  regardless of edit history (keys sorted). Identical applet set likewise (if the
  applet list proves non-deterministic, sort it too — see Considerations).
- **Semantics preserved.** The model still receives cwd, home, and all guidance; only
  ordering changes. `resolveSystemMessage` still replaces exactly one
  `{{SESSION_CWD}}` placeholder.
- **No new per-turn injection.** Memory stays injected once at create/resume (not
  per turn); this spec does not add any per-turn prefix mutation.

## Considerations

- **Wire-order dependence.** The measured 0%→97% swing proves the tools array sits
  after cwd in the wire prompt today; moving cwd last is strictly non-harmful even if
  the SDK reorders internally (worst case: neutral). No SDK cooperation required.
- **Applet-list determinism.** `buildAppletSection` joins `listApplets()` slugs; if
  that order is not stable across process restarts it is a (smaller, system-wide)
  prefix-bust source. Out of scope unless observed; sort slugs if it matters.
- **Home vs cwd.** `Home directory` uses `process.env.HOME` (host-constant, same for
  all sessions) — it stays in Environment; only the per-session cwd moves.
- **Resume append path.** Resume adds memory via a `mode:'append'` system message
  (`session-manager.ts:942`); it shares `formatMemoryForPrompt`, so the sort fixes
  both create and resume paths at once.

## Acceptance

- Observable (measured, needs signoff): repeat the three-session probe after the
  change — a different-cwd session (C-equivalent) now reads a large `cacheReadTokens`
  on turn one (target: comparable to the same-cwd ~97%, not 0). Same-cwd sharing is
  unchanged.
- Gates: `npm run typecheck`, `npm run lint:strict`, `npx knip`, `npx vitest run`,
  `npm run build:client`, `npm run check:specs` — all green.
- Oracles: unit — `formatMemoryForPrompt` sorts keys (same content, different insert
  order ⇒ identical string); `resolveSystemMessage` still replaces the cwd once and
  the resolved cwd appears AFTER the memory/guidelines body, not in `## Environment`.

## Plan

| # | Step | Files | Oracle |
|---|------|-------|--------|
| P1 | Sort keys in `formatMemoryForPrompt` (deterministic serialization) | `src/memory-tool.ts` | unit: two stores with identical entries in different insert order produce identical output |
| P2 | Move `{{SESSION_CWD}}` out of `## Environment`; emit it last, after memory, under `## Session Context` | `src/prompts.ts` | unit: resolved message has cwd once, positioned after the memory block; `## Environment` no longer contains the cwd line |
| P3 | Re-run the three-session cache probe; confirm different-cwd first-turn `cacheReadTokens` is now large | manual/telemetry | signoff |
