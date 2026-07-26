import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findCommand, getCommands, loadSkillCommands, registerCommand, type Command } from '../../public/ts/command-registry.js';

const mockState = vi.hoisted(() => ({
  activeSessionId: null as string | null,
  availableModels: [] as any[],
  activeSessionChangeListeners: [] as Array<() => void>,
  sessionActivateListeners: [] as Array<() => void>,
  newSessionClick: vi.fn(),
  selectModel: vi.fn(),
  showToast: vi.fn(),
  setActiveContextBudget: vi.fn(),
  setActiveReasoningEffort: vi.fn(),
  archiveSession: vi.fn(),
  renameSession: vi.fn(),
  chatView: {
    activateSession: vi.fn(),
    applyCwdChange: vi.fn(),
    getActiveForm: vi.fn(),
    getCwd: vi.fn(),
    updateStatus: vi.fn(),
  },
}));

vi.mock('../../public/ts/router.js', () => ({
  newSessionClick: mockState.newSessionClick,
}));

vi.mock('../../public/ts/app-state.js', () => ({
  getActiveSessionId: () => mockState.activeSessionId,
  getAvailableModels: () => mockState.availableModels,
  onActiveSessionChange: (listener: () => void) => {
    mockState.activeSessionChangeListeners.push(listener);
    return () => {};
  },
  onSessionActivate: (listener: () => void) => {
    mockState.sessionActivateListeners.push(listener);
    return () => {};
  },
}));

vi.mock('../../public/ts/chat-view-controller.js', () => ({
  chatView: mockState.chatView,
}));

vi.mock('../../public/ts/model-selector.js', () => ({
  selectModel: mockState.selectModel,
}));

vi.mock('../../public/ts/toast.js', () => ({
  showToast: mockState.showToast,
}));

vi.mock('../../public/ts/context-footer.js', () => ({
  setActiveContextBudget: mockState.setActiveContextBudget,
  setActiveReasoningEffort: mockState.setActiveReasoningEffort,
}));

vi.mock('../../public/ts/session-panel.js', () => ({
  archiveSession: mockState.archiveSession,
  renameSession: mockState.renameSession,
}));

function response(ok: boolean, data: any): Response {
  return {
    ok,
    json: vi.fn(async () => data),
  } as unknown as Response;
}

function rejectingJsonResponse(ok: boolean): Response {
  return {
    ok,
    json: vi.fn(async () => {
      throw new Error('invalid json');
    }),
  } as unknown as Response;
}

function setActiveSession(sessionId: string | null): void {
  mockState.activeSessionId = sessionId;
}

function resetRegisteredSkillCommands(): void {
  for (const listener of mockState.activeSessionChangeListeners) listener();
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  setActiveSession(null);
  mockState.availableModels = [];
  mockState.chatView.getCwd.mockReturnValue('/repo');
  mockState.chatView.getActiveForm.mockReturnValue(null);
  resetRegisteredSkillCommands();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetRegisteredSkillCommands();
});

describe('registry lookup and ownership', () => {
  it('returns the registered command collection including built-ins', () => {
    expect(getCommands().map(command => command.name)).toEqual(expect.arrayContaining([
      'caco.session-new',
      'caco.session-context-window',
      'caco.session-effort',
    ]));
  });

  it('lets a direct bare command override the legacy caco-prefixed fallback only while registered', () => {
    const bareRestart: Command = { name: 'restart', description: 'SDK restart', source: 'extension', handler: () => {} };
    const dispose = registerCommand(bareRestart);

    expect(findCommand('restart')).toBe(bareRestart);
    expect(findCommand('caco.restart')?.source).toBe('built-in');

    dispose();
    expect(findCommand('restart')).toBe(findCommand('caco.restart'));
  });

  it('does not treat non-built-in caco-prefixed commands as legacy bare aliases', () => {
    const extensionCommand: Command = { name: 'caco.external', description: 'External', source: 'extension', handler: () => {} };
    const dispose = registerCommand(extensionCommand);

    expect(findCommand('external')).toBeUndefined();
    expect(findCommand('caco.external')).toBe(extensionCommand);

    dispose();
  });
});

describe('simple built-in command handlers', () => {
  it('runs the new-session command through the router seam', async () => {
    await findCommand('session-new')?.handler('');

    expect(mockState.newSessionClick).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['agent', 'No active session'],
    ['session-rename', 'No active session'],
    ['session-cwd', 'No active session'],
    ['session-folder', 'No active session'],
    ['session-archive', 'No active session'],
    ['session-fork', 'No active session'],
    ['session-compact', 'No active session'],
    ['session-context-window', 'No active session'],
    ['session-effort', 'No active session'],
  ])('/%s reports no active session when required', async (name, message) => {
    await findCommand(name)?.handler('value');

    expect(mockState.showToast).toHaveBeenCalledWith(message);
  });

  it('trims rename input before calling the session panel seam', async () => {
    setActiveSession('s1');

    await findCommand('session-rename')?.handler('  Better name  ');

    expect(mockState.renameSession).toHaveBeenCalledWith('s1', 'Better name');
  });

  it('rejects an empty rename with usage text', async () => {
    setActiveSession('s1');

    await findCommand('session-rename')?.handler('   ');

    expect(mockState.showToast).toHaveBeenCalledWith('Usage: /session-rename <new name>');
  });
});

describe('agent commands', () => {
  it('rejects an empty agent selection with usage text', async () => {
    setActiveSession('s1');

    await findCommand('agent')?.handler('   ');

    expect(mockState.showToast).toHaveBeenCalledWith('Usage: /agent <agent-name>');
  });

  it('shows a success toast when agent selection returns an agent id', async () => {
    setActiveSession('s1');
    vi.stubGlobal('fetch', vi.fn(async () => response(true, { agentId: 'reviewer' })));

    await findCommand('agent')?.handler(' reviewer ');

    expect(mockState.showToast).toHaveBeenCalledWith('Selected reviewer', { type: 'success', autoHideMs: 2000 });
  });

  it('restores the slash command when agent selection fails', async () => {
    setActiveSession('s1');
    const textarea = { value: '', dispatchEvent: vi.fn(), focus: vi.fn() } as unknown as HTMLTextAreaElement;
    mockState.chatView.getActiveForm.mockReturnValue({ textarea });
    vi.stubGlobal('fetch', vi.fn(async () => response(false, { error: 'unknown agent' })));

    await findCommand('agent')?.handler('missing');

    expect(textarea.value).toBe('/agent missing');
    expect(mockState.showToast).toHaveBeenCalledWith('unknown agent');
  });

  it('reports agent picker fetch failures and empty lists as empty picker results', async () => {
    setActiveSession('s1');
    vi.stubGlobal('fetch', vi.fn(async () => response(false, { error: 'agent list unavailable' })));

    await expect(findCommand('agent')?.picker?.()).resolves.toEqual([]);
    expect(mockState.showToast).toHaveBeenCalledWith('agent list unavailable');

    vi.stubGlobal('fetch', vi.fn(async () => response(true, { agents: [] })));
    await expect(findCommand('agent')?.picker?.()).resolves.toEqual([]);
    expect(mockState.showToast).toHaveBeenCalledWith('No SDK agents available');
  });
});

describe('session cwd and folder commands', () => {
  it('patches cwd and applies the effective server response', async () => {
    setActiveSession('s1');
    const fetchMock = vi.fn(async () => response(true, { cwd: '/srv/project', hasGit: true, gitBranch: 'main' }));
    vi.stubGlobal('fetch', fetchMock);

    await findCommand('session-cwd')?.handler(' /requested ');

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: '/requested' }),
    });
    expect(mockState.chatView.applyCwdChange).toHaveBeenCalledWith('s1', '/srv/project', true, 'main');
    expect(mockState.showToast).toHaveBeenCalledWith('CWD → /srv/project', { type: 'success', autoHideMs: 3000 });
  });

  it('reports cwd validation, server, and network failures', async () => {
    setActiveSession('s1');

    await findCommand('session-cwd')?.handler('   ');
    expect(mockState.showToast).toHaveBeenCalledWith('Usage: /session-cwd <path>');

    vi.stubGlobal('fetch', vi.fn(async () => response(false, { error: 'bad cwd' })));
    await findCommand('session-cwd')?.handler('/missing');
    expect(mockState.showToast).toHaveBeenCalledWith('bad cwd');

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    await findCommand('session-cwd')?.handler('/missing');
    expect(mockState.showToast).toHaveBeenCalledWith('Failed to change CWD');
  });

  it('patches folder moves and formats root destinations', async () => {
    setActiveSession('s1');
    const fetchMock = vi.fn(async () => response(true, {}));
    vi.stubGlobal('fetch', fetchMock);

    await findCommand('session-folder')?.handler(' root ');

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder: 'root' }),
    });
    expect(mockState.showToast).toHaveBeenCalledWith('Session moved to root', { type: 'success', autoHideMs: 3000 });
  });

  it('rejects nested folders and reports folder failures', async () => {
    setActiveSession('s1');

    await findCommand('session-folder')?.handler('a/b');
    expect(mockState.showToast).toHaveBeenCalledWith('Nested folders not supported yet');

    vi.stubGlobal('fetch', vi.fn(async () => rejectingJsonResponse(false)));
    await findCommand('session-folder')?.handler('team');
    expect(mockState.showToast).toHaveBeenCalledWith('Unknown error');

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    await findCommand('session-folder')?.handler('team');
    expect(mockState.showToast).toHaveBeenCalledWith('Failed to move session');
  });
});

describe('session archive, model, restart, fork, and compact commands', () => {
  it('archives with the best available display name from session state', async () => {
    setActiveSession('s1');
    vi.stubGlobal('fetch', vi.fn(async () => response(true, { summary: 'Older summary' })));

    await findCommand('session-archive')?.handler('');

    expect(mockState.archiveSession).toHaveBeenCalledWith('s1', 'Older summary');
  });

  it('changes the active session model and reports server failures', async () => {
    setActiveSession('s1');
    vi.stubGlobal('fetch', vi.fn(async () => response(true, {})));

    await findCommand('session-model')?.handler('gpt-5');

    expect(mockState.chatView.updateStatus).toHaveBeenCalledWith('/repo', 'gpt-5');
    expect(mockState.showToast).toHaveBeenCalledWith('Model changed to gpt-5', { type: 'success', autoHideMs: 3000 });

    vi.stubGlobal('fetch', vi.fn(async () => response(false, { error: 'model rejected' })));
    await findCommand('session-model')?.handler('bad-model');
    expect(mockState.showToast).toHaveBeenCalledWith('model rejected');
  });

  it('selects the default model outside an active session and builds model picker descriptions', async () => {
    mockState.availableModels = [
      { id: 'free', name: 'Free Model', cost: 0 },
      { id: 'paid', name: 'Paid Model', cost: 2, priceCategory: 'premium' },
      { id: 'blank', name: 'Blank Model', cost: 1 },
    ];

    await findCommand('session-model')?.handler('free');

    expect(mockState.selectModel).toHaveBeenCalledWith('free');
    expect(findCommand('session-model')?.picker?.()).toEqual([
      { id: 'free', label: 'Free Model', description: 'free' },
      { id: 'paid', label: 'Paid Model', description: 'premium' },
      { id: 'blank', label: 'Blank Model', description: '' },
    ]);
  });

  it('posts restart and reports both success and fetch failure', async () => {
    const fetchMock = vi.fn(async () => response(true, { message: 'Restarting' }));
    vi.stubGlobal('fetch', fetchMock);

    await findCommand('restart')?.handler('');

    expect(fetchMock).toHaveBeenCalledWith('/api/restart', { method: 'POST' });
    expect(mockState.showToast).toHaveBeenCalledWith('Restarting', { type: 'info', autoHideMs: 3000 });

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    await findCommand('restart')?.handler('');
    expect(mockState.showToast).toHaveBeenCalledWith('Failed to restart server');
  });

  it('forks with optional initial message and activates the returned session', async () => {
    setActiveSession('s1');
    const fetchMock = vi.fn(async () => response(true, { name: 'Forked session', sessionId: 's2' }));
    vi.stubGlobal('fetch', fetchMock);

    await findCommand('session-fork')?.handler(' keep this context ');

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1/fork', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initialMessage: 'keep this context' }),
    });
    expect(mockState.chatView.activateSession).toHaveBeenCalledWith('s2');
  });

  it('reports fork API and network failures', async () => {
    setActiveSession('s1');
    vi.stubGlobal('fetch', vi.fn(async () => response(false, { error: 'too large' })));
    await findCommand('session-fork')?.handler('');
    expect(mockState.showToast).toHaveBeenCalledWith('too large');

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    await findCommand('session-fork')?.handler('');
    expect(mockState.showToast).toHaveBeenCalledWith('Fork failed: offline');
  });

  it('compacts with focused instructions and reports success or failures', async () => {
    setActiveSession('s1');
    const fetchMock = vi.fn(async () => response(true, { tokensRemoved: 1200, messagesRemoved: 4 }));
    vi.stubGlobal('fetch', fetchMock);

    await findCommand('session-compact')?.handler(' summarize tests ');

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1/compact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customInstructions: 'summarize tests' }),
    });
    expect(mockState.showToast).toHaveBeenCalledWith('Compacted: 1200 tokens, 4 messages removed', { type: 'success', autoHideMs: 5000 });

    vi.stubGlobal('fetch', vi.fn(async () => response(false, { error: 'busy' })));
    await findCommand('session-compact')?.handler('');
    expect(mockState.showToast).toHaveBeenCalledWith('busy');

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    await findCommand('session-compact')?.handler('');
    expect(mockState.showToast).toHaveBeenCalledWith('Compaction failed');
  });
});

describe('context window command', () => {
  it.each([
    ['1.5m', 1500000, 'Context capped at 1.5M — history replays once'],
    ['42k', 42000, 'Context capped at 42k — history replays once'],
    ['default', null, 'Context cap cleared (SDK default ~80%)'],
  ])('parses %s into the expected token cap', async (input, expectedTokens, expectedToast) => {
    setActiveSession('s1');
    const fetchMock = vi.fn(async () => response(true, {}));
    vi.stubGlobal('fetch', fetchMock);

    await findCommand('session-context-window')?.handler(input);

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextBudgetTokens: expectedTokens }),
    });
    expect(mockState.setActiveContextBudget).toHaveBeenCalledWith(expectedTokens);
    expect(mockState.showToast).toHaveBeenCalledWith(expectedToast, { type: 'success', autoHideMs: 4000 });
  });

  it('rejects invalid token counts before calling the server', async () => {
    setActiveSession('s1');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await findCommand('session-context-window')?.handler('0');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockState.showToast).toHaveBeenCalledWith('Invalid token count: 0');
  });

  it('reports context window server and network failures', async () => {
    setActiveSession('s1');
    vi.stubGlobal('fetch', vi.fn(async () => response(false, { error: 'cap rejected' })));
    await findCommand('session-context-window')?.handler('10k');
    expect(mockState.showToast).toHaveBeenCalledWith('cap rejected');

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    await findCommand('session-context-window')?.handler('10k');
    expect(mockState.showToast).toHaveBeenCalledWith('Failed to set context window: offline');
  });

  it('builds context picker items from model window and current cap', async () => {
    setActiveSession('s1');
    mockState.availableModels = [{ id: 'model-a', name: 'Model A', cost: 0, contextWindow: 512000 }];
    vi.stubGlobal('fetch', vi.fn(async () => response(true, { model: 'model-a', contextBudgetTokens: 200000 })));

    await expect(findCommand('session-context-window')?.picker?.()).resolves.toEqual([
      { id: '100000', label: '100k', description: '20%', danger: false },
      { id: '200000', label: '200k', description: '39% · current', danger: false },
      { id: '300000', label: '300k', description: '59%', danger: false },
      { id: '400000', label: '400k', description: '78%', danger: false },
      { id: 'default', label: 'SDK default (~80%)', description: 'clear cap' },
    ]);
  });

  it('returns fallback context picker entries without an active or matching model', async () => {
    await expect(findCommand('session-context-window')?.picker?.()).resolves.toEqual([
      { id: 'default', label: 'No active session', description: '' },
    ]);

    setActiveSession('s1');
    vi.stubGlobal('fetch', vi.fn(async () => response(true, { model: 'unknown', contextBudgetTokens: null })));
    await expect(findCommand('session-context-window')?.picker?.()).resolves.toEqual([
      { id: 'default', label: 'SDK default (~80%)', description: 'current' },
    ]);
  });
});

describe('reasoning effort command', () => {
  it('uses the picker when no effort id is typed', async () => {
    setActiveSession('s1');

    await findCommand('session-effort')?.handler('  ');

    expect(mockState.showToast).toHaveBeenCalledWith('Use the picker: /session-effort', { type: 'info', autoHideMs: 2000 });
  });

  it('updates reasoning effort, clears defaults, and ignores the none sentinel', async () => {
    setActiveSession('s1');
    const fetchMock = vi.fn(async () => response(true, {}));
    vi.stubGlobal('fetch', fetchMock);

    await findCommand('session-effort')?.handler('high');
    await findCommand('session-effort')?.handler('default');
    await findCommand('session-effort')?.handler('none');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockState.setActiveReasoningEffort).toHaveBeenNthCalledWith(1, 'high');
    expect(mockState.setActiveReasoningEffort).toHaveBeenNthCalledWith(2, null);
    expect(mockState.showToast).toHaveBeenCalledWith('Reasoning effort set to High', { type: 'success', autoHideMs: 3000 });
    expect(mockState.showToast).toHaveBeenCalledWith('Reasoning effort set to Default', { type: 'success', autoHideMs: 3000 });
  });

  it('reports effort server and network failures', async () => {
    setActiveSession('s1');
    vi.stubGlobal('fetch', vi.fn(async () => response(false, { error: 'effort rejected' })));
    await findCommand('session-effort')?.handler('high');
    expect(mockState.showToast).toHaveBeenCalledWith('effort rejected');

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    await findCommand('session-effort')?.handler('high');
    expect(mockState.showToast).toHaveBeenCalledWith('Failed to set reasoning effort: offline');
  });

  it('builds supported effort picker rows with default and current labels', async () => {
    setActiveSession('s1');
    mockState.availableModels = [{
      id: 'model-a',
      name: 'Model A',
      cost: 0,
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ['low', 'high', 'max'],
      defaultReasoningEffort: 'medium',
    }];
    vi.stubGlobal('fetch', vi.fn(async () => response(true, { model: 'model-a', reasoningEffort: 'high' })));

    await expect(findCommand('session-effort')?.picker?.()).resolves.toEqual([
      { id: 'default', label: 'Default', description: 'Model default (Medium)' },
      { id: 'low', label: 'Low', description: '' },
      { id: 'high', label: 'High', description: 'current' },
      { id: 'max', label: 'max', description: '' },
    ]);
  });

  it('returns effort picker fallback rows without active session or model support', async () => {
    await expect(findCommand('session-effort')?.picker?.()).resolves.toEqual([
      { id: 'none', label: 'No active session', description: '' },
    ]);

    setActiveSession('s1');
    mockState.availableModels = [{ id: 'plain', name: 'Plain', cost: 0, supportsReasoningEffort: false }];
    vi.stubGlobal('fetch', vi.fn(async () => response(true, { model: 'plain' })));

    await expect(findCommand('session-effort')?.picker?.()).resolves.toEqual([
      { id: 'none', label: 'Model does not support reasoning effort', description: '' },
    ]);
  });
});

describe('skill command loading and invocation failures', () => {
  it('uses hint and generated descriptions when registering skills', async () => {
    setActiveSession('s1');
    vi.stubGlobal('fetch', vi.fn(async () => response(true, { skills: [
      { name: 'hinted', hint: 'Use the hint' },
      { name: 'plain' },
    ] })));

    await loadSkillCommands();

    expect(findCommand('hinted')?.description).toBe('Use the hint');
    expect(findCommand('plain')?.description).toBe('Skill plain');
  });

  it('does not register skills when the fetch fails or there is no active session', async () => {
    const commandNamesBeforeFailure = getCommands().map(command => command.name);
    setActiveSession('s1');
    const fetchMock = vi.fn(async () => response(false, {}));
    vi.stubGlobal('fetch', fetchMock);

    await loadSkillCommands();

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1/skills');
    expect(getCommands().map(command => command.name)).toEqual(commandNamesBeforeFailure);

    setActiveSession(null);
    const commandNamesBeforeNoSession = getCommands().map(command => command.name);
    await loadSkillCommands();
    expect(getCommands().map(command => command.name)).toEqual(commandNamesBeforeNoSession);
  });

  it('restores input and toasts when skill invocation fails', async () => {
    setActiveSession('s1');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/skills')) return response(true, { skills: [{ name: 'review' }] });
      return response(false, { error: 'skill failed' });
    }));
    const textarea = { value: '', dispatchEvent: vi.fn(), focus: vi.fn() } as unknown as HTMLTextAreaElement;
    mockState.chatView.getActiveForm.mockReturnValue({ textarea });

    await loadSkillCommands();
    await findCommand('review')?.handler('check branch');

    expect(textarea.value).toBe('/review check branch');
    expect(mockState.showToast).toHaveBeenCalledWith('skill failed');
  });

  it('reports no active session from a registered skill handler', async () => {
    setActiveSession('s1');
    vi.stubGlobal('fetch', vi.fn(async () => response(true, { skills: [{ name: 'review' }] })));
    await loadSkillCommands();

    setActiveSession(null);
    await findCommand('review')?.handler('anything');

    expect(mockState.showToast).toHaveBeenCalledWith('No active session');
  });
});

describe('caco.plugin-directory', () => {
  const run = async (arg: string) => { await findCommand('caco.plugin-directory')!.handler(arg); };

  it('bare invocation SHOWS the current list and performs no write', async () => {
    setActiveSession('s1');
    const fetchMock = vi.fn(async () => response(true, { pluginDirectories: ['/abs/p1', '/abs/p2'] }));
    vi.stubGlobal('fetch', fetchMock);

    await run('   ');

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1/state');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockState.showToast).toHaveBeenCalledWith(expect.stringContaining('/abs/p1'), expect.objectContaining({ type: 'info' }));
  });

  it('bare invocation reports "none" when unset', async () => {
    setActiveSession('s1');
    vi.stubGlobal('fetch', vi.fn(async () => response(true, { pluginDirectories: [] })));
    await run('');
    expect(mockState.showToast).toHaveBeenCalledWith('Plugin directories: none', expect.objectContaining({ type: 'info' }));
  });

  it('sets space-separated paths and reports a reconnect', async () => {
    setActiveSession('s1');
    const fetchMock = vi.fn(async () => response(true, { pluginDirectoriesChanged: true, pluginDirectoriesRecreated: true }));
    vi.stubGlobal('fetch', fetchMock);

    await run('/abs/p1 /abs/p2');

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ pluginDirectories: ['/abs/p1', '/abs/p2'] }),
    }));
    expect(mockState.showToast).toHaveBeenCalledWith(expect.stringContaining('session reconnected'), expect.objectContaining({ type: 'success' }));
  });

  it('reports "applies on next open" when no recreate happened', async () => {
    setActiveSession('s1');
    vi.stubGlobal('fetch', vi.fn(async () => response(true, { pluginDirectoriesChanged: true, pluginDirectoriesRecreated: false })));
    await run('/abs/p1');
    expect(mockState.showToast).toHaveBeenCalledWith(expect.stringContaining('applies on next open'), expect.objectContaining({ type: 'success' }));
  });

  it.each(['clear', 'none', 'reset', 'CLEAR'])('clears with the word %s (sending [])', async (word) => {
    setActiveSession('s1');
    const fetchMock = vi.fn(async () => response(true, { pluginDirectoriesChanged: true }));
    vi.stubGlobal('fetch', fetchMock);

    await run(word);

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1', expect.objectContaining({
      body: JSON.stringify({ pluginDirectories: [] }),
    }));
    expect(mockState.showToast).toHaveBeenCalledWith(expect.stringContaining('Plugin directories cleared'), expect.objectContaining({ type: 'success' }));
  });

  it('reports a no-op rather than staying silent', async () => {
    setActiveSession('s1');
    vi.stubGlobal('fetch', vi.fn(async () => response(true, { pluginDirectoriesChanged: false })));
    await run('/abs/p1');
    expect(mockState.showToast).toHaveBeenCalledWith(expect.stringContaining('Plugin directories unchanged'), expect.objectContaining({ type: 'info' }));
  });

  it('surfaces route warnings alongside success', async () => {
    setActiveSession('s1');
    vi.stubGlobal('fetch', vi.fn(async () => response(true, { pluginDirectoriesChanged: true, pluginWarnings: ['No plugin.json found in /abs/p1'] })));
    await run('/abs/p1');
    expect(mockState.showToast).toHaveBeenCalledWith(expect.stringContaining('No plugin.json'), expect.objectContaining({ type: 'success' }));
  });

  it('surfaces warnings on the clear path too', async () => {
    setActiveSession('s1');
    vi.stubGlobal('fetch', vi.fn(async () => response(true, { pluginDirectoriesChanged: true, pluginWarnings: ['stale note'] })));
    await run('clear');
    expect(mockState.showToast).toHaveBeenCalledWith(expect.stringContaining('stale note'), expect.objectContaining({ type: 'success' }));
  });

  it('reports the route error verbatim', async () => {
    setActiveSession('s1');
    vi.stubGlobal('fetch', vi.fn(async () => response(false, { error: 'Not a directory: /abs/p1' })));
    await run('/abs/p1');
    expect(mockState.showToast).toHaveBeenCalledWith('Not a directory: /abs/p1');
  });

  it('requires an active session', async () => {
    setActiveSession(null);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await run('/abs/p1');
    expect(mockState.showToast).toHaveBeenCalledWith('No active session');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
