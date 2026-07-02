# spec-style

A simple, enforceable visual style guide for Caco's UI and applets, plus the
theme-compatibility contract every surface must honor so the themes applet can
recolor the whole app. Reference surfaces (the bar to match): the **session
list**, the **chat well + footer**, and the **applet browser**.

## Goals

Any new UI or applet looks like it belongs, and recolors correctly under every
theme, by consuming a fixed set of design tokens instead of raw colors. A
contributor can style a surface without inventing spacing, radii, or hex values,
and without breaking theming.

## Design

**Token layers (consume the top layer only).**

1. *Theme palette* (theme files in `public/themes/*.css`): a tiny set —
   `--base, --text, --border, --accent, --green, --red, --orange, --yellow,
   --purple, --cyan`. **UI/applets must NOT read these directly.**
2. *Semantic tokens* (`public/style.css` `:root`, mapped from the palette): the
   `--color-*` namespace (e.g. `--color-text`, `--color-text-muted`,
   `--color-border`, `--color-accent`, `--color-bg-hover`, `--color-applet-bg`,
   `--color-success`, `--color-error`, `--color-danger`, `--color-link`), plus
   scale tokens `--space-{xs,sm,md,lg,xl}`, `--radius-{sm,md,lg}`, and
   `--font-{sans,mono}`. **This is the only layer surfaces consume.**

Switching a theme swaps layer 1; layer 2 (and everything built on it) recolors
automatically — including `color-mix()`-derived tokens like `--color-text-muted`.

**Visual language (from the reference surfaces).**
- **Hierarchy:** one bright title (`--color-text`), supporting/secondary text
  dimmed (`--color-text-muted`), never more than ~2 weight levels per view.
- **Grouping:** rows/cards separated by `--space-sm`/`--space-md` gaps and
  `--color-border` hairlines, not by boxes-within-boxes.
- **Interaction:** hover = `--color-bg-hover`; accent/selected = `--color-accent`;
  radius `--radius-md` for controls, `--radius-lg` for panels.
- **Density:** compact — the session list / footer set the baseline; padding in
  `--space-*` units, no ad-hoc px except 1px borders.
- **Typography:** `--font-sans` for prose/UI, `--font-mono` for code/paths/ids.

## Invariants

- **Tokens only** (invariant): surfaces reference `--color-*`/`--space-*`/
  `--radius-*`/`--font-*` — never the raw palette (`--text`, `--accent`), never a
  hardcoded hex, never an undefined var (undefined vars silently fall back and
  do NOT theme — the class of bug this guide exists to prevent).
- **No hardcoded fallbacks that hide breakage** (invariant): `var(--color-x,
  #hex)` masks a wrong/undefined token with an un-themed literal. Use the bare
  `var(--color-x)`; if a fallback is truly needed, fall back to another token.
- **Theme-agnostic** (fact): a surface must be legible under both light and dark
  themes because it derives from tokens, not assumed light-on-dark.

## Considerations

Common mistakes this guide targets (all present in older applets): `--text-primary`
/`--text-muted` (do not exist → use `--color-text`/`--color-text-muted`),
`--bg-surface` (→ `--color-applet-bg`), `color: white` on an accent button (→ keep
a token or accept the accent's contrast pair). Keep it simple: this is a token
contract + a light visual language, not a component library. New semantic colors
go in `style.css` `:root` (mapped from the palette) first, then get consumed.

## Risks and Mitigations

- Guide ignored / silent theme breakage → an undefined-var smell is greppable; a lint/grep check over `applets/**/*.css` for non-token colors could enforce it later (not built now).
- Palette drift across themes → all themes define the same palette keys; a missing key surfaces as an obviously wrong color under that theme.

## Acceptance

- Observable: an applet styled to this guide recolors correctly when the themes applet switches theme (light↔dark), with title/secondary hierarchy intact.
- Gates: n/a (documentation).
- Oracles: visual signoff under ≥2 themes (one light, one dark); grep `applets/**/*.css` shows no `--text-primary`/`--text-muted`/`--bg-surface`/hardcoded hex in surfaces claimed conformant.

## Plan

| # | Step | Files | Oracle |
|---|------|-------|--------|
| 1 | Document token layers + visual language (this spec) | `docs/spec-style.md` | by-construction |
| 2 | First conformance pass: mcp-servers applet | `applets/mcp-servers/style.css` | visual under 2 themes |

## Rationale

The reference surfaces already follow this implicitly; the guide just names the
contract so applets stop drifting (the mcp-servers applet shipped with
`--text-primary`/`--bg-surface`, which theme to nothing). Themes map a 10-color
palette into the `--color-*` namespace via `color-mix`, so consuming semantic
tokens is what makes one palette swap recolor the entire app.
