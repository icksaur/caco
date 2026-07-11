# spec-enable-tools-discovery

Relocate deferred-tool discovery from `caco_docs section="tools"` onto
`caco_enable_tools` (no-args), so `caco_docs` can itself be deferred. Amends
spec-tool-reveal (supersedes Plan row B1's discovery home + the "caco_docs never
excluded" invariant).

**Amendment (proactive discovery).** The no-args list is a *pull*: an agent that
does not already know a capability exists either never finds it, or burns a round
trip calling `caco_enable_tools()` just to read the list. Caco already knows the
deferred set every turn, so it also *pushes* discovery — a one-time system-prompt
explainer of the defer model plus a per-turn names-only reminder — closing the
gap without shipping schemas. See "Proactive discovery" below.

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
- The agent **discovers deferred capabilities without a round trip**: a static
  system-prompt "Tool Availability" section teaches the defer model once, and a
  per-turn **names-only** reminder lists what is currently deferred. Descriptions
  stay a pull (`caco_enable_tools()`); enabling stays a pull (`caco_enable_tools({
  names })`).
- The system prompt stops naming specific tools that may themselves be deferred:
  the dead first-turn `get_applet_state` directive is removed, and the scattered
  faith-based "Call `caco_docs` …" instructions become "enable it, then call" —
  `caco_docs` is itself defer-eligible, so those instructions could dangle-
  reference an invisible tool.

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

### Proactive discovery — push the deferred NAMES, not just pull them

With defer active, most tools are hidden and their descriptions are gone from the
turn. Caco knows the deferred set every dispatch, so it surfaces it at two grains:

**1. Static explainer (system prompt, once).** A short "Tool Availability" section
in `buildSystemMessage()` gives the model the mental model: the visible tool list
is intentionally trimmed to save per-turn tokens; many capabilities (applets,
browser, surface, `caco_docs`, MCP servers) are DEFERRED; when you need one, enable
it with `caco_enable_tools({ names:[...] })` and it is callable next turn; call
`caco_enable_tools()` (no args) for the full deferred list with descriptions. This
carries **no per-session data**, so it lives in the cached stable prefix and
preserves cross-session prefix sharing. It REPLACES the dangling "Call caco_docs …"
faith and the removed first-turn `get_applet_state` note.

**2. Change-triggered names-only reminder (dynamic tail).** When the session's
deferred set is non-empty, Caco appends a compact
`<deferred_tools>id, id, …</deferred_tools>` reminder to the outgoing `prompt`
(the lever Caco already owns in `dispatchMessage` → `sendStream`; precedented by
the outer runtime's `<system_reminder>` blocks). NAMES ONLY — no schemas, no
descriptions.

**Emit only on change, not every turn (bounded history).** Appending the same line
every dispatch would accrete duplicate reminders in history and pay their replay
cost forever — so the reminder is emitted only when the deferred set has CHANGED
since the last reminder for this session, PLUS on the first dispatch of a session
and on the first dispatch after a resume or a compaction (context boundaries where
the prior reminder may no longer be in-window). Steady state (unchanged deferred
set, no boundary) emits nothing. This bounds cumulative reminder cost to O(number
of defer/enable events + boundaries), not O(turns) — the honest budget, not "free".
The last-emitted set is tracked in the same per-session in-memory state as the
deferred set itself.

**Enableable identifiers, no catalog needed.** The reminder emits identifiers the
agent passes straight to `caco_enable_tools({ names })`. Because a `ToolKey` IS the
model-facing enable identifier (`cacoKey`/`mcpKey` are the bare name), the deferred
exclusion keys themselves are exactly those identifiers — unique by catalog
construction (the catalog is keyed by them) and unambiguous, so each round-trips
through `resolveEnableTargets` verbatim with no display-name collision to resolve.
No catalog lookup, no name-frequency check.

**Cheap synchronous source — no catalog RPC on the send path.** The deferred keys
are `deferredToolKeys(excluded, policyDisabled)` = the session's LIVE in-memory
`excludedTools` set MINUS the permanent policy (builtin) exclusions. This is pure
and synchronous — it never calls `getToolCatalog()`, which issues SDK/MCP metadata
RPCs and would add latency and a failure mode to every prompt send. (Hard-disabled
tools are filtered pre-registration, so the exclusion set is by construction a
subset of registered, non-hard-disabled keys — filtering `policyDisabled` alone
therefore yields exactly the deferred set `formatDeferredTools` selects **when the
exclusion set is a subset of the live catalog**, which holds for every ordinary
session.) The one exception is a *stale* exclusion key — an operator manual-defers
an MCP server, then removes that server from the MCP config while its learned keys
persist in the manual-defer store: that key stays in `excludedTools` (and in the
existing "excluded − policy" savings accounting) but is no longer in the catalog, so
the reminder lists it while the no-args list does not. This is bounded and harmless:
enabling it is a clean, self-correcting `caco_enable_tools` "unknown tool" rejection,
never a wrong enable. Gating it out would require the very catalog RPC this seam
forbids, so the sync definition (matching the savings-accounting deferred set) wins.

**Seam choice — tail reminder, NOT the system-message body.** The names list is
per-session and changes whenever the agent enables/defers a tool. It must not go in
the cached system-message body: that body is a deliberately stable, cross-session-
shared prefix (spec-prompt-stable-prefix — only `{{SESSION_CWD}}` varies, placed
last), so embedding a per-session list there both breaks cross-session sharing and
sits at the front, forcing every enable to re-send the whole prefix. The dynamic
tail keeps the large stable prefix cached; the reminder rides on the turn's already-
new tokens. An alternative — refreshing a `## Deferred Tools` section in the LIVE
system message via `rpc.options.update({ systemMessage })` on the same call that
mutates `excludedTools` — was considered: it avoids conversation-history growth but
(a) breaks the cross-session stable prefix and (b) depends on the SDK's
`options.update` accepting `systemMessage` (today only `excludedTools` is passed).
Rejected in favor of the dependency-free tail reminder; revisit only if the names-
line history growth ever proves material.

**One source of truth, two renderings.** The no-args full list and the reminder are
BOTH derived from the same deferred set. `formatDeferredTools` selects it via
`classifyTool` over the catalog (to decorate with descriptions); the reminder
selects the identical set via `deferredToolKeys` synchronously (bare keys). An
oracle pins the equivalence: over any catalog whose keys cover the exclusion set,
`deferredToolKeys` returns exactly the keys of the tools `formatDeferredTools` lists
(the sole exception being a stale exclusion key for an unconfigured server, above).
So the surfaces cannot drift on the underlying set — the "no two catalogs to sync"
guarantee is preserved; only the "exactly one call site" wording relaxes (see the
invariant amendment), and the reminder additionally commits its emission signature
only AFTER the send is in flight (below), so a pre-send failure never marks an
undelivered reminder as sent.

**Commit-after-send (no wedge).** `nextDeferredToolsReminder` returns `{ text,
commit }`: `text` is appended to the model prompt, and `commit()` — which advances
the per-session emission signature — is called only once `sendStream` has handed the
message to the SDK. If a pre-send step (`beforeSend`, or the synchronous part of the
send) throws, `commit()` is skipped, so the unchanged deferred set re-emits on the
next dispatch instead of being silently suppressed. A send REJECTION retries with the
same `messageOptions` (reminder preserved), so committing at in-flight is correct.

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
- **Discovery has one source of truth** (invariant, replaces "one home"): the
  deferred set is one selection (`excluded` minus policy), and every rendering — the
  `caco_enable_tools` no-args full list (`formatDeferredTools`) AND the per-turn
  names-only reminder (`deferredToolKeys`) — resolves to it. An oracle pins that the
  two agree over any catalog, so the surfaces cannot disagree and there are no two
  catalog texts to keep in sync.
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
- **Names-only keeps the savings.** Defer's whole point is not shipping schemas
  every turn; the reminder ships only bare enableable identifiers (a word or two
  each), so a fully-deferred big MCP server costs a comma-separated line, not KBs.
  Descriptions stay behind the no-args pull.
- **Bounded, not free.** The reminder is emitted only on change + context
  boundaries (first dispatch, post-resume, post-compaction), never every turn, so
  cumulative history cost is O(defer/enable events + boundaries). Steady state adds
  nothing. An empty deferred set emits nothing.
- **Signature lifetime.** The per-session emission signature is cleared at both
  compaction seams (manual `compactSession`, auto `session.compaction_complete`) and
  unconditionally in `disposeSessionRuntime` (the teardown chokepoint every session-
  end path already calls) — so the signature Map is bounded by live sessions, not by
  process lifetime. The clear lives in `disposeSessionRuntime` itself, not the
  runtime object's `dispose()`, because a runtime object exists only if
  `getSessionRuntime` was used.
- **Enableable identifiers.** The reminder emits the deferred exclusion keys, which
  ARE the model-facing enable identifiers (`caco`/`mcp` keys are the bare name) and
  are unique by catalog construction — so every one round-trips through
  `resolveEnableTargets` verbatim, with no display-name ambiguity to resolve.
- **Synchronous only.** The reminder is built from the session's in-memory deferred
  set, never a `getToolCatalog()` RPC, so prompt-send gains no latency or failure
  mode.
- **Freshness / no stale action.** The reminder reflects the deferred set AS OF that
  dispatch; after a mid-request enable, the next boundary/change reminder omits the
  tool. Acting on a just-enabled name is harmless (enabling an already-enabled tool
  is an idempotent no-op).

## Risks and Mitigations

- **Agent can't find a doc section because caco_docs is deferred and it doesn't
  realize it can re-enable it.** Mitigation: the no-args discovery list includes
  `caco_docs`; the tool description states no-args lists everything re-enableable.
- **Regression: something still calls the removed catalog path.** Mitigation:
  grep gate + the redirect stub keeps `section="tools"` a valid (if redirecting)
  call; the pure formatter test + handler tests pin the new home.
- **Per-turn reminder undoes the savings.** Mitigation: names only + change/
  boundary-triggered emission (not every turn) + skip-when-empty; the reminder is
  orders of magnitude below the schema bytes defer omits. A budget oracle asserts
  the reminder carries no schema/description text and is absent in steady state.
- **Hot-path RPC on send.** Mitigation: the reminder is derived from the
  synchronous in-memory deferred set, never `getToolCatalog()`; the accessor is
  synchronous (returns `string | null`, not a Promise) and reads only the live
  exclusion set.
- **Ambiguous identifier can't be enabled.** Mitigation: the reminder emits
  canonical exclusion keys (which are the enable identifiers), unique by catalog
  construction; a round-trip oracle asserts every emitted key resolves via
  `resolveEnableTargets`.
- **The two renderings drift.** Mitigation: one deferred-set selection; an
  equivalence oracle asserts `deferredToolKeys` returns exactly the keys the no-args
  list (`formatDeferredTools`) would show over the same catalog.

## Acceptance

- Observable: on a session with deferred tools, `caco_enable_tools()` (no args)
  returns the grouped deferred list; `caco_enable_tools({ names:["caco_docs"] })`
  re-enables it; `caco_docs section="tools"` returns the redirect line; a lean new
  session shows `caco_docs` among its deferred tools. Operator signoff on the
  no-args output.
- Observable (proactive): a lean new session's FIRST outgoing prompt carries a
  `<deferred_tools>…</deferred_tools>` identifier line matching its deferred set;
  after the agent enables a tool the next dispatch's reminder reflects the shrunk
  set; a steady-state dispatch with an unchanged, non-empty set emits NO new
  reminder; a fully-enabled session carries none; the system message contains the
  "Tool Availability" explainer and no first-turn `get_applet_state` directive.
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
  - `deferredToolKeys(excluded, policyDisabled)` unit: over an all-origins catalog,
    returns exactly the keys of the deferred entries `formatDeferredTools` lists
    (equivalence oracle); drops policy exclusions; preserves order; empty deferred
    set ⇒ empty (⇒ no reminder). Round-trip oracle: every returned key resolves via
    `resolveEnableTargets` (no ambiguity).
  - reminder-emission unit: `dispatchMessage` appends the `<deferred_tools>` line
    (identifiers only, no schema/description text) on first dispatch and when the
    deferred set changed since the last reminder; emits nothing in steady state
    (unchanged, non-empty) and nothing for a fully-enabled session; issues NO
    catalog RPC (synchronous in-memory source only).
  - retry/display unit: the reminder augments the model-bound prompt exactly once
    and is shared by the initial-send and retry option builders; the user-visible
    `displayPrompt` remains the original user text (no `<deferred_tools>` markup).
  - prompt-snapshot unit: `buildSystemMessage()` contains the "Tool Availability"
    section and no `get_applet_state` first-turn directive.

## Plan

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 1 | Rename `formatToolCatalog`→`formatDeferredTools`; filter to `deferred`, add disabled-count footer + empty-set line | `src/session-tool-state.ts`, `tests/unit/tool-catalog.test.ts` | formatter unit: only deferred listed, footer count, empty message | discovery-one-home |
| 2 | `caco_enable_tools`: `names` optional; no-args/empty ⇒ `getToolCatalog(sessionId)`+`formatDeferredTools`; update description (no-args lists deferred) | `src/tool-reveal-tool.ts` | handler unit: no-args⇒list+no mutation; names⇒enable | sole-escape-hatch |
| 3 | Remove `section="tools"` catalog branch → redirect string; drop `sessionRef` param + import from `createDocsTool`; update description/index bullet | `src/dev-docs-tool.ts`, `server.ts` | docs handler: `section="tools"`⇒redirect | discovery-one-home |
| 4 | Add `'caco_docs'` to `DEFER_ELIGIBLE_CACO_TOOLS`; add `PROTECTED_TOOLS=['caco_enable_tools']` and strip it inside `parseDisabledToolNames` so config can never hard-disable the hatch | `src/tool-registry.ts`, `tests/unit/tool-registry.test.ts` | `isDeferEligibleCacoTool('caco_docs')===true`; protected-hatch unit (defaults+env never disable `caco_enable_tools`) | sole-escape-hatch; defer-never-breaks |
| 5 | Delete obsolete `tests/unit/dev-docs-tools-section.test.ts`; add `tests/unit/tool-reveal-discovery.test.ts` (no-args⇒list+no mutation, names⇒enable, exact-id) and extend `tests/unit/tool-catalog.test.ts` for `formatDeferredTools` | `tests/unit/dev-docs-tools-section.test.ts` (rm), `tests/unit/tool-reveal-discovery.test.ts` (new), `tests/unit/tool-catalog.test.ts` | new tests green; `grep -r 'section=\"tools\"'` shows no catalog-building caller | - |
| 6 | Amend spec-tool-reveal.md: invariant "caco_docs never excluded"→"caco_enable_tools sole hatch"; B1 discovery home→caco_enable_tools; note caco_docs defer-eligible | `docs/spec-tool-reveal.md` | grep: no "caco_docs never excluded" contradiction | sole-escape-hatch |
| 7 | Add pure `deferredToolKeys(excluded, policyDisabled)` (bare deferred keys = enable ids) + `renderDeferredToolsReminder(keys)`; leaf `deferred-reminder-store` (emit-once-on-change sig + `clearDeferredReminder`) | `src/session-tool-state.ts`, `src/deferred-reminder-store.ts`, `tests/unit/tool-catalog.test.ts`, `tests/unit/deferred-reminder-store.test.ts` | keys == formatter's deferred keys; round-trip; emit-once/boundary | discovery-one-source |
| 8 | Add "Tool Availability" section to `buildSystemMessage()`; remove dead first-turn `get_applet_state` note; fold "Call caco_docs" into enable-then-call | `src/prompts.ts`, `tests/unit/prompts-stable-prefix.test.ts` | prompt snapshot: section present, no get_applet_state directive | discovery-one-source |
| 9 | `SessionManager.nextDeferredToolsReminder` (sync, RPC-free) → augment the model prompt once in `dispatchMessage` (shared by send + retry; `displayPrompt` stays original); clear sig at compaction (both seams) + teardown | `src/session-manager.ts`, `src/routes/session-messages.ts`, `src/dispatch-events.ts`, `src/session-runtime.ts` | present on change/boundary, absent in steady state; no catalog RPC; displayPrompt clean | discovery-one-source |
| 10 | Amend the "one home"→"one source of truth" invariant wording in this spec and spec-tool-reveal | `docs/spec-enable-tools-discovery.md`, `docs/spec-tool-reveal.md` | grep: no "one place"/"one home" contradiction | discovery-one-source |

## Rationale (optional)

The escape hatch and the catalog were two separate always-on tools because the
catalog *was* a `caco_docs` section. But the agent's mental model is "I want a
tool → `caco_enable_tools`" — so discovery belonged there all along. Folding it in
makes `caco_enable_tools` a self-describing single entry point and demotes
`caco_docs` to an ordinary, deferrable doc tool. Net: one fewer always-on tool for
the common session that never opens project docs, and a tighter discover→enable
loop, at the cost of one redirect stub.
