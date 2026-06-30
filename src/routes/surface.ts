/**
 * Surface routes — two-party collaborative document.
 *
 * See docs/research/session-surface-applet.md.
 *
 *   GET    /api/sessions/:sessionId/surface
 *   GET    /api/sessions/:sessionId/surface/changes
 *   POST   /api/sessions/:sessionId/surface/mutate
 *   POST   /api/sessions/:sessionId/surface/clear-changes
 *   PUT    /api/sessions/:sessionId/surface/changes/:itemId
 *
 * All routes require an existing Caco session.
 * Mutating routes return { ok: true, dataToken } or
 * { ok: false, reason, currentDataToken?, errors? } with HTTP 200 — protocol-level
 * failures are not HTTP errors so retry logic stays simple.
 */

import { Router, Request, Response } from 'express';
import { sessionManager } from '../session-manager.js';
import { broadcastEvent } from './websocket.js';
import {
  getSurface,
  mutate,
  clearChanges,
  putChange,
  patchStyle,
  notifySurfaceUpdate,
  type MutateRequest,
  type SurfaceItem,
  type MutateResult,
  type SurfaceStyle,
} from '../surface-store.js';

const router = Router();

function ensureSession(sessionId: string, res: Response): boolean {
  if (!sessionManager.getSessionCwd(sessionId)) {
    res.status(404).json({ error: `Session not found: ${sessionId}` });
    return false;
  }
  return true;
}

function maybeNotify(sessionId: string, origin: 'agent' | 'user', result: MutateResult): void {
  notifySurfaceUpdate(sessionId, origin, result, broadcastEvent);
}

router.get('/sessions/:sessionId/surface', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  if (!ensureSession(sessionId, res)) return;
  const doc = getSurface(sessionId);
  if (!doc) {
    res.status(404).json({ error: 'No surface document for this session.' });
    return;
  }
  res.json(doc);
});

router.get('/sessions/:sessionId/surface/changes', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  if (!ensureSession(sessionId, res)) return;
  const doc = getSurface(sessionId);
  if (!doc) {
    res.status(404).json({ error: 'No surface document for this session.' });
    return;
  }
  res.json({ dataToken: doc.dataToken, changes: doc.changes });
});

router.post('/sessions/:sessionId/surface/mutate', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  if (!ensureSession(sessionId, res)) return;
  const body = req.body as { dataToken?: unknown } & MutateRequest;
  if (typeof body.dataToken !== 'string') {
    res.status(400).json({ error: 'dataToken (string) is required' });
    return;
  }
  const result = mutate(sessionId, body.dataToken, {
    create: body.create,
    update: body.update,
    delete: body.delete,
  });
  maybeNotify(sessionId, 'agent', result);
  res.json(result);
});

router.post('/sessions/:sessionId/surface/clear-changes', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  if (!ensureSession(sessionId, res)) return;
  const body = req.body as { dataToken?: unknown };
  if (typeof body.dataToken !== 'string') {
    res.status(400).json({ error: 'dataToken (string) is required' });
    return;
  }
  const result = clearChanges(sessionId, body.dataToken);
  maybeNotify(sessionId, 'agent', result);
  res.json(result);
});

router.put('/sessions/:sessionId/surface/changes/:itemId', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  const itemId = req.params.itemId as string;
  if (!ensureSession(sessionId, res)) return;
  const body = req.body as { dataToken?: unknown; item?: SurfaceItem };
  if (typeof body.dataToken !== 'string') {
    res.status(400).json({ error: 'dataToken (string) is required' });
    return;
  }
  if (!body.item) {
    res.status(400).json({ error: 'item is required' });
    return;
  }
  const result = putChange(sessionId, body.dataToken, itemId, body.item);
  maybeNotify(sessionId, 'user', result);
  res.json(result);
});

// PATCH /surface/style — set style, customScript, customStyle
router.patch('/sessions/:sessionId/surface/style', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  if (!ensureSession(sessionId, res)) return;
  const body = req.body as { dataToken?: string; style?: string; customScript?: string | null; customStyle?: string | null };
  if (typeof body.dataToken !== 'string') {
    res.status(400).json({ error: 'dataToken (string) is required' });
    return;
  }
  const result = patchStyle(sessionId, body.dataToken, {
    style: body.style as SurfaceStyle | undefined,
    customScript: body.customScript,
    customStyle: body.customStyle,
  });
  maybeNotify(sessionId, 'agent', result);
  res.json(result);
});

export { router };
