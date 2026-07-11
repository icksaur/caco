import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let cacoHome: string;
let originalCacoHome: string | undefined;
let resetStore: (() => void) | undefined;

function cardsFile(sessionId: string): string {
  return join(cacoHome, 'sessions', sessionId, 'files-cards.json');
}

async function importStore() {
  const store = await import('../../src/file-edits-store.js');
  resetStore = store._resetForTest;
  return store;
}

beforeEach(() => {
  originalCacoHome = process.env.CACO_HOME;
  cacoHome = mkdtempSync(join(tmpdir(), 'caco-file-edits-more-'));
  process.env.CACO_HOME = cacoHome;
  resetStore = undefined;
  vi.useFakeTimers();
  vi.resetModules();
});

afterEach(() => {
  resetStore?.();
  vi.useRealTimers();
  if (originalCacoHome === undefined) {
    delete process.env.CACO_HOME;
  } else {
    process.env.CACO_HOME = originalCacoHome;
  }
  rmSync(cacoHome, { recursive: true, force: true });
});

describe('file-edits-store additional hermetic coverage', () => {
  it('filters malformed persisted cards and dismissed entries while preserving valid fields', async () => {
    const dataStore = await import('../../src/session-data-store.js');
    const { getCardList, SCHEMA_VERSION } = await importStore();
    const sessionId = 'file-edits-more-filter';
    dataStore.setSessionData(sessionId, 'files-cards', {
      schemaVersion: 'old',
      updatedAt: 99,
      cards: [
        { relativePath: 'ok.ts', collapsed: false, defaultViewerType: 'diff', activeViewerType: 'diff', diffMode: 'staged' },
        { relativePath: 'bad-diff.ts', diffMode: 'range' },
        { relativePath: 42 },
      ],
      dismissed: ['gone.ts', 12, null],
    });

    const result = getCardList(sessionId);

    expect(result).toEqual({
      schemaVersion: SCHEMA_VERSION,
      updatedAt: null,
      cards: [
        { relativePath: 'ok.ts', collapsed: false, defaultViewerType: 'diff', activeViewerType: 'diff', diffMode: 'staged' },
      ],
      dismissed: ['gone.ts'],
    });
  });

  it('returns the empty shape when the persisted JSON is corrupt', async () => {
    const { getCardList, SCHEMA_VERSION } = await importStore();
    const sessionId = 'file-edits-more-corrupt';
    const sessionDir = join(cacoHome, 'sessions', sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(cardsFile(sessionId), '{ broken json');

    const result = getCardList(sessionId);

    expect(result).toEqual({ schemaVersion: SCHEMA_VERSION, updatedAt: null, cards: [], dismissed: [] });
  });

  it('debounces setCardList and writes the latest body when the timer fires', async () => {
    const { setCardList } = await importStore();
    const sessionId = 'file-edits-more-debounce';

    setCardList(sessionId, { cards: [{ relativePath: 'old.ts' }], dismissed: [] });
    setCardList(sessionId, { cards: [{ relativePath: 'new.ts', diffMode: 'unstaged' }], dismissed: ['x.ts'] });
    expect(existsSync(cardsFile(sessionId))).toBe(false);

    await vi.advanceTimersByTimeAsync(500);

    const persisted = JSON.parse(readFileSync(cardsFile(sessionId), 'utf-8'));
    expect(persisted.schemaVersion).toBe(2);
    expect(typeof persisted.updatedAt).toBe('string');
    expect(persisted.cards).toEqual([{ relativePath: 'new.ts', diffMode: 'unstaged' }]);
    expect(persisted.dismissed).toEqual(['x.ts']);
  });

  it('flushSession writes a pending body immediately and prevents a later timer write', async () => {
    const { setCardList, flushSession } = await importStore();
    const sessionId = 'file-edits-more-flush';

    setCardList(sessionId, { cards: [{ relativePath: 'now.ts', activeViewerType: 'markdown' }], dismissed: [] });
    flushSession(sessionId);
    const first = readFileSync(cardsFile(sessionId), 'utf-8');
    rmSync(cardsFile(sessionId), { force: true });
    await vi.advanceTimersByTimeAsync(500);

    expect(JSON.parse(first).cards).toEqual([{ relativePath: 'now.ts', activeViewerType: 'markdown' }]);
    expect(existsSync(cardsFile(sessionId))).toBe(false);
  });

  it('flushAll writes pending bodies for every session', async () => {
    const { setCardList, flushAll } = await importStore();

    setCardList('file-edits-more-all-a', { cards: [{ relativePath: 'a1.ts' }], dismissed: [] });
    setCardList('file-edits-more-all-a', { cards: [{ relativePath: 'a2.ts' }], dismissed: ['dismiss-a.ts'] });
    setCardList('file-edits-more-all-b', { cards: [{ relativePath: 'b.ts' }], dismissed: [] });
    flushAll();

    expect(JSON.parse(readFileSync(cardsFile('file-edits-more-all-a'), 'utf-8')).cards).toEqual([{ relativePath: 'a2.ts' }]);
    expect(JSON.parse(readFileSync(cardsFile('file-edits-more-all-a'), 'utf-8')).dismissed).toEqual(['dismiss-a.ts']);
    expect(JSON.parse(readFileSync(cardsFile('file-edits-more-all-b'), 'utf-8')).cards).toEqual([{ relativePath: 'b.ts' }]);
  });

  it('cancelCardPersist drops a pending write without resurrecting a file', async () => {
    const { setCardList, cancelCardPersist } = await importStore();
    const sessionId = 'file-edits-more-cancel';

    setCardList(sessionId, { cards: [{ relativePath: 'ghost.ts' }], dismissed: [] });
    cancelCardPersist(sessionId);
    await vi.advanceTimersByTimeAsync(500);

    expect(existsSync(cardsFile(sessionId))).toBe(false);
  });

  it('_resetForTest clears pending timers without writing them', async () => {
    const { setCardList, _resetForTest } = await importStore();
    const sessionId = 'file-edits-more-reset';

    setCardList(sessionId, { cards: [{ relativePath: 'reset.ts' }], dismissed: [] });
    _resetForTest();
    await vi.advanceTimersByTimeAsync(500);

    expect(existsSync(cardsFile(sessionId))).toBe(false);
  });

  it('flushSession and cancelCardPersist are no-ops for sessions without pending writes', async () => {
    const { flushSession, cancelCardPersist, getCardList } = await importStore();
    const sessionId = 'file-edits-more-noop';

    flushSession(sessionId);
    cancelCardPersist(sessionId);

    expect(existsSync(cardsFile(sessionId))).toBe(false);
    expect(getCardList(sessionId).cards).toEqual([]);
  });
});
