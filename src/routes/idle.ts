/**
 * Idle notifications route (spec-idle-notifications).
 *
 *   GET /api/idle?after=<seq>&session=<id?>&wait=<ms>
 *     → { cursor, events, reset }
 *
 * A long-poll feed of "a session reached a real idle" events for out-of-process
 * automation (bash/python/powershell). The client passes back the `cursor` it
 * last saw as `after`; an idle that landed between polls is returned immediately,
 * and the bounded ring signals `reset` rather than silently dropping. Query
 * parsing is pure + exported so the clamp/validation contract is unit-testable
 * without a live Express app.
 */

import { Router, Request, Response } from 'express';
import { idleFeed } from '../idle-feed.js';

const router = Router();

/** Parse the idle-feed query. Bad/absent `after` ⇒ undefined (start at head);
 *  `wait` is coerced to a non-negative integer (the feed caps it). */
export function parseIdleQuery(query: { after?: string; session?: string; wait?: string }): {
  after?: number;
  session?: string;
  wait: number;
} {
  const afterNum = Number.parseInt(query.after ?? '', 10);
  const waitNum = Number.parseInt(query.wait ?? '', 10);
  return {
    after: Number.isFinite(afterNum) ? afterNum : undefined,
    session: query.session,
    wait: Number.isFinite(waitNum) && waitNum > 0 ? waitNum : 0,
  };
}

router.get('/idle', async (req: Request, res: Response) => {
  const { after, session, wait } = parseIdleQuery(req.query as { after?: string; session?: string; wait?: string });

  // Cancel the long-poll if the client disconnects, so the parked waiter + timer
  // are released immediately instead of lingering until the wait cap.
  const controller = new AbortController();
  req.on('close', () => controller.abort());

  const result = await idleFeed.read({ after, session, wait, signal: controller.signal });
  if (!res.writableEnded) res.json(result);
});

export { router };
