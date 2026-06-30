# R1 — `caco.` command namespace (collision hygiene)

Status: spec (light). Prerequisite: none. Scope: client only (`public/ts/`).

## Goals

Move Caco's 13 built-in slash commands into a reserved `caco.` prefix (`caco.restart`, `caco.agent`, `caco.session-new`, …) so they can never collide with SDK skills or extension commands in the shared `/` namespace. Bare names remain as permanent yielding aliases: `/restart` still works when no skill claims that name. The picker and docs show the canonical `caco.*` names; typing a bare name surfaces the canonical via substring.

## Problem

Caco's 13 built-ins (`session-new`, `agent`, `restart`, `session-*`) live in the **same `/` namespace** that now also hosts SDK skills (R2). A skill named `restart`, `agent`, `fork`, `model`, … would collide. Today built-ins silently win (`loadSkillCommands` skips a name a built-in already holds), so a legitimately-named skill becomes **unreachable** — the user's own customization loses to a Caco command. The bare namespace should belong to the SDK/skills; Caco's app-specific commands should be namespaced.

## Design

**Canonical names become `caco.<name>`** — `caco.session-new`, `caco.agent`, `caco.restart`, `caco.session-fork`, etc. The picker and docs show these.

**Bare names stay as yielding aliases** (permanent, not deprecated). Resolution rule in `findCommand(name)`:
1. Direct hit (`commands.get(name)`) wins — a skill/extension/template registered under a bare name is reached as typed.
2. Else, if `commands.get('caco.' + name)` exists and is a `built-in`, return it — the legacy bare name resolves to the Caco command.
3. Else undefined.

This **cedes the bare namespace to skills on collision** (rule 1) while keeping every existing `/restart`, `/agent`, … working unchanged when no skill claims that name (rule 2). Zero muscle-memory disruption, collision-proof by construction.

**Registration collision checks use a DIRECT lookup, not `findCommand`.** `loadSkillCommands` must check `commands.get(skill.name)` (no alias fallback) before skipping — otherwise a skill named `restart` would see the `caco.restart` alias via `findCommand` and be wrongly skipped. With a direct check, a skill named `restart` registers under the bare name and wins; `/caco.restart` still reaches the Caco command.

**Picker** (`getCommands` → slash popup) lists the registered (`caco.*`) names; substring filtering means typing `restart` surfaces `caco.restart`, so discovery is preserved.

| File | Change |
|---|---|
| `public/ts/command-registry.ts` | `BUILTIN_COMMANDS` names → `caco.*`; `registerBuiltin` calls use `caco.*`; `findCommand` gains the alias fallback (rules 1–3); `loadSkillCommands` shadow check switches to direct `commands.get`. |
| `README.md` | Command table rows → `/caco.<name>`; one line noting bare aliases still work. |
| `tests/unit/command-registry.test.ts` | Canonical names updated; alias-resolution test; skill-wins-bare-name test; skill-shadows-canonical blocked. |

No server-side change. No new files.

## Invariants

- Every Caco built-in is always reachable via its `caco.*` canonical name, regardless of what skills are registered.
- A skill claiming a bare name that overlaps a built-in alias registers and wins the bare slot — never silently dropped.
- `loadSkillCommands` never clobbers an already-registered command of any kind.

## Considerations

- Extension/template commands are author-named and stay in the bare namespace; only Caco's own built-ins move to `caco.*`.
- Bare names are permanent yielding aliases — no deprecation toast, no nag.
- Renaming the SDK `/agent` concept is out of scope; `caco.agent` is Caco's selector wrapper.
- A skill named `caco.session-new` (the canonical built-in form) is still correctly blocked by the direct `commands.get` check, since the built-in is registered under that exact name.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| `findCommand` alias causes a skill to be wrongly skipped at registration | Registration uses direct `commands.get`; alias fallback only fires on lookup, never on registration. |
| User scripts or README refer to old bare names | Bare aliases are permanent; existing invocations continue to work. |
| Picker inserts `caco.restart`; user types bare `/restart` | Both forms work in the input box; picker auto-completes on substring. |

## Acceptance

- Observable: `/caco.restart`, `/caco.agent`, etc. appear in the command picker; `/restart` and `/agent` still invoke the same built-ins when no skill claims those names.
- Budgets: n/a.
- Gates: `npm run build` green; `tests/unit/command-registry.test.ts` green.
- Oracles:
  - `findCommand('restart') === findCommand('caco.restart')` → same built-in object (`command-registry.test.ts`).
  - Skill named `restart` registers and wins the bare name; `findCommand('caco.restart')` still returns the built-in (`command-registry.test.ts`).
  - Skill named `caco.session-new` is skipped by the direct-match guard (`command-registry.test.ts`).

## Plan

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 1 | Rename `BUILTIN_COMMANDS` to `caco.*` prefix | `public/ts/command-registry.ts` | build green | Built-ins always reachable via canonical name |
| 2 | Add `findCommand` alias fallback (rules 1–3) | `public/ts/command-registry.ts` | `findCommand('restart') === findCommand('caco.restart')` — `command-registry.test.ts` | - |
| 3 | Switch `loadSkillCommands` to direct `commands.get` check | `public/ts/command-registry.ts` | skill `restart` wins bare; `caco.restart` still resolves to built-in — `command-registry.test.ts` | Skills never silently dropped |
| 4 | Update README command table | `README.md` | by-construction (doc only) | - |
| 5 | Add/update unit tests: canonical names, alias resolution, skill-wins-bare, skill-shadows-canonical blocked | `tests/unit/command-registry.test.ts` | all oracle assertions green | - |
