import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFileWatcher, type FileWatcher } from '../../src/file-watcher.js';

const scratchRoots: string[] = [];
const watchers: FileWatcher[] = [];

function scratchDir(name: string): string {
  const dir = join(tmpdir(), 'caco-file-watcher-test', `${name}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  scratchRoots.push(dir);
  return dir;
}

async function waitForReady(root: string, onChange: ReturnType<typeof vi.fn>): Promise<void> {
  for (let i = 0; i < 10; i++) {
    writeFileSync(join(root, `.watch-ready-${i}`), `${i}\n`);
    try {
      await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 300 });
      onChange.mockClear();
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  throw new Error('file watcher did not observe readiness probe');
}

afterEach(() => {
  for (const watcher of watchers) {
    watcher.detach('s1');
    watcher.detach('s2');
    watcher.detach('ignored');
  }
  watchers.length = 0;
  for (const dir of scratchRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('createFileWatcher', () => {
  it('tracks attach, idempotent reattach, and detach state', async () => {
    const root = scratchDir('file-watcher-state');
    const watcher = createFileWatcher();
    watchers.push(watcher);
    const onChange = vi.fn();

    await expect(watcher.attach('s1', root, onChange)).resolves.toBe(true);
    await expect(watcher.attach('s1', root, onChange)).resolves.toBe(true);

    expect(watcher.isWatching('s1')).toBe(true);
    watcher.detach('s1');
    expect(watcher.isWatching('s1')).toBe(false);
    watcher.detach('s1');
    expect(watcher.isWatching('s1')).toBe(false);
  });

  it('fires the change callback for real file mutations', async () => {
    const root = scratchDir('file-watcher-change');
    const watchedFile = join(root, 'watched.txt');
    writeFileSync(watchedFile, 'before\n');
    const watcher = createFileWatcher();
    watchers.push(watcher);
    const onChange = vi.fn();

    await expect(watcher.attach('s2', root, onChange)).resolves.toBe(true);
    await waitForReady(root, onChange);
    writeFileSync(watchedFile, 'after\n');

    await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 2000 });
  });

  it('honors hardcoded excluded directories and .gitignore rules', async () => {
    const root = scratchDir('file-watcher-ignore');
    writeFileSync(join(root, '.gitignore'), 'ignored.txt\n');
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'visible.txt'), 'before\n');
    writeFileSync(join(root, 'ignored.txt'), 'before\n');
    writeFileSync(join(root, 'node_modules', 'pkg.txt'), 'before\n');
    const watcher = createFileWatcher();
    watchers.push(watcher);
    const onChange = vi.fn();

    await expect(watcher.attach('ignored', root, onChange)).resolves.toBe(true);
    await waitForReady(root, onChange);
    writeFileSync(join(root, 'ignored.txt'), 'after\n');
    writeFileSync(join(root, 'node_modules', 'pkg.txt'), 'after\n');
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(onChange).not.toHaveBeenCalled();

    writeFileSync(join(root, 'visible.txt'), 'after\n');
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1), { timeout: 2000 });
  });
});
