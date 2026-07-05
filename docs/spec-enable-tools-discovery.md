# spec-enable-tools-discovery

Relocate deferred-tool discovery from `caco_docs section="tools"` onto
`caco_enable_tools` (no-args), so `caco_docs` can itself be deferred. Amends
spec-tool-reveal (supersedes Plan row B1's discovery home + the "caco_docs never
excluded" invariant).

## Goals

- `caco_enable_tools()` with no `names` (or `names: []`) returns the session's
  **deferred** tool list (grouped, name + one-line description) — the single
  discover→enable loop, on the one tool the agent reaches for. No mutation, no
  cache-bust.
- `caco_enable_tools({ names })` enables as today (unchanged).
- `caco_docs` is now **defer-eligible** (added to `DEFER_ELIGIBLE_CACO_TOOLS`), so
  the many sessions that never read project docs stop paying its schema every turn.
- `caco_docs section="tools"` no longer builds the catalog; it returns a one-line
  redirect to `caco_enable_tools()` (resilience for the old habit).

## Design

**Sole escape hatch = `caco_enable_tools`.** Today two tools are pinned always-on
(`caco_docs`, `caco_enable_tools`) and discovery lives on `caco_docs`. That split
is why `caco_docs` cannot be deferred. Collapsing discovery onto
`caco_enable_tools` makes it the ONE tool that must never be deferred — it both
lists what is deferred and enables it — which is the correct-by-design escape
hatch (a single always-visible entry point that is self-describing).

**Discovery output = deferred-only.** The no-args result lists only `deferred`
tools (the actionable set; `enabled` tools are already visible to the model, and
`disabled` tools are not re-enableable). A trailing one-line footer notes only the
**count** of policy-disabled tools — their names are intentionally NOT listed
(they cannot be enabled, so listing them is noise); the count exists solely so an
agent that expected e.g. `bash` understands some tools are policy-blocked rather
than missing. Empty case: an explicit "no deferred tools" line.

**One formatter, repurposed.** `formatToolCatalog` (session-tool-state.ts) is
renamed `formatDeferredTools` and filtered to `state === 'deferred'` + the
disabled-count footer. Its only non-test consumer moves from dev-docs-tool.ts to
tool-reveal-tool.ts. The handler calls `sessionManager.getToolCatalog(sessionId)`
(the session-scoped path already used by `enableToolsLocked`) then the pure
formatter — no new state, no second catalog source.

**`caco_docs` loses the tools branch + its sessionRef.** The `section==="tools"`
branch is replaced by a redirect string; `createDocsTool` no longer needs the
`sessionRef` parameter (added earlier only for that branch) — it is removed again.

**Defer-eligibility.** `'caco_docs'` is appended to `DEFER_ELIGIBLE_CACO_TOOLS`.
It then auto-defers on the cache-free seams (C2 cold resume, C3 create) like any
allowlisted Caco tool, and is re-enableable via `caco_enable_tools({ names:
["caco_docs"] })` — which the no-args discovery list will surface.

## Invariants

- **`caco_enable_tools` is the sole always-on escape hatch** (invariant, replaces
  the old two-tool version): it is never in `DEFER_ELIGIBLE_CACO_TOOLS`, never
  policy-disabled, never hard-disabled — **including via `CACO_DISABLED_TOOLS` /
  `DEFAULT_DISABLED_TOOLS`**, which `filterDisabledTools` applies pre-registration
  and could otherwise remove the hatch entirely (a capability-recovery deadlock).
  Enforced correct-by-design: `parseDisabledToolNames` strips a `PROTECTED_TOOLS`
  set (= `caco_enable_tools`) from the disabled set so an operator misconfig cannot
  disable it — mirroring the existing `skillToolEnabled` guard against
  `CACO_EXCLUDED_BUILTINS`. If it could be disabled the agent could not recover any
  capability, including `caco_docs`. This is the one tool the defer/disable system
  must never touch.
- **Discovery has one home** (invariant): the deferred-tool list is produced by
  exactly one formatter (`formatDeferredTools`) called from exactly one place
  (`caco_enable_tools` no-args). No second copy in `caco_docs` (which now
  redirects) — no two catalog texts to keep in sync.
- **Defer never breaks capability** (unchanged): every deferred tool, now
  including `caco_docs`, is re-enableable via `caco_enable_tools`; the no-args
  list makes it discoverable.

## Considerations

- **Old-habit resilience.** An agent conditioned on `caco_docs section="tools"`
  still gets a helpful redirect **when `caco_docs` is currently enabled**. When
  `caco_docs` is itself deferred it cannot be called at all, so this redirect is a
  best-effort convenience, NOT the recovery mechanism — recovery rests entirely on
  `caco_enable_tools`'s always-on description + no-args discovery list (which
  includes `caco_docs`). Cheap, one line.
- **Enable-tool description is hot (every turn).** The added discovery sentence
  must stay short; it replaces the existing "discover them with caco_docs
  section=\"tools\"" clause (net ~neutral length), so no real growth.
- **`caco_docs` self-defer recovery.** When `caco_docs` is deferred and the agent
  needs a doc section, it must first `caco_enable_tools({ names: ["caco_docs"] })`.
  The no-args list surfaces `caco_docs` as a deferred entry, so the path is
  discoverable without prior knowledge.
- **Empty deferred set.** A fully-enabled session (nothing deferred) returns an
  explicit "no deferred tools" message, not an empty/confusing blob.

## Risks and Mitigations

- **Agent can't find a doc section because caco_docs is deferred and it doesn't
  realize it can re-enable it.** Mitigation: the no-args discovery list includes
  `caco_docs`; the tool description states no-args lists everything re-enableable.
- **Regression: something still calls the removed catalog path.** Mitigation:
  grep gate + the redirect stub keeps `section="tools"` a valid (if redirecting)
  call; the pure formatter test + handler tests pin the new home.

## Acceptance

- Observable: on a session with deferred tools, `caco_enable_tools()` (no args)
  returns the grouped deferred list; `caco_enable_tools({ names:["caco_docs"] })`
  re-enables it; `caco_docs section="tools"` returns the redirect line; a lean new
  session shows `caco_docs` among its deferred tools. Operator signoff on the
  no-args output.
- Budgets: no per-turn token growth (enable-tool description swaps one discovery
  clause for another); `caco_docs` now omitted from deferred sessions = a saving.
- Gates: tsc, `lint:strict`, `knip`, vitest, `build:client`, `check:specs` — green.
- Oracles:
  - `formatDeferredTools` unit: compare against an **independent expected string**
    (not just "enabled/disabled absent") over a catalog spanning all origins —
    Caco (incl. `caco_docs` deferred), builtin (one deferred + one policy-disabled),
    and MCP (≥2 deferred) — asserting: exactly the deferred entries appear, grouped
    and in catalog order, with name + first-line description; the disabled **count**
    footer is correct and names no disabled tool; and the empty-set case returns the
    explicit "no deferred tools" message.
  - handler unit: no `names` ⇒ calls `getToolCatalog(sessionRef.id)` **with that
    exact id**, returns the formatted list, and does NOT call `enableTools` (no
    mutation); `names:[]` ⇒ identical; `names:["x"]` ⇒ calls `enableTools`, NOT the
    formatter.
  - `isDeferEligibleCacoTool('caco_docs') === true`.
  - protected-hatch unit: `parseDisabledToolNames(['caco_enable_tools'], 'caco_enable_tools')`
    (defaults AND env) never yields `caco_enable_tools` in the set — the hatch
    cannot be hard-disabled by config.
  - `caco_docs` handler: `section="tools"` returns the redirect (no catalog build).

## Plan

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 1 | Rename `formatToolCatalog`→`formatDeferredTools`; filter to `deferred`, add disabled-count footer + empty-set line | `src/session-tool-state.ts`, `tests/unit/tool-catalog.test.ts` | formatter unit: only deferred listed, footer count, empty message | discovery-one-home |
| 2 | `caco_enable_tools`: `names` optional; no-args/empty ⇒ `getToolCatalog(sessionId)`+`formatDeferredTools`; update description (no-args lists deferred) | `src/tool-reveal-tool.ts` | handler unit: no-args⇒list+no mutation; names⇒enable | sole-escape-hatch |
| 3 | Remove `section="tools"` catalog branch → redirect string; drop `sessionRef` param + import from `createDocsTool`; update description/index bullet | `src/dev-docs-tool.ts`, `server.ts` | docs handler: `section="tools"`⇒redirect | discovery-one-home |
| 4 | Add `'caco_docs'` to `DEFER_ELIGIBLE_CACO_TOOLS`; add `PROTECTED_TOOLS=['caco_enable_tools']` and strip it inside `parseDisabledToolNames` so config can never hard-disable the hatch | `src/tool-registry.ts`, `tests/unit/tool-registry.test.ts` | `isDeferEligibleCacoTool('caco_docs')===true`; protected-hatch unit (defaults+env never disable `caco_enable_tools`) | sole-escape-hatch; defer-never-breaks |
| 5 | Delete obsolete `tests/unit/dev-docs-tools-section.test.ts`; add `tests/unit/tool-reveal-discovery.test.ts` (no-args⇒list+no mutation, names⇒enable, exact-id) and extend `tests/unit/tool-catalog.test.ts` for `formatDeferredTools` | `tests/unit/dev-docs-tools-section.test.ts` (rm), `tests/unit/tool-reveal-discovery.test.ts` (new), `tests/unit/tool-catalog.test.ts` | new tests green; `grep -r 'section=\"tools\"'` shows no catalog-building caller | - |
| 6 | Amend spec-tool-reveal.md: invariant "caco_docs never excluded"→"caco_enable_tools sole hatch"; B1 discovery home→caco_enable_tools; note caco_docs defer-eligible | `docs/spec-tool-reveal.md` | grep: no "caco_docs never excluded" contradiction | sole-escape-hatch |

## Rationale (optional)

The escape hatch and the catalog were two separate always-on tools because the
catalog *was* a `caco_docs` section. But the agent's mental model is "I want a
tool → `caco_enable_tools`" — so discovery belonged there all along. Folding it in
makes `caco_enable_tools` a self-describing single entry point and demotes
`caco_docs` to an ordinary, deferrable doc tool. Net: one fewer always-on tool for
the common session that never opens project docs, and a tighter discover→enable
loop, at the cost of one redirect stub.
