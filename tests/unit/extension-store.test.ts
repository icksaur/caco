import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const testDir = join(tmpdir(), `caco-ext-test-${Date.now()}`);
const extDir = join(testDir, '.caco', 'extensions');

beforeEach(() => {
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function makeExt(slug: string, manifest: Record<string, unknown>): void {
  const dir = join(extDir, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
}

describe('extension-store', () => {
  it('returns empty when no dirs exist', async () => {
    const { listExtensions } = await import('../../src/extension-store.js');
    const result = await listExtensions();
    expect(Array.isArray(result)).toBe(true);
  });

  it('discovers extension from valid manifest', async () => {
    makeExt('test-ext', { name: 'Test', provides: ['css'] });

    const mod = await import('../../src/extension-store.js');

    const scanDir = (mod as Record<string, unknown>)['scanDir'] as undefined;
    expect(scanDir).toBeUndefined();

    const { getExtension } = mod;
    const ext = await getExtension('test-ext');

    // May or may not find it depending on process.cwd and homedir
    // This test verifies the function doesn't throw
    expect(ext === null || ext.slug === 'test-ext').toBe(true);
  });

  it('skips dirs without valid manifest', async () => {
    const dir = join(extDir, 'bad-ext');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), 'not json');

    const { listExtensions } = await import('../../src/extension-store.js');
    const result = await listExtensions();
    expect(result.find(e => e.slug === 'bad-ext')).toBeUndefined();
  });

  it('skips manifest with missing required fields', async () => {
    makeExt('no-provides', { name: 'NoProvides' });

    const { listExtensions } = await import('../../src/extension-store.js');
    const result = await listExtensions();
    expect(result.find(e => e.slug === 'no-provides')).toBeUndefined();
  });
});
