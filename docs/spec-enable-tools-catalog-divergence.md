# spec-enable-tools-catalog-divergence

**Status:** draft

`caco_enable_tools` rejects a tool key that Caco itself advertised one turn earlier
(`unknown tool: ADO-repo_get_file_content`), and the rejection message sends the agent
into a re-list loop. The name is correct. The *advertised* set and the *enable-able* set
are computed from two different universes.

## Root cause

Two independent derivations, neither aware of the other:

**Advertised** — `SessionManager.nextDeferredToolsReminder` (session-manager.ts:2430)
returns `deferredToolKeys(this.getExcludedToolKeys(sessionId), policyBuiltins)`: the
session's entire live `excludedTools` set minus policy builtins. It is deliberately
synchronous and RPC-free (spec-enable-tools-discovery) and never consults a catalog.

That exclusion set is seeded at create (session-manager.ts:807) and cold resume from
`computeStaleDeferCandidates` (session-manager.ts:2546), whose MCP candidate universe is
`allLearnedKeys()` ∪ `getAutoDeferred()`. Both are persisted **system-wide** under
`~/.caco` (`tool-key-registry.json`, `auto-defer.json`) and are therefore cross-session
and cross-repo: every MCP key ever observed on this machine, in any folder, under any MCP
configuration.

**Enable-able** — `enableToolsLocked` (session-manager.ts:2797) resolves names against
`getToolCatalog(sessionId)`, whose MCP half comes from `listMcpServers(sessionId)` →
`rpc.mcp.list()`: only the servers actually loaded in **this** session.

So any learned key whose server is not configured for the current session's folder is
advertised but cannot be resolved. `resolveEnableTargets` (session-tool-state.ts:55)
returns `unknown tool: <name>`, which is true of the catalog and false of the reminder the
agent was reading.

This is invisible on the dev box because `~/.caco/tool-key-registry.json` holds exactly one
server (`github-mcp-server`) and it is loaded everywhere. It appears wherever MCP
configuration varies per repo.

## Why it loops

`tool-reveal-tool.ts:42` appends: *"Call `caco_enable_tools` with no arguments to list the
exact names of tools you can enable."* The no-args path is `formatDeferredTools`, which
iterates `catalog.values()` — the **same** session-scoped catalog that just failed to
resolve the name. The phantom key is absent from that listing too. The agent is told to
consult a list that cannot contain the name it was just handed, so it re-lists, re-tries,
and re-fails. The remediation advice is unfollowable for precisely the case that triggers
it.

## Accepted debt: phantom keys stay in `excludedTools`

R1 and R2 fix the *read* paths. The invalid keys themselves remain in the session's
exclusion set, because the only place they could be removed is the seed, and the seed
cannot see the session (see the rejected alternative below). The resulting invariant is
therefore explicit and must be stated at `getExcludedToolKeys`:

> A session's `excludedTools` may contain keys for MCP servers that are not loaded in this
> session. Such keys exclude nothing, cost nothing, and are not enable-able. Any consumer
> that presents the set to a model, or prices it, must intersect it with the session's
> enable-able catalog first.

Current consumers and their obligations:

* `nextDeferredToolsReminder` — intersects (R1).
* `enableToolsLocked` — resolves against the catalog, so it is already immune; R2 only
  improves its diagnostics.
* `deferredDefsSavings` (session-manager.ts:2478) — **does not** intersect, and so counts
  phantom keys as deferred definitions. They were never in the session's tool block and
  save nothing; they inflate `deferredDefsCount` and, once a size was learned in another
  session, `deferredDefsTokens`. Out of scope here (it is an accounting error, not a
  behavioural loop) but it is a real defect and should be tracked, not forgotten.
* The mcp-servers applet payload — same intersect obligation; verify during implementation.

## Related over-reporting (out of scope, note only)

See the `deferredDefsSavings` bullet above. R1 filters the reminder, not the savings math,
so that defect survives this change and needs its own item.

## Design

Two fixes. R1 removes the divergence; R2 makes the residual case legible instead of
looping. R2 is not redundant — R1's filter depends on a cache that can be cold on the very
first dispatch of a session, which is exactly when this bug bites.

### R1 — intersect the reminder with the session's enable-able keys

Add a per-session cache of the catalog's enable-able key set and filter
`nextDeferredToolsReminder` against it.

* `getToolCatalog(sessionId)` populates `enableableKeysBySession: Map<string, Set<ToolKey>>`
  **only when `sessionId` was supplied**. The no-arg variant resolves an arbitrary
  most-recent session and must not write another session's cache — that is the same class
  of bug as the `/servers` telemetry scoping.
* The cached set is the catalog keys that `enableToolsLocked` can actually act on:
  catalog entries excluding MCP entries carried with `excludable: false` (the display-only
  `server/tool` ids minted at session-manager.ts:2376 for tools whose model-facing key has
  never been observed). Defensive rather than load-bearing — such ids are not exclusion
  keys and so cannot appear in a reminder — but a key that cannot be excluded cannot be
  un-excluded, and the set should mean exactly "enable-able".
* `nextDeferredToolsReminder` filters `deferredToolKeys(...)` against the cached set.
* **A missing cache entry means no filtering**, not an empty advertisement. Advertising
  nothing would silently disable the whole discovery feature on any path that never calls
  `getToolCatalog`; the failure mode must stay "over-advertise", which is today's
  behaviour.

**Never cache an unverified enumeration.** This is the sharp edge of R1. Both
`listMcpServers` (session-manager.ts:2201) and `listMcpTools` (session-manager.ts:2332)
swallow RPC failures and return `[]`. A transient hiccup therefore produces a catalog with
zero MCP entries, and caching that set would filter **every** MCP key out of the reminder —
turning an over-advertise bug into a silent over-hide that strands the agent with no way to
discover a deferred tool. Over-hiding is strictly worse than the bug being fixed.

Both RPCs must therefore report failure distinguishably from an empty result (an internal
variant returning `{ ok, servers }` / `{ ok, tools }`, with the existing swallow-to-empty
signatures preserved for their other callers). `getToolCatalog` records whether MCP
enumeration was fully successful, and the cache is written **only when it was**. A failed
or partial enumeration leaves the previous cache entry untouched — and if there is none,
leaves it absent, which falls back to unfiltered advertising. A session with zero
*configured* MCP servers is a successful enumeration and legitimately caches an
MCP-key-free set; a session whose enumeration *failed* is not.

**Cache lifecycle.** Every session-scoped `getToolCatalog` call overwrites the entry, so
the cache tracks the live catalog with no explicit invalidation. Warm recreates
(session-manager.ts:1787/1848/1931) resume under the same session id and re-seed
`excludedTools`; they re-warm through the same resume hook, so a set of loaded servers that
changed across the recreate is picked up on the next warm rather than persisting stale.
Evict on session close. Blast radius is bounded to the reminder text: `enableToolsLocked`
always re-derives a fresh catalog and never reads this cache, so a stale entry can only
mis-advertise, never mis-enable.

Staleness within a session is additionally harmless because `listMcpTools` enumerates a
server's tools server-side, independent of `excludedTools` — which is why the mcp-servers
applet and `formatDeferredTools` can render *deferred* MCP tools at all. If that ever
ceased to hold, the cache would shrink as tools were deferred and would hide legitimately
re-enableable tools; row 2's invariant test must be written so that it would catch this.

**Warming.** Warm the cache once the session is live at the end of create and resume, so
the reminder is filtered as early as possible. It must not be awaited (send latency) and
must not reject into the create/resume path — an explicit `.catch(log)`, never a bare
`void`, so a failure cannot surface as an unhandled rejection.

This warm is **not** a guarantee that the *first* dispatch is filtered: it races an
immediate first send, and it is skipped entirely when enumeration fails. The property R1
guarantees is "filtered once the warm has settled". The residual unfiltered window is
exactly why R2 is required rather than optional.

Rejected alternative: filter phantom keys out of `excludedTools` at seed time. It is the
cleaner model — an exclusion key for an unloaded server is meaningless in `excludedTools`
and saves nothing — but the seed is computed *synchronously before the session exists*
(session-manager.ts:807), so there is no session to ask, and `listMcpServers(undefined)`
falls back to an arbitrary other session's server list. That would filter against the
wrong universe. Revisit only if the seed becomes async.

### R2 — name the phantom case, and do not block the batch on it

In `enableToolsLocked`, split unresolvable names into two classes before failing:

* **Phantom** — unresolvable against the catalog *and* present in the session's live
  exclusion set. Caco advertised it; its MCP server is not loaded in this session.
* **Unknown** — unresolvable and not advertised. A genuine typo or hallucination.

Unknown names keep today's atomic all-or-nothing rejection (a syntax mistake must not cost
a cache-bust). Phantom names are **skipped, not fatal**: enable everything that resolves
and report the phantoms. Rationale: the phantom is Caco's mistake, not the agent's, and
failing the whole batch punishes a correct call that happened to include one bad
advertisement.

**Precedence.** Unknown dominates. A batch containing any unknown name is rejected
atomically with no mutation, regardless of what else it contains — so `[phantom, typo]`
rejects on the typo and the phantom is merely mentioned, never acted on. Phantoms are only
skipped in batches that are otherwise clean.

This does not weaken the "a syntax mistake costs no cache-bust" invariant: that invariant
is about *agent* error, and phantom keys are not agent error. A batch that busts the cache
after skipping a phantom would have busted it anyway for its valid members.

A **phantom-only** batch is the headline case and must mutate nothing: no
`setExcludedToolsLive` call, therefore no cache-bust, and a non-fatal explanatory report.

The phantom report must state that the tool's MCP server is not loaded in this session and
that it is not available here, and must **not** direct the agent to re-list — the no-args
listing cannot contain it either. The existing "call with no arguments" advice stays for
the unknown-name case, where it is correct.

## Plan

| # | Change | Oracle |
|---|--------|--------|
| 0 | Harness: a `SessionManager` test seam that seeds a session's `excludedTools` with a key for a server absent from the catalog (inject via `tool-key-registry` + a stubbed `listMcpServers`/`listMcpTools`) | The harness alone reproduces `unknown tool:` from `enableTools` for an advertised key — **must fail to reproduce nothing**, i.e. the reproduction is red before R1 |
| 1 | R1: MCP enumeration reports success/failure distinguishably from empty (`{ ok, servers }` / `{ ok, tools }` internals; existing swallow-to-empty signatures preserved) | With `rpc.mcp.list` throwing, `getToolCatalog` reports enumeration failure rather than an empty server list |
| 2 | R1 cache population in `getToolCatalog(sessionId)`, gated on a fully successful enumeration; skip when no `sessionId` | With a throwing `rpc.mcp.list`, no cache entry is written and a pre-existing entry is left untouched. **Red before the gate**: without it the entry is overwritten with an MCP-free set. The no-`sessionId` guard is an intra-change assertion, not a red-before oracle |
| 3 | R1 filter in `nextDeferredToolsReminder` | Invariant test: for the row-0 session, every key in the reminder resolves via `resolveEnableTargets` against that session's catalog. Red before the filter. Written so that a catalog which omitted *deferred* MCP tools would also fail it (assert a known-deferred, known-loaded key survives the filter — not merely that the phantom is gone) |
| 4 | R1 cold-cache fallback | With no cache entry, the reminder is byte-identical to today's unfiltered output. Red if the filter treats a missing entry as an empty set |
| 5 | R1 warm-on-create/resume with an explicit `.catch`, never a bare `void` | Once the warm settles, `nextDeferredToolsReminder` is filtered (assert on the settled state, not on the first dispatch — the warm races an immediate send and that race is accepted). A throwing `getToolCatalog` neither fails create nor produces an unhandled rejection; assert via a `process.on('unhandledRejection')` probe, red against a bare `void` |
| 6 | R2 phantom vs unknown classification, precedence, and messaging | `[phantom]` alone: non-fatal report, no `setExcludedToolsLive` call, no mutation, no re-list advice. `[valid, phantom]` enables `valid` and reports the phantom. `[valid, typo]` and `[phantom, typo]` both reject atomically with no mutation and with the re-list advice. All red before the classification |
| 7 | Full gate | `npm run build` + 10 phases green |

Every oracle must be mutation-checked: replace the R1 filter with identity and row 3 must
go red; remove the enumeration-success gate and row 2 must go red; collapse the R2
classification to a single branch and row 6 must go red.

## Testability

Unit-testable on any box — the reproduction is deterministic once a learned key for an
unloaded server is injected. **Not** reproducible end-to-end on the dev box: it has a
single MCP server and that server is loaded in every folder, so the two universes coincide.
End-to-end confirmation requires a machine with per-repo MCP configuration.
