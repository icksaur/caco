import { describe, it, expect } from 'vitest';
import { buildSessionListModel } from '../../public/ts/session-list-model.js';
import type { SessionData } from '../../public/ts/types.js';

function session(id: string, opts: Partial<SessionData> = {}): SessionData {
  return { sessionId: id, ...opts };
}

describe('buildSessionListModel', () => {
  it('root-only sessions — no folders', () => {
    const sessions = [session('a'), session('b')];
    const model = buildSessionListModel(sessions, ['a', 'b'], new Set());
    expect(model.root).toHaveLength(2);
    expect(model.folders).toHaveLength(0);
  });

  it('mixed root + folders — root first, folders alphabetical', () => {
    const sessions = [
      session('r1'),
      session('f1', { folder: 'beta' }),
      session('f2', { folder: 'alpha' }),
    ];
    const model = buildSessionListModel(sessions, [], new Set());
    expect(model.root).toHaveLength(1);
    expect(model.root[0].sessionId).toBe('r1');
    expect(model.folders).toHaveLength(2);
    expect(model.folders[0].name).toBe('alpha');
    expect(model.folders[1].name).toBe('beta');
  });

  it('MRU order within groups', () => {
    const sessions = [session('a'), session('b'), session('c')];
    const model = buildSessionListModel(sessions, ['c', 'a', 'b'], new Set());
    expect(model.root.map(s => s.sessionId)).toEqual(['c', 'a', 'b']);
  });

  it('unobserved-first within groups', () => {
    const sessions = [
      session('a', { isUnobserved: false }),
      session('b', { isUnobserved: true }),
      session('c', { isUnobserved: false }),
    ];
    const model = buildSessionListModel(sessions, ['a', 'b', 'c'], new Set());
    expect(model.root[0].sessionId).toBe('b');
  });

  it('sessions not in MRU snapshot go to top', () => {
    const sessions = [session('a'), session('new')];
    const model = buildSessionListModel(sessions, ['a'], new Set());
    expect(model.root[0].sessionId).toBe('new');
    expect(model.root[1].sessionId).toBe('a');
  });

  it('aggregate badges — hasBusy, hasUnobserved', () => {
    const sessions = [
      session('a', { folder: 'work', isBusy: true }),
      session('b', { folder: 'work', isUnobserved: true }),
      session('c', { folder: 'idle' }),
    ];
    const model = buildSessionListModel(sessions, [], new Set());
    const work = model.folders.find(f => f.name === 'work')!;
    expect(work.hasBusy).toBe(true);
    expect(work.hasUnobserved).toBe(true);
    const idle = model.folders.find(f => f.name === 'idle')!;
    expect(idle.hasBusy).toBe(false);
    expect(idle.hasUnobserved).toBe(false);
  });

  it('collapse state applied', () => {
    const sessions = [
      session('a', { folder: 'alpha' }),
      session('b', { folder: 'beta' }),
    ];
    const collapsed = new Set(['alpha']);
    const model = buildSessionListModel(sessions, [], collapsed);
    expect(model.folders[0].collapsed).toBe(true);
    expect(model.folders[1].collapsed).toBe(false);
  });

  it('empty folders excluded', () => {
    const sessions = [session('a')];
    const model = buildSessionListModel(sessions, [], new Set());
    expect(model.folders).toHaveLength(0);
  });

  it('MRU within folders', () => {
    const sessions = [
      session('a', { folder: 'work' }),
      session('b', { folder: 'work' }),
      session('c', { folder: 'work' }),
    ];
    const model = buildSessionListModel(sessions, ['c', 'b', 'a'], new Set());
    const work = model.folders[0];
    expect(work.sessions.map(s => s.sessionId)).toEqual(['c', 'b', 'a']);
  });
});
