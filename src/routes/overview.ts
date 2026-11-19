/**
 * GET /api/overview (spec-session-overview, Layer 3). Read only.
 *
 * `scope=local` returns this instance's classified sessions. `scope=all` is the
 * hub view: local plus every registered peer's `/api/overview?scope=local`
 * under the fetch policy (`overview-fanout.ts`), merged with
 * `duplicateOn` on every shared session id, and one order. A request carrying
 * `X-Caco-Overview-Hop: 1` (a peer hop) may only ask for `local`.
 */

import { Router, Request, Response } from 'express';
import { realOverviewSources, type OverviewContextMode, type OverviewSources } from '../session-overview-io.js';
import { OVERVIEW_SHOWS, type OverviewShow } from '../session-overview.js';
import { OVERVIEW_HOP_HEADER, type FanoutOptions } from '../overview-fanout.js';
import { computeOverview } from '../overview-service.js';

const router = Router();

export { OVERVIEW_HOP_HEADER };
const SCOPES = new Set(['local', 'all']);
const SHOWS = new Set<OverviewShow>(OVERVIEW_SHOWS);
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
  if (!SHOWS.has(show)) { res.status(400).json({ error: 'show must be all, busy, wakes or waiting' }); return; }
  if (!CONTEXTS.has(context)) { res.status(400).json({ error: 'context must be brief, full or none' }); return; }
  const keys = keysRaw ? keysRaw.split(',').map(k => k.trim()).filter(Boolean) : undefined;
  try {
    res.json(await computeOverview({ scope: scope as 'local' | 'all', show, context, keys }, { sources: sourcesFactory, fanout: fanoutOverrides }));
  } catch (e) {
    console.error(`[OVERVIEW] collection failed: ${e instanceof Error ? e.name : typeof e}`);
    res.status(500).json({ error: 'overview collection failed' });
  }
});

export { router };
