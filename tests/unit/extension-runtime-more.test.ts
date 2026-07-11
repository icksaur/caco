import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import type { ExtensionInfo } from '../../src/extension-store.js';

const extensions = vi.hoisted(() => ({
  listExtensions: vi.fn<() => Promise<ExtensionInfo[]>>(),
}));
const eventBus = vi.hoisted(() => ({
  broadcastGlobalEvent: vi.fn(),
  broadcastEvent: vi.fn(),
}));
const jitiState = vi.hoisted(() => ({
  modules: new Map<string, unknown>(),
  import: vi.fn((path: string) => Promise.resolve(jitiState.modules.get(path) ?? {})),
}));
const fsState = vi.hoisted(() => ({
  files: new Map<string, string>(),
  readFileSync: vi.fn((path: string) => {
    const value = fsState.files.get(path);
    if (value === undefined) throw new Error('missing file');
    return value;
  }),
  writeFileSync: vi.fn((path: string, content: string) => {
    fsState.files.set(path, content);
  }),
  mkdirSync: vi.fn(),
}));

vi.mock('../../src/extension-store.js', () => extensions);
vi.mock('../../src/event-bus.js', () => eventBus);
vi.mock('jiti', () => ({ createJiti: () => ({ import: jitiState.import }) }));
vi.mock('fs', async importOriginal => {
  const original = await importOriginal<typeof import('fs')>();
  return {
    ...original,
    readFileSync: fsState.readFileSync,
    writeFileSync: fsState.writeFileSync,
    mkdirSync: fsState.mkdirSync,
  };
});

import { DuplicateClientMessageError, ExtensionRuntime, getClientMessageHandler, getExtensionMetadata, loadServerExtensions, type ServerExtensionAPI } from '../../src/extension-runtime.js';

function extension(slug: string, provides: ExtensionInfo['provides'] = ['server']): ExtensionInfo {
  return {
    slug,
    name: `${slug} name`,
    description: `${slug} description`,
    provides,
    dir: `fixtures/extensions/${slug}`,
  };
}

function appFake(): Express {
  return { use: vi.fn() } as unknown as Express;
}

beforeEach(() => {
  vi.clearAllMocks();
  extensions.listExtensions.mockResolvedValue([]);
  jitiState.modules.clear();
  fsState.files.clear();
});

describe('ExtensionRuntime load lifecycle', () => {
  it('loads server extensions, exposes API side effects, metadata, tools, state, and mounted router', async () => {
    const ext = extension('alpha', ['server', 'client', 'css']);
    extensions.listExtensions.mockResolvedValue([ext]);
    fsState.files.set('fixtures/extensions/alpha/state.json', JSON.stringify({ visits: 1 }));
    const clientHandler = vi.fn();
    jitiState.modules.set('fixtures/extensions/alpha/server.ts', {
      default: vi.fn((api: ServerExtensionAPI) => {
        expect(api.getState('visits')).toBe(1);
        api.setState('visits', 2);
        api.setDescription('runtime description');
        api.registerTool({ name: 'alpha-tool', description: 'tool', handler: vi.fn() });
        api.broadcast('alpha.global', { ok: true });
        api.broadcastToSession('session-1', 'alpha.session', { ok: true });
        api.onClientMessage('alpha.ping', clientHandler);
      }),
    });
    const app = appFake();
    const rt = new ExtensionRuntime();

    const tools = await rt.load(app);

    expect(tools.map(tool => tool.name)).toEqual(['alpha-tool']);
    expect(rt.getClientMessageHandler('alpha.ping')).toBe(clientHandler);
    expect(rt.getMetadata()).toEqual([{ slug: 'alpha', description: 'runtime description', tools: ['alpha-tool'], hasCSS: true, hasClient: true, hasServer: true }]);
    expect(eventBus.broadcastGlobalEvent).toHaveBeenCalledWith({ type: 'alpha.global', data: { ok: true } });
    expect(eventBus.broadcastEvent).toHaveBeenCalledWith('session-1', { type: 'alpha.session', data: { ok: true } });
    expect(fsState.mkdirSync).toHaveBeenCalledWith('fixtures/extensions/alpha', { recursive: true });
    expect(JSON.parse(fsState.files.get('fixtures/extensions/alpha/state.json') ?? '{}')).toEqual({ visits: 2 });
    expect(app.use).toHaveBeenCalledWith('/ext/alpha', expect.any(Function));
  });

  it('records non-server extensions as metadata without importing server.ts', async () => {
    extensions.listExtensions.mockResolvedValue([extension('visual', ['client', 'css'])]);
    const rt = new ExtensionRuntime();

    await expect(rt.load(appFake())).resolves.toEqual([]);

    expect(jitiState.import).not.toHaveBeenCalled();
    expect(rt.getMetadata()).toEqual([{ slug: 'visual', description: 'visual description', tools: [], hasCSS: true, hasClient: true, hasServer: false }]);
  });

  it('returns no tools and keeps metadata when server.ts has no default export', async () => {
    extensions.listExtensions.mockResolvedValue([extension('empty')]);
    jitiState.modules.set('fixtures/extensions/empty/server.ts', { named: vi.fn() });
    const rt = new ExtensionRuntime();

    await expect(rt.load(appFake())).resolves.toEqual([]);

    expect(rt.getMetadata()).toEqual([{ slug: 'empty', description: 'empty description', tools: [], hasCSS: false, hasClient: false, hasServer: true }]);
  });

  it('isolates ordinary extension load failures and continues loading the next extension', async () => {
    extensions.listExtensions.mockResolvedValue([extension('bad'), extension('good')]);
    jitiState.modules.set('fixtures/extensions/bad/server.ts', { default: () => { throw new Error('boom'); } });
    jitiState.modules.set('fixtures/extensions/good/server.ts', { default: (api: ServerExtensionAPI) => api.registerTool({ name: 'good-tool', description: 'tool', handler: vi.fn() }) });
    const rt = new ExtensionRuntime();

    const tools = await rt.load(appFake());

    expect(tools.map(tool => tool.name)).toEqual(['good-tool']);
    expect(rt.getMetadata().map(meta => meta.slug)).toEqual(['bad', 'good']);
  });

  it('propagates duplicate client message errors because they are global namespace collisions', async () => {
    extensions.listExtensions.mockResolvedValue([extension('dup')]);
    jitiState.modules.set('fixtures/extensions/dup/server.ts', {
      default: (api: ServerExtensionAPI) => {
        api.onClientMessage('dup.ping', vi.fn());
        api.onClientMessage('dup.ping', vi.fn());
      },
    });
    const rt = new ExtensionRuntime();

    await expect(rt.load(appFake())).rejects.toThrow(DuplicateClientMessageError);
  });

  it('reload clears stale handlers and metadata before loading fresh extensions', async () => {
    const rt = new ExtensionRuntime();
    rt.registerClientMessageHandler('old.message', vi.fn(), 'old');
    extensions.listExtensions.mockResolvedValue([extension('fresh')]);
    jitiState.modules.set('fixtures/extensions/fresh/server.ts', { default: (api: ServerExtensionAPI) => api.onClientMessage('fresh.message', vi.fn()) });

    await rt.reload(appFake());

    expect(rt.getClientMessageHandler('old.message')).toBeUndefined();
    expect(rt.getClientMessageHandler('fresh.message')).toBeDefined();
    expect(rt.getMetadata().map(meta => meta.slug)).toEqual(['fresh']);
  });

  it('getState returns undefined for missing or malformed state files and setState starts fresh', async () => {
    extensions.listExtensions.mockResolvedValue([extension('stateful')]);
    fsState.files.set('fixtures/extensions/stateful/state.json', '{bad json');
    jitiState.modules.set('fixtures/extensions/stateful/server.ts', {
      default: (api: ServerExtensionAPI) => {
        expect(api.getState('anything')).toBeUndefined();
        api.setState('answer', 42);
      },
    });

    await new ExtensionRuntime().load(appFake());

    expect(JSON.parse(fsState.files.get('fixtures/extensions/stateful/state.json') ?? '{}')).toEqual({ answer: 42 });
  });
});

describe('extensionRuntime singleton wrappers', () => {
  it('loadServerExtensions and getter wrappers delegate to the singleton runtime', async () => {
    extensions.listExtensions.mockResolvedValue([extension('singleton')]);
    const handler = vi.fn();
    jitiState.modules.set('fixtures/extensions/singleton/server.ts', { default: (api: ServerExtensionAPI) => api.onClientMessage('singleton.message', handler) });

    await loadServerExtensions(appFake());

    expect(getClientMessageHandler('singleton.message')).toBe(handler);
    expect(getExtensionMetadata().map(meta => meta.slug)).toContain('singleton');
  });
});
