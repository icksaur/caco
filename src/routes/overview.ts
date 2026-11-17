/**
 * GET /api/overview (spec-session-overview, Layer 3). Read only.
 *
 * `scope=local` returns this instance's classified sessions. `scope=all` is the
 * hub view: local plus every registered peer's `/api/overview?scope=local`
 * under the fetch policy (`overview-fanout.ts`), merged with
 * `duplicate-session` flags and one deterministic order. A request carrying
 * `X-Caco-Overview-Hop: 1` (a peer hop) may only ask for `local`.
 */

import { Router, Request, Response } from 'express';
import { collectOverviewInputs, realOverviewSources, type OverviewContextMode, type OverviewSources } from '../session-overview-io.js';
import { buildSessionOverview, mergeSessionOverviews, overviewThresholdsFromEnv, type OverviewShow, type OverviewEntry } from '../session-overview.js';
import { fetchPeerOverviews, OVERVIEW_HOP_HEADER, type FanoutOptions, type PeerFetchResult } from '../overview-fanout.js';
import { getPeers, parseAllowRemote, recordPeerIdentity } from '../peer-store.js';

const router = Router();

export { OVERVIEW_HOP_HEADER };
const SCOPES = new Set(['local', 'all']);
const SHOWS = new Set<OverviewShow>(['all', 'attention', 'busy', 'wakes', 'waiting']);
const CONTEXTS = new Set<OverviewContextMode>(['brief', 'full', 'none']);

let sourcesFactory: () => OverviewSources = realOverviewSources;
let fanoutOverrides: Partial<FanoutOptions> = {};

/** Test seams. */
export function _setOverviewSourcesForTests(f: (() => OverviewSources) | null): void {
  sourcesFactory = f ?? realOverviewSources;
}
export function _setFanoutOptionsForTests(o: Partial<FanoutOptions> | null): void {
  fanoutOverrides = o ?? {};
}

const one = (v: unknown): string | undefined => (typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined);

/** `brief` keeps the last user and assistant excerpts; `full` adds error and event type. */
function applyContextMode(entries: OverviewEntry[], mode: OverviewContextMode): void {
  if (mode !== 'brief') return;
  for (const e of entries) {
    delete e.context.lastError;
    delete e.context.lastEventType;
  }
}

router.get('/overview', async (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  const scope = one(req.query.scope) ?? 'local';
  const show = (one(req.query.show) ?? 'all') as OverviewShow;
  const context = (one(req.query.context) ?? 'brief') as OverviewContextMode;
  const keysRaw = one(req.query.keys);
  if (!SCOPES.has(scope)) { res.status(400).json({ error: 'scope must be local or all' }); return; }
  if (scope === 'all' && req.get(OVERVIEW_HOP_HEADER) === '1') {
    res.status(400).json({ error: 'scope=all is not allowed on a peer hop' });
    return;
  }
  if (!SHOWS.has(show)) { res.status(400).json({ error: 'show must be all, attention, busy, wakes or waiting' }); return; }
  if (!CONTEXTS.has(context)) { res.status(400).json({ error: 'context must be brief, full or none' }); return; }
  const keys = keysRaw ? keysRaw.split(',').map(k => k.trim()).filter(Boolean) : undefined;
  try {
    const inputs = await collectOverviewInputs(sourcesFactory(), { context });
    const thresholds = overviewThresholdsFromEnv(process.env);
    if (scope === 'local') {
      const ov = buildSessionOverview(inputs, Date.now(), { show, keys, thresholds });
      applyContextMode(ov.entries, context);
      res.json({ ...ov, scope, coverage: 'complete' });
      return;
    }
    // Hub: classify locally unfiltered, fetch peers, merge, then filter.
    const local = buildSessionOverview(inputs, Date.now(), { show: 'all', thresholds });
    const peers = getPeers();
    const results: PeerFetchResult[] = peers.length === 0 ? [] : await fetchPeerOverviews({
      peers, selfId: local.instance.id, allowRemote: parseAllowRemote(process.env.CACO_PEERS_ALLOW_REMOTE),
      context, onIdentity: recordPeerIdentity, ...fanoutOverrides,
    });
    const ok = results.filter(r => r.status === 'ok' && r.overview);
    const merged = mergeSessionOverviews([local, ...ok.map(r => r.overview!)], { show, keys });
    applyContextMode(merged.entries, context);
    const partial = ok.length === 0 || results.some(r => r.status !== 'ok' && r.status !== 'self');
    res.json({
      schemaVersion: local.schemaVersion,
      scope,
      coverage: partial ? 'partial' : 'complete',
      ...(peers.length === 0 && { note: 'No peers are registered here; all-machine views run on the portal host.' }),
      instance: local.instance,
      generatedAt: local.generatedAt,
      show,
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
    });
  } catch (e) {
    console.error(`[OVERVIEW] collection failed: ${e instanceof Error ? e.name : typeof e}`);
    res.status(500).json({ error: 'overview collection failed' });
  }
});

export { router };
