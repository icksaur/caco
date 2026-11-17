/**
 * GET /api/overview (spec-session-overview, Layer 3). Read only.
 *
 * `scope=local` returns this instance's classified sessions. `scope=all` is the
 * hub fan-out (phase 4); until then it returns local data with
 * `coverage: 'partial'`. A request carrying `X-Caco-Overview-Hop: 1` (a peer
 * hop) may only ask for `local`.
 */

import { Router, Request, Response } from 'express';
import { collectOverviewInputs, realOverviewSources, type OverviewContextMode, type OverviewSources } from '../session-overview-io.js';
import { buildSessionOverview, overviewThresholdsFromEnv, type OverviewShow, type SessionOverview } from '../session-overview.js';

const router = Router();

export const OVERVIEW_HOP_HEADER = 'X-Caco-Overview-Hop';
const SCOPES = new Set(['local', 'all']);
const SHOWS = new Set<OverviewShow>(['all', 'attention', 'busy', 'wakes', 'waiting']);
const CONTEXTS = new Set<OverviewContextMode>(['brief', 'full', 'none']);

let sourcesFactory: () => OverviewSources = realOverviewSources;

/** Test seam. */
export function _setOverviewSourcesForTests(f: (() => OverviewSources) | null): void {
  sourcesFactory = f ?? realOverviewSources;
}

const one = (v: unknown): string | undefined => (typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined);

/** `brief` keeps the last user and assistant excerpts; `full` adds error and event type. */
function applyContextMode(ov: SessionOverview, mode: OverviewContextMode): void {
  if (mode !== 'brief') return;
  for (const e of ov.entries) {
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
    const ov = buildSessionOverview(inputs, Date.now(), { show, keys, thresholds: overviewThresholdsFromEnv(process.env) });
    applyContextMode(ov, context);
    res.json({
      ...ov,
      scope,
      coverage: scope === 'all' ? 'partial' : 'complete',
      ...(scope === 'all' && { note: 'Cross-instance fan-out is not available yet; this response has local data only.' }),
    });
  } catch (e) {
    console.error(`[OVERVIEW] collection failed: ${e instanceof Error ? e.name : typeof e}`);
    res.status(500).json({ error: 'overview collection failed' });
  }
});

export { router };
