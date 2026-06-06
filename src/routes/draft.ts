/**
 * Pre-session draft routes.
 *
 * Global new-chat draft buffer — not tied to any session. See
 * docs/chat-draft-persistence.md §API.
 *
 *   GET    /api/draft/newchat    → 200 text/plain | 404
 *   PUT    /api/draft/newchat    ← text/plain     → 204 | 413
 *   DELETE /api/draft/newchat    → 204
 */

import { Router, Request, Response } from 'express';
import express from 'express';
import { getNewChatDraft, setNewChatDraft, deleteNewChatDraft } from '../chat-draft-store.js';

const router = Router();

const DRAFT_TEXT_PARSER = express.text({ type: 'text/plain', limit: '1mb' });

router.get('/draft/newchat', (_req: Request, res: Response) => {
  const text = getNewChatDraft();
  if (text === null) { res.status(404).end(); return; }
  res.type('text/plain; charset=utf-8').send(text);
});

router.put('/draft/newchat', DRAFT_TEXT_PARSER, (req: Request, res: Response) => {
  const text = typeof req.body === 'string' ? req.body : '';
  setNewChatDraft(text);
  res.status(204).end();
});

router.delete('/draft/newchat', (_req: Request, res: Response) => {
  deleteNewChatDraft();
  res.status(204).end();
});

export { router };
