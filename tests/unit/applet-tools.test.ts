import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppletMeta } from '../../src/applet-store.js';

const appletState = vi.hoisted(() => ({
  getAppletUserState: vi.fn(),
  getAppletNavigation: vi.fn(),
  getActiveAppletSlug: vi.fn(),
}));
const appletStore = vi.hoisted(() => ({ listApplets: vi.fn() }));
const restartManager = vi.hoisted(() => ({
  requestRestart: vi.fn(),
  getActiveDispatches: vi.fn(),
}));

vi.mock('../../src/applet-state.js', () => appletState);
vi.mock('../../src/applet-store.js', () => appletStore);
vi.mock('../../src/restart-manager.js', () => restartManager);

import {
  APPLET_HOWTO,
  buildAppletUsage,
  createAppletTools,
  formatAppletUsage,
} from '../../src/applet-tools.js';

type TestInput = Omit<AppletMeta, 'createdAt' | 'updatedAt'>;

interface ToolWithHandler<TArgs extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  handler: (args: TArgs) => Promise<Record<string, unknown>>;
}

function testFormat(applet: TestInput): string {
  return formatAppletUsage({ ...applet, paths: {}, createdAt: '', updatedAt: '' });
}

function applet(
  slug: string,
  extra: Partial<AppletMeta & { paths: unknown }> = {}
): AppletMeta & { paths: unknown } {
  return {
    slug,
    name: `${slug} name`,
    description: `${slug} description`,
    createdAt: '',
    updatedAt: '',
    paths: {},
    ...extra,
  };
}

function createTools(pushStateToApplet = vi.fn(() => true)): ToolWithHandler[] {
  return createAppletTools('/project', { id: 'sess-1' }, pushStateToApplet) as unknown as ToolWithHandler[];
}

function getTool(tools: ToolWithHandler[], name: string): ToolWithHandler {
  const tool = tools.find(t => t.name === name);
  expect(tool).toBeDefined();
  return tool as ToolWithHandler;
}

beforeEach(() => {
  vi.clearAllMocks();
  appletState.getAppletUserState.mockReturnValue({ selected: 'file.txt', count: 2 });
  appletState.getAppletNavigation.mockReturnValue({
    stack: [{ slug: 'files', label: 'Files' }],
    urlParams: { path: 'src/index.ts' },
  });
  appletState.getActiveAppletSlug.mockReturnValue('files');
  appletStore.listApplets.mockResolvedValue([]);
  restartManager.getActiveDispatches.mockReturnValue(0);
});

describe('formatAppletUsage', () => {
  it('formats applet with required params', () => {
    const result = testFormat({
      slug: 'text-editor',
      name: 'Text Editor',
      description: 'Edit text files',
      params: {
        path: { required: true, description: 'Absolute path to file' },
      },
    });

    expect(result).toContain('## text-editor');
    expect(result).toContain('Edit text files');
    expect(result).toContain('/?applet=text-editor&path=<path>');
    expect(result).toContain('Required: path - Absolute path to file');
  });

  it('uses agentUsage.purpose over description', () => {
    const result = testFormat({
      slug: 'git-status',
      name: 'Git Status',
      description: 'View git status',
      agentUsage: { purpose: 'Show git repository status with staging controls' },
      params: { path: { required: true, description: 'Repo path' } },
    });

    expect(result).toContain('Show git repository status with staging controls');
    expect(result).not.toContain('View git status');
  });

  it('handles optional params', () => {
    const result = testFormat({
      slug: 'git-diff',
      name: 'Git Diff',
      description: 'View diffs',
      params: {
        path: { required: true, description: 'Repo path' },
        staged: { required: false, description: 'Show staged diff' },
      },
    });

    expect(result).toContain('Required: path - Repo path');
    expect(result).toContain('Optional: staged - Show staged diff');
  });

  it('handles applet with no params', () => {
    const result = testFormat({
      slug: 'calculator',
      name: 'Calculator',
      description: 'Perform calculations',
    });

    expect(result).toContain('## calculator');
    expect(result).toContain('/?applet=calculator');
    expect(result).not.toContain('Required:');
    expect(result).not.toContain('Optional:');
  });

  it('falls back to name when no description or purpose', () => {
    const result = testFormat({
      slug: 'my-applet',
      name: 'My Applet',
    });

    expect(result).toContain('My Applet');
  });

  it('includes stateSchema get and set keys', () => {
    const result = testFormat({
      slug: 'text-editor',
      name: 'Text Editor',
      description: 'Edit files',
      params: { path: { required: true, description: 'File path' } },
      stateSchema: {
        get: { path: 'string', loaded: 'boolean', size: 'number' },
        set: { content: 'string - replaces content' },
      },
    });

    expect(result).toContain('State (get_applet_state): path, loaded, size');
    expect(result).toContain('State (set_applet_state): content');
  });

  it('handles stateSchema with only get', () => {
    const result = testFormat({
      slug: 'image-viewer',
      name: 'Image Viewer',
      description: 'View images',
      stateSchema: {
        get: { imagePath: 'string', loaded: 'boolean' },
        set: null,
      },
    });

    expect(result).toContain('State (get_applet_state): imagePath, loaded');
    expect(result).not.toContain('set_applet_state');
  });
});

describe('buildAppletUsage', () => {
  it('lists non-deprecated applet usage and omits deprecated entries', async () => {
    appletStore.listApplets.mockResolvedValue([
      applet('files', { name: 'Files', params: { path: { required: false, description: 'File path' } } }),
      applet('old-files', { deprecated: true, replacedBy: 'files' }),
    ]);

    const usage = await buildAppletUsage();

    expect(appletStore.listApplets).toHaveBeenCalledOnce();
    expect(usage).toContain('# Applet Usage');
    expect(usage).toContain('## files');
    expect(usage).toContain('Optional: path - File path');
    expect(usage).not.toContain('old-files');
  });

  it('reports deprecated, missing, and empty applet sets', async () => {
    appletStore.listApplets.mockResolvedValue([applet('legacy', { deprecated: true, replacedBy: 'files' })]);
    await expect(buildAppletUsage('legacy')).resolves.toBe('Applet "legacy" is deprecated. Use "files" instead.');

    appletStore.listApplets.mockResolvedValue([applet('files')]);
    await expect(buildAppletUsage('missing')).resolves.toBe('Applet "missing" not found. Available: files');

    appletStore.listApplets.mockResolvedValue([]);
    await expect(buildAppletUsage()).resolves.toBe('No applets installed. Use caco_docs section="applets:create" to create one.');
  });
});

describe('applet tool handlers', () => {
  it('gets full applet state with navigation metadata', async () => {
    const out = await getTool(createTools(), 'get_applet_state').handler({});

    expect(appletState.getAppletUserState).toHaveBeenCalledWith('sess-1');
    expect(appletState.getAppletNavigation).toHaveBeenCalledWith('sess-1');
    expect(appletState.getActiveAppletSlug).toHaveBeenCalledWith('sess-1');
    expect(out.resultType).toBe('success');
    expect(out.textResultForLlm).toContain('"selected": "file.txt"');
    expect(out.textResultForLlm).toContain('"activeApplet":"files"');
  });

  it('gets one state key and reports missing keys with available names', async () => {
    const tool = getTool(createTools(), 'get_applet_state');

    const selected = await tool.handler({ key: 'selected' });
    expect(selected.textResultForLlm).toContain('Applet state["selected"]: "file.txt"');
    expect(selected.textResultForLlm).toContain('"urlParams":{"path":"src/index.ts"}');

    const missing = await tool.handler({ key: 'absent' });
    expect(missing.textResultForLlm).toContain('Key "absent" not found');
    expect(missing.textResultForLlm).toContain('Available keys: selected, count');
  });

  it('reports empty state and no active applet', async () => {
    appletState.getAppletUserState.mockReturnValue({});
    appletState.getAppletNavigation.mockReturnValue({ stack: [], urlParams: {} });
    appletState.getActiveAppletSlug.mockReturnValue(null);

    const out = await getTool(createTools(), 'get_applet_state').handler({});

    expect(out.textResultForLlm).toContain('No applet state set. No applet open.');
    expect(out.textResultForLlm).toContain('"stack":[]');
  });

  it('pushes state to a targeted applet session or broadcasts with null session', async () => {
    const pushStateToApplet = vi.fn(() => true);
    const tool = getTool(createTools(pushStateToApplet), 'set_applet_state');

    const targeted = await tool.handler({ sessionId: 'other-session', data: { answer: 42 } });
    expect(pushStateToApplet).toHaveBeenCalledWith('other-session', { answer: 42 });
    expect(targeted.textResultForLlm).toBe('State pushed to applet: {"answer":42}');

    await tool.handler({ data: { broadcast: true } });
    expect(pushStateToApplet).toHaveBeenLastCalledWith(null, { broadcast: true });
  });

  it('reports when no applet websocket accepted pushed state', async () => {
    const pushStateToApplet = vi.fn(() => false);
    const out = await getTool(createTools(pushStateToApplet), 'set_applet_state').handler({
      data: { answer: 42 },
    });

    expect(out.textResultForLlm).toBe('No applet WebSocket connections available. The applet may not be open.');
    expect(out.resultType).toBe('success');
  });

  it('schedules restart and includes active dispatch telemetry', async () => {
    restartManager.getActiveDispatches.mockReturnValue(2);

    const out = await getTool(createTools(), 'restart_server').handler({});

    expect(restartManager.requestRestart).toHaveBeenCalledOnce();
    expect(out.textResultForLlm).toContain('Waiting for 2 active session(s)');
    expect(out.resultType).toBe('success');
    expect(out.toolTelemetry).toMatchObject({
      restartScheduled: true,
      activeDispatches: 2,
      pid: process.pid,
    });
  });
});

describe('APPLET_HOWTO', () => {
  it('contains key applet authoring sections', () => {
    expect(APPLET_HOWTO).toContain('# Creating Applets in Caco');
    expect(APPLET_HOWTO).toContain('## File Structure');
    expect(APPLET_HOWTO).toContain('## JavaScript APIs');
    expect(APPLET_HOWTO).toContain('setAppletState');
  });
});
