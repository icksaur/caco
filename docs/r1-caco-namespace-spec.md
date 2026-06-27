# R1 — `caco.` command namespace (collision hygiene)

Status: spec (light). Goal: move Caco's built-in slash commands into a reserved
`caco.` namespace so they can never collide with SDK skills (`/skill-name`) or any
future SDK/plugin command that shares the bare `/` namespace, while preserving the
existing bare names as zero-disruption fallbacks.

## Problem

Caco's 13 built-ins (`session-new`, `agent`, `restart`, `session-*`) live in the **same
`/` namespace** that now also hosts SDK skills (R2). A skill named `restart`, `agent`,
`fork`, `model`, … would collide. Today built-ins silently win (`loadSkillCommands` skips
a name a built-in already holds), so a legitimately-named skill becomes **unreachable** —
the user's own customization loses to a Caco command. The bare namespace should belong to
the SDK/skills; Caco's app-specific commands should be namespaced.

## Design

**Canonical names become `caco.<name>`** — `caco.session-new`, `caco.agent`,
`caco.restart`, `caco.session-fork`, etc. The picker and docs show these.

**Bare names stay as yielding aliases** (permanent, not deprecated). Resolution rule in
`findCommand(name)`:
1. Direct hit (`commands.get(name)`) wins — so a skill/extension/template registered
   under a bare name is reached as typed.
2. Else, if `commands.get('caco.' + name)` exists and is a `built-in`, return it — the
   legacy bare name resolves to the Caco command.
3. Else undefined.

This **cedes the bare namespace to skills on collision** (rule 1) while keeping every
existing `/restart`, `/agent`, … working unchanged when no skill claims that name (rule
2). Zero muscle-memory disruption, collision-proof by construction.

**Registration collision checks use a DIRECT lookup, not `findCommand`.**
`loadSkillCommands` must check `commands.get(skill.name)` (no alias fallback) before
skipping — otherwise a skill named `restart` would see the `caco.restart` alias via
`findCommand` and be wrongly skipped, defeating the goal. With a direct check, a skill
named `restart` registers under the bare name and wins; `/caco.restart` still reaches the
Caco command. (Since all built-ins are now `caco.*`-prefixed, a skill can only collide
with another skill/template/extension — never a built-in.)

**Picker** (`getCommands` → slash popup) lists the registered (`caco.*`) names; substring
filtering means typing `restart` surfaces `caco.restart`, so discovery is preserved.
Selecting from the list inserts the canonical name.

## Scope of change

| File | Change |
|---|---|
| `public/ts/command-registry.ts` | `BUILTIN_COMMANDS` names → `caco.*`; `registerBuiltin` calls use `caco.*`; `findCommand` gains the alias fallback (rules 1–3). |
| `public/ts/command-registry.ts` (`loadSkillCommands`) | shadow check switches `findCommand(skill.name)` → `commands.get(skill.name)` (direct). |
| `README.md` | command table rows → `/caco.<name>`; one line noting bare aliases still work. |
| `tests/unit/command-registry.test.ts` | BUILTIN_COMMANDS names are now `caco.*`; the README assertion follows; `findCommand('agent')` keeps working via alias; rewrite the "skill never shadows a built-in" test to stub a skill named `caco.session-new` (the canonical name) and assert it's skipped, plus add an alias-resolution test (`findCommand('restart') === findCommand('caco.restart')`) and a "skill claims a bare name the alias covers" test (skill `restart` wins the bare name; `caco.restart` still resolves to the built-in). |

No server-side change (commands are a frontend concept). No new files.

## Out of scope
- Renaming the SDK `/agent` concept — `caco.agent` is Caco's selector wrapper; the bare
  `/agent` alias preserves the familiar form.
- A deprecation toast — bare names are permanent yielding aliases, not deprecated, so no
  nag is warranted.
- Extension/template commands — those are author-named and intentionally live in the bare
  namespace; only Caco's own built-ins move.

## Tests
- All `BUILTIN_COMMANDS` register under `caco.*` and are documented in README.
- `findCommand('restart')` and `findCommand('caco.restart')` resolve to the same built-in.
- A skill named `caco.session-new` is skipped (can't shadow a built-in).
- A skill named `restart` registers and wins the bare name; `findCommand('caco.restart')`
  still returns the built-in (alias yields to the skill).
- Existing `/agent`, picker, and skill tests stay green.
- `npm run build` gate green.
