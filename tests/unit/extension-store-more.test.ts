import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type WatchCallback = (event: string, filename: string | Buffer | null) => void;

const testState = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMPDIR || '/tmp';
  return {
    homeDir: `${tmp}/caco-extension-store-more-home-${process.pid}`,
    projectDir: `${tmp}/caco-extension-store-more-project-${process.pid}`,
  };
});

const watchState = vi.hoisted(() => ({
  calls: [] as Array<{ dir: string; options: { recursive?: boolean }; callback: WatchCallback }>,
  closeFns: [] as Array<() => void>,
  throwOnWatch: false,
}));

vi.mock('os', async (importOriginal) => {
  const original = await importOriginal<typeof import('os')>();
  return { ...original, homedir: () => testState.homeDir };
});

vi.mock('fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('fs')>();
  return {
    ...original,
    watch: vi.fn((dir: string, options: { recursive?: boolean }, callback: WatchCallback) => {
      if (watchState.throwOnWatch) throw new Error('watch unavailable');
      const close = vi.fn();
      watchState.calls.push({ dir, options, callback });
      watchState.closeFns.push(close);
      return { close, on: vi.fn() };
    }),
  };
});

import { getExtension, listExtensions, watchExtensions } from '../../src/extension-store.js';

function userExtDir(slug: string): string {
  return join(testState.homeDir, '.caco', 'extensions', slug);
}

function projectExtDir(slug: string): string {
  return join(testState.projectDir, '.caco', 'extensions', slug);
}

function writeManifest(dir: string, manifest: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf-8');
}

describe('extension-store additional coverage', () => {
  beforeEach(() => {
    rmSync(testState.homeDir, { recursive: true, force: true });
    rmSync(testState.projectDir, { recursive: true, force: true });
    vi.spyOn(process, 'cwd').mockReturnValue(testState.projectDir);
    watchState.calls = [];
    watchState.closeFns = [];
    watchState.throwOnWatch = false;
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.mocked(process.cwd).mockRestore();
    vi.mocked(console.warn).mockRestore();
    rmSync(testState.homeDir, { recursive: true, force: true });
    rmSync(testState.projectDir, { recursive: true, force: true });
  });

  it('discovers valid user and project manifests with full returned metadata', async () => {
    writeManifest(userExtDir('theme'), {
      name: 'Theme',
      description: 'Adds styles',
      provides: ['css'],
    });
    writeManifest(projectExtDir('agent'), {
      name: 'Agent',
      provides: ['server', 'client'],
    });

    await expect(listExtensions()).resolves.toEqual([
      {
        slug: 'agent',
        name: 'Agent',
        provides: ['server', 'client'],
        dir: projectExtDir('agent'),
      },
      {
        slug: 'theme',
        name: 'Theme',
        description: 'Adds styles',
        provides: ['css'],
        dir: userExtDir('theme'),
      },
    ]);
  });

  it('prefers a project extension over a user extension with the same slug', async () => {
    writeManifest(userExtDir('shared'), {
      name: 'User Shared',
      provides: ['css'],
    });
    writeManifest(projectExtDir('shared'), {
      name: 'Project Shared',
      description: 'Project wins',
      provides: ['server'],
    });

    const extension = await getExtension('shared');

    expect(extension).toEqual({
      slug: 'shared',
      name: 'Project Shared',
      description: 'Project wins',
      provides: ['server'],
      dir: projectExtDir('shared'),
    });
  });

  it('skips invalid manifests and non-directory entries', async () => {
    mkdirSync(join(testState.homeDir, '.caco', 'extensions'), { recursive: true });
    writeFileSync(join(testState.homeDir, '.caco', 'extensions', 'not-a-dir'), 'x', 'utf-8');
    mkdirSync(userExtDir('corrupt'), { recursive: true });
    writeFileSync(join(userExtDir('corrupt'), 'manifest.json'), '{ not json', 'utf-8');
    writeManifest(userExtDir('missing-name'), { provides: ['css'] });
    writeManifest(userExtDir('missing-provides'), { name: 'Missing Provides' });
    writeManifest(userExtDir('valid'), { name: 'Valid', provides: ['client'] });

    const extensions = await listExtensions();

    expect(extensions.map(extension => extension.slug)).toEqual(['valid']);
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it('reports watched style, client, and server file changes by slug and type', () => {
    const changes: Array<[string, string]> = [];

    const watch = watchExtensions((slug, type) => {
      changes.push([slug, type]);
    });
    for (const call of watchState.calls) {
      call.callback('change', 'theme/style.css');
      call.callback('change', 'theme/client.ts');
      call.callback('change', 'theme/nested/server.ts');
      call.callback('change', 'theme/README.md');
      call.callback('change', 'top-level-only');
      call.callback('change', null);
    }
    watch.close();

    expect(watchState.calls.map(call => [call.dir, call.options])).toEqual([
      [join(testState.homeDir, '.caco', 'extensions'), { recursive: true }],
      [join(testState.projectDir, '.caco', 'extensions'), { recursive: true }],
    ]);
    expect(changes).toEqual([
      ['theme', 'css'],
      ['theme', 'client'],
      ['theme', 'server'],
      ['theme', 'css'],
      ['theme', 'client'],
      ['theme', 'server'],
    ]);
    expect(watchState.closeFns).toHaveLength(2);
    for (const close of watchState.closeFns) expect(close).toHaveBeenCalledOnce();
  });

  it('returns a closeable watch when directories cannot be watched', () => {
    watchState.throwOnWatch = true;

    const watch = watchExtensions(() => {
      throw new Error('unexpected change');
    });

    expect(() => watch.close()).not.toThrow();
    expect(watchState.calls).toEqual([]);
  });
});
