/**
 * Surface store — two-party collaborative document per session.
 *
 * See docs/session-surface-applet.md for the protocol.
 *
 * Document shape:
 *   { dataToken, style, items, changes, customScript?, customStyle? }
 *
 * - Agent mutates via mutate() — atomic create/update/delete + clear changes.
 * - Human mutates via putChange() — writes one full item into the changes map.
 * - clearChanges() — agent acknowledges without writing.
 *
 * All mutating operations require the current dataToken; mismatches return 'stale'.
 */

import { createHash } from 'crypto';
import { getSessionData, setSessionData, deleteSessionData } from './storage.js';

export const MAX_ITEMS = 200;
export const SURFACE_DATA_NAME = 'surface';

export type SurfaceStyle = 'roadmap' | 'custom';

export interface SurfaceItem {
  id: string;
  type: string;
  [key: string]: unknown;
}

export interface SurfaceDoc {
  dataToken: string;
  style: SurfaceStyle;
  items: SurfaceItem[];
  changes: Record<string, SurfaceItem>;
  customScript: string | null;
  customStyle: string | null;
}

export interface MutateRequest {
  create?: SurfaceItem[];
  update?: SurfaceItem[];
  delete?: string[];
}

export type Reason = 'stale' | 'unknown-item' | 'limit' | 'invalid';

export interface OkResult {
  ok: true;
  dataToken: string;
}

export interface FailResult {
  ok: false;
  reason: Reason;
  currentDataToken?: string;
  errors?: string[];
}

export type MutateResult = OkResult | FailResult;

/** Canonical JSON: keys sorted recursively. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

/**
 * Compute a 12-character token from the document body (excluding the token itself).
 * Sufficient for single-session optimistic locking.
 */
export function computeToken(doc: Omit<SurfaceDoc, 'dataToken'>): string {
  return createHash('sha256').update(canonical(doc)).digest('hex').slice(0, 12);
}

const EMPTY_DOC_BODY = {
  style: 'roadmap' as const,
  items: [] as SurfaceItem[],
  changes: {} as Record<string, SurfaceItem>,
  customScript: null as string | null,
  customStyle: null as string | null,
};

/** The token of a brand-new (never-written) surface document.
 *  Returned by getSurface/getOrInitSurface when no doc exists, so the agent
 *  can always make a successful first call without an extra round-trip. */
export const INITIAL_DATA_TOKEN = computeToken(EMPTY_DOC_BODY);

function emptyDoc(): SurfaceDoc {
  return { dataToken: INITIAL_DATA_TOKEN, ...EMPTY_DOC_BODY };
}

/** Read the surface document for a session, or null if none stored. */
export function getSurface(sessionId: string): SurfaceDoc | null {
  const raw = getSessionData(sessionId, SURFACE_DATA_NAME);
  if (!raw) return null;
  return raw as unknown as SurfaceDoc;
}

/** Read or create — used by mutate which is allowed to materialize the doc on first write. */
export function getOrInitSurface(sessionId: string): SurfaceDoc {
  return getSurface(sessionId) ?? emptyDoc();
}

/** Delete the surface document entirely. */
export function deleteSurface(sessionId: string): boolean {
  return deleteSessionData(sessionId, SURFACE_DATA_NAME);
}

/** Patch style, customScript, and/or customStyle. */
export function patchStyle(
  sessionId: string,
  dataToken: string,
  patch: { style?: SurfaceStyle; customScript?: string | null; customStyle?: string | null }
): MutateResult {
  const doc = getOrInitSurface(sessionId);
  if (doc.dataToken !== dataToken) {
    return { ok: false, reason: 'stale', currentDataToken: doc.dataToken };
  }
  if (patch.style !== undefined) doc.style = patch.style;
  if (patch.customScript !== undefined) doc.customScript = patch.customScript;
  if (patch.customStyle !== undefined) doc.customStyle = patch.customStyle;
  const saved = persist(sessionId, doc);
  return { ok: true, dataToken: saved.dataToken };
}

/** Re-stamp the document with a fresh token and persist it. */
function persist(sessionId: string, doc: SurfaceDoc): SurfaceDoc {
  const { dataToken: _ignored, ...body } = doc;
  void _ignored;
  const token = computeToken(body);
  const next: SurfaceDoc = { ...body, dataToken: token } as SurfaceDoc;
  setSessionData(sessionId, SURFACE_DATA_NAME, next as unknown as Record<string, unknown>);
  return next;
}

function validateItem(item: unknown): string[] {
  const errors: string[] = [];
  if (!item || typeof item !== 'object') {
    errors.push('item must be an object');
    return errors;
  }
  const obj = item as Record<string, unknown>;
  if (typeof obj.id !== 'string' || !obj.id) errors.push('item.id must be a non-empty string');
  if (typeof obj.type !== 'string' || !obj.type) errors.push('item.type must be a non-empty string');
  return errors;
}

/**
 * Agent-side mutate: applies create/update/delete and clears `changes` atomically.
 * Returns the new doc on success, or a structured failure.
 */
export function mutate(sessionId: string, dataToken: string, req: MutateRequest): MutateResult {
  const doc = getOrInitSurface(sessionId);
  if (doc.dataToken !== dataToken) {
    return { ok: false, reason: 'stale', currentDataToken: doc.dataToken };
  }

  const create = req.create ?? [];
  const update = req.update ?? [];
  const del = req.delete ?? [];

  const errors: string[] = [];
  for (const it of create) errors.push(...validateItem(it).map(e => `create: ${e}`));
  for (const it of update) {
    if (!it || typeof it !== 'object' || typeof (it as Record<string, unknown>).id !== 'string') {
      errors.push('update: item.id must be a string');
    }
  }
  if (errors.length > 0) {
    return { ok: false, reason: 'invalid', currentDataToken: doc.dataToken, errors };
  }

  const byId = new Map(doc.items.map(it => [it.id, it]));

  for (const id of del) byId.delete(id);

  for (const it of update) {
    const existing = byId.get(it.id);
    if (!existing) continue;
    byId.set(it.id, { ...existing, ...it });
  }

  for (const it of create) {
    byId.set(it.id, it);
  }

  if (byId.size > MAX_ITEMS) {
    return { ok: false, reason: 'limit', currentDataToken: doc.dataToken };
  }

  const newItems = Array.from(byId.values());

  const next: SurfaceDoc = {
    ...doc,
    items: newItems,
    changes: {},
  };
  const saved = persist(sessionId, next);
  return { ok: true, dataToken: saved.dataToken };
}

/** Human-side: write one full post-edit item into `changes`. */
export function putChange(sessionId: string, dataToken: string, itemId: string, item: SurfaceItem): MutateResult {
  const doc = getSurface(sessionId);
  if (!doc) return { ok: false, reason: 'unknown-item' };
  if (doc.dataToken !== dataToken) {
    return { ok: false, reason: 'stale', currentDataToken: doc.dataToken };
  }
  const errors = validateItem(item);
  if (errors.length > 0 || item.id !== itemId) {
    return {
      ok: false,
      reason: 'invalid',
      currentDataToken: doc.dataToken,
      errors: item.id !== itemId ? ['item.id must match :itemId in path'] : errors,
    };
  }
  if (!doc.items.find(it => it.id === itemId)) {
    return { ok: false, reason: 'unknown-item', currentDataToken: doc.dataToken };
  }
  const next: SurfaceDoc = { ...doc, changes: { ...doc.changes, [itemId]: item } };
  const saved = persist(sessionId, next);
  return { ok: true, dataToken: saved.dataToken };
}

/** Agent acknowledges `changes` without otherwise writing. */
export function clearChanges(sessionId: string, dataToken: string): MutateResult {
  const doc = getSurface(sessionId);
  if (!doc) return { ok: false, reason: 'unknown-item' };
  if (doc.dataToken !== dataToken) {
    return { ok: false, reason: 'stale', currentDataToken: doc.dataToken };
  }
  if (Object.keys(doc.changes).length === 0) {
    return { ok: true, dataToken: doc.dataToken };
  }
  const next: SurfaceDoc = { ...doc, changes: {} };
  const saved = persist(sessionId, next);
  return { ok: true, dataToken: saved.dataToken };
}
