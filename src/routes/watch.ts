/**
 * File-watch lease HTTP routes.
 *
 * See docs/file-watch-leases.md. Thin wrappers over the watch-store module
 * plus a single broadcaster injection at startup.
 */

import { Router, Request, Response } from 'express';
import { sessionManager } from '../session-manager.js';
import { createWatchStore, type WatchScope, type ChangeEvent } from '../watch-store.js';
import { broadcastEvent, type SessionEvent } from './websocket.js';
import { sessionState } from '../session-state.js';

const router = Router();

const watchStore = createWatchStore({
  broadcast: (ev: ChangeEvent) => {
    broadcastEvent(ev.sessionId, {
      type: 'caco.fs.changed',
      data: {
        leaseId: ev.leaseId,
        path: ev.path,
        eventType: ev.eventType,
        ...(ev.filename ? { filename: ev.filename } : {}),
      },
    } as SessionEvent);
  },
});

// Release all of a session's leases when the session is deleted. The hook is
// registered via initWatchRoutes() after createSessionState() resolves —
// sessionState is a `let` exported from session-state.ts and is undefined
// at module load time. Calling it here would crash on server start.
let listenerRegistered = false;
export function initWatchRoutes(): void {
  if (listenerRegistered) return;
  listenerRegistered = true;
  sessionState.onSessionEnd((sessionId) => {
    watchStore.releaseSession(sessionId);
  });
}

function ensureSession(sessionId: string, res: Response): boolean {
  if (!sessionManager.getSessionCwd(sessionId)) {
    res.status(404).json({ error: `Session not found: ${sessionId}` });
    return false;
  }
  return true;
}

router.post('/sessions/:sessionId/watch', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  if (!ensureSession(sessionId, res)) return;
  const body = req.body as { path?: unknown; scope?: unknown };
  if (typeof body.path !== 'string' || !body.path) {
    res.status(400).json({ error: 'path (non-empty string) is required' });
    return;
  }
  const scope = body.scope === 'file' || body.scope === 'dir' ? (body.scope as WatchScope) : undefined;
  const result = watchStore.acquireLease(sessionId, body.path, scope);
  res.json(result);
});

router.post('/sessions/:sessionId/watch/:leaseId/renew', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  const leaseId = req.params.leaseId as string;
  if (!ensureSession(sessionId, res)) return;
  const result = watchStore.renewLease(leaseId);
  res.json(result);
});

router.delete('/sessions/:sessionId/watch/:leaseId', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  const leaseId = req.params.leaseId as string;
  if (!ensureSession(sessionId, res)) return;
  watchStore.releaseLease(leaseId);
  res.json({ ok: true });
});

router.get('/sessions/:sessionId/watch', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  if (!ensureSession(sessionId, res)) return;
  res.json({ leases: watchStore.listLeases(sessionId) });
});

export { router };
