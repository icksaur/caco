import { execFileSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const eventBus = vi.hoisted(() => ({
  broadcastEvent: vi.fn(),
}));

const watcherState = vi.hoisted(() => {
  const watched = new Set<string>();
  return {
    watched,
    createFileWatcher: vi.fn(() => ({
      attach: vi.fn(async (sessionId: string) => {
        watched.add(sessionId);
        return true;
      }),
      detach: vi.fn((sessionId: string) => {
        watched.delete(sessionId);
      }),
      isWatching: vi.fn((sessionId: string) => watched.has(sessionId)),
    })),
  };
});

vi.mock('../../src/event-bus.js', () => eventBus);
vi.mock('../../src/file-watcher.js', () => ({ createFileWatcher: watcherState.createFileWatcher }));

interface Repo {
  root: string;
  run: (...args: string[]) => string;
  write: (relativePath: string, content: string) => void;
}

const scratchRoots: string[] = [];
const pollers: Array<import('../../src/git-edit-poller.js').GitEditPoller> = [];
const gitEnvKeys = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TEMPLATE_DIR', 'HOME'] as const;
const originalGitEnv = new Map<string, string | undefined>();

for (const key of gitEnvKeys) {
  originalGitEnv.set(key, process.env[key]);
}

function setGitIsolationEnv(base: string): void {
  process.env.GIT_CONFIG_GLOBAL = join(base, 'global-gitconfig');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_TEMPLATE_DIR = join(base, 'git-template');
  process.env.HOME = base;
}

function restoreGitIsolationEnv(): void {
  for (const key of gitEnvKeys) {
    const original = originalGitEnv.get(key);
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
}

function scratchDir(name: string): string {
  const dir = join(process.cwd(), '.caco', 'test-work', `${name}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  scratchRoots.push(dir);
  return dir;
}

function createRepo(name: string): Repo {
  const base = scratchDir(name);
  const root = join(base, 'repo');
  mkdirSync(root, { recursive: true });
  setGitIsolationEnv(base);
  const run = (...args: string[]): string => execFileSync('git', args, {
    cwd: root,
    encoding: 'utf-8',
  });
  const write = (relativePath: string, content: string): void => {
    const fullPath = join(root, relativePath);
    mkdirSync(join(fullPath, '..'), { recursive: true });
    writeFileSync(fullPath, content);
  };
  writeFileSync(join(base, 'global-gitconfig'), '');
  mkdirSync(join(base, 'git-template'), { recursive: true });
  run('init', '-b', 'main');
  run('config', 'user.email', 'test@example.invalid');
  run('config', 'user.name', 'Caco Test');
  run('config', 'commit.gpgsign', 'false');
  run('config', 'tag.gpgsign', 'false');
  mkdirSync(join(root, '.git-hooks-empty'), { recursive: true });
  run('config', 'core.hooksPath', '.git-hooks-empty');
  write('tracked.txt', 'one\n');
  run('add', 'tracked.txt');
  run('commit', '-m', 'initial');
  return { root, run, write };
}

async function importPoller(): Promise<typeof import('../../src/git-edit-poller.js')> {
  vi.resetModules();
  watcherState.watched.clear();
  return import('../../src/git-edit-poller.js');
}

async function createPoller(): Promise<import('../../src/git-edit-poller.js').GitEditPoller> {
  const { createGitEditPoller } = await importPoller();
  const poller = createGitEditPoller();
  pollers.push(poller);
  return poller;
}

afterEach(() => {
  for (const poller of pollers) {
    for (const sessionId of ['s-clean', 's-dirty', 's-life', 's-clean-card', 's-staged']) {
      poller.detachFromSession(sessionId);
    }
  }
  pollers.length = 0;
  eventBus.broadcastEvent.mockClear();
  watcherState.createFileWatcher.mockClear();
  watcherState.watched.clear();
  restoreGitIsolationEnv();
  for (const dir of scratchRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('createGitEditPoller snapshots', () => {
  it('attaches lazily and returns no edits for a clean repository', async () => {
    const repo = createRepo('git-poller-clean');
    const poller = await createPoller();

    await expect(poller.snapshot('s-clean', repo.root)).resolves.toEqual([]);
    expect(poller.isAttached('s-clean')).toBe(true);
    expect(eventBus.broadcastEvent).not.toHaveBeenCalled();
  });

  it('reports modified and untracked files with git-backed diffs and full-file payloads', async () => {
    const repo = createRepo('git-poller-dirty');
    repo.write('tracked.txt', 'one\ntwo\n');
    repo.write('new.txt', 'alpha\nbeta\n');
    const poller = await createPoller();

    const edits = await poller.snapshot('s-dirty', repo.root);
    const byPath = new Map(edits.map(edit => [edit.relativePath, edit]));

    expect(byPath.get('tracked.txt')?.status).toBe('modified');
    expect(byPath.get('tracked.txt')?.diff).toContain('+two');
    expect(byPath.get('tracked.txt')?.fullFile).toMatchObject({
      headLines: ['one'],
      workLines: ['one', 'two'],
      hunks: [{ headStart: 1, headLen: 1, workStart: 1, workLen: 2 }],
    });
    expect(byPath.get('new.txt')?.status).toBe('untracked');
    expect(byPath.get('new.txt')?.fullFile?.headLines).toBeNull();
    expect(byPath.get('new.txt')?.fullFile?.workLines).toEqual(['alpha', 'beta']);
  });

  it('builds clean cards for persisted paths that are no longer dirty', async () => {
    const repo = createRepo('git-poller-clean-card');
    const poller = await createPoller();

    const edits = await poller.snapshot('s-clean-card', repo.root, ['tracked.txt']);

    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({
      relativePath: 'tracked.txt',
      status: 'clean',
      fullFile: { headLines: ['one'], workLines: ['one'], hunks: [] },
    });
    expect(edits[0].diff).toBeUndefined();
  });

  it('opens staged diffs separately from working-tree status', async () => {
    const repo = createRepo('git-poller-staged');
    repo.write('tracked.txt', 'one\nstaged\n');
    repo.run('add', 'tracked.txt');
    const poller = await createPoller();
    await poller.attachToSession('s-staged', repo.root);

    const staged = await poller.openFile('s-staged', 'tracked.txt', { diffMode: 'staged' });

    expect(staged).toMatchObject({ relativePath: 'tracked.txt', status: 'modified' });
    expect(staged?.diff).toContain('+staged');
  });
});

describe('createGitEditPoller poll lifecycle', () => {
  it('broadcasts a change card on triggered polls and stops after detach', async () => {
    const repo = createRepo('git-poller-lifecycle');
    const poller = await createPoller();
    await poller.attachToSession('s-life', repo.root);
    repo.write('tracked.txt', 'one\nchanged\n');

    poller.triggerPoll('s-life', 'event');

    await vi.waitFor(() => expect(eventBus.broadcastEvent).toHaveBeenCalledTimes(1), { timeout: 1000 });
    const [, event] = eventBus.broadcastEvent.mock.calls[0];
    expect(event).toMatchObject({
      type: 'caco.edit',
      data: {
        cleared: [],
        pollSource: 'event',
        edits: [{ relativePath: 'tracked.txt', status: 'modified' }],
      },
    });
    expect(event.data.edits[0].diff).toContain('+changed');

    poller.detachFromSession('s-life');
    expect(poller.isAttached('s-life')).toBe(false);
    eventBus.broadcastEvent.mockClear();
    repo.write('tracked.txt', 'one\nchanged again\n');
    poller.triggerPoll('s-life', 'event');
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(eventBus.broadcastEvent).not.toHaveBeenCalled();
  });
});
