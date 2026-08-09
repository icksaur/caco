import { beforeEach, describe, expect, it, vi } from 'vitest';

interface UserPreferences {
  lastCwd: string;
  lastModel: string;
  lastSessionId: string | null;
  autoContinueEnabled?: boolean;
}

interface ResumeResult {
  sessionId: string;
  usedFallbackCwd?: string;
  repairMessage?: string;
}

interface SessionStateConfig {
  toolFactory: (sessionCwd: string, sessionRef: { id: string }) => unknown[];
  excludedTools?: string[];
}

const deps = vi.hoisted(() => ({
  sessionManager: {
    init: vi.fn(),
    hasMessages: vi.fn(),
    getMostRecentForCwd: vi.fn(),
    isActive: vi.fn(),
    resume: vi.fn(),
    create: vi.fn(),
    getSessionCwd: vi.fn(),
    delete: vi.fn(),
    getHistory: vi.fn(),
    stop: vi.fn(),
  },
  loadPreferences: vi.fn(),
  savePreferences: vi.fn(),
  resolveModelAlias: vi.fn(),
  resolveSystemMessage: vi.fn(),
  buildSystemMessage: vi.fn(),
}));

vi.mock('../../src/session-manager.js', () => ({ sessionManager: deps.sessionManager }));
vi.mock('../../src/preferences.js', () => ({
  loadPreferences: deps.loadPreferences,
  savePreferences: deps.savePreferences,
  DEFAULT_MODEL: 'default-model',
  resolveModelAlias: deps.resolveModelAlias,
}));
vi.mock('../../src/prompts.js', () => ({
  resolveSystemMessage: deps.resolveSystemMessage,
  buildSystemMessage: deps.buildSystemMessage,
}));

const config: SessionStateConfig = {
  toolFactory: () => [],
  excludedTools: ['disabled_tool'],
};

function freshPreferences(overrides: Partial<UserPreferences> = {}): UserPreferences {
  return { lastCwd: '', lastModel: 'saved-model', lastSessionId: null, ...overrides };
}

async function importStateModule() {
  return import('../../src/session-state.js');
}

async function createState(preferences: UserPreferences) {
  deps.loadPreferences.mockResolvedValue(preferences);
  const mod = await importStateModule();
  return mod.createSessionState(config as unknown as import('../../src/types.js').SessionStateConfig);
}

beforeEach(() => {
  vi.resetModules();
  deps.sessionManager.init.mockReset().mockResolvedValue(undefined);
  deps.sessionManager.hasMessages.mockReset().mockReturnValue(false);
  deps.sessionManager.getMostRecentForCwd.mockReset().mockReturnValue(null);
  deps.sessionManager.isActive.mockReset().mockReturnValue(false);
  deps.sessionManager.resume.mockReset().mockResolvedValue({ sessionId: 'resumed-1' } satisfies ResumeResult);
  deps.sessionManager.create.mockReset().mockResolvedValue('created-1');
  deps.sessionManager.getSessionCwd.mockReset().mockReturnValue(null);
  deps.sessionManager.delete.mockReset().mockResolvedValue(undefined);
  deps.sessionManager.getHistory.mockReset().mockResolvedValue([]);
  deps.sessionManager.stop.mockReset().mockResolvedValue(undefined);
  deps.loadPreferences.mockReset().mockResolvedValue(freshPreferences());
  deps.savePreferences.mockReset().mockResolvedValue(undefined);
  deps.resolveModelAlias.mockReset().mockImplementation((model: string) => 'resolved-' + model);
  deps.resolveSystemMessage.mockReset().mockImplementation((message: string, cwd: string) => message + '@' + cwd);
  // Returns a DIFFERENT value on each call, so a create that reuses a captured
  // prompt instead of rebuilding is observable (spec-memory-frozen-in-startup-prompt).
  let buildCount = 0;
  deps.buildSystemMessage.mockReset().mockImplementation(async () => `built-prompt-${++buildCount}`);
});

describe('createSessionState', () => {
  it('initializes the manager and queues a saved session with messages for first-message resume', async () => {
    const preferences = freshPreferences({ lastCwd: '/workspace', lastSessionId: 'saved-1' });
    deps.sessionManager.hasMessages.mockImplementation((id: string) => id === 'saved-1');
    const state = await createState(preferences);

    expect(deps.sessionManager.init).toHaveBeenCalledOnce();
    expect(state.getSessionIdForHistory()).toBe('saved-1');
    expect(deps.savePreferences).not.toHaveBeenCalled();
  });

  it('adopts the most recent cwd session when no preference has been written', async () => {
    const preferences = freshPreferences({ lastSessionId: undefined as unknown as null });
    deps.sessionManager.getMostRecentForCwd.mockReturnValue('recent-1');
    deps.sessionManager.hasMessages.mockImplementation((id: string) => id === 'recent-1');
    const state = await createState(preferences);

    expect(deps.sessionManager.getMostRecentForCwd).toHaveBeenCalledWith(process.cwd());
    expect(state.sessionIdForHistory).toBe('recent-1');
    expect(preferences.lastSessionId).toBe('recent-1');
    expect(deps.savePreferences).toHaveBeenCalledWith(preferences);
  });

  it('leaves history empty when preferences explicitly request a fresh chat', async () => {
    const state = await createState(freshPreferences({ lastSessionId: null }));
    expect(state.activeSessionId).toBeNull();
    expect(state.sessionIdForHistory).toBeNull();
    expect(deps.sessionManager.getMostRecentForCwd).not.toHaveBeenCalled();
  });
});

describe('SessionState.ensureSession', () => {
  it('resumes a pending session once and persists the active id', async () => {
    const preferences = freshPreferences({ lastCwd: '/workspace', lastSessionId: 'saved-1' });
    deps.sessionManager.hasMessages.mockReturnValue(true);
    deps.sessionManager.resume.mockResolvedValue({ sessionId: 'saved-1', repairMessage: 'fixed' } satisfies ResumeResult);
    const state = await createState(preferences);

    const id = await state.ensureSession('ignored-model');

    expect(id).toBe('saved-1');
    expect(state.getActiveSessionId()).toBe('saved-1');
    expect(state.getSessionIdForHistory()).toBe('saved-1');
    expect(deps.sessionManager.resume).toHaveBeenCalledWith('saved-1', { toolFactory: config.toolFactory, excludedTools: ['disabled_tool'] });
    expect(deps.sessionManager.create).not.toHaveBeenCalled();
    expect(deps.savePreferences).toHaveBeenLastCalledWith(expect.objectContaining({ lastSessionId: 'saved-1' }));

    deps.sessionManager.isActive.mockReturnValue(true);
    expect(await state.ensureSession('new-model')).toBe('saved-1');
    expect(deps.sessionManager.create).not.toHaveBeenCalled();
  });

  it('falls back to creating a session when pending resume fails', async () => {
    const preferences = freshPreferences({ lastCwd: '/workspace', lastSessionId: 'saved-1' });
    deps.sessionManager.hasMessages.mockReturnValue(true);
    deps.sessionManager.resume.mockRejectedValue(new Error('resume failed'));
    deps.sessionManager.create.mockResolvedValue('created-after-fail');
    const state = await createState(preferences);

    const id = await state.ensureSession('alias-model');

    expect(id).toBe('created-after-fail');
    expect(deps.resolveModelAlias).toHaveBeenCalledWith('alias-model');
    expect(deps.resolveSystemMessage).toHaveBeenCalledWith('built-prompt-1', '/workspace');
    expect(deps.sessionManager.create).toHaveBeenCalledWith('/workspace', {
      model: 'resolved-alias-model',
      systemMessage: 'built-prompt-1@/workspace',
      toolFactory: config.toolFactory,
      excludedTools: ['disabled_tool'],
    });
    expect(preferences.lastSessionId).toBe('created-after-fail');
    expect(preferences.lastCwd).toBe('/workspace');
  });

  it('rebuilds the system message on EVERY create, never reusing a captured one', async () => {
    // The freeze bug (spec-memory-frozen-in-startup-prompt): the prompt was built once at
    // server startup, so a memory edit never reached a later session. Asserting a single
    // create pins nothing — a cached first value looks identical. Only a SECOND create can
    // tell "rebuilt" from "captured", so this asserts the second build's value.
    const preferences = freshPreferences({ lastCwd: '/workspace', lastSessionId: null });
    deps.sessionManager.create.mockResolvedValue('created-1');
    const state = await createState(preferences);

    await state.ensureSession('m', true, '/workspace');
    await state.ensureSession('m', true, '/workspace');

    expect(deps.buildSystemMessage).toHaveBeenCalledTimes(2);
    expect(deps.sessionManager.create).toHaveBeenLastCalledWith('/workspace', expect.objectContaining({
      systemMessage: 'built-prompt-2@/workspace',
    }));
  });

  it('uses provided cwd and default model when creating a new chat', async () => {
    const preferences = freshPreferences({ lastCwd: '/old', lastSessionId: null });
    const state = await createState(preferences);

    const id = await state.ensureSession(undefined, true, '/new-cwd', 'client-a');

    expect(id).toBe('created-1');
    expect(deps.resolveModelAlias).toHaveBeenCalledWith('default-model');
    expect(deps.sessionManager.create).toHaveBeenCalledWith('/new-cwd', expect.objectContaining({ model: 'resolved-default-model' }));
    expect(state.getActiveSessionId('client-a')).toBe('created-1');
    expect(preferences.lastCwd).toBe('/new-cwd');
  });

  it('propagates create failures without marking a session active', async () => {
    deps.sessionManager.create.mockRejectedValue(new Error('create failed'));
    const state = await createState(freshPreferences({ lastSessionId: null }));

    await expect(state.ensureSession('bad-model')).rejects.toThrow('create failed');

    expect(state.getActiveSessionId()).toBeNull();
    expect(deps.savePreferences).not.toHaveBeenCalled();
  });
});

describe('SessionState transitions and preferences', () => {
  it('switchSession resumes, updates cwd from manager, persists preferences, and returns resume details', async () => {
    const state = await createState(freshPreferences({ lastSessionId: null }));
    deps.sessionManager.resume.mockResolvedValue({ sessionId: 'switch-1', usedFallbackCwd: '/fallback' } satisfies ResumeResult);
    deps.sessionManager.getSessionCwd.mockReturnValue('/resumed-cwd');

    const result = await state.switchSession('switch-1', 'client-a');

    expect(result).toEqual({ sessionId: 'switch-1', usedFallbackCwd: '/fallback' });
    expect(state.getActiveSessionId('client-a')).toBe('switch-1');
    expect(deps.sessionManager.resume).toHaveBeenCalledWith('switch-1', { toolFactory: config.toolFactory, excludedTools: ['disabled_tool'] });
    expect(deps.savePreferences).toHaveBeenCalledWith(expect.objectContaining({ lastSessionId: 'switch-1', lastCwd: '/resumed-cwd' }));
  });

  it('switchSession propagates resume failures without changing the active session', async () => {
    const state = await createState(freshPreferences({ lastSessionId: null }));
    await state.ensureSession('model', false, '/cwd', 'client-a');
    deps.sessionManager.resume.mockRejectedValue(new Error('switch failed'));

    await expect(state.switchSession('missing', 'client-a')).rejects.toThrow('switch failed');

    expect(state.getActiveSessionId('client-a')).toBe('created-1');
  });

  it('prepareNewChat clears active and pending state while saving cwd preferences', async () => {
    const state = await createState(freshPreferences({ lastSessionId: null }));
    await state.ensureSession('model', false, '/old-cwd', 'client-a');
    deps.savePreferences.mockClear();

    await state.prepareNewChat('/fresh-cwd', 'client-a');

    expect(state.getActiveSessionId('client-a')).toBeNull();
    expect(state.getSessionIdForHistory('client-a')).toBeNull();
    expect(deps.savePreferences).toHaveBeenCalledWith(expect.objectContaining({ lastSessionId: null, lastCwd: '/fresh-cwd' }));
  });

  it('updatePreferences serializes and returns the same persisted preference object', async () => {
    const state = await createState(freshPreferences({ lastCwd: '/old', lastModel: 'old', lastSessionId: 'old-session' }));

    const updated = await state.updatePreferences({ lastModel: 'new-model', lastCwd: '/new', lastSessionId: null }, 'client-a');

    expect(updated).toMatchObject({ lastModel: 'new-model', lastCwd: '/new', lastSessionId: null });
    expect(state.preferences).toBe(updated);
    expect(deps.savePreferences).toHaveBeenCalledWith(updated);
  });

  it('getSessionConfig exposes tool configuration without session fields', async () => {
    const state = await createState(freshPreferences());
    expect(state.getSessionConfig()).toEqual({ toolFactory: config.toolFactory, excludedTools: ['disabled_tool'] });
  });
});

describe('SessionState deletion, history, and shutdown', () => {
  it('deleteSession clears active sessions and notifies remaining listeners only', async () => {
    const state = await createState(freshPreferences({ lastSessionId: null }));
    await state.ensureSession('model', false, '/cwd', 'client-a');
    const listener = vi.fn();
    const removed = vi.fn();
    const unsubscribe = state.onSessionEnd(removed);
    state.onSessionEnd(listener);
    unsubscribe();

    const wasActive = await state.deleteSession('created-1', 'client-a');

    expect(wasActive).toBe(true);
    expect(state.getActiveSessionId('client-a')).toBeNull();
    expect(deps.sessionManager.delete).toHaveBeenCalledWith('created-1');
    expect(listener).toHaveBeenCalledWith('created-1');
    expect(removed).not.toHaveBeenCalled();
  });

  it('deleteSession keeps inactive active ids and swallows listener errors', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = await createState(freshPreferences({ lastSessionId: null }));
    await state.ensureSession('model', false, '/cwd', 'client-a');
    state.onSessionEnd(() => { throw new Error('listener failed'); });

    const wasActive = await state.deleteSession('other-session', 'client-a');

    expect(wasActive).toBe(false);
    expect(state.getActiveSessionId('client-a')).toBe('created-1');
    expect(errorSpy).toHaveBeenCalledWith('[SESSION-END] listener error:', expect.any(Error));
    errorSpy.mockRestore();
  });

  it('hasMessages distinguishes inactive sessions, user messages, assistant-only history, and manager failures', async () => {
    const state = await createState(freshPreferences({ lastSessionId: null }));
    expect(await state.hasMessages('client-a')).toBe(false);

    await state.ensureSession('model', false, '/cwd', 'client-a');
    deps.sessionManager.isActive.mockReturnValue(true);
    deps.sessionManager.getHistory.mockResolvedValue([{ type: 'assistant.message' }]);
    expect(await state.hasMessages('client-a')).toBe(false);

    deps.sessionManager.getHistory.mockResolvedValue([{ type: 'user.message' }]);
    expect(await state.hasMessages('client-a')).toBe(true);

    deps.sessionManager.getHistory.mockRejectedValue(new Error('history failed'));
    expect(await state.hasMessages('client-a')).toBe(false);
  });

  it('shutdown stops all active client sessions and clears history pointers', async () => {
    const state = await createState(freshPreferences({ lastSessionId: null }));
    deps.sessionManager.create.mockResolvedValueOnce('client-a-session').mockResolvedValueOnce('client-b-session');
    await state.ensureSession('model-a', false, '/a', 'client-a');
    await state.ensureSession('model-b', false, '/b', 'client-b');

    await state.shutdown();

    expect(deps.sessionManager.stop).toHaveBeenCalledWith('client-a-session');
    expect(deps.sessionManager.stop).toHaveBeenCalledWith('client-b-session');
    expect(state.getActiveSessionId('client-a')).toBeNull();
    expect(state.getSessionIdForHistory('client-b')).toBeNull();
  });
});

