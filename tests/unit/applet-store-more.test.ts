import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { mkdir, readFile, readdir, writeFile } from 'fs/promises';
import { join } from 'path';

const testState = vi.hoisted(() => ({ homeDir: `${process.cwd()}/.caco-applet-store-more-${process.pid}` }));

vi.mock('os', async (importOriginal) => {
  const original = await importOriginal<typeof import('os')>();
  return { ...original, homedir: () => testState.homeDir };
});

import {
  appletExists,
  deleteApplet,
  getAppletPaths,
  listApplets,
  loadApplet,
  resolveAppletAsset,
  saveApplet,
} from '../../src/applet-store.js';

function userAppletRoot(): string {
  return join(testState.homeDir, '.caco', 'applets');
}

function appletDir(slug: string): string {
  return join(userAppletRoot(), slug);
}

async function writeUserApplet(
  slug: string,
  meta: Partial<{
    name: string;
    description: string;
    createdAt: string;
    updatedAt: string;
    deprecated: boolean;
  }> = {},
  files: Partial<{ html: string; js: string; css: string; extra: Record<string, string> }> = {},
): Promise<void> {
  const root = appletDir(slug);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'meta.json'), JSON.stringify({
    slug,
    name: meta.name ?? slug,
    description: meta.description,
    createdAt: meta.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: meta.updatedAt ?? '2026-01-01T00:00:00.000Z',
    deprecated: meta.deprecated,
  }));
  await writeFile(join(root, 'content.html'), files.html ?? `<main>${slug}</main>`);
  if (files.js !== undefined) await writeFile(join(root, 'script.js'), files.js);
  if (files.css !== undefined) await writeFile(join(root, 'style.css'), files.css);
  for (const [name, content] of Object.entries(files.extra ?? {})) {
    await writeFile(join(root, name), content);
  }
}

beforeEach(() => {
  rmSync(testState.homeDir, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(testState.homeDir, { recursive: true, force: true });
});

describe('applet-store save and load', () => {
  it('saves an applet to the mocked user home and preserves createdAt on update', async () => {
    const firstPaths = await saveApplet('alpha-tool', 'Alpha Tool', '<p>one</p>', 'window.one = true;', '.one{}', 'first');
    const firstMeta = JSON.parse(await readFile(firstPaths.meta, 'utf-8'));

    const secondPaths = await saveApplet('alpha-tool', 'Alpha Tool 2', '<p>two</p>', undefined, undefined, 'second');
    const secondMeta = JSON.parse(await readFile(secondPaths.meta, 'utf-8'));

    expect(firstPaths.root).toBe(appletDir('alpha-tool'));
    expect(secondMeta).toMatchObject({
      slug: 'alpha-tool',
      name: 'Alpha Tool 2',
      description: 'second',
      createdAt: firstMeta.createdAt,
    });
    expect(new Date(secondMeta.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(firstMeta.updatedAt).getTime());
    expect(await readFile(secondPaths.html, 'utf-8')).toBe('<p>two</p>');
    expect(await readFile(secondPaths.js, 'utf-8')).toBe('window.one = true;');
    expect(await readFile(secondPaths.css, 'utf-8')).toBe('.one{}');
  });

  it('loads optional css and deterministic sibling js before script.js', async () => {
    await writeUserApplet('multi-js', { name: 'Multi JS' }, {
      html: '<section>multi</section>',
      js: 'script();',
      css: '.multi{}',
      extra: {
        'z-helper.js': 'z();',
        'a-helper.js': 'a();',
        'note.txt': 'ignored',
      },
    });

    const applet = await loadApplet('multi-js');
    expect(applet?.meta.name).toBe('Multi JS');
    expect(applet?.html).toBe('<section>multi</section>');
    expect(applet?.css).toBe('.multi{}');
    expect(applet?.js).toBe('// ─── a-helper.js ──────────────────────────────────────\na();\n\n// ─── z-helper.js ──────────────────────────────────────\nz();\n\n// ─── script.js ─────────────────────────────────────\nscript();');
  });

  it('loads sibling js even when script.js is absent', async () => {
    await writeUserApplet('extra-only', { name: 'Extra Only' }, {
      extra: { 'helper.js': 'helper();' },
    });

    const applet = await loadApplet('extra-only');
    expect(applet?.js).toBe('// ─── helper.js ──────────────────────────────────────\nhelper();');
    expect(applet?.css).toBeUndefined();
  });

  it('returns null for missing applets and applets missing required html', async () => {
    expect(await loadApplet('missing-applet')).toBeNull();

    const root = appletDir('no-html');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'meta.json'), JSON.stringify({
      slug: 'no-html',
      name: 'No HTML',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }));

    expect(await loadApplet('no-html')).toBeNull();
  });

  it('rejects invalid slugs for load and save', async () => {
    await expect(loadApplet('Bad Slug')).rejects.toThrow('Invalid slug "Bad Slug"');
    await expect(saveApplet('bad-', 'Bad', '<p>bad</p>')).rejects.toThrow('Invalid slug "bad-"');
    await expect(saveApplet('a'.repeat(65), 'Long', '<p>long</p>')).rejects.toThrow('too long');
  });
});

describe('applet-store listing and paths', () => {
  it('lists user applets sorted by updatedAt and skips hidden or invalid entries', async () => {
    await writeUserApplet('older', { name: 'Older', updatedAt: '2026-01-01T00:00:00.000Z' });
    await writeUserApplet('newer', { name: 'Newer', updatedAt: '2026-01-03T00:00:00.000Z' });
    await mkdir(appletDir('.hidden'), { recursive: true });
    await writeUserApplet('_private', { name: 'Private', updatedAt: '2026-01-04T00:00:00.000Z' });
    await writeFile(join(userAppletRoot(), 'not-a-directory'), 'skip me');
    await mkdir(appletDir('bad-meta'), { recursive: true });
    await writeFile(join(appletDir('bad-meta'), 'meta.json'), '{ broken');

    const names = (await listApplets()).filter(applet => ['older', 'newer', '_private', 'bad-meta'].includes(applet.slug)).map(applet => applet.slug);
    expect(names).toEqual(['newer', 'older']);
  });

  it('lets user applets override bundled applets with the same slug in listings and loads', async () => {
    await writeUserApplet('files', { name: 'User Files', updatedAt: '2030-01-01T00:00:00.000Z' }, {
      html: '<p>user files</p>',
    });

    const listed = await listApplets();
    const filesEntries = listed.filter(applet => applet.slug === 'files');
    expect(filesEntries).toHaveLength(1);
    expect(filesEntries[0]?.name).toBe('User Files');
    expect(filesEntries[0]?.paths.root).toBe(appletDir('files'));
    expect((await loadApplet('file-edits'))?.html).toBe('<p>user files</p>');
  });

  it('returns write paths inside the mocked user applet directory', () => {
    expect(getAppletPaths('path-check')).toEqual({
      root: appletDir('path-check'),
      meta: join(appletDir('path-check'), 'meta.json'),
      html: join(appletDir('path-check'), 'content.html'),
      js: join(appletDir('path-check'), 'script.js'),
      css: join(appletDir('path-check'), 'style.css'),
    });
  });
});

describe('applet-store existence, deletion, and assets', () => {
  it('detects valid user, bundled, aliased, missing, and invalid applet slugs', async () => {
    await writeUserApplet('exists-user');

    expect(await appletExists('exists-user')).toBe(true);
    expect(await appletExists('files')).toBe(true);
    expect(await appletExists('file-edits')).toBe(true);
    expect(await appletExists('missing-applet')).toBe(false);
    expect(await appletExists('Bad Slug')).toBe(false);
  });

  it('deletes only user applets and reports whether anything was removed', async () => {
    await writeUserApplet('delete-me');

    expect(await deleteApplet('delete-me')).toBe(true);
    expect(existsSync(appletDir('delete-me'))).toBe(false);
    expect(await deleteApplet('delete-me')).toBe(false);
    await expect(deleteApplet('bad-')).rejects.toThrow('Invalid slug "bad-"');
    expect(await appletExists('files')).toBe(true);
  });

  it('resolves user assets first, bundled alias assets second, and null for missing assets', async () => {
    await writeUserApplet('asset-user', {}, {
      extra: { 'asset.txt': 'asset' },
    });

    const userAsset = await resolveAppletAsset('asset-user', 'asset.txt');
    const bundledAsset = await resolveAppletAsset('file-edits', 'content.html');
    const missingAsset = await resolveAppletAsset('asset-user', 'missing.txt');

    expect(userAsset).toBe(join(appletDir('asset-user'), 'asset.txt'));
    expect(bundledAsset).toMatch(/applets\/files\/content\.html$/);
    expect(missingAsset).toBeNull();
  });

  it('writes exactly the expected files for applets without optional js or css', async () => {
    const paths = await saveApplet('html-only', 'HTML Only', '<p>only</p>');

    expect((await readdir(paths.root)).sort()).toEqual(['content.html', 'meta.json']);
    expect(await readFile(paths.html, 'utf-8')).toBe('<p>only</p>');
  });
});
