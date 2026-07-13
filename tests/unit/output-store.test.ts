import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let cacoHome: string;
let originalCacoHome: string | undefined;

async function importStore() {
  return import('../../src/output-store.js');
}

beforeEach(() => {
  originalCacoHome = process.env.CACO_HOME;
  cacoHome = mkdtempSync(join(tmpdir(), 'caco-output-store-test-'));
  process.env.CACO_HOME = cacoHome;
  vi.resetModules();
});

afterEach(() => {
  if (originalCacoHome === undefined) delete process.env.CACO_HOME;
  else process.env.CACO_HOME = originalCacoHome;
  rmSync(cacoHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('output-store outputs', () => {
  it('persists text output metadata and reloads it from disk', async () => {
    const first = await importStore();
    const outputId = first.storeOutput('sess-a', '/work/repo', 'terminal text', {
      type: 'terminal',
      command: 'printf hello',
      highlight: 'bash',
    });

    const metaPath = join(cacoHome, 'sessions', 'sess-a', 'outputs', `${outputId}.meta.json`);
    const dataPath = join(cacoHome, 'sessions', 'sess-a', 'outputs', `${outputId}.txt`);
    expect(JSON.parse(readFileSync(metaPath, 'utf-8'))).toMatchObject({
      type: 'terminal',
      sessionId: 'sess-a',
      sessionCwd: '/work/repo',
      command: 'printf hello',
      highlight: 'bash',
    });
    expect(readFileSync(dataPath, 'utf-8')).toBe('terminal text');

    vi.resetModules();
    const fresh = await importStore();
    const loaded = fresh.getOutput(outputId);
    expect(loaded?.data).toBe('terminal text');
    expect(loaded?.metadata).toMatchObject({ type: 'terminal', sessionId: 'sess-a' });
  });

  it('returns freshly stored output from the in-memory cache', async () => {
    const store = await importStore();
    const outputId = store.storeOutput('sess-cache', '/cache', 'cached data', { type: 'raw' });

    expect(store.getOutput(outputId)).toEqual({
      data: 'cached data',
      metadata: expect.objectContaining({
        type: 'raw',
        sessionId: 'sess-cache',
        sessionCwd: '/cache',
      }),
    });
  });

  it('persists image output as a binary-readable b64 file', async () => {
    const first = await importStore();
    const bytes = Buffer.from('aW1hZ2U=', 'utf-8');
    const outputId = first.storeOutput('sess-image', '/images', bytes, {
      type: 'image',
      mimeType: 'image/png',
    });

    expect(existsSync(join(cacoHome, 'sessions', 'sess-image', 'outputs', `${outputId}.b64`))).toBe(true);

    vi.resetModules();
    const fresh = await importStore();
    const loaded = fresh.getOutput(outputId);
    expect(Buffer.isBuffer(loaded?.data)).toBe(true);
    expect(Buffer.compare(loaded?.data as Buffer, bytes)).toBe(0);
    expect(loaded?.metadata.mimeType).toBe('image/png');
  });

  it('returns null when sessions, metadata, or data files are missing', async () => {
    const store = await importStore();
    expect(store.getOutput('missing')).toBeNull();

    const outputDir = join(cacoHome, 'sessions', 'sess-a', 'outputs');
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, 'out_without_data.meta.json'), JSON.stringify({
      type: 'raw',
      createdAt: '2026-01-01T00:00:00.000Z',
      sessionId: 'sess-a',
    }));

    expect(store.getOutput('out_without_data')).toBeNull();
  });

  it('returns null and logs when output metadata is corrupt', async () => {
    const store = await importStore();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const outputDir = join(cacoHome, 'sessions', 'sess-bad', 'outputs');
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, 'out_bad.meta.json'), '{ invalid');
    writeFileSync(join(outputDir, 'out_bad.txt'), 'data');

    expect(store.getOutput('out_bad')).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      '[storage] Error reading output out_bad:',
      expect.any(SyntaxError),
    );
  });

  it('lists valid output metadata and skips malformed metadata', async () => {
    const store = await importStore();
    expect(store.listOutputs('no-session')).toEqual([]);

    const outputDir = join(cacoHome, 'sessions', 'sess-list', 'outputs');
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, 'valid.meta.json'), JSON.stringify({
      type: 'file',
      createdAt: '2026-01-01T00:00:00.000Z',
      sessionId: 'sess-list',
      path: 'src/a.ts',
    }));
    writeFileSync(join(outputDir, 'bad.meta.json'), '{ broken');
    writeFileSync(join(outputDir, 'note.txt'), 'not metadata');

    expect(store.listOutputs('sess-list')).toEqual([
      {
        type: 'file',
        createdAt: '2026-01-01T00:00:00.000Z',
        sessionId: 'sess-list',
        path: 'src/a.ts',
      },
    ]);
  });

  it('counts files older than the prune cutoff without deleting them', async () => {
    const store = await importStore();
    expect(store.pruneOutputs()).toBe(0);

    const outputDir = join(cacoHome, 'sessions', 'sess-prune', 'outputs');
    mkdirSync(outputDir, { recursive: true });
    const oldFile = join(outputDir, 'old.txt');
    const oldMeta = join(outputDir, 'old.meta.json');
    const newFile = join(outputDir, 'new.txt');
    writeFileSync(oldFile, 'old');
    writeFileSync(oldMeta, '{}');
    writeFileSync(newFile, 'new');
    const oldDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    utimesSync(oldFile, oldDate, oldDate);
    utimesSync(oldMeta, oldDate, oldDate);

    expect(store.pruneOutputs(1)).toBe(2);
    expect(existsSync(oldFile)).toBe(true);
    expect(existsSync(oldMeta)).toBe(true);
  });
});

describe('output-store activities', () => {
  it('persists activities and retrieves them by id', async () => {
    const store = await importStore();
    const activityId = store.storeActivity('sess-activity', 'tool.execution_start', 'running tool', 'details');

    const loaded = store.getActivity(activityId);
    expect(loaded).toEqual({
      id: activityId,
      metadata: expect.objectContaining({
        type: 'tool.execution_start',
        text: 'running tool',
        details: 'details',
        sessionId: 'sess-activity',
      }),
    });
  });

  it('returns null for absent and corrupt activities', async () => {
    const store = await importStore();
    expect(store.getActivity('missing_activity')).toBeNull();

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const activityDir = join(cacoHome, 'sessions', 'sess-corrupt', 'activity');
    mkdirSync(activityDir, { recursive: true });
    writeFileSync(join(activityDir, 'activity_bad.json'), '{ nope');

    expect(store.getActivity('activity_bad')).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith('Failed to read activity activity_bad:', expect.any(SyntaxError));
    expect(store.getActivity('activity_other')).toBeNull();
  });

  it('lists activities sorted by creation time and skips corrupt files', async () => {
    const store = await importStore();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(store.listActivities('missing-session')).toEqual([]);

    const activityDir = join(cacoHome, 'sessions', 'sess-sort', 'activity');
    mkdirSync(activityDir, { recursive: true });
    writeFileSync(join(activityDir, 'activity_late.json'), JSON.stringify({
      type: 'assistant.intent',
      text: 'late',
      createdAt: '2026-01-02T00:00:00.000Z',
      sessionId: 'sess-sort',
    }));
    writeFileSync(join(activityDir, 'activity_early.json'), JSON.stringify({
      type: 'assistant.intent',
      text: 'early',
      createdAt: '2026-01-01T00:00:00.000Z',
      sessionId: 'sess-sort',
    }));
    writeFileSync(join(activityDir, 'activity_bad.json'), '{ bad');

    expect(store.listActivities('sess-sort').map(activity => activity.metadata.text)).toEqual(['early', 'late']);
  });
});

describe('detectLanguage', () => {
  it('maps known extensions case-insensitively and defaults unknown paths to plaintext', async () => {
    const { detectLanguage } = await importStore();
    expect(detectLanguage('src/main.TSX')).toBe('typescript');
    expect(detectLanguage('Dockerfile.dockerfile')).toBe('dockerfile');
    expect(detectLanguage('.env')).toBe('shell');
    expect(detectLanguage('README.md')).toBe('markdown');
    expect(detectLanguage('no-extension')).toBe('plaintext');
    expect(detectLanguage('archive.unknown')).toBe('plaintext');
  });
});
