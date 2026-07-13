import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

type AppletMeta = {
  slug: string;
  name: string;
  description?: string;
  params?: Record<string, unknown>;
  updatedAt?: string;
  paths?: Record<string, string>;
  deprecated?: boolean;
  replacedBy?: string;
};

type StoredApplet = {
  meta: AppletMeta;
  html: string;
  js?: string;
  css?: string;
};

type SessionMeta = {
  activeApplet?: string;
  appletParams?: Record<string, string>;
  appletPanelVisible?: boolean;
};

type OutputRecord = {
  data: string | Buffer;
  metadata: Record<string, unknown>;
};

type ExtensionInfo = {
  slug: string;
  dir: string;
  name: string;
  provides: ('css' | 'client' | 'server')[];
};

const fakes = vi.hoisted(() => ({
  homeDir: '',
  preferences: { theme: 'dark', fontSize: 14 },
  models: [
    { id: 'gpt-test', name: 'GPT Test', family: 'test' },
    { id: 'claude-test', name: 'Claude Test', family: 'test' },
  ],
  usage: { total: { inputTokens: 10, outputTokens: 20 } },
  outputs: new Map<string, OutputRecord>(),
  appletUserState: new Map<string, unknown>(),
  activeAppletSlug: new Map<string, string>(),
  sessionMeta: new Map<string, SessionMeta>(),
  applets: [] as AppletMeta[],
  appletLoads: new Map<string, StoredApplet>(),
  appletAssets: new Map<string, string>(),
  extensions: [] as ExtensionInfo[],
  history: [] as Array<{ type: string; data?: unknown }>,
  historySessionId: undefined as string | undefined,
  activeDispatches: 0,
  getModels: vi.fn(),
  getHistory: vi.fn(),
  updatePreferences: vi.fn(),
  setAppletUserState: vi.fn(),
  getAppletUserState: vi.fn(),
  clearAppletUserState: vi.fn(),
  getActiveAppletSlug: vi.fn(),
  setActiveAppletSlug: vi.fn(),
  listApplets: vi.fn(),
  loadApplet: vi.fn(),
  resolveAppletAsset: vi.fn(),
  listExtensions: vi.fn(),
  getExtension: vi.fn(),
  requestRestart: vi.fn(),
  modelCostSummary: vi.fn(),
}));

vi.mock('os', async importOriginal => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => fakes.homeDir };
});

vi.mock('../../src/session-manager.js', () => ({
  sessionManager: {
    getModels: fakes.getModels,
    getHistory: fakes.getHistory,
    getSessionCwd: () => fakes.homeDir,
  },
}));

vi.mock('../../src/session-state.js', () => ({
  sessionState: {
    get preferences() { return fakes.preferences; },
    updatePreferences: fakes.updatePreferences,
    get sessionIdForHistory() { return fakes.historySessionId; },
  },
}));

vi.mock('../../src/storage.js', () => ({
  getOutput: (id: string) => fakes.outputs.get(id),
  updateSessionMeta: (sessionId: string, updater: (meta: SessionMeta) => void, opts?: { createIfMissing?: boolean }) => {
    const existing = fakes.sessionMeta.get(sessionId);
    if (!existing && opts?.createIfMissing === false) {
      return false;
    }
    const meta = existing ?? {};
    updater(meta);
    fakes.sessionMeta.set(sessionId, meta);
    return true;
  },
}));

vi.mock('../../src/applet-state.js', () => ({
  setAppletUserState: fakes.setAppletUserState,
  getAppletUserState: fakes.getAppletUserState,
  clearAppletUserState: fakes.clearAppletUserState,
  getActiveAppletSlug: fakes.getActiveAppletSlug,
  setActiveAppletSlug: fakes.setActiveAppletSlug,
}));

vi.mock('../../src/applet-store.js', () => ({
  listApplets: fakes.listApplets,
  loadApplet: fakes.loadApplet,
  resolveAppletAsset: fakes.resolveAppletAsset,
}));

vi.mock('../../src/extension-store.js', () => ({
  listExtensions: fakes.listExtensions,
  getExtension: fakes.getExtension,
}));

vi.mock('../../src/usage-state.js', () => ({
  getUsage: () => fakes.usage,
}));

vi.mock('../../src/restart-manager.js', () => ({
  requestRestart: fakes.requestRestart,
  getActiveDispatches: () => fakes.activeDispatches,
}));

vi.mock('../../src/model-billing.js', () => ({
  modelCostSummary: fakes.modelCostSummary,
}));

let server: Server;
let base: string;
let root: string;
let workspace: string;
let home: string;
let extensionDir: string;
const originalCwd = process.cwd();

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'caco-api-harness-'));
  workspace = join(root, 'workspace');
  home = join(root, 'home');
  extensionDir = join(root, 'extension-one');
  fakes.homeDir = home;

  mkdirSync(join(workspace, 'public', 'themes'), { recursive: true });
  mkdirSync(join(workspace, 'dir'), { recursive: true });
  mkdirSync(join(workspace, '.hidden'), { recursive: true });
  mkdirSync(join(workspace, '.caco', 'prompts'), { recursive: true });
  mkdirSync(join(home, '.caco', 'prompts'), { recursive: true });
  mkdirSync(extensionDir, { recursive: true });

  writeFileSync(join(workspace, 'public', 'themes', 'dark-mode.css'), 'body{}');
  writeFileSync(join(workspace, 'public', 'themes', 'blue.css'), 'body{}');
  writeFileSync(join(workspace, 'dir', 'file.txt'), 'hello file');
  writeFileSync(join(workspace, 'dir', 'page.html'), '<h1>Hello</h1>');
  writeFileSync(join(workspace, '.hidden', 'secret.txt'), 'secret');
  writeFileSync(join(workspace, 'root.md'), 'root');
  writeFileSync(join(workspace, '.gitignore'), 'ignored.md\n');
  writeFileSync(join(workspace, 'ignored.md'), 'ignored');
  writeFileSync(join(workspace, '.caco', 'prompts', 'local.md'), 'Local prompt\nbody');
  writeFileSync(join(workspace, '.caco', 'prompts', 'shared.md'), 'Local shared wins');
  writeFileSync(join(home, '.caco', 'prompts', 'global.md'), 'Global prompt');
  writeFileSync(join(home, '.caco', 'prompts', 'shared.md'), 'Global shared loses');
  writeFileSync(join(extensionDir, 'style.css'), '.x { color: red; }');
  writeFileSync(join(extensionDir, 'client.ts'), 'export const answer = 42; console.log(answer);');

  process.chdir(workspace);
  const { router } = await import('../../src/routes/api.js');
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(async () => {
  process.chdir(originalCwd);
  if (server) {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  // Best-effort: the temp tree lives under the OS temp dir, so a Windows
  // file-lock EPERM on teardown leaks a harmless dir the OS reclaims later.
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch { /* leaked temp dir under os.tmpdir() — harmless */ }
});

beforeEach(() => {
  fakes.outputs.clear();
  fakes.appletUserState.clear();
  fakes.activeAppletSlug.clear();
  fakes.sessionMeta.clear();
  fakes.appletAssets.clear();
  fakes.history = [];
  fakes.historySessionId = undefined;
  fakes.activeDispatches = 0;
  fakes.applets = [{ slug: 'demo', name: 'Demo', description: 'Demo applet', params: { q: { type: 'string' } }, updatedAt: 'now', paths: { root: 'demo' } }];
  fakes.appletLoads = new Map([
    ['demo', { meta: { slug: 'demo', name: 'Demo' }, html: '<section>Demo</section>', js: 'window.demo = true;', css: '.demo{}' }],
  ]);
  fakes.extensions = [{ slug: 'ext-one', dir: extensionDir, name: 'Extension One', provides: ['css', 'client'] }];

  fakes.getModels.mockImplementation(() => fakes.models);
  fakes.getHistory.mockImplementation(async () => fakes.history);
  fakes.updatePreferences.mockImplementation(async (patch: Record<string, unknown>, clientId?: string) => ({ ...fakes.preferences, ...patch, clientId }));
  fakes.setAppletUserState.mockImplementation((sessionId: string | undefined, state: unknown) => { fakes.appletUserState.set(sessionId ?? '', state); });
  fakes.getAppletUserState.mockImplementation((sessionId: string | undefined) => fakes.appletUserState.get(sessionId ?? '') ?? null);
  fakes.clearAppletUserState.mockImplementation((sessionId: string | undefined) => { fakes.appletUserState.delete(sessionId ?? ''); });
  fakes.getActiveAppletSlug.mockImplementation((sessionId: string | undefined) => fakes.activeAppletSlug.get(sessionId ?? '') ?? null);
  fakes.setActiveAppletSlug.mockImplementation((sessionId: string | undefined, slug: string) => { fakes.activeAppletSlug.set(sessionId ?? '', slug); });
  fakes.listApplets.mockImplementation(async () => fakes.applets);
  fakes.loadApplet.mockImplementation(async (slug: string) => fakes.appletLoads.get(slug) ?? null);
  fakes.resolveAppletAsset.mockImplementation(async (slug: string, filename: string) => fakes.appletAssets.get(`${slug}/${filename}`) ?? null);
  fakes.listExtensions.mockImplementation(async () => fakes.extensions);
  fakes.getExtension.mockImplementation(async (slug: string) => fakes.extensions.find(e => e.slug === slug) ?? null);
  fakes.requestRestart.mockClear();
  fakes.modelCostSummary.mockImplementation((model: { id: string }) => ({ inputCost: model.id.length, outputCost: model.id.length * 2 }));
});

const api = (path: string) => `${base}${path}`;
const getJson = async (path: string) => (await fetch(api(path))).json() as Promise<any>;
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(api(path), { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const putText = (path: string, body: string) => fetch(api(path), { method: 'PUT', headers: { 'content-type': 'text/plain' }, body });

describe('api route harness', () => {
  it('returns cost-enriched models and raw models', async () => {
    const models = await getJson('/models');
    expect(models.models).toEqual([
      { id: 'gpt-test', name: 'GPT Test', inputCost: 8, outputCost: 16 },
      { id: 'claude-test', name: 'Claude Test', inputCost: 11, outputCost: 22 },
    ]);

    const raw = await getJson('/models/raw');
    expect(raw.models).toEqual(fakes.models);
  });

  it('returns usage, themes, and preferences', async () => {
    expect(await getJson('/usage')).toEqual({ usage: fakes.usage });
    expect(await getJson('/themes')).toEqual({ themes: [{ id: 'blue', name: 'Blue' }, { id: 'dark-mode', name: 'Dark Mode' }] });
    expect(await getJson('/preferences')).toEqual(fakes.preferences);
  });

  it('updates preferences with the client id header', async () => {
    const response = await post('/preferences', { theme: 'light' }, { 'x-client-id': 'client-1' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ theme: 'light', fontSize: 14, clientId: 'client-1' });
  });

  it('serves output as json, raw text, and a 404', async () => {
    fakes.outputs.set('one', { data: 'hello output', metadata: { mimeType: 'text/plain', createdAt: 'today' } });
    const jsonResponse = await fetch(api('/outputs/one?format=json'));
    expect(jsonResponse.status).toBe(200);
    expect(await jsonResponse.json()).toEqual({ id: 'one', data: 'hello output', metadata: { mimeType: 'text/plain', createdAt: 'today' }, createdAt: 'today' });

    const rawResponse = await fetch(api('/outputs/one'));
    expect(rawResponse.headers.get('content-type')).toContain('text/plain');
    expect(await rawResponse.text()).toBe('hello output');

    const missing = await fetch(api('/outputs/missing'));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toMatch(/not found/i);
  });

  it('writes tmp files from base64 data and rejects invalid tmpfile input', async () => {
    expect((await post('/tmpfile', {})).status).toBe(400);
    expect((await post('/tmpfile', { data: 'data:text/plain,not-base64' })).status).toBe(400);

    const response = await post('/tmpfile', { data: Buffer.from('tmp data').toString('base64'), mimeType: 'text/plain', filename: 'saved.txt' });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, filename: 'saved.txt', size: 8, mimeType: 'text/plain' });
    expect(readFileSync(body.path, 'utf-8')).toBe('tmp data');
    expect(body.path.startsWith(join(home, '.caco', 'tmp'))).toBe(true);
  });

  it('returns filtered debug messages or an empty history without a session', async () => {
    expect(await getJson('/debug/messages')).toEqual({ count: 0, messages: [] });

    fakes.historySessionId = 's1';
    fakes.history = [
      { type: 'user.message', data: { content: 'hello' } },
      { type: 'tool.execution', data: { content: 'skip me' } },
      { type: 'assistant.message', data: { content: 'hi', toolRequests: [{}] } },
    ];
    const body = await getJson('/debug/messages');
    expect(body).toEqual({ count: 2, messages: [
      { type: 'user.message', content: 'hello', hasToolRequests: false },
      { type: 'assistant.message', content: 'hi', hasToolRequests: true },
    ] });
    expect(fakes.getHistory).toHaveBeenCalledWith('s1');
  });

  it('gets and sets applet state with validation', async () => {
    const invalid = await post('/applet/state?sessionId=s1', null);
    expect(invalid.status).toBe(400);

    const response = await post('/applet/state?sessionId=s1', { selected: 2 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(await getJson('/applet/state?sessionId=s1')).toEqual({ state: { selected: 2 } });
  });

  it('lists applets and loads an applet while updating session metadata', async () => {
    const listed = await getJson('/applets');
    expect(listed.applets[0]).toMatchObject({ slug: 'demo', name: 'Demo', description: 'Demo applet', deprecated: false, replacedBy: null });

    fakes.activeAppletSlug.set('s1', 'old');
    fakes.appletUserState.set('s1', { stale: true });
    fakes.sessionMeta.set('s1', {});
    const response = await post('/applets/demo/load', { sessionId: 's1', urlParams: { q: 'term' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, slug: 'demo', title: 'Demo', html: '<section>Demo</section>' });
    expect(fakes.clearAppletUserState).toHaveBeenCalledWith('s1');
    expect(fakes.sessionMeta.get('s1')).toEqual({ activeApplet: 'demo', appletParams: { q: 'term' }, appletPanelVisible: true });

    const missing = await post('/applets/missing/load', {});
    expect(missing.status).toBe(404);
  });

  it('serves applet assets and validates asset paths', async () => {
    const assetPath = join(root, 'asset.json');
    writeFileSync(assetPath, '{"ok":true}');
    fakes.appletAssets.set('demo/data.json', assetPath);

    const response = await fetch(api('/applets/demo/assets/data.json'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ ok: true });

    expect((await fetch(api('/applets/Bad/assets/data.json'))).status).toBe(400);
    expect((await fetch(api('/applets/demo/assets/missing.json'))).status).toBe(404);
  });

  it('lists files and reports missing directories', async () => {
    const body = await getJson('/files?path=dir');
    expect(body.path).toBe(join(workspace, 'dir'));
    expect(body.files).toEqual([{ name: 'file.txt', type: 'file', size: 10 }, { name: 'page.html', type: 'file', size: 14 }]);

    const missing = await fetch(api('/files?path=missing-dir'));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toMatch(/directory not found/i);
  });

  it('serves files with validation and not-found behavior', async () => {
    const missingPath = await fetch(api('/file'));
    expect(missingPath.status).toBe(400);

    const directory = await fetch(api('/file?path=dir'));
    expect(directory.status).toBe(400);
    expect((await directory.json()).error).toMatch(/directory/i);

    const response = await fetch(api('/file?path=dir/page.html'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(await response.text()).toBe('<h1>Hello</h1>');

    const missing = await fetch(api('/file?path=missing.txt'));
    expect(missing.status).toBe(404);
  });

  it('writes files and rejects missing parent directories', async () => {
    const response = await putText('/files/dir/written.txt', 'written body');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, path: join(workspace, 'dir', 'written.txt'), size: 12 });
    expect(readFileSync(join(workspace, 'dir', 'written.txt'), 'utf-8')).toBe('written body');

    const missingParent = await putText('/files/no-parent/file.txt', 'x');
    expect(missingParent.status).toBe(400);
    expect((await missingParent.json()).error).toMatch(/parent directory/i);
  });

  it('lists project files with fuzzy search and missing-directory errors', async () => {
    const all = await getJson(`/project-files?cwd=${encodeURIComponent(workspace)}`);
    expect(all.files).toContain('dir/file.txt');
    expect(all.files).toContain('root.md');
    expect(all.files).not.toContain('ignored.md');

    const searched = await getJson(`/project-files?cwd=${encodeURIComponent(workspace)}&q=page`);
    expect(searched.files[0]).toBe('dir/page.html');

    const missing = await fetch(api(`/project-files?cwd=${encodeURIComponent(join(workspace, 'missing'))}`));
    expect(missing.status).toBe(404);
  });

  it('lists and reads prompts from hermetic local and home directories', async () => {
    const listed = await getJson('/prompts');
    expect(listed.prompts).toEqual(expect.arrayContaining([
      { name: 'global', description: 'Global prompt' },
      { name: 'local', description: 'Local prompt' },
      { name: 'shared', description: 'Local shared wins' },
    ]));

    expect(await getJson('/prompts/shared')).toEqual({ name: 'shared', content: 'Local shared wins' });
    const missing = await fetch(api('/prompts/missing'));
    expect(missing.status).toBe(404);
  });

  it('lists extensions and serves css plus bundled client js', async () => {
    expect(await getJson('/extensions')).toEqual({ extensions: fakes.extensions });

    const css = await fetch(api('/extensions/ext-one/style.css'));
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
    expect(await css.text()).toBe('.x { color: red; }');

    const client = await fetch(api('/extensions/ext-one/client.js'));
    expect(client.status).toBe(200);
    expect(client.headers.get('content-type')).toContain('application/javascript');
    expect(await client.text()).toContain('answer');

    const cachedClient = await fetch(api('/extensions/ext-one/client.js'));
    expect(cachedClient.status).toBe(200);
    expect(await cachedClient.text()).toContain('answer');

    expect((await fetch(api('/extensions/missing/style.css'))).status).toBe(404);
    expect((await fetch(api('/extensions/missing/client.js'))).status).toBe(404);
  });

  it('schedules restart and reports active dispatches', async () => {
    fakes.activeDispatches = 2;
    const response = await post('/restart', {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, activeDispatches: 2, message: 'Restart scheduled. Waiting for 2 active session(s) to complete.' });
    expect(fakes.requestRestart).toHaveBeenCalledTimes(1);
  });

  it('keeps all filesystem fixtures inside the harness root', () => {
    expect(existsSync(home)).toBe(true);
    expect(home.startsWith(root)).toBe(true);
    expect(workspace.startsWith(root)).toBe(true);
  });
});
