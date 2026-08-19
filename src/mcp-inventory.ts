/**
 * MCP inventory assembly — the pure adapter layer for
 * spec-enable-tools-config-freshness (increment 3 / cf-seed).
 *
 * NO SDK, NO I/O, NO session state. Turns the plain-data results of the SDK RPCs
 * (`mcp.discover` + `mcp.list` + per-server `listTools`) plus the key registry's
 * reverse-lookups into the two inputs the freshness core (`mcp-freshness.ts`)
 * consumes: a `ServerInventory` and a per-key `KeyOrigin` map. The stateful shell
 * (session-manager) gathers the RPC results and calls these; it never re-derives
 * the state-bucketing or correlation rules inline.
 *
 * Invariant (parent spec): NEVER over-hide. Every ambiguous signal resolves to
 * "retain / advertise". Concretely: ANY live signal that a server exists
 * (presence in `mcp.list`, even down / failed-enumeration) keeps it at least
 * `'down'` (retained) — only a server with NO live signal anywhere (absent from
 * both discover and `mcp.list`) is treated as removed.
 */

import type { ToolKey } from './tool-key.js';
import type { ServerConnState, ServerInventory, KeyOrigin } from './mcp-freshness.js';

/** The subset of `McpServerStatus` (SDK session-events.d.ts) this layer distinguishes. */
export type McpStatusLite =
  | 'connected'
  | 'failed'
  | 'needs-auth'
  | 'pending'
  | 'disabled'
  | 'not_configured';

/**
 * Assemble a `ServerInventory` from the authoritative RPC results.
 *
 * `discover === null` means the `mcp.discover` RPC failed/threw (discoverOk=false) —
 * the freshness core then narrows NOTHING (discover-failure gate).
 *
 * State bucketing (only meaningful when discoverOk), most-conservative-wins so a
 * server proven present by ANY live signal is never treated as removed:
 *  1. `enumeratedServers.has(name)`  → 'enumerated' (successful listTools, incl. an
 *     empty successful result; live positive evidence overrides discover silence).
 *  2. authoritatively disabled — discover `enabled:false`, OR live status 'disabled'
 *     → 'disabled'.
 *  3. present in `mcp.list` with any other status (connected-but-listTools-failed,
 *     failed, needs-auth, pending, not_configured) → 'down' (retain).
 *  4. discovered (enabled) but NOT in `mcp.list` at all → 'down' (configured, not
 *     connected this session — retain).
 *  5. absent from BOTH discover and `mcp.list` → NOT in state ⇒ removed.
 */
export function buildServerInventory(args: {
  discover: readonly { name: string; enabled: boolean }[] | null;
  liveServers: readonly { name: string; status: McpStatusLite }[];
  enumeratedServers: ReadonlySet<string>;
  liveKeysByServer: ReadonlyMap<string, ReadonlySet<ToolKey>>;
}): ServerInventory {
  const { discover, liveServers, enumeratedServers, liveKeysByServer } = args;
  const discoverOk = discover !== null;

  const liveStatus = new Map<string, McpStatusLite>();
  for (const s of liveServers) liveStatus.set(s.name, s.status);

  const state = new Map<string, ServerConnState>();

  if (discoverOk) {
    const discovered = new Map<string, boolean>(); // name → enabled
    for (const d of discover!) discovered.set(d.name, d.enabled);

    // Every server named by ANY source is a candidate; the bucketing decides its state.
    const names = new Set<string>([...discovered.keys(), ...liveStatus.keys()]);
    for (const name of names) {
      // 1. Proven live-enumerated wins outright.
      if (enumeratedServers.has(name)) {
        state.set(name, 'enumerated');
        continue;
      }
      // 2. Authoritatively disabled (either source).
      const discEnabled = discovered.get(name);
      if (discEnabled === false || liveStatus.get(name) === 'disabled') {
        state.set(name, 'disabled');
        continue;
      }
      // 3/4. Present by any live/config signal (and not disabled/enumerated) → down.
      //      This covers: in mcp.list with a non-disabled status (3), and discovered-
      //      enabled but absent from mcp.list (4). Both retain.
      if (liveStatus.has(name) || discovered.has(name)) {
        state.set(name, 'down');
        continue;
      }
      // 5. No signal anywhere → removed (not added to state).
    }
  }

  // Only enumerated servers contribute live keys (the freshness core enforces this too).
  const liveKeys = new Map<string, ReadonlySet<ToolKey>>();
  for (const [server, keys] of liveKeysByServer) {
    if (state.get(server) === 'enumerated') liveKeys.set(server, keys);
  }

  return { state, liveKeysByServer: liveKeys, discoverOk };
}

/**
 * Assemble a per-key `KeyOrigin` map from the registry reverse-lookups.
 *
 * For each key, its metadata-namespace supplier servers (`serversForKey`) are each
 * resolved to a PROVEN config-key via `configKeyForServer`:
 *  - a resolved config key is pushed into `servers` (the removed-vs-retained verdict
 *    is then decided downstream by `ServerInventory.state`, never here);
 *  - a supplier with NO proven mapping sets `uncorrelated = true` (unverifiable →
 *    keeps the key alive; never fabricate an identity fallback).
 *
 * A key with no supplier servers at all → `{ servers: [], uncorrelated: false }`
 * (no info; the core keeps it — over-advertise).
 */
export function assembleKeyOrigin(args: {
  keys: Iterable<ToolKey>;
  serversForKey: (k: ToolKey) => readonly string[];
  configKeyForServer: (metaName: string) => string | undefined;
}): Map<ToolKey, KeyOrigin> {
  const { keys, serversForKey, configKeyForServer } = args;
  const out = new Map<ToolKey, KeyOrigin>();
  for (const key of keys) {
    if (out.has(key)) continue;
    const metaServers = serversForKey(key);
    const servers: string[] = [];
    let uncorrelated = false;
    for (const meta of metaServers) {
      const cfg = configKeyForServer(meta);
      if (cfg !== undefined) {
        if (!servers.includes(cfg)) servers.push(cfg);
      } else {
        uncorrelated = true; // unverifiable supplier → retain (ANY-supplier-unmapped rule)
      }
    }
    out.set(key, { servers, uncorrelated });
  }
  return out;
}
