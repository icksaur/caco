import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_SID = 'v5-migration-test-' + Date.now();
const seed = {
  schemaVersion: 2,
  cards: [
    {
      relativePath: 'foo.ts',
      defaultViewerType: 'diff',
      activeViewerType: 'diff',
    },
  ],
  dismissed: ['old-path.ts'],
};

let cacoHome: string;
let originalCacoHome: string | undefined;

beforeEach(() => {
  originalCacoHome = process.env.CACO_HOME;
  cacoHome = mkdtempSync(join(tmpdir(), 'caco-v5-test-'));
  process.env.CACO_HOME = cacoHome;
  // STORAGE_ROOT is captured at module-load time. Reset modules
  // so the dynamic imports below pick up the test-scoped CACO_HOME.
  vi.resetModules();
});

afterEach(() => {
  if (originalCacoHome === undefined) {
    delete process.env.CACO_HOME;
  } else {
    process.env.CACO_HOME = originalCacoHome;
  }
  rmSync(cacoHome, { recursive: true, force: true });
});

describe('file-edits-store V5 migration', () => {
  it('copies legacy file-edits-cards into files-cards and deletes the old key', async () => {
    // Late import so CACO_HOME is set before the module reads it.
    const dataStore = await import('../../src/session-data-store.js');
    const { getCardList } = await import('../../src/file-edits-store.js');

    dataStore.setSessionData(
      TEST_SID,
      'file-edits-cards',
      seed as unknown as Record<string, unknown>,
    );

    const sessionDir = join(cacoHome, 'sessions', TEST_SID);
    expect(existsSync(join(sessionDir, 'file-edits-cards.json'))).toBe(true);

    const result = getCardList(TEST_SID);

    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]!.relativePath).toBe('foo.ts');
    expect(result.dismissed).toEqual(['old-path.ts']);

    expect(dataStore.getSessionData(TEST_SID, 'file-edits-cards')).toBeNull();
    expect(dataStore.getSessionData(TEST_SID, 'files-cards')).not.toBeNull();
    expect(existsSync(join(sessionDir, 'file-edits-cards.json'))).toBe(false);
    expect(existsSync(join(sessionDir, 'files-cards.json'))).toBe(true);
  });

  it('reads directly from files-cards when present (no migration)', async () => {
    const dataStore = await import('../../src/session-data-store.js');
    const { getCardList } = await import('../../src/file-edits-store.js');

    dataStore.setSessionData(
      TEST_SID,
      'files-cards',
      seed as unknown as Record<string, unknown>,
    );

    const result = getCardList(TEST_SID);
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]!.relativePath).toBe('foo.ts');
  });

  it('returns empty CardList when neither key exists', async () => {
    const { getCardList } = await import('../../src/file-edits-store.js');
    const result = getCardList(TEST_SID);
    expect(result.cards).toHaveLength(0);
    expect(result.dismissed).toHaveLength(0);
  });

  it('migration is idempotent on second read', async () => {
    const dataStore = await import('../../src/session-data-store.js');
    const { getCardList } = await import('../../src/file-edits-store.js');

    dataStore.setSessionData(
      TEST_SID,
      'file-edits-cards',
      seed as unknown as Record<string, unknown>,
    );
    getCardList(TEST_SID); // first call migrates
    const second = getCardList(TEST_SID);
    expect(second.cards).toHaveLength(1);
    expect(dataStore.getSessionData(TEST_SID, 'file-edits-cards')).toBeNull();
  });
});
