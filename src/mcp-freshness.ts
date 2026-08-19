/**
 * MCP freshness — the pure decision core for spec-enable-tools-config-freshness.
 *
 * NO SDK, NO I/O, NO session state. Everything here is plain-data-in /
 * plain-data-out so the whole "is this tool actually available, and if not why"
 * decision surface is unit-testable in isolation. The stateful shell
 * (session-manager) gathers the inputs (from `mcp.discover` + live status + the
 * key registry) and feeds them here; it never re-derives these rules inline.
 *
 * Invariant (parent spec): NEVER over-hide. When the authoritative inputs are
 * incomplete or an identity can't be correlated, the safe answer is
 * "advertise / retain", never "hide".
 */

import type { ToolKey } from './tool-key.js';

/**
 * Why a requested tool can't be enabled. Each maps to a distinct, non-looping
 * operator/agent message. ONLY `unknown` should ever tell the agent to re-list —
 * every other class is a Caco/config state that re-listing cannot change.
 */
export type EnableUnavailableReason =
  /** Server is configured, enabled, and enumerated, but the tool isn't in its
   *  current live tool set (dropped from the server's allowlist / not exposed). */
  | 'not-available'
  /** The tool's server is absent from the authoritative configured inventory
   *  (`mcp.discover`) and its identity IS correlated — genuinely not configured. */
  | 'not-configured'
  /** The tool's server is in the inventory but `enabled: false`. */
  | 'server-disabled'
  /** The tool's server is configured + enabled but failed to connect/enumerate
   *  this session (transiently down). Retry may help. */
  | 'temporarily-unavailable'
  /** A retained legacy registry key whose server can't be correlated to the
   *  current inventory (server removed before the identity mapping existed).
   *  RETAINED to avoid over-hide, but not enable-able; clears on operator purge.
   *  MUST NOT be reported as `unknown` (that would trigger a re-list loop). */
  | 'stale-unverified'
  /** No server association at all — a typo / hallucinated name. The ONLY reason
   *  whose remediation is "re-list". */
  | 'unknown';

/** Coarse connection state of a configured MCP server this session. */
export type ServerConnState = 'enumerated' | 'down' | 'disabled';

/**
 * The authoritative per-server facts the classifier needs, assembled by the
 * caller from `mcp.discover` (configured inventory + `enabled`) and live status
 * (`mcp.list`/`listTools`). Keyed by the server identity used for correlation
 * (the config key from `mcp.discover`).
 */
export interface ServerInventory {
  /** Server names present in `mcp.discover` (the configured inventory), mapped to
   *  their connection state. Absent from this map = not configured. */
  readonly state: ReadonlyMap<string, ServerConnState>;
  /** For each ENUMERATED server, the set of model-facing tool keys it currently
   *  exposes (from live `listTools`). Used to decide not-available. */
  readonly liveKeysByServer: ReadonlyMap<string, ReadonlySet<ToolKey>>;
  /** True when the `mcp.discover` call succeeded and the inventory is complete.
   *  When false, the caller must NOT narrow anything (see spec discover-failure
   *  gate); the classifier still answers, but callers gate drops on this. */
  readonly discoverOk: boolean;
}

/**
 * Correlation between a model-facing tool key and the server(s) that supply it.
 * `servers` holds the CORRELATED config-key identities (may be more than one —
 * a name can be served by multiple servers). `uncorrelated` is true when the key
 * exists in the registry but its server identity could NOT be correlated to the
 * `mcp.discover` namespace (the legacy stale case).
 */
export interface KeyOrigin {
  /** Correlated config-key server identities that supply this model-facing key. */
  readonly servers: readonly string[];
  /** The registry knows this key but no server identity correlates to discover. */
  readonly uncorrelated: boolean;
}

/**
 * Classify why a requested (already-known-not-directly-enableable) tool key is
 * unavailable. Pure. Precedence favors the MOST-available state for a
 * multi-server key (a tool served by any enumerated+exposing server is
 * `not-available` only if NONE expose it; if any expose it, it's actually
 * enable-able and should not reach here).
 *
 * `origin` is undefined when the name has no registry/catalog association at all.
 */
export function classifyUnavailable(
  origin: KeyOrigin | undefined,
  inv: ServerInventory,
): EnableUnavailableReason {
  return classifyUnavailableDetailed(origin, inv).reason;
}

/**
 * Like `classifyUnavailable`, but also returns the server that PRODUCED the winning
 * (most-available) reason — for the enable-failure message label. NOT `servers[0]`:
 * labelling a `temporarily-unavailable` verdict with a *removed* server would mislead.
 * `server` is undefined when no correlated server drove the verdict (no-origin /
 * uncorrelated-only / no-server cases). Pure.
 */
export function classifyUnavailableDetailed(
  origin: KeyOrigin | undefined,
  inv: ServerInventory,
): { reason: EnableUnavailableReason; server?: string } {
  // No association anywhere → a typo/hallucination. Only this says "re-list".
  if (!origin) return { reason: 'unknown' };
  // If discovery failed we cannot assert a server is removed/disabled/down;
  // preserve uncertainty rather than mislabel. A key the registry knows but whose
  // inventory we can't trust is treated as temporarily-unavailable (retry-safe),
  // never not-configured/unknown.
  if (!inv.discoverOk) return { reason: 'temporarily-unavailable' };

  const correlated = origin.servers ?? [];
  const rank: Record<EnableUnavailableReason, number> = {
    'not-available': 0,          // most available (server is up, just doesn't expose it)
    'temporarily-unavailable': 1,
    'server-disabled': 2,
    'not-configured': 3,
    'stale-unverified': 4,
    'unknown': 5,                // least
  };
  // Rank each CORRELATED server; take the most-available verdict AND the server that
  // produced it.
  let best: EnableUnavailableReason | null = null;
  let bestServer: string | undefined;
  for (const server of correlated) {
    const conn = inv.state.get(server);
    let reason: EnableUnavailableReason;
    if (conn === undefined) reason = 'not-configured';       // correlated but removed
    else if (conn === 'disabled') reason = 'server-disabled';
    else if (conn === 'down') reason = 'temporarily-unavailable';
    else reason = 'not-available';                            // enumerated, not exposing
    if (best === null || rank[reason] < rank[best]) { best = reason; bestServer = server; }
  }
  // An uncorrelated supplier is a POSSIBLE (unverifiable) home for the key. It does
  // not dominate a correlated verdict — if any correlated server gives a more
  // available state, that wins (most-available). Only when there is NO correlated
  // server at all does uncorrelated/none collapse to stale-unverified.
  if (best === null) {
    return { reason: (origin.uncorrelated || correlated.length === 0) ? 'stale-unverified' : 'unknown' };
  }
  // A correlated verdict exists. If it is the least-available (not-configured) but
  // an uncorrelated supplier might still hold the key, prefer stale-unverified only
  // when that is MORE available — it isn't (rank 4 > 3), so keep `best`.
  return { reason: best, server: bestServer };
}

/** The one class whose remediation is to re-list. Every other reason is
 *  non-looping and must NOT advise re-listing. */
export function reasonSaysRelist(reason: EnableUnavailableReason): boolean {
  return reason === 'unknown';
}

/** A short, non-looping operator/agent message for each reason. Never contains a
 *  path (PII) — only the server identity and the class. */
export function messageForReason(reason: EnableUnavailableReason, name: string, server?: string): string {
  const s = server ? ` (server "${server}")` : '';
  switch (reason) {
    case 'not-available':
      return `"${name}"${s} is not in that server's current tool set (removed from its allowlist or not exposed); it cannot be enabled here. Proceed without it.`;
    case 'not-configured':
      return `"${name}"${s} — that MCP server is not configured in this environment. Add it to ~/.copilot/mcp-config.json and reload. Do not retry.`;
    case 'server-disabled':
      return `"${name}"${s} — that MCP server is configured but disabled. Enable it in config; retrying will not help.`;
    case 'temporarily-unavailable':
      return `"${name}"${s} — that MCP server is configured but not connected right now. It may become available; retry later. Do not re-list.`;
    case 'stale-unverified':
      return `"${name}" is a stale cache entry that can't be verified against the current config; it is not available. Do not retry — it will clear when the operator purges unknown tools.`;
    case 'unknown':
      return `unknown tool: "${name}". Call caco_enable_tools with no arguments to list the exact enable-able names.`;
  }
}

/**
 * Refcount-safe refinement of the over-advertising seed against the authoritative
 * inventory (spec D2 Stage 2). Returns the refined enable-able set.
 *
 * Semantics per correlated supplier server:
 * - `enumerated`: authoritative — exposes exactly `liveKeysByServer[server]`.
 * - `disabled` / not-in-inventory (removed): authoritative NEGATIVE — supplies
 *   nothing (its keys must not be kept alive by it).
 * - `down`: NON-authoritative — may still supply the key; keeps it alive.
 * A key is REMOVED only when NO server keeps it alive: no enumerated server exposes
 * it, AND no down/uncorrelated (unproven) server might supply it. Newly-exposed
 * live keys from enumerated servers are ADDED (widen), so a freshly-configured tool
 * appears. When `discoverOk` is false, nothing is narrowed OR widened by removal —
 * the seed is returned unchanged plus any live additions are still safe to add.
 *
 * `keyOrigin` maps every relevant model-facing key (seed keys AND live keys) to its
 * correlated/uncorrelated supplier servers.
 */
export function refineEnableableKeys(args: {
  seed: ReadonlySet<ToolKey>;
  keyOrigin: ReadonlyMap<ToolKey, KeyOrigin>;
  inv: ServerInventory;
}): Set<ToolKey> {
  const { seed, keyOrigin, inv } = args;
  const out = new Set<ToolKey>(seed);

  // Widen: add every key an ENUMERATED server currently exposes (newly-configured
  // tools). Guard on 'enumerated' state defensively — liveKeysByServer should only
  // hold enumerated servers, but enforce the invariant here so a mis-assembled input
  // can't add keys for a down/disabled server.
  for (const [server, live] of inv.liveKeysByServer) {
    if (inv.state.get(server) !== 'enumerated') continue;
    for (const key of live) out.add(key);
  }

  // Narrow only on a successful, complete inventory (discover-failure gate).
  if (!inv.discoverOk) return out;

  for (const key of [...out]) {
    const origin = keyOrigin.get(key);
    if (!origin) continue; // unknown origin → keep (over-advertise, never over-hide).
    const servers = origin.servers ?? [];
    if (servers.length === 0 && !origin.uncorrelated) continue; // no info → keep.

    // Does any server KEEP this key alive?
    let keptAlive = false;
    for (const server of servers) {
      const conn = inv.state.get(server);
      if (conn === 'enumerated') {
        if (inv.liveKeysByServer.get(server)?.has(key)) { keptAlive = true; break; }
        // enumerated + not exposing → this server is an authoritative NEGATIVE; keep looking.
      } else if (conn === 'down') {
        keptAlive = true; break; // down server might still supply it → keep (refcount).
      }
      // conn === 'disabled' or undefined (removed) → authoritative negative; keep looking.
    }
    // An uncorrelated supplier is unverifiable → it keeps the key alive (retain;
    // it will surface as stale-unverified at enable time, never over-hidden).
    if (!keptAlive && origin.uncorrelated) keptAlive = true;

    if (!keptAlive) out.delete(key);
  }
  return out;
}
