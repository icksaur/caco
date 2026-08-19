# Increment 3 (cf-seed) — implementation plan

Wires the spec's two-stage D2 + synchronous D3 seed into the live session, using the
pure cores from increments 1–2. Constraint on this box: typecheck + unit tests only
(no build/restart). So all NEW logic lands in a pure, unit-testable module; the
session-manager change is a thin RPC-gather + call-the-core shell.

## SDK contract (verified against @github/copilot-sdk 1.0.8 rpc.d.ts)

- `session.rpc.mcp.discover({ workingDirectory? }) -> { servers: DiscoveredMcpServer[] }`
  - `DiscoveredMcpServer = { name /*config key*/, type?, source, enabled }`  (rpc.d.ts:4149, 6583, 15903)
- `session.rpc.mcp.list() -> { servers: McpServer[], host? }`
  - `McpServer = { name /*config key*/, status: McpServerStatus, source?, error? }` (rpc.d.ts:7266, 7297)
  - `McpServerStatus = connected | failed | needs-auth | pending | disabled | not_configured` (session-events.d.ts:565)
- `session.rpc.mcp.listTools({ serverName }) -> { tools: {name, description}[] }`  (rpc.d.ts:2373 call site)
- `session.rpc.tools.getCurrentMetadata() -> { tools: CurrentToolMetadata[] }` — carries `mcpServerName`, `mcpToolName`.

### Identity (C6) — correlate only on PROVEN linkage (review BLOCKER 2)
`lookupMcpKey(s.name, t.name)` MISSES are tolerated (display-only entries), so the
existing catalog code does NOT prove `mcp.list`/`discover` names equal the metadata
composite server name. Therefore we must NOT blanket-assert identity. Instead, per
server, record `learnServerCorrelation(metaServer, configKey)` ONLY when it is PROVEN
this session: a server listed by `mcp.list` (config-key namespace) whose `listTools`
SUCCEEDED and produced ≥1 tool that resolves — via `lookupMcpKey(configKey, toolName)` —
to a learned key. That success uniquely links the config-key `s.name` to the same
composite server the metadata learner used (they are the same value on this SDK, and the
successful resolve is the proof). If the resolve never succeeds for a server, we do NOT
correlate it — it stays uncorrelated ⇒ retained (never over-hide). No identity-fallback
that fabricates a mapping.

## New pure module: `src/mcp-inventory.ts`

Plain-data-in (RPC result shapes) → `ServerInventory` + `keyOrigin` for the freshness
core. NO SDK import, NO session state — unit-testable. Exports:

```ts
buildServerInventory(args: {
  discover: { name: string; enabled: boolean }[] | null;   // null = discover failed/threw
  liveServers: { name: string; status: McpStatusLite }[];  // from mcp.list; [] tolerated
  enumeratedServers: ReadonlySet<string>;                  // servers whose listTools SUCCEEDED (incl. empty result)
  liveKeysByServer: ReadonlyMap<string, ReadonlySet<ToolKey>>; // enumerated servers' live keys
}): ServerInventory
```
- `discoverOk = discover !== null`.
- A server is **live-enumerated** iff `enumeratedServers.has(name)` — successful
  `listTools`, INCLUDING an empty successful result (an empty success is authoritative-
  negative for its keys, NOT a swallowed failure). A `connected`/present status WITHOUT
  enumeration success is `'down'` (retain).
- state map (only when discoverOk) — union of THREE sources, most-conservative wins so a
  server proven present by ANY live signal is never treated as removed (never-over-hide):
  - live-enumerated (from `enumeratedServers`) ⇒ `'enumerated'` (regardless of discover
    presence: live positive evidence overrides discover silence — widen/retain).
  - else authoritatively disabled — discovered with `enabled === false`, OR live status
    `disabled` ⇒ `'disabled'`.
  - else PRESENT in `mcp.list` (any non-disabled status: connected-but-listTools-failed,
    failed, needs-auth, pending, not_configured) ⇒ `'down'` (retain). **A server present
    in `mcp.list` is NEVER treated as removed, even if absent from discover and its
    enumeration failed** (review round-3 BLOCKER: a correlated `mcp.list`-present server
    with a failed `listTools` must stay `down`, not drop).
  - else discovered (enabled) but NOT in `mcp.list` at all ⇒ `'down'` (configured, not
    connected this session — retain).
  - else NOT in discover AND NOT in `mcp.list` ⇒ NOT in `state` ⇒ removed (no live signal
    anywhere).
- A server in `mcp.list` but ABSENT from discover AND not enumerated (unproven live):
  present ⇒ `'down'` (retained). If it was never correlated, its keys are also kept alive
  via `KeyOrigin.uncorrelated`. Either way: retained, never over-hidden — covered by a test.
- `liveKeysByServer` passed through unchanged (already keyed by config-key server name;
  only enumerated servers should be present — caller ensures this).

```ts
assembleKeyOrigin(args: {
  keys: Iterable<ToolKey>;                        // union(seed, all live keys)
  serversForKey: (k: ToolKey) => string[];        // registry reverse-map (metadata namespace)
  configKeyForServer: (metaName: string) => string | undefined;
}): Map<ToolKey, KeyOrigin>
```
For each key: `metaServers = serversForKey(k)`. For each `metaServer`:
- If `configKeyForServer(metaServer)` returns a config key `cfg` (a PROVEN correlation):
  push `cfg` into `servers` — **including when that server is absent from the whole live
  inventory**. Whether it is actually removed is decided downstream by
  `ServerInventory.state`: `refineEnableableKeys`/`classifyUnavailable` drop the key only
  when `cfg` is in NEITHER discover NOR `mcp.list` (no live signal anywhere → removed). A
  `cfg` present in `mcp.list` (even down / failed-enumeration) is `'down'` and RETAINED.
  (BLOCKER 1: an explicitly-mapped supplier must NOT collapse to `{servers:[],
  uncorrelated:false}` / silently retained-without-a-drop-path.)
- If `configKeyForServer(metaServer)` returns undefined (NOT correlated): this supplier
  is unverifiable → set `uncorrelated = true`. Do NOT fabricate an identity-fallback
  config key. An uncorrelated supplier keeps the key alive.

So: `servers` = the PROVEN config keys of this key's suppliers. `uncorrelated` = true iff
ANY supplier metaServer has no proven config-key mapping (the ANY-supplier-unmapped
rule). A key with NO metaServers at all → `{ servers: [], uncorrelated: false }` (no
info; refine/classify keep it — over-advertise). The removed-vs-retained decision is
entirely `state`-driven; `assembleKeyOrigin` needs NO `discoveredNames` input (NIT).

Both functions PURE; ~30 lines each. Full unit coverage: discover-fail gate, disabled vs
down vs enumerated mapping, phantom-live-server retention, live-enumerated-not-discovered
override (retain/widen), connected-but-listTools-failed ⇒ down, explicitly-mapped-but-
absent-from-ALL-inventory ⇒ dropped, uncorrelated ANY-supplier rule, and the COMBINED
critical case (review SHOULD): previously-correlated + absent from discover + present in
`mcp.list` + `listTools` FAILED ⇒ `down` and RETAINED (not dropped).

## Synchronous D3 seed: `src/session-tool-state.ts` new pure `buildSyncSeed`

```ts
buildSyncSeed(args: {
  cacoEnableableKeys: Iterable<ToolKey>;   // caco catalog, excludable
  builtinEnableableKeys: Iterable<ToolKey>;// builtin: keys, minus policy-disabled
  learnedMcpKeys: Iterable<ToolKey>;       // allLearnedKeys()
  carriedExcluded: Iterable<ToolKey>;      // ALL uncertain dynamically-excluded keys (any origin)
}): Set<ToolKey>
```
Pure union. Superset by construction (never over-hide). Unit-tested.
`carriedExcluded` is EVERY uncertain dynamically-excluded key (the session's seeded
exclusions minus policy builtins), NOT only carried MCP keys — because the builtin-name
cache is populated fire-and-forget (`setBuiltinToolNames`, session-manager.ts:492-499)
and may still be empty when the sync seed runs, so an excluded builtin could otherwise be
hidden from its own reminder (review MUST). Superset direction: an excluded key of any
origin is advertised, never silently dropped.

## session-manager wiring (thin shell — NOT unit-tested here, guarded by types)

Reuse the SINGLE existing snapshot in `getToolCatalog` (review MUST: no separate
`gatherServerInventory` RPC pass — that would create inconsistent snapshots + duplicate
latency). `getToolCatalog` ALREADY calls `listMcpServers` (→ live status), `listMcpTools`
per server (→ live keys + a per-server enumerateOk from its `onFailure`), and
`getCurrentMetadata`+`learnFromMetadata`. Add ONE more call to that same pass:
`mcp.discover({ workingDirectory })` (try/catch → null ⇒ discoverOk=false).

1. Inside `getToolCatalog`, after the existing `mcp = await Promise.all(...)` block:
   - Capture per-server `{ status, enumerateOk, liveKeys }` from that same enumeration
     (thread a per-server failure flag through `listMcpTools`, distinct from the shared
     `enumerationOk`).
   - For each server whose listTools SUCCEEDED and produced ≥1 resolved (learned) key,
     `learnServerCorrelation(s.name, s.name)` — the PROVEN linkage (BLOCKER 2).
   - `discover = await this.mcpDiscover(target)` (new thin wrapper, null on throw).
   - `inv = buildServerInventory({ discover, liveServers, enumeratedServers,
     liveKeysByServer })` — `enumeratedServers` = the set of server names whose
     `listMcpTools` did NOT signal failure (its `onFailure` never fired), including
     empty-but-successful results.
   - `keyOrigin = assembleKeyOrigin({ keys: union(seed, allLiveKeys), serversForKey,
     configKeyForServer })`.
2. Replace the seed line (session-manager.ts:2468)
   `this.enableableKeysBySession.set(sessionId, enableableToolKeys(catalog))`
   → `const seed = buildSyncSeed({...}); const refined = refineEnableableKeys({ seed,
   keyOrigin, inv }); this.enableableKeysBySession.set(sessionId, refined);`
   Replace the inline guard with the pure `shouldCommitWarmSet({ sessionId,
   enumerationOk, activeAtEntry, activeNow: this.activeSessions.get(sessionId) })`
   predicate (behaviour-identical; see Lifecycle safety).
   On discover FAILURE (`discoverOk=false`): `refineEnableableKeys` performs NO narrowing
   AND — because `state` is empty, so its `state.get(server)==='enumerated'` widen guard
   never matches — NO live-key widening either; it returns the seed UNCHANGED. Live MCP
   keys are still present in the seed via `allLearnedKeys()` (learned earlier this pass),
   so nothing is stranded. (Corrected: not "seed+live-additions" — the seed already
   carries learned keys; widening only happens on a successful discover.)
3. Add a SYNCHRONOUS seed at create (after session-manager.ts:885) and resume (after the
   resume `activeSessions.set`), BEFORE the async `warmEnableableKeys`:
   `this.enableableKeysBySession.set(sessionId, buildSyncSeed({...}))`. In-memory only
   (caco catalog + builtin names + allLearnedKeys + the session's seeded exclusions) —
   zero RPC. Ordering is safe because the async warm overwrites under the same-session
   identity guard (review SHOULD confirmed).

## Deliberately deferred to later increments (unchanged from prior agreement)
- cf-message: wire `classifyUnavailable`/`messageForReason` into `enableToolsLocked` +
  tool-reveal-tool (increment 4).
- cf-reload: `mcp.config.reload` + session recreate on config change (increment 5).
- cf-verify: full suite (increment 6).

## Validation on this box
`npx tsc --noEmit` + new unit tests for `mcp-inventory.ts` and `buildSyncSeed`, plus the
existing freshness/registry suites. Unit tests MUST cover (review MUSTs): phantom-live-
server retention (uncorrelated-kept-alive); connected-but-listTools-failed ⇒ down (not
enumerated, not authoritative-negative); explicitly-mapped-but-absent server ⇒ servers
includes the removed config key ⇒ dropped; ANY-supplier-unmapped ⇒ uncorrelated retain.
No runtime verify possible (no build/restart here).

## Lifecycle safety (review MUST)
Preserve the existing `activeAtEntry` identity guard (session-manager.ts:2395-2399,
2460-2469): capture the ActiveSession object at entry and only write the refined set when
`this.activeSessions.get(sessionId) === activeAtEntry` still holds — so a session torn
down and recreated under the same caller id during the async enumeration cannot inherit
the dead one's warm result. The guard is left byte-for-byte unchanged (only the VALUE
written changes from `enableableToolKeys(catalog)` to the refined seed).

To make the changed async write path testable here (review MUST), extract the write
decision into a PURE predicate in `session-tool-state.ts`:
```ts
shouldCommitWarmSet(args: {
  sessionId: string | undefined;        // only an explicitly-named session may write
  enumerationOk: boolean;               // a failed MCP enumeration must not write an MCP-free set
  activeAtEntry: object | undefined;    // ActiveSession captured at entry (identity token)
  activeNow: object | undefined;        // this.activeSessions.get(sessionId) at write time
}): boolean   // === (!!sessionId && enumerationOk && !!activeAtEntry && activeAtEntry === activeNow)
```
`getToolCatalog` calls this predicate at line 2467 instead of the inline `&&` chain (same
boolean, now unit-tested): asserts no-write on missing sessionId, on failed enumeration,
on a null/replaced active session (torn-down / recreated-same-id), and write on the happy
path. The session-manager change is a mechanical substitution of the predicate for the
existing expression — behaviour-identical, but now covered.
