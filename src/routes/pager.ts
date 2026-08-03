/**
 * Pager route (spec-pager).
 *
 *   GET /api/pager?since=<version>&wait=<ms>
 *     → { version, busyCount, busy, waiting, waitingTruncated }
 *
 * One endpoint for both the immediate read and the wait: `wait=0` (or absent)
 * answers now, `wait>0` holds until the board changes, the wait elapses, or the
 * client disconnects. Two endpoints returning the same payload would be two
 * things to keep in sync.
 *
 * The response is always a FULL snapshot, never a delta, which is what makes a
 * missed wake-up self-correcting. Query parsing is pure + exported so the clamp
 * contract is unit-testable without a live Express app.
 */

import { Router, Request, Response } from 'express';
import { activityVersion } from '../activity-version.js';
import { sessionManager } from '../session-manager.js';
import { updateSessionMeta } from '../storage.js';

const router = Router();

/** Parse the pager query. A bad/absent `since` ⇒ undefined (answer immediately);
 *  `wait` is coerced to a non-negative integer (the feed clamps the ceiling). */
export function parsePagerQuery(query: { since?: string; wait?: string }): {
  since?: number;
  wait: number;
} {
  const sinceNum = Number.parseInt(query.since ?? '', 10);
  const waitNum = Number.parseInt(query.wait ?? '', 10);
  return {
    since: Number.isFinite(sinceNum) ? sinceNum : undefined,
    wait: Number.isFinite(waitNum) && waitNum > 0 ? waitNum : 0,
  };
}

router.get('/pager', async (req: Request, res: Response) => {
  const { since, wait } = parsePagerQuery(req.query as { since?: string; wait?: string });

  // Release the parked waiter and its timer as soon as the client goes away,
  // rather than holding a socket (and delaying a graceful restart) until the cap.
  const controller = new AbortController();
  req.on('close', () => controller.abort());

  await activityVersion.read({ since, wait, signal: controller.signal });
  if (res.writableEnded) return;

  // Report the version as of the moment the snapshot is BUILT, not the one that
  // woke the waiter: a bump landing in between would otherwise be reported as
  // already-seen, and the client would not re-poll for it.
  res.json(sessionManager.pagerView(activityVersion.version));
});

/**
 * POST /api/sessions/:sessionId/pager-dismiss
 *
 * Take one offer off the pager board. Writes ONLY `pagerDismissedAt` — it does
 * NOT mark the session observed, because dismissing an offer on a phone must not
 * tell every other client the session has been read. The watermark is monotonic:
 * a strictly newer offer outranks it and the card returns.
 */
router.post('/sessions/:sessionId/pager-dismiss', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  if (!sessionManager.getSessionCwd(sessionId)) {
    res.status(404).json({ error: `Session not found: ${sessionId}` });
    return;
  }

  const dismissedAt = new Date().toISOString();
  const written = updateSessionMeta(sessionId, meta => { meta.pagerDismissedAt = dismissedAt; }, { createIfMissing: false });
  if (!written) {
    // Corrupt or absent meta: refuse rather than report a dismissal that was
    // never persisted, which would reappear on the next poll and look like a bug.
    res.status(409).json({ error: 'Could not persist the dismissal (session metadata unreadable)' });
    return;
  }

  activityVersion.bump();
  res.json({ success: true, dismissedAt });
});

export { router };
