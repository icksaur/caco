/**
 * File Edits Card-List Store
 *
 * Per-session persisted card list for the file-edits applet.
 * See docs/file-edits-v2.1.md §3.
 *
 * Schema on disk (~/.caco/sessions/<sessionId>/file-edits-cards.json):
 *
 *   {
 *     "schemaVersion": 1,
 *     "updatedAt": ISO-8601,
 *     "cards": [{ relativePath, collapsed }],
 *     "dismissed": [path, ...]
 *   }
 *
 * Writes are debounced per-session-ID with a 500ms timer; flushAll() is
 * called from session detach and process shutdown so we don't lose the
 * last gesture (e.g. an X-dismiss that fires moments before SIGINT).
 */

import { getSessionData, setSessionData } from './session-data-store.js';

const STORE_NAME = 'file-edits-cards';
const DEBOUNCE_MS = 500;

export const SCHEMA_VERSION = 1;

export interface CardPersist {
  relativePath: string;
  collapsed: boolean;
}

export interface CardList {
  schemaVersion: number;
  updatedAt: string | null;
  cards: CardPersist[];
  dismissed: string[];
}

/** Per-session pending write timer + body. Allows flush-before-fire. */
interface PendingWrite {
  timer: NodeJS.Timeout;
  body: CardList;
}
const pending = new Map<string, PendingWrite>();

/** Get the persisted card list for a session. Returns the empty list
 *  shape if the file is missing or unparseable. */
export function getCardList(sessionId: string): CardList {
  const raw = getSessionData(sessionId, STORE_NAME);
  if (raw && typeof raw === 'object') {
    const cards = Array.isArray(raw.cards) ? (raw.cards as unknown[]).filter(isCardPersist) : [];
    const dismissed = Array.isArray(raw.dismissed)
      ? (raw.dismissed as unknown[]).filter((d): d is string => typeof d === 'string')
      : [];
    return {
      schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : SCHEMA_VERSION,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
      cards,
      dismissed,
    };
  }
  return { schemaVersion: SCHEMA_VERSION, updatedAt: null, cards: [], dismissed: [] };
}

function isCardPersist(v: unknown): v is CardPersist {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.relativePath === 'string' && typeof o.collapsed === 'boolean';
}

/** Schedule a debounced write for `sessionId`. The body is updated each
 *  call (the latest body wins). Returns immediately; the actual disk
 *  write happens after DEBOUNCE_MS or via flush(). */
export function setCardList(sessionId: string, body: { cards: CardPersist[]; dismissed: string[] }): void {
  const merged: CardList = {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    cards: body.cards,
    dismissed: body.dismissed,
  };
  const existing = pending.get(sessionId);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    pending.delete(sessionId);
    try {
      setSessionData(sessionId, STORE_NAME, merged as unknown as Record<string, unknown>);
    } catch (err) {
      console.warn(`[FILE-EDITS-STORE] write failed for ${sessionId.slice(0, 8)}:`, (err as Error).message);
    }
  }, DEBOUNCE_MS);
  pending.set(sessionId, { timer, body: merged });
}

/** Fire any pending write for `sessionId` immediately and clear the timer.
 *  Call from session detach and the route's flush path. */
export function flushSession(sessionId: string): void {
  const p = pending.get(sessionId);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(sessionId);
  try {
    setSessionData(sessionId, STORE_NAME, p.body as unknown as Record<string, unknown>);
  } catch (err) {
    console.warn(`[FILE-EDITS-STORE] flush write failed for ${sessionId.slice(0, 8)}:`, (err as Error).message);
  }
}

/** Fire all pending writes synchronously. Call from SIGINT shutdown. */
export function flushAll(): void {
  for (const sid of Array.from(pending.keys())) flushSession(sid);
}

/** Test-only: reset pending state. */
export function _resetForTest(): void {
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
}
