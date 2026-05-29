/**
 * File-edits HTTP routes. See docs/file-edits.md.
 *
 * Thin wrapper around the GitEditPoller singleton (injected via init).
 */

import { Router, Request, Response } from 'express';
import { sessionManager } from '../session-manager.js';
import type { GitEditPoller } from '../git-edit-poller.js';

const router = Router();

let poller: GitEditPoller | null = null;

export function initFileEditsRoutes(p: GitEditPoller): void {
  poller = p;
}

function ensureSession(sessionId: string, res: Response): boolean {
  if (!sessionManager.getSessionCwd(sessionId)) {
    res.status(404).json({ error: `Session not found: ${sessionId}` });
    return false;
  }
  return true;
}

/**
 * GET /api/sessions/:sessionId/file-edits/snapshot
 * Returns the current dirty set as an array of EditEntry. Used when the
 * applet opens to populate the panel without waiting for the next poll.
 */
router.get('/sessions/:sessionId/file-edits/snapshot', async (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  if (!ensureSession(sessionId, res)) return;
  if (!poller) { res.json({ edits: [] }); return; }
  try {
    const cwd = sessionManager.getSessionCwd(sessionId) ?? undefined;
    const edits = await poller.snapshot(sessionId, cwd);
    res.json({ edits });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * POST /api/sessions/:sessionId/file-edits/refresh
 * Manual poll trigger from the applet's Refresh button.
 */
router.post('/sessions/:sessionId/file-edits/refresh', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  if (!ensureSession(sessionId, res)) return;
  poller?.triggerPoll(sessionId, 'manual-refresh');
  res.json({ ok: true });
});

export { router };
