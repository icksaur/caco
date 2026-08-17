# spec-enable-tools-config-freshness

**Status:** draft, reviewed across 4 peer-session rounds (all BLOCKER/MUST folded).

Parent/sibling: `spec-enable-tools-catalog-divergence` (advertised-vs-enable-able
sets), `spec-enable-tools-discovery` (RPC-free reminder), `spec-tool-reveal`
(the defer/reveal model). This spec adds the **freshness** layer those assume: the
tool universe a session sees must reflect the CURRENT `~/.copilot/mcp-config.json`,
and no stale persisted cache may advertise a tool the current config can't enable.

## Correctness constraints surfaced by review (read first)

These are load-bearing facts the design MUST respect (all verified in code):

- **C1 — `allLearnedKeys()` discards server identity.** It returns
  `[...new Set(registry.values())]` (`tool-key-registry.ts:95-98`) — deduped
  model-facing names, NOT composites. You cannot derive `server(key)` from it. Any
  per-server filter must iterate `keysForServer(server)` for each server of
  interest (`tool-key-registry.ts:82-89`).
- **C2 — registry server-name is the SDK metadata name, not the home-config key.**
  Keys are learned via `learnFromMetadata` from `m.mcpServerName`
  (`tool-key-registry.ts:71-76`). It is NOT proven equal to the home
  `mcp-config.json` server key. **The filter must therefore key off the SAME name
  space the registry uses. Store the server name alongside learned keys (already the
  composite's first field) and filter by that, never by the raw config key —
  otherwise a name mismatch over-hides (C5 violation).** (A one-time registry
  migration/read exposes `server(key)` for the filter; see D2.)
- **C3 — pre-create cannot know the full server inventory, so it must NOT drop.**
  The seed (`session-manager.ts:819-823`) is computed before the session exists;
  `rpc.mcp.list`/`mcp.discover` need an active session (`:2235-2245`). Home
  `~/.copilot/mcp-config.json` is Caco-owned, but workspace/plugin servers are
  SDK-discovered (via `mcp.discover`, runtime-owned paths). Since pre-create
  knowledge is incomplete, **Stage 1 drops nothing** — it only builds an
  over-advertising synchronous seed to close the first-turn race. All narrowing is
  deferred to Stage 2, which has the authoritative `mcp.discover` inventory + live
  status. (This dissolves the home-vs-project filename hazard entirely.)
- **C4 — `setExcludedToolsLive` cannot change the server set.** It only calls
  `rpc.options.update({ excludedTools })` (`:2523-2529`). Warm reload requires a
  session recreate/rebind, not an exclusion update.
- **C5 — never over-hide (parent invariant).** A redundant advertise costs one bad
  enable attempt; hiding an enable-able tool strands a capability. Every drop is
  gated "unsure ⇒ advertise", never "unsure ⇒ hide". Concretely: **Stage 1
  (pre-create) drops NOTHING** — it only builds an over-advertising seed. The single
  drop point is Stage 2, and even there a key is dropped ONLY when its server is
  provably absent from the authoritative `mcp.discover` inventory AND its identity is
  correlated to a discover entry (see C6). When identity can't be correlated, keep
  advertised.
- **C6 — server-identity namespace mismatch + legacy migration (the crux).**
  `mcp.discover().name`/`DiscoveredMcpServer` reports the **config key**
  (`rpc.d.ts:4149-4155`), while the key registry composites use the **SDK metadata
  server name** from `learnFromMetadata`'s `m.mcpServerName`
  (`tool-key-registry.ts:71-76`; the metadata does NOT carry the config key,
  verified `session-manager.ts:71-73`). Equality is unproven, so a removed server's
  keys can only be dropped if its registry name is correlated to a discover entry.

  **Two-part fix — a safe fallback alone is NOT sufficient (it would leave the exact
  reported `ADO-*` phantoms stranded forever, since a removed server no longer
  appears in `mcp.discover` to correlate against):**

  1. **Forward mapping (persist correlation while both identities are observable).**
     Extend the registry (or a sibling store) to record, per learned key, BOTH the
     SDK metadata server name AND the config-key it correlates to. The correlation is
     observable at learn time because `getCurrentToolMetadata` runs against a live
     session whose `mcp.discover` inventory is simultaneously available — match the
     observed metadata server to its discover entry then (e.g. by shared
     tool membership / the SDK's own linkage) and persist `metadataName ↔ configKey`.
     From then on, a removed config-key is correlated to its registry names and its
     keys drop cleanly.
  2. **Legacy migration (repair the existing unmapped population).** Existing
     `tool-key-registry.json` entries have no config-key mapping. On first run under
     the new scheme, backfill the mapping for every currently-discoverable server
     (their metadata↔config-key is observable now, and ONLY when the linkage is
     **provably unique** — never guess from ambiguous shared-tool membership).
     Registry entries whose server is **already gone** (the stranded `ADO-*` case)
     can't be correlated via discover — so the ONLY safe repair is an **explicit
     operator purge**: a "forget unknown tools" action in the mcp-servers applet that
     removes registry entries the operator confirms are stale. **Do NOT use an
     automatic age-only staleness sweep** — a tool merely deferred/unused (or on a
     temporarily-down server) for N days is not evidence it was removed, so
     age-based auto-deletion would over-hide (C5 violation). An automatic sweep is
     acceptable ONLY if gated on authoritative absence (server confirmed absent from
     `mcp.discover` while correlated), which by construction the stranded legacy
     entries fail — hence operator purge is required for them.

  For any registry server name STILL not correlated after the above, **retain its
  keys (never drop)** — over-advertise, per C5. The forward mapping + migration make
  that residual set shrink to empty over normal use.

## Goal (operator intent)

> "We need to be able to use all tools configured, and not have any stale cache
> issues."

Two concrete, currently-broken behaviours:

1. **All configured tools usable.** After editing `~/.copilot/mcp-config.json`
   (adding a server or widening a server's `tools` allowlist), a new session must
   be able to enable/use those tools — without a full server process restart.

2. **No stale-cache advertisement (bounded by warm completion).** A tool the
   current config does NOT provide must not be *persistently* advertised.
   **Guarantee:** once the async warm (Stage 2) **successfully completes** for a
   session, its reminders advertise only tools backed by the authoritative
   `mcp.discover` inventory + live status — removed servers' keys and
   dropped-allowlist tools are gone, **for servers whose identity is correlated
   (C6)**. Uncorrelated legacy registry keys (a server removed BEFORE the C6 forward
   mapping existed) are the one exception: they persist until an explicit operator
   purge, since a removed server can no longer be correlated via `mcp.discover`. **Before** that completion (the first turn, or
   while the warm is in flight), the seed over-advertises (never over-hides).
   Enabling any not-currently-available tool ALWAYS returns an honest, non-looping
   message (never "unknown … re-list"), so a pre-warm over-advertised name is
   harmless. This is the invariant-preserving trade: never over-hide; converge to
   exact once the warm lands. (The warm is fire-and-forget, so "next turn" is not
   guaranteed — the guarantee is tied to warm *completion*, typically within a turn
   or two.)

## Current behaviour (root causes)

### F1 — mcp-config is read once per session, never reloaded, no watch

`loadMcpServers()` (`src/mcp-config-loader.ts:22`) reads
`~/.copilot/mcp-config.json` synchronously and returns the server map. It is called
from `create`/`_doResume` when a session is built. There is **no file watch and no
cache invalidation**. Consequences observed live: config edited at 12:12 while the
server started at 12:00 — every session already warm keeps the old server set, and
even new sessions pick up the change only because create re-reads the file (which is
correct) — but a widened `tools` allowlist on an ALREADY-loaded server is not
reflected in a warm session at all. The operator's mental model ("I edited the
config, tools should work") is violated until a full restart.

### F2 — persisted key registry / auto-defer latch outlive the config that created them

`~/.caco/tool-key-registry.json` and `~/.caco/auto-defer.json` are **system-wide,
persisted, monotonic-add** (spec-enable-tools-catalog-divergence documents this).
They accumulate every MCP key ever observed on the machine, under any past config.
A new session seeds `excludedTools` from `allLearnedKeys()` ∪ `getAutoDeferred()`,
so it advertises keys for tools the CURRENT config no longer provides. Those keys
then fail to resolve against the session catalog → `unknown tool` (the exact report:
`ADO-repo_get_pull_request_by_id, ...`). The registry is never pruned when a server
or tool leaves the config.

### F3 — the enable-able cache is warmed fire-and-forget, so the first turn races it

`warmEnableableKeys` (`src/session-manager.ts:2502`) primes
`enableableKeysBySession` via `getToolCatalog`, but is intentionally **not awaited**
(`:895` create, `:1235` resume; "must add no latency"). The first user turn's
`nextDeferredToolsReminder` (`session-messages.ts:473`) can emit before the warm
resolves; with the cache absent, `advertisableToolKeys` (`session-tool-state.ts:206`)
falls back to advertising everything. So even a correctly-configured session
over-advertises on turn 1. (This is the F2 symptom's delivery vehicle on new
sessions.)

## Design

Three coordinated fixes. The invariant throughout (from the parent spec): **never
over-hide** — an enable-able tool must always be discoverable; the safe failure
direction is a redundant advertise, never a stranded capability.

### D1 (F1) — reload mcp-config on change; no full restart needed

- **Single validated home snapshot per create/resume (MUST).** Read
  `~/.copilot/mcp-config.json` ONCE at the top of create/resume and thread it to the
  SDK session build. There is **no pre-create seed filter** (Stage 1 never drops), so
  the seed (D3) needs no config read at all. The authoritative server inventory for
  narrowing comes from `mcp.discover` POST-create (Stage 2); Caco does not scan
  project/plugin config files.
- **Warm-session reload requires a session RECREATE, not an exclusion update (C4).**
  `setExcludedToolsLive` only mutates `excludedTools` and cannot add/remove/re-scope
  MCP servers. An operator reload must rebuild the SDK session with the fresh
  `mcpServers` map (the existing warm-recreate path that re-passes
  `ActiveSession.excludedTools`), which busts that session's prompt cache once — so
  it MUST be explicit (a `POST /api/mcp/reload` or mcp-servers applet button), never
  a silent auto-watch-reload of warm sessions. New sessions get the change for free;
  warm sessions get it on explicit reload or their next cold resume.
- **Transactional reload (SHOULD).** A malformed/partially-written
  `mcp-config.json` must FAIL the reload and retain each warm session's prior config,
  never recreate a session with zero MCP servers. `loadMcpServers`
  (`mcp-config-loader.ts:22-35`) already catches+logs; the reload path must treat a
  parse failure as a no-op, not an empty server set.
- **Optional** `fs.watch` on `mcp-config.json` that only **invalidates a memoized
  snapshot** (next create/resume re-reads) — must use the hardened watch pattern
  (spec-server-resilience: `.on('error')`, survive EPERM).

### Cross-cutting — enable failure message classification (identity-aware)

Distinguish these classes and never loop; only `unknown` says "re-list":
- **not-available** — the tool's server IS configured/loaded, but the tool isn't
  currently enable-able here (dropped from the server's `tools` allowlist, or not yet
  observed). Wording must not overclaim: say "previously associated with server X
  but not available in this session," NOT "provided by server X" (it may have been
  dropped from that server's allowlist).
- **not-configured** — the tool's server is absent from `mcp.discover` (not
  configured in any source: user, workspace, or plugin).
- **server-disabled** — the tool's server is in `mcp.discover` with `enabled:false`.
  It exists in config but is turned off; do not advise retry (retry won't help) —
  tell the operator to enable the server in config.
- **temporarily-unavailable** — the tool's server is in `mcp.discover`, enabled, but
  failed to connect/enumerate this session (down). Advise retry, do not say "re-list"
  and do not imply the tool was removed.
- **unknown** — no server association at all (typo/hallucination); the ONLY class
  that says "re-list".
- **stale-unverified** — a retained legacy registry key whose server can't be
  correlated to the current `mcp.discover` inventory (C6). Not enable-able; NEVER
  says "re-list" (re-listing shows the same stale name → loop). Tell the agent it's a
  stale cache entry that will clear on operator purge; proceed without it.

**Classification needs an identity-aware reverse lookup (MUST).** Model-facing names
do not encode their server, and one name may map to multiple registry composites
(`tool-key-registry.ts:25-30, 95-98`). Add a reverse index (model-facing name →
server(s)) so the message path decides deterministically. Precedence, keyed off the
`mcp.discover` inventory + live status (the authoritative sources): a name whose
server is **in discover, enabled, AND enumerated** ⇒ not-available; **in discover
but `enabled:false`** ⇒ server-disabled; **in discover, enabled, but failed/down**
⇒ temporarily-unavailable; **absent from discover but correlated (C6)** ⇒
not-configured; **retained-uncorrelated legacy key (server not correlated to any
discover entry, C6)** ⇒ **stale-unverified**; **no server association at all** ⇒
unknown. Resolve multi-server names to the most-available state (prefer in-discover
+ enumerated).

The **stale-unverified** class is critical (round-8 fix): an uncorrelated legacy key
(e.g. a stranded `ADO-*`) is RETAINED to avoid over-hide, but must NOT be classified
`unknown` — `unknown` tells the agent to re-list, reproducing the original loop.
Instead: "this tool is a stale cache entry that can't be verified against current
config; it is not available \u2014 do not retry, and it will clear when the operator purges
unknown tools." Never say "re-list". Only a name with NO server association
whatsoever (a true typo/hallucination) is `unknown`.

### D2 (F2) — over-advertising seed (pre-create) + authoritative narrowing (post-create)

Two stages, because the authoritative server inventory isn't available until the
session is live (C3, C6):

**Stage 1 — pre-create, PURE SUPERSET SEED (never drops).** Pre-create, Caco
cannot authoritatively know the full configured server inventory (home config is
Caco-owned, but workspace/plugin servers are SDK-discovered and not enumerable on
disk, C3). Therefore Stage 1 does **NOT drop any key** — dropping on incomplete
knowledge is the over-hide hazard the reviewer correctly flagged. Instead Stage 1
only *builds the synchronous seed* (D3): the union of Caco + builtin enable-able
keys + all learned MCP keys (`allLearnedKeys()`), plus any `config.excludedTools`
carried on warm recreate. This over-advertises by construction (safe: never
over-hide) and exists purely to close the first-turn race. **All actual freshness
narrowing happens in Stage 2 with authoritative data.** (This removes the fragile
home-config-name filter entirely.)

**Stage 2 — post-create, AUTHORITATIVE via `mcp.discover` + live status.** The
async warm uses two SDK RPCs that together give the complete picture:

- **`session.rpc.mcp.discover({ workingDirectory })` → `DiscoveredMcpServer[]`**
  (rpc.d.ts:6583, 15903) is the **configured inventory** across user + workspace +
  plugin sources, each with a `type`/source and `enabled` state. This is the
  authoritative "is this server CONFIGURED at all" oracle — it distinguishes
  **removed** (absent from discover) from **configured**.
- **`session.rpc.mcp.list()` / the session's live tool enumeration** gives
  **connection status** (running / disabled / failed / needs-auth / pending;
  rpc.d.ts:16860) and, via `listTools`, the live per-server tool set — the
  **down vs enumerated** oracle.

Narrowing (per-server, refcount-safe merge). **Gate: if `mcp.discover` throws or
returns unusable/empty-on-error data, perform NO narrowing this pass — leave the
entire seed untouched** (no drop is safe without a complete authoritative
inventory). On a successful discover:
- Server **absent from `mcp.discover` AND its registry identity is correlated to the
  discover namespace (C6)** ⇒ removed ⇒ drop its keys. If the server name can't be
  correlated, RETAIN (C5/C6). This is the ONLY drop point.
- Server **present with `enabled: false`** ⇒ configured-but-disabled ⇒ drop from the
  advertised/enable-able set (it cannot be enabled), but classify enable attempts as
  **server-disabled** (distinct diagnostic; not "temporarily-unavailable / retry").
- Server **in `mcp.discover`, enabled, but failed/pending in status** ⇒
  configured-but-down ⇒ KEEP its keys (temporarily-unavailable), never narrow on
  missing enumeration.
- Server **in `mcp.discover`, enabled, AND successfully enumerated** ⇒ REPLACE its
  contribution with its live `listTools` set (adds new, removes allowlist-dropped).

**Refcount / collision (MUST):** a model-facing key may be supplied by more than one
server (`tool-key-registry.ts:25-30`). The merge MUST track per-server key sets and
only remove a key from the advertised set when **no remaining server** supplies it —
never delete a key still provided by another server.

### D3 (F3) — close the first-turn race with a synchronous, all-origin superset seed

The first-turn reminder must never fall into the "cache absent ⇒ advertise
everything" fallback (`session-tool-state.ts:206`). Seed `enableableKeysBySession`
**synchronously** at create/resume, before the async `warmEnableableKeys`.

**The seed MUST be a safe SUPERSET across ALL origins (C5), not just MCP.**
`enableableToolKeys` today is derived from the full catalog (Caco + builtin + MCP);
a synchronous MCP-only seed would omit enable-able Caco/builtin keys and hide THEIR
deferred reminders on turn one. The synchronous seed is therefore:

```
seed = { all Caco enable-able keys }        // known synchronously (Caco catalog)
      ∪ { all builtin enable-able keys }     // known synchronously (registered builtins)
      ∪ { allLearnedKeys() }                 // ALL learned MCP keys (superset; Stage 1 never drops, no config filter)
      ∪ { uncertain config.excludedTools MCP keys }   // carried on warm recreate (C-carry-through)
```

Because it is a **superset** (may include a not-yet-observed MCP key), it satisfies
never-over-hide: worst case one redundant advertise, never a hidden tool. The async
warm then *refines* it per-server (D2 Stage 2 merge): it REPLACES a
successfully-enumerated server's keys with that server's live set (adding new,
removing dropped), and LEAVES untouched any server that failed to enumerate. **A key
present in the synchronous seed whose server has not yet been positively enumerated
stays advertised** (not hidden) until Stage 2 proves it absent from a live server —
so no tool is stranded between seed and warm.

Keeps the zero-added-latency property: the seed is in-memory set math over the
already-read config snapshot + persisted registry, no RPC.

**Carry-through excluded keys (MUST).** A warm recreate re-passes
`config.excludedTools` (`session-manager.ts:819-823, 1110-1114`), which may contain
MCP keys whose server identity can't be correlated pre-create (C2). Because those
are *excluded* (deferred), they must appear in the reminder — so the D3 seed MUST
include any uncertain excluded MCP key too (superset direction), not just the
home-config-derived keys. An excluded key of unknown provenance is advertised, never
silently dropped.

## Sibling-spec reconciliation (MUST)

`spec-enable-tools-catalog-divergence` explicitly **rejects seed-time filtering** and
accepts an unfiltered first-turn window (it filters only at the reminder via the
async-warmed cache, tolerating turn-1 over-advertise as "one bad attempt"). **This
spec is consistent with that stance, not in conflict with it:** this spec ALSO does
no seed-time filtering — Stage 1 builds an over-advertising superset seed and drops
nothing; the seed exists only to close the first-turn *cache-absent* race, not to
filter. ALL narrowing is post-create via `mcp.discover` + live status (Stage 2) plus
the sibling's `advertisableToolKeys` reminder filter. Update the sibling only to:
(a) note the first-turn cache-absent window is now closed by the synchronous superset
seed, and (b) cross-reference that authoritative post-create narrowing (removed /
disabled / down / dropped-allowlist) lives here. Do not leave two specs with
contradictory invariants.

## Implementation plan (final, two-stage)

1. **D1 home snapshot**: read `~/.copilot/mcp-config.json` once at create/resume top;
   thread to SDK build. No pre-create seed filter (Stage 1 never drops).
2. **D2 Stage 1 (pre-create superset seed)**: build the D3 seed only; drop nothing.
3. **D2 Stage 2 (post-create, authoritative)**: in `warmEnableableKeys`, call
   `session.rpc.mcp.discover({ workingDirectory })` for the configured inventory +
   `mcp.list`/`listTools` for status/live tools. **Gate: on discover throw/failure,
   narrow nothing.** Correlate registry server names to discover config-keys (C6) via
   live `getCurrentToolMetadata` observation; drop keys only for a CORRELATED server
   absent from discover. Handle `enabled:false` (drop + server-disabled). Per-server
   refcount-safe merge; keep uncorrelated and down servers' keys.
4. **D3 synchronous all-origin superset seed** (Caco ∪ builtin ∪ `allLearnedKeys()`
   ∪ uncertain `config.excludedTools`) of `enableableKeysBySession` at create
   (`:895`) / resume (`:1235`), before the async warm. Drops nothing.
5. **Reverse-registry index** (name → server[s]) + **6-state** message
   classification (not-available / not-configured / server-disabled /
   temporarily-unavailable / stale-unverified / unknown) keyed off `mcp.discover` +
   status, in `enableToolsLocked` / `tool-reveal-tool.ts`. Only `unknown` says
   "re-list"; the stranded-legacy case is `stale-unverified` (non-looping).
6. **C6 correlation + migration**: persist `metadataName ↔ configKey` at learn time
   ONLY on provably-unique linkage; backfill for discoverable servers on first run;
   add an operator "forget unknown tools" purge for already-stranded legacy entries.
   NO automatic age-only sweep (over-hides); any auto-sweep must be gated on
   authoritative correlated-absence.
7. **D1 warm reload**: explicit endpoint/applet → session RECREATE (not
   `setExcludedToolsLive`, C4); transactional (parse failure = no-op, keep prior).
8. **Reconcile** `spec-enable-tools-catalog-divergence`.
9. Tests + full unit suite.

## Verification

- Edit `mcp-config.json` to ADD a server/tool → a NEW session can enable+use it
  with no full restart. (D1/D2)
- Edit to REMOVE a server → after that session's warm completes, its keys are no
  longer advertised (absent from `mcp.discover`); any attempt reports not-configured,
  never "unknown … re-list". Keys MAY appear on the pre-warm first turn (bounded goal
  #2), never persistently. (D2 Stage 2)
- Drop a tool from a still-configured server's allowlist → after warm, that tool
  classifies not-available (absent from the enumerated server's `listTools`); a
  merely-down server's tools stay advertised (temporarily-unavailable), never hidden.
- Brand-new session, first turn: `caco_enable_tools` for a configured, learned tool
  succeeds; the seed advertises a superset (never over-hides) before the warm lands.
- Unit: Stage-2 merge is refcount-safe (a key shared by two servers survives one
  server's removal); down-vs-removed-vs-disabled distinguished via discover +
  status; discover-failure gate narrows nothing; synchronous seed non-empty with a
  cold cache; message classifier returns the six distinct states and a stranded
  legacy `ADO-*` key classifies **stale-unverified** (never `unknown`/re-list); C6
  forward mapping
  is captured at learn time and the migration/purge converges a pre-existing
  unmapped `ADO-*`-style entry.
- **Legacy repro (the reported bug):** a stale `ADO-*` registry entry for a server
  no longer configured converges to not-advertised ONLY via the explicit operator
  purge (forward correlation can't reach a server already gone) — assert the purge
  removes it, and assert NO automatic age-based deletion of a merely-unused key.
- Regression: configured+observed tool still enables; icm non-whitelisted tool still
  reports not-available; NO over-hide of any enable-able tool at any point.

## Files

- `src/mcp-config-loader.ts` — `loadMcpServers` (`:22`): fresh read; optional
  memoize+invalidate.
- `src/session-manager.ts` — seed (`create :807`, `computeStaleDeferCandidates
  :2546`), `warmEnableableKeys` (`:2502`) + call sites (`:895`, `:1235`),
  `nextDeferredToolsReminder` (`:2488`), `enableToolsLocked` (`:2886`), reload path.
- `src/session-tool-state.ts` — `advertisableToolKeys` (`:206`), `enableableToolKeys`
  (`:187`), `partitionEnableNames` (`:232`), message classes.
- `src/tool-key-registry.ts` — `allLearnedKeys` (`:95`), `keysForServer` (`:82`).
- Prior diagnosis docs (workspace): `caco-enable-tools-phantom-defer.md`,
  `caco-enable-tools-nonwhitelisted.md`, `caco-enable-tools-cold-session.md`.
