/**
 * The overview computation shared by `GET /api/overview` and the
 * `caco_sessions_overview` tool (spec-session-overview). Read only: local
 * collection plus, for `scope=all`, the peer fan-out and hub merge. The tool
 * calls this in process; it never makes an HTTP request to its own instance.
 */

import { collectOverviewInputs, realOverviewSources, type OverviewContextMode, type OverviewSources } from './session-overview-io.js';
import {
  buildSessionOverview, mergeSessionOverviews,
  type OverviewShow, type OverviewEntry, type SessionOverview,
} from './session-overview.js';
import { fetchPeerOverviews, type FanoutOptions, type PeerFetchResult, type PeerStatus } from './overview-fanout.js';
import { getPeers, parseAllowRemote } from './peer-store.js';

export interface OverviewQuery {
  scope: 'local' | 'all';
  show: OverviewShow;
  context: OverviewContextMode;
  keys?: string[];
}

export interface OverviewInstanceStatus {
  instance: { id?: string; name: string; origin?: string; self?: true };
  status: PeerStatus;
  fetchedAt: string;
  reason?: string;
  counts?: SessionOverview['counts'];
  wakeLoopEnabled?: boolean;
}

export interface OverviewResult {
  schemaVersion: number;
  scope: 'local' | 'all';
  coverage: 'complete' | 'partial';
  note?: string;
  instance: { id: string; name: string };
  generatedAt: string;
  show: OverviewShow;
  wakeLoopEnabled: boolean;
  /** `scope=all` only: one per instance, this one first. */
  instances?: OverviewInstanceStatus[];
  counts: SessionOverview['counts'];
  entries: OverviewEntry[];
}

export interface OverviewServiceDeps {
  sources?: () => OverviewSources;
  fanout?: Partial<FanoutOptions>;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

/** `brief` keeps the last user and assistant excerpts; `full` adds error and event type. */
function applyContextMode(entries: OverviewEntry[], mode: OverviewContextMode): void {
  if (mode !== 'brief') return;
  for (const e of entries) {
    delete e.context.lastError;
    delete e.context.lastEventType;
  }
}

export async function computeOverview(q: OverviewQuery, deps: OverviewServiceDeps = {}): Promise<OverviewResult> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const inputs = await collectOverviewInputs((deps.sources ?? realOverviewSources)(), { context: q.context });
  if (q.scope === 'local') {
    const ov = buildSessionOverview(inputs, now(), { show: q.show, keys: q.keys });
    applyContextMode(ov.entries, q.context);
    return { ...ov, scope: 'local', coverage: 'complete' };
  }
  // Hub: classify locally unfiltered, fetch peers, merge, then filter.
  const local = buildSessionOverview(inputs, now(), { show: 'all' });
  const peers = getPeers(env);
  const results: PeerFetchResult[] = peers.length === 0 ? [] : await fetchPeerOverviews({
    peers, selfId: local.instance.id, allowRemote: parseAllowRemote(env.CACO_PEERS_ALLOW_REMOTE),
    context: q.context, ...deps.fanout,
  });
  // A peer's data passed validation, but merging must still never fail the
  // call (Invariant 7): add peers one at a time and drop any whose data makes
  // the merge throw, reporting it invalid.
  const accepted = [local];
  for (const r of results.filter(x => x.status === 'ok' && x.overview)) {
    try {
      mergeSessionOverviews([...accepted, r.overview!]);
      accepted.push(r.overview!);
    } catch {
      r.status = 'invalid';
      r.reason = 'merge failed';
      delete r.overview;
    }
  }
  const merged = mergeSessionOverviews(accepted, { show: q.show, keys: q.keys });
  applyContextMode(merged.entries, q.context);
  const partial = accepted.length === 1 || results.some(r => r.status !== 'ok' && r.status !== 'self');
  const out: OverviewResult = {
    schemaVersion: local.schemaVersion,
    scope: 'all',
    coverage: partial ? 'partial' : 'complete',
    instance: local.instance,
    generatedAt: local.generatedAt,
    show: q.show,
    wakeLoopEnabled: local.wakeLoopEnabled,
    instances: [
      { instance: { ...local.instance, self: true }, status: 'ok', fetchedAt: local.generatedAt, counts: local.counts },
      ...results.map(r => ({
        instance: r.instance, status: r.status, fetchedAt: r.fetchedAt,
        ...(r.reason && { reason: r.reason }),
        ...(r.overview && { counts: r.overview.counts, wakeLoopEnabled: r.overview.wakeLoopEnabled }),
      })),
    ],
    counts: merged.counts,
    entries: merged.entries,
  };
  if (peers.length === 0) out.note = 'No peers are registered here; all-machine views run on the portal host.';
  return out;
}
