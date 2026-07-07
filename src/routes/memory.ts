/**
 * Memory routes — the HTTP surface for the Memories applet (view + delete).
 *
 *   GET    /api/memory        → { entries, count, capacity }
 *   DELETE /api/memory/:key   → { ok, deleted?|notFound?, entries, count, capacity } | 400
 *
 * Thin adapter over the shared store in memory-tool.ts (readMemory/writeMemory/
 * SLUG_RE/MAX_ENTRIES). No store logic is re-implemented here — the tool and the
 * routes MUST stay one implementation (spec-memory §Risks/INVARIANT).
 */

import { Router, Request, Response } from 'express';
import { readMemory, writeMemory, SLUG_RE, MAX_ENTRIES } from '../memory-tool.js';

interface MemoryPayload {
  entries: Record<string, string>;
  count: number;
  capacity: number;
}

/** The GET /memory body: the full store plus count + capacity. */
export function getMemoryPayload(): MemoryPayload {
  const entries = readMemory();
  return { entries, count: Object.keys(entries).length, capacity: MAX_ENTRIES };
}

interface DeleteResult {
  status: number;
  body: Record<string, unknown>;
}

/** DELETE /memory/:key backing logic. Validates the slug BEFORE any store access
 *  (an invalid key is rejected 400 and never reaches writeMemory), then deletes if
 *  present. A missing key is a successful no-op. Always returns the fresh post-delete
 *  entries so the applet can re-render directly from the response. */
export function deleteMemoryKey(key: string): DeleteResult {
  if (!key || !SLUG_RE.test(key)) {
    return { status: 400, body: { error: 'Invalid key: must be a slug (lowercase letters, numbers, hyphens).' } };
  }
  const store = readMemory();
  const present = key in store;
  if (present) {
    delete store[key];
    writeMemory(store);
  }
  const meta = { entries: store, count: Object.keys(store).length, capacity: MAX_ENTRIES };
  return { status: 200, body: present ? { ok: true, deleted: key, ...meta } : { ok: true, notFound: key, ...meta } };
}

const router = Router();

router.get('/memory', (_req: Request, res: Response) => {
  res.json(getMemoryPayload());
});

router.delete('/memory/:key', (req: Request, res: Response) => {
  const result = deleteMemoryKey(req.params.key as string);
  res.status(result.status).json(result.body);
});

export { router };
