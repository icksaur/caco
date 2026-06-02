/**
 * File-edits HTTP routes. See docs/file-edits.md, docs/file-edits-v2.1.md.
 *
 * Thin wrapper around the GitEditPoller singleton (injected via init).
 */

import { Router, Request, Response } from 'express';
import { sessionManager } from '../session-manager.js';
import type { GitEditPoller } from '../git-edit-poller.js';
import {
  getCardList,
  setCardList,
  flushSession,
  SCHEMA_VERSION,
  type CardPersist,
} from '../file-edits-store.js';

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
 * Returns the current dirty set + persisted-clean entries as an array of
 * EditEntry. Used when the applet opens to populate the panel without
 * waiting for the next poll.
 */
router.get('/sessions/:sessionId/file-edits/snapshot', async (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  if (!ensureSession(sessionId, res)) return;
  if (!poller) { res.json({ edits: [] }); return; }
  try {
    const cwd = sessionManager.getSessionCwd(sessionId) ?? undefined;
    const persisted = getCardList(sessionId);
    const persistedPaths = persisted.cards.map((c) => c.relativePath);
    const edits = await poller.snapshot(sessionId, cwd, persistedPaths);
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

/**
 * GET /api/sessions/:sessionId/file-edits/cards
 * Returns the persisted card list (V2.1).
 */
router.get('/sessions/:sessionId/file-edits/cards', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  if (!ensureSession(sessionId, res)) return;
  res.json(getCardList(sessionId));
});

/**
 * PUT /api/sessions/:sessionId/file-edits/cards
 * Persists the card list. Body: { schemaVersion, cards, dismissed }.
 * Server sets updatedAt.
 */
function putCardsHandler(req: Request, res: Response): void {
  const sessionId = req.params.sessionId as string;
  if (!ensureSession(sessionId, res)) return;
  const body = req.body;
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'body must be an object' });
    return;
  }
  if (body.schemaVersion !== SCHEMA_VERSION) {
    res.status(400).json({ error: `unknown schemaVersion: ${body.schemaVersion}` });
    return;
  }
  if (!Array.isArray(body.cards) || !body.cards.every(isCardPersist)) {
    res.status(400).json({ error: 'cards must be Array<{ relativePath: string, collapsed: boolean }>' });
    return;
  }
  if (!Array.isArray(body.dismissed) || !body.dismissed.every((d: unknown) => typeof d === 'string')) {
    res.status(400).json({ error: 'dismissed must be string[]' });
    return;
  }
  setCardList(sessionId, { cards: body.cards as CardPersist[], dismissed: body.dismissed as string[] });
  res.json({ ok: true });
}

router.put('/sessions/:sessionId/file-edits/cards', putCardsHandler);
// V2.1: POST alias for navigator.sendBeacon, which only supports POST.
// The beforeunload best-effort flush path uses sendBeacon, so the
// route must be reachable via POST too.
router.post('/sessions/:sessionId/file-edits/cards', putCardsHandler);

function isCardPersist(v: unknown): v is CardPersist {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.relativePath === 'string' && typeof o.collapsed === 'boolean';
}

/** Called from server shutdown / session detach so we don't lose the
 *  last pending PUT. */
export function flushFileEditsCardList(sessionId: string): void {
  flushSession(sessionId);
}

export { router };
