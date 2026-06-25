/**
 * Tests for src/surface-store.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  computeToken,
  getSurface,
  mutate,
  putChange,
  clearChanges,
  deleteSurface,
  MAX_ITEMS,
  type SurfaceDoc,
} from '../../src/surface-store.js';

function freshSessionId(): string {
  return 'test-surface-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

function sessionDir(id: string): string {
  return join(homedir(), '.caco', 'sessions', id);
}

function cleanup(id: string) {
  const d = sessionDir(id);
  if (existsSync(d)) rmSync(d, { recursive: true, force: true });
}

function seed(sessionId: string, items: { id: string; type: string; [k: string]: unknown }[] = []): string {
  // Use mutate from a fresh doc — token starts as the empty-doc token.
  const initial = getSurface(sessionId);
  const startToken = initial ? initial.dataToken : computeToken({
    style: 'roadmap',
    items: [],
    changes: {},
    customScript: null,
    customStyle: null,
  });
  const result = mutate(sessionId, startToken, { create: items });
  if (!result.ok) throw new Error('seed failed: ' + JSON.stringify(result));
  return result.dataToken;
}

describe('surface-store', () => {
  let sessionId: string;

  beforeEach(() => { sessionId = freshSessionId(); });
  afterEach(() => { cleanup(sessionId); });

  describe('computeToken', () => {
    it('is deterministic for identical bodies', () => {
      const body = { style: 'roadmap' as const, items: [], changes: {}, customScript: null, customStyle: null };
      expect(computeToken(body)).toBe(computeToken(body));
    });

    it('changes when items change', () => {
      const a = computeToken({ style: 'roadmap', items: [], changes: {}, customScript: null, customStyle: null });
      const b = computeToken({ style: 'roadmap', items: [{ id: 'x', type: 'task' }], changes: {}, customScript: null, customStyle: null });
      expect(a).not.toBe(b);
    });

    it('is stable under key order', () => {
      const a = computeToken({ style: 'roadmap', items: [{ id: 'x', type: 'task', a: 1, b: 2 }], changes: {}, customScript: null, customStyle: null });
      const b = computeToken({ style: 'roadmap', items: [{ id: 'x', type: 'task', b: 2, a: 1 } as { id: string; type: string }], changes: {}, customScript: null, customStyle: null });
      expect(a).toBe(b);
    });
  });

  describe('mutate', () => {
    it('creates an empty surface if none exists and applies create', () => {
      const startToken = computeToken({ style: 'roadmap', items: [], changes: {}, customScript: null, customStyle: null });
      const result = mutate(sessionId, startToken, { create: [{ id: 't1', type: 'task', label: 'foo' }] });
      expect(result.ok).toBe(true);
      const doc = getSurface(sessionId);
      expect(doc?.items.length).toBe(1);
      expect(doc?.items[0].id).toBe('t1');
    });

    it('rotates token on success', () => {
      const t1 = seed(sessionId, [{ id: 't1', type: 'task' }]);
      const t2Result = mutate(sessionId, t1, { create: [{ id: 't2', type: 'task' }] });
      if (!t2Result.ok) throw new Error('expected ok');
      expect(t2Result.dataToken).not.toBe(t1);
    });

    it('shallow-merges update by id', () => {
      seed(sessionId, [{ id: 't1', type: 'task', label: 'old', status: 'pending' }]);
      const doc = getSurface(sessionId)!;
      const result = mutate(sessionId, doc.dataToken, { update: [{ id: 't1', type: 'task', label: 'new' }] });
      expect(result.ok).toBe(true);
      const final = getSurface(sessionId)!;
      expect(final.items[0].label).toBe('new');
      expect(final.items[0].status).toBe('pending');
    });

    it('delete removes items', () => {
      seed(sessionId, [{ id: 't1', type: 'task' }, { id: 't2', type: 'task' }]);
      const doc = getSurface(sessionId)!;
      const result = mutate(sessionId, doc.dataToken, { delete: ['t1'] });
      expect(result.ok).toBe(true);
      const final = getSurface(sessionId)!;
      expect(final.items.map(i => i.id)).toEqual(['t2']);
    });

    it('clears changes atomically on success', () => {
      seed(sessionId, [{ id: 't1', type: 'task', status: 'pending' }]);
      let doc = getSurface(sessionId)!;
      putChange(sessionId, doc.dataToken, 't1', { id: 't1', type: 'task', status: 'done' });
      doc = getSurface(sessionId)!;
      expect(Object.keys(doc.changes).length).toBe(1);
      const result = mutate(sessionId, doc.dataToken, {});
      expect(result.ok).toBe(true);
      const final = getSurface(sessionId)!;
      expect(Object.keys(final.changes).length).toBe(0);
    });

    it('stale token does not mutate and does not clear changes', () => {
      seed(sessionId, [{ id: 't1', type: 'task', status: 'pending' }]);
      let doc = getSurface(sessionId)!;
      putChange(sessionId, doc.dataToken, 't1', { id: 't1', type: 'task', status: 'done' });
      doc = getSurface(sessionId)!;
      const stale = 'badtoken00000';
      const result = mutate(sessionId, stale, { create: [{ id: 't2', type: 'task' }] });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toBe('stale');
      expect(result.currentDataToken).toBe(doc.dataToken);
      const final = getSurface(sessionId)!;
      expect(final.items.find(i => i.id === 't2')).toBeUndefined();
      expect(Object.keys(final.changes).length).toBe(1);
    });

    it('over-cap returns limit', () => {
      const items: { id: string; type: string }[] = [];
      for (let i = 0; i < MAX_ITEMS; i++) items.push({ id: 'i' + i, type: 'task' });
      seed(sessionId, items);
      const doc = getSurface(sessionId)!;
      const result = mutate(sessionId, doc.dataToken, { create: [{ id: 'overflow', type: 'task' }] });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toBe('limit');
      const after = getSurface(sessionId)!;
      expect(after.items.length).toBe(MAX_ITEMS);
    });

    it('invalid item shape returns invalid', () => {
      const startToken = computeToken({ style: 'roadmap', items: [], changes: {}, customScript: null, customStyle: null });
      const result = mutate(sessionId, startToken, { create: [{ id: '', type: 'task' }] });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toBe('invalid');
    });
  });

  describe('putChange', () => {
    it('writes one entry, rotates token, does NOT touch items', () => {
      seed(sessionId, [{ id: 't1', type: 'task', status: 'pending' }]);
      const before = getSurface(sessionId)!;
      const result = putChange(sessionId, before.dataToken, 't1', { id: 't1', type: 'task', status: 'done' });
      expect(result.ok).toBe(true);
      const after = getSurface(sessionId)!;
      expect(after.dataToken).not.toBe(before.dataToken);
      expect(after.changes['t1'].status).toBe('done');
      expect(after.items[0].status).toBe('pending');
    });

    it('unknown item id returns unknown-item', () => {
      seed(sessionId, [{ id: 't1', type: 'task' }]);
      const doc = getSurface(sessionId)!;
      const result = putChange(sessionId, doc.dataToken, 'nope', { id: 'nope', type: 'task' });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toBe('unknown-item');
    });

    it('last write wins for same id', () => {
      seed(sessionId, [{ id: 't1', type: 'task', status: 'pending' }]);
      let doc = getSurface(sessionId)!;
      putChange(sessionId, doc.dataToken, 't1', { id: 't1', type: 'task', status: 'active' });
      doc = getSurface(sessionId)!;
      putChange(sessionId, doc.dataToken, 't1', { id: 't1', type: 'task', status: 'done' });
      doc = getSurface(sessionId)!;
      expect(doc.changes['t1'].status).toBe('done');
      expect(Object.keys(doc.changes).length).toBe(1);
    });

    it('rejects when item.id does not match :itemId in path', () => {
      seed(sessionId, [{ id: 't1', type: 'task' }]);
      const doc = getSurface(sessionId)!;
      const result = putChange(sessionId, doc.dataToken, 't1', { id: 't2', type: 'task' });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toBe('invalid');
    });
  });

  describe('clearChanges', () => {
    it('empties changes and rotates token', () => {
      seed(sessionId, [{ id: 't1', type: 'task', status: 'pending' }]);
      let doc = getSurface(sessionId)!;
      putChange(sessionId, doc.dataToken, 't1', { id: 't1', type: 'task', status: 'done' });
      doc = getSurface(sessionId)!;
      const before = doc.dataToken;
      const result = clearChanges(sessionId, doc.dataToken);
      expect(result.ok).toBe(true);
      const final = getSurface(sessionId)!;
      expect(Object.keys(final.changes).length).toBe(0);
      expect(final.dataToken).not.toBe(before);
    });

    it('stale token is a no-op', () => {
      seed(sessionId, [{ id: 't1', type: 'task' }]);
      const doc = getSurface(sessionId)!;
      putChange(sessionId, doc.dataToken, 't1', { id: 't1', type: 'task', status: 'done' });
      const result = clearChanges(sessionId, 'bogus0000000');
      expect(result.ok).toBe(false);
      const after = getSurface(sessionId)!;
      expect(Object.keys(after.changes).length).toBe(1);
    });

    it('idempotent when nothing to clear', () => {
      seed(sessionId, [{ id: 't1', type: 'task' }]);
      const doc = getSurface(sessionId)!;
      const r1 = clearChanges(sessionId, doc.dataToken);
      expect(r1.ok).toBe(true);
      if (!r1.ok) throw new Error('unreachable');
      // Token may stay the same because no changes existed.
      expect(r1.dataToken).toBe(doc.dataToken);
    });
    it('returns unknown-item when no doc exists', () => {
      const result = clearChanges('surface-missing-' + Date.now(), 'any-token');
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toBe('unknown-item');
    });
  });

  describe('deleteSurface', () => {
    it('removes the document', () => {
      seed(sessionId, [{ id: 't1', type: 'task' }]);
      expect(getSurface(sessionId)).not.toBeNull();
      const ok = deleteSurface(sessionId);
      expect(ok).toBe(true);
      expect(getSurface(sessionId)).toBeNull();
    });
  });
});

// Suppress unused-var warning for SurfaceDoc import used only by inference.
const _typecheck: SurfaceDoc | null = null;
void _typecheck;
