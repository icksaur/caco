# Increment 4 (cf-message) — implementation plan

Wire the six-state classifier (`classifyUnavailable` / `messageForReason` from
increment 1's `mcp-freshness.ts`) into the enable-failure path, so a non-enable-able
requested tool gets a precise, NON-LOOPING diagnostic instead of today's single blanket
"phantom: server not loaded" message. Only `unknown` (a true typo/hallucination) ever
says "re-list". Constraint on this box: typecheck + unit tests only.

## Current state
- `enableToolsLocked` (session-manager.ts:3005) calls `partitionEnableNames` →
  `{ resolvable, phantom, unknown }`. `unknown` DOMINATES (atomic reject with re-list
  advice). `phantom` names are returned as-is; the ok-result carries `phantom: string[]`.
- `tool-reveal-tool.ts:55-56` renders ALL phantoms with ONE message ("their MCP server
  is not loaded here … do not retry"). That is already non-looping but coarse — it can't
  distinguish removed / disabled / down / stale-unverified / not-available.

## The six states already exist (increment 1)
`EnableUnavailableReason = not-available | not-configured | server-disabled |
temporarily-unavailable | stale-unverified | unknown`. `classifyUnavailable(origin, inv)`
+ `messageForReason(reason, name, server?)` + `reasonSaysRelist(reason)` are pure and
tested. This increment only ASSEMBLES their inputs at enable time and threads the message
out.

## Inputs needed at enable time: `inv` + `keyOrigin`
`enableToolsLocked` ALREADY calls `getToolCatalog(sessionId)` (line 3012), which computes
`inv` (buildServerInventory) and `keyOrigin` (assembleKeyOrigin) internally for the
Stage-2 refine. Rather than recompute (extra RPCs), EXPOSE them:

1. `getToolCatalog` returns an extra field `freshness?: { inv: ServerInventory;
   keyOrigin: Map<ToolKey, KeyOrigin> }`, present whenever a per-session Stage-2 snapshot
   was ASSEMBLED — **including when `inv.discoverOk` is false** (MUST: a
   `ServerInventory{discoverOk:false}` is meaningful; `classifyUnavailable` safely maps a
   known key to `temporarily-unavailable` under it, never `unknown`/removed). `undefined`
   is reserved for paths where NO snapshot was assembled at all (the no-session variant).
   NON-breaking: existing callers ignore the new field; the three existing return fields
   `{ catalog, excluded, policyDisabled }` are unchanged. **`freshness` is populated under
   the SAME `shouldCommitWarmSet` active-session identity guard as the refined set (MUST):
   if the captured session was torn down/replaced during enumeration, `freshness` is
   omitted — enable messaging must never consume a dead/other session's snapshot.**

2. A new PURE helper in `session-tool-state.ts` (or a small new module) —
   `classifyEnableFailures`:
   ```ts
   classifyEnableFailures(args: {
     phantomNames: readonly string[];          // from partitionEnableNames (proven ⊆ excluded)
     keyOrigin: ReadonlyMap<ToolKey, KeyOrigin>;
     inv: ServerInventory;
   }): { name: string; key: ToolKey; reason: EnableUnavailableReason; server?: string }[]
   ```
   A phantom name is, by construction, an EXACT exclusion `ToolKey` (a display name that
   resolves against the catalog is classified `resolvable`, never phantom — MUST). So the
   name IS the key; NO by-name/raw fallback (that could mis-resolve → mis-classify).
   For each: `origin = keyOrigin.get(key)`; `{ reason, server } =
   classifyUnavailableDetailed(origin, inv)`.

   **BLOCKER FIX — a proven phantom can NEVER become `unknown`.** `partitionEnableNames`
   already proved the name is in `excluded` (Caco advertised it), so its floor is
   `stale-unverified`, never `unknown` (which would re-emit the re-list loop). Enforce it
   HERE: if `classifyUnavailableDetailed` returns `unknown` (undefined/no-server origin),
   REMAP to `stale-unverified` for a proven phantom. `unknown` is reserved for the
   `partitionEnableNames` `unknown` bucket (a name NOT in excluded), which keeps its
   existing atomic-reject + re-list path untouched.

2b. **Server-for-winning-reason (MUST).** Add `classifyUnavailableDetailed(origin, inv):
    { reason, server? }` to `mcp-freshness.ts` — the SAME rank/select as
    `classifyUnavailable`, but also returning the server that PRODUCED the winning
    reason (not `servers[0]`, which could label a `temporarily-unavailable` verdict with a
    *removed* server). `classifyUnavailable` becomes a thin wrapper returning `.reason`.
    Unit-tested for winning-server alignment across multi-server cases.

3. `enableToolsLocked` return type gains the classified phantoms:
   `{ ok: true; enabled; alreadyEnabled; phantom: string[];
      phantomReasons?: { name: string; reason: EnableUnavailableReason; server?: string }[] }`
   Populated ONLY when `freshness` was available; else `phantomReasons` is omitted and the
   caller falls back to today's blanket phantom message (safe: still non-looping).
   `enableTools` (the public wrapper) passes it through.

4. `tool-reveal-tool.ts`: when `phantomReasons` is present, render ONE line per reason via
   `messageForReason(reason, name, server)` (already non-looping, PII-free). Group by
   reason for brevity if multiple share it. When absent, keep the existing blanket phantom
   line.

4b. **NEW BLOCKER FIX — the `ok:false` branch (tool-reveal-tool.ts:41-42) currently
    appends "call with no arguments to list …" re-list advice to EVERY failure**, incl.
    `tool is disabled and not re-enableable` and `session is not active`/RPC failures —
    violating "only `unknown` says re-list". Gate it: append the re-list advice ONLY when
    the error is the `unknown tool:` class (the sole agent-fixable-by-relisting error).
    `enableToolsLocked`'s `ok:false` errors are: `unknown tool: …` (re-list OK), `tool is
    disabled and not re-enableable: …` (NO re-list — operator/policy), `session is not
    active` / `rpc.options.update did not succeed` / validate errors (NO re-list —
    operational). Detect via an explicit flag rather than string-matching: extend the
    `ok:false` shape to `{ ok:false; error; relistable: boolean }` (`relistable:true` only
    for the unknown-name reject), and the tool renders the re-list line iff `relistable`.

## Invariants preserved
- `unknown` still DOMINATES and atomically rejects with re-list advice (unchanged path;
  a phantom is never unknown, so this never fires for a classified phantom).
- A phantom-only batch still mutates nothing, is `ok:true`, no cache-bust.
- No message contains a USER-SPECIFIC filesystem path (PII) — `messageForReason` uses
  name+server only; the fixed `~/.copilot/mcp-config.json` guidance string is allowed
  (it is a well-known non-user path, not PII).
- When freshness is unavailable (the no-session variant assembled NO per-session
  snapshot), fall back to the existing blanket phantom message — still non-looping. NOTE:
  a discover/list RPC failure does NOT drop freshness — it yields `inv.discoverOk:false`,
  which is still exposed and safely classifies known keys as `temporarily-unavailable`.

## Deliberately deferred
- cf-reload (increment 5): `mcp.config.reload` + session recreate on config change.
- cf-verify (increment 6): full suite.

## Validation on this box
`npx tsc --noEmit` + new unit tests:
- `classifyUnavailableDetailed`: winning-server aligns with the winning reason across
  multi-server cases (e.g. a key served by a removed AND a down server ⇒
  `temporarily-unavailable` labelled with the DOWN server, not the removed one).
- `classifyEnableFailures`: all five phantom reasons (not-available / not-configured /
  server-disabled / temporarily-unavailable / stale-unverified) via crafted
  inv/keyOrigin; `unknown` is remapped to `stale-unverified` for a proven phantom. The
  BLOCKER case — a proven phantom with NO `keyOrigin` entry ⇒ `stale-unverified` (NOT
  `unknown`), no re-list advice.
- tool-reveal-tool render test: one line per reason via `messageForReason`, no re-list
  advice for any phantom reason, no user-specific path.
Plus the existing suites. No runtime verify possible here.
