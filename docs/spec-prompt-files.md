# Prompt files: standardize to ecosystem locations

Status: spec. Goal: replace Caco's bespoke `.caco/prompts/*.md` prompt-template
feature with the **standard Copilot prompt-file** location + format, so prompts live
where agents/skills do and use the documented `.prompt.md` convention.

## Goals

Prompt files are a real Copilot customization (`.github/prompts/*.prompt.md`), but they
are an **IDE-only** feature — not surfaced by `@github/copilot-sdk@1.0.1` (no
`rpc.prompts`; `.prompt.md` never appears in `commands.list`; official docs: "only
available in VS Code, Visual Studio, and JetBrains IDEs"). So Caco must scan and render
them **itself**. Today it scans a non-standard path (`~/.caco/prompts` + `./.caco/prompts`)
with a non-standard format (plain `.md`, first line = description). This spec moves Caco
onto the ecosystem-standard locations and format. The SDK does the rendering for agents
(`/agent`) and skills (`commands.list`); prompts are the one surface Caco owns.

## Confirmed format (VS Code docs)

- Extension: `.prompt.md`.
- Optional YAML frontmatter, all fields optional: `description`, `name` (default =
  filename), `argument-hint`, `agent` (`ask`/`agent`/`plan`/custom-agent), `model`,
  `tools`.
- Body: Markdown instructions. Input variables `${input:var}` / `${input:var:placeholder}`
  (an IDE resolver concept — see R6 for Caco's v1 behavior).
- Invocation: `/name extra args` in chat (extra text passed to the prompt).

## Locations (standardize to SDK config dirs)

| Scope | New location | Replaces |
|---|---|---|
| Project | `<programCwd>/.github/prompts/*.prompt.md` | `./.caco/prompts/*.md` |
| User | `~/.copilot/prompts/*.prompt.md` (SDK `configDirectory`) | `~/.caco/prompts/*.md` |

Precedence: **project overrides user** on name collision (unchanged from today's
local-over-global). User-level prompts have no canonical IDE filesystem path (VS Code
stores them in opaque profile data); `~/.copilot/prompts` is the SDK-config analogue to
`~/.copilot/agents` and `~/.copilot/skills`, chosen for consistency.

## Requirements

| # | Requirement |
|---|---|
| R1 | Scan `<cwd>/.github/prompts` + `~/.copilot/prompts` for `*.prompt.md`. Stop scanning `.caco/prompts` entirely. |
| R2 | Command name = frontmatter `name` else filename minus `.prompt.md`. Description = frontmatter `description` else first non-empty body line (after frontmatter), capped 80 chars. |
| R3 | `GET /api/prompts/:name` resolves the command name through the **same parsed name→path index** as listing (not by assuming `<name>.prompt.md`, since frontmatter `name` may differ from the filename), and returns the **body only** (YAML frontmatter stripped). |
| R4 | Project prompt overrides user prompt on name collision. |
| R5 | Argument substitution into the body using the user's typed `args`: replace **every** literal `$ARGUMENTS` occurrence with `args`. If the body contains no `$ARGUMENTS` and `args` is non-empty, append `\n\n${args}`. If `args` is empty, the body is returned unchanged (byte-for-byte, modulo frontmatter stripping). Substitution is exact-literal (no word-boundary matching). |
| R6 | `${input:...}` variables are **not** substituted in v1 (Caco is not the IDE resolver). They are passed through literally; capable models often prompt for them. Documented limitation, not a bug. R5's `$ARGUMENTS` is the supported token. |
| R7 | A prompt command must **not** shadow an existing built-in, extension, or agent command. `loadPromptTemplates` checks `findCommand(name)` before registering and skips (logs) on collision. Among prompts themselves, project still overrides user (R4). |
| R8 | A prompt's effective name must match `^\S+$` (no whitespace/slash; non-empty). If frontmatter `name` is invalid, fall back to the filename; if the filename-derived name is invalid, skip the file. |

## Design

- **Shared parser** `parsePromptFile(content, filename) -> { name, description, body }`
  (in `src/routes/api.ts` or a small `src/prompt-files.ts`): split optional
  `---\n…\n---` frontmatter (tolerate CRLF, empty, and malformed/unparseable YAML →
  treat as no frontmatter, whole file is body); compute `name` (frontmatter `name`,
  validated `^\S+$`, else filename minus `.prompt.md`, else skip), `description`
  (frontmatter `description` else first non-empty body line, capped 80), and the
  frontmatter-stripped `body`. **Both** `scanPromptDir` and `GET /prompts/:name` use this
  one parser so listing, naming, and stripping never diverge.
- `scanPromptDir(dir)`: filter `*.prompt.md`; run `parsePromptFile`; build
  `Map<name, { name, description, path }>` keyed by the effective command name.
- `GET /prompts`: roots `[~/.copilot/prompts, <cwd>/.github/prompts]` (user first,
  project second so project wins the merge `Map`). Returns `{name, description}[]`.
- `GET /prompts/:name`: look the name up in the merged name→path index (project over
  user), read that path, return `parsePromptFile(...).body`. 404 if the name is unknown.
- Frontend `loadPromptTemplates` (`public/ts/main.ts`): before registering each prompt,
  call `findCommand(name)`; if it resolves to a non-template command, **skip** (R7). The
  handler receives `args: string` (already passed by
  `chat-form-controller.tryExecuteSlashCommand`); fetch the body, apply the R5
  substitution via a pure helper `applyPromptArgs(body, args)` (unit-tested), then put
  the result in the textarea.
- `agent`/`model`/`tools`/`argument-hint` frontmatter: **ignored in v1** (Caco runs the
  prompt in the current session/model). Documented limitation, not a bug.

## Migration / breaking change

`.caco/prompts` is dropped. Any existing user prompt must move to `~/.copilot/prompts`
(or project `.github/prompts`) and be renamed `*.prompt.md`. This is intended (the user
asked to remove the Caco-specific location). No automatic migration — note in README.

## Out of scope

- Surfacing prompts through the SDK (impossible — not an SDK feature).
- `agent`/`model`/`tools` honoring; `argument-hint` UI; `#tool:` references; referenced-
  file expansion. Possible later, none required for parity-of-location.

## Acceptance

- Observable: `/foo` registered from `~/.copilot/prompts/foo.prompt.md`; `/foo arg` fills textarea with substituted body; frontmatter stripped from response; `.caco/prompts` files ignored.
- Budgets: n/a.
- Gates: `npm run build` + full test suite green.
- Oracles: `parsePromptFile` and `applyPromptArgs` pure helpers — by-construction unit tests (write before implementation); existing prompts-route tests updated for new paths/extension.

| T | Check |
|---|---|
| T1 | `~/.copilot/prompts/foo.prompt.md` → `/foo` registered; description from frontmatter. |
| T2 | `<cwd>/.github/prompts/bar.prompt.md` → `/bar` registered. |
| T3 | Same name in both → project body wins. |
| T4 | `/foo` with a `$ARGUMENTS` body + typed args → all `$ARGUMENTS` replaced; no raw frontmatter in textarea. |
| T5 | `.caco/prompts/*.md` is ignored (no command registered). |
| T6 | Frontmatter stripped from `GET /prompts/:name` response. |
| T7 | Frontmatter `name` differs from filename → command uses `name`; `GET /prompts/<name>` resolves the right file. |
| T8 | Prompt named same as a built-in/agent command → skipped, built-in survives. |
| T9 | Malformed/empty frontmatter → whole file treated as body; no crash. |
| T10 | CRLF frontmatter delimiters parse correctly. |
| T11 | Body with no `$ARGUMENTS` + non-empty args → `\n\n<args>` appended; empty args → body unchanged. |
| T12 | `${input:...}` body passes through literally (R6). |
| T13 | Invalid frontmatter `name` (whitespace/empty) → falls back to filename. |
| T14 | `.md` (not `.prompt.md`) files are ignored. |

Unit-test the pure helpers directly: `parsePromptFile` (split/strip/name/description over
malformed, empty, CRLF, name-mismatch inputs) and `applyPromptArgs` (multiple
`$ARGUMENTS`, no token + append, empty args, `${input:}` passthrough). Update any existing
prompts-route tests to the new paths/extension.

## Plan

1. R1–R4 in `src/routes/api.ts` (scan + routes + frontmatter strip) with unit tests.
2. R5 substitution in `public/ts/main.ts` handler + a small pure helper (unit-tested).
3. Move smoke fixtures: `~/.copilot/prompts/smoke-user-prompt.prompt.md` +
   `<cwd>/.github/prompts/smoke-proj-prompt.prompt.md`; delete `.caco/prompts` copies.
4. Update README/EXTENSIONS references from `.caco/prompts` to the new locations.
5. `npm run build`; code review; commit.
