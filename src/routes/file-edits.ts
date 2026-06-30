/**
 * File-edits HTTP routes. See docs/spec-files-applet-edits.md, docs/spec-files-applet-edits.md.
 *
 * Thin wrapper around the GitEditPoller singleton (injected via init).
 */

import { Router, Request, Response } from 'express';
import { resolve, join, sep } from 'path';
import { stat } from 'fs/promises';
import { sessionManager } from '../session-manager.js';
import type { GitEditPoller } from '../git-edit-poller.js';
import {
  getCardList,
  setCardList,
  flushSession,
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
    // snapshot() lazy-attaches; isAttached reflects whether the cwd
    // resolved to a git repo. The client uses isGit to decide whether
    // in-cwd opens go through the diff path or a read-only viewer.
    res.json({ edits, isGit: poller.isAttached(sessionId) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * POST /api/sessions/:sessionId/file-edits/open
 * V3.1: materialize an EditEntry for any repo path picked by the user.
 * Body: { relativePath: string }. Returns { edit: EditEntry } or
 * 400 / 404 per validation outcome.
 */
router.post('/sessions/:sessionId/file-edits/open', async (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  if (!ensureSession(sessionId, res)) return;
  if (!poller) { res.status(404).json({ error: 'poller not initialized' }); return; }
  const body = req.body;
  if (!body || typeof body !== 'object' || typeof body.relativePath !== 'string' || body.relativePath.length === 0) {
    res.status(400).json({ error: 'relativePath must be a non-empty string' });
    return;
  }
  const relPath = body.relativePath as string;
  if (relPath.includes('\0')) {
    res.status(400).json({ error: 'relativePath contains NUL' });
    return;
  }
  if (relPath.startsWith('/') || /^[a-zA-Z]:/.test(relPath) || relPath.startsWith('\\\\')) {
    res.status(400).json({ error: 'relativePath must not be absolute' });
    return;
  }
  if (relPath.split(/[/\\]/).some((seg) => seg === '..')) {
    res.status(400).json({ error: 'relativePath must not contain ".." segments' });
    return;
  }
  // V6: optional diffMode + ref.
  // V6.1: only unstaged + staged. range mode dropped (no natural
  // entry point existed; the URL-typing case wasn't worth its
  // complexity tax). git-status's per-file diff link uses
  // diffMode=staged when staged, omits otherwise (= unstaged).
  const diffMode = body.diffMode;
  if (diffMode !== undefined && diffMode !== 'unstaged' && diffMode !== 'staged') {
    res.status(400).json({ error: 'diffMode must be one of: unstaged, staged' });
    return;
  }
  const cwd = sessionManager.getSessionCwd(sessionId);
  if (!cwd) { res.status(404).json({ error: 'session has no cwd' }); return; }
  // Best-effort post-join containment check. The poller resolves
  // repoRoot internally (via findRepoRoot at attach time); for the
  // route's defense-in-depth we re-check against cwd, which is a
  // tighter bound than repoRoot for subdirectory sessions. Normalize
  // cwd via resolve() so a trailing-slash cwd doesn't break the
  // startsWith check (cwd + sep would become path//).
  const normalizedCwd = resolve(cwd);
  const abs = resolve(join(normalizedCwd, relPath));
  if (!abs.startsWith(normalizedCwd + sep) && abs !== normalizedCwd) {
    res.status(400).json({ error: 'relativePath escapes session cwd' });
    return;
  }
  // Reject directories. Allow missing-on-disk files (the poller treats
  // those as deleted-from-working-tree but still in HEAD — a valid
  // case for buildCleanEntry to handle via git show.)
  try {
    const st = await stat(abs);
    if (!st.isFile()) {
      res.status(400).json({ error: 'relativePath is not a file' });
      return;
    }
  } catch { /* missing — let poller decide */ }
  try {
    const edit = await poller.openFile(sessionId, relPath, { diffMode });
    if (!edit) {
      res.status(404).json({ error: 'path not found in HEAD or working tree' });
      return;
    }
    res.json({ edit });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
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
  // V2.c: accept v1 (legacy) AND v2 (current). Version-tolerant
  // server keeps the rollout window safe. See docs/spec-files-applet-edits.md
  if (body.schemaVersion !== 1 && body.schemaVersion !== 2) {
    res.status(400).json({ error: `unknown schemaVersion: ${body.schemaVersion}` });
    return;
  }
  if (!Array.isArray(body.cards) || !body.cards.every(isCardPersist)) {
    res.status(400).json({ error: 'cards must be Array<{ relativePath: string, collapsed?: boolean, defaultViewerType?: string, activeViewerType?: string }>' });
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
  if (typeof o.relativePath !== 'string') return false;
  if (o.collapsed !== undefined && typeof o.collapsed !== 'boolean') return false;
  if (o.defaultViewerType !== undefined && typeof o.defaultViewerType !== 'string') return false;
  if (o.activeViewerType !== undefined && typeof o.activeViewerType !== 'string') return false;
  return true;
}

/** Called from server shutdown / session detach so we don't lose the
 *  last pending PUT. */
export function flushFileEditsCardList(sessionId: string): void {
  flushSession(sessionId);
}

export { router };
