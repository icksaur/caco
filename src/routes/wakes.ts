/**
 * Session self-wake routes (spec-session-wake): list every wake for the jobs
 * applet, and let a human stop one. Re-arming goes through the session's own
 * `caco_wake` tool, so there is no create/resume route.
 */

import { Router, Request, Response } from 'express';
import { wakeManager } from '../wake-runtime.js';
import { sessionManager } from '../session-manager.js';
import { summarizeWake } from '../wake-core.js';

const router = Router();

router.get('/wakes', (_req: Request, res: Response) => {
  const names = new Map(sessionManager.list().map(s => [s.sessionId, s.name || s.summary || s.autoName || null]));
  const wakes = wakeManager.list()
    .map(({ sessionId, wake }) => ({ sessionId, sessionName: names.get(sessionId) ?? null, ...summarizeWake(wake) }))
    .sort((a, b) => Date.parse(a.nextWakeAt) - Date.parse(b.nextWakeAt));
  res.json({ wakes });
});

router.delete('/wakes/:sessionId', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  if (!wakeManager.clear(sessionId)) {
    res.status(404).json({ error: 'No wake for this session' });
    return;
  }
  res.json({ ok: true });
});

export { router };
