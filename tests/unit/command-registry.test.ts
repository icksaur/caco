import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { BUILTIN_COMMANDS, findCommand, restoreCommandInput, registerCommand, loadAgentCommands, type Command } from '../../public/ts/command-registry.js';
import { setActiveSession } from '../../public/ts/app-state.js';
import { parseAgentDispatchInput } from '../../public/ts/agent-command.js';
import { chatView } from '../../public/ts/chat-view-controller.js';

const README = readFileSync(join(__dirname, '../../README.md'), 'utf-8');

describe('BUILTIN_COMMANDS', () => {
  beforeEach(() => {
    setActiveSession(null, '');
    vi.unstubAllGlobals();
  });

  it('has no duplicate names', () => {
    const names = BUILTIN_COMMANDS.map(c => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every command has a non-empty description', () => {
    for (const cmd of BUILTIN_COMMANDS) {
      expect(cmd.description.length, `${cmd.name} missing description`).toBeGreaterThan(0);
    }
  });

  for (const cmd of BUILTIN_COMMANDS) {
    it(`/${cmd.name} has a registered handler`, () => {
      expect(findCommand(cmd.name), `/${cmd.name} declared in BUILTIN_COMMANDS but never registered via registerBuiltin`).toBeDefined();
    });
  }

  for (const cmd of BUILTIN_COMMANDS) {
    it(`/${cmd.name} is documented in README.md`, () => {
      expect(README, `/${cmd.name} not found in README.md`).toContain(`/${cmd.name}`);
    });
  }

  it('/agent parses the first token as agent name and the rest as prompt', () => {
    expect(parseAgentDispatchInput('reviewer check reliability')).toEqual({
      agentName: 'reviewer',
      prompt: 'check reliability',
    });
    expect(parseAgentDispatchInput('reviewer')).toBeNull();
  });

  it('/agent picker lists SDK agents and fills a trailing prompt space', async () => {
    setActiveSession('s1', '/repo');
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        agents: [
          { name: 'reviewer', displayName: 'Reviewer', description: 'Reviews code', model: 'gpt-5.5' },
        ],
      }),
    })));

    const picker = findCommand('agent')?.picker;
    expect(picker).toBeDefined();
    const items = await picker!();
    expect(items).toEqual([
      {
        id: 'reviewer',
        label: 'Reviewer (reviewer)',
        description: 'Reviews code · gpt-5.5',
        value: 'reviewer ',
      },
    ]);
  });

  it('/agent posts selected agent and prompt', async () => {
    setActiveSession('s1', '/repo');
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await findCommand('agent')!.handler('reviewer check reliability');

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1/agent-dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentName: 'reviewer', prompt: 'check reliability' }),
    });
  });

  it('/agent saves the consumed command for async restorePrompt recovery', async () => {
    setActiveSession('s1', '/repo');
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const savePrompt = vi.spyOn(chatView, 'savePrompt').mockImplementation(() => {});

    await findCommand('agent')!.handler('reviewer check reliability');

    expect(savePrompt).toHaveBeenCalledWith('/agent reviewer check reliability', 's1');
    savePrompt.mockRestore();
  });

  it('restores failed slash-command input into the active form textarea', () => {
    const textarea = {
      value: '',
      dispatchEvent: vi.fn(),
      focus: vi.fn(),
    } as unknown as HTMLTextAreaElement;

    restoreCommandInput({ textarea }, '/agent reviewer long prompt');

    expect(textarea.value).toBe('/agent reviewer long prompt');
    expect(textarea.dispatchEvent).toHaveBeenCalled();
    expect(textarea.focus).toHaveBeenCalled();
  });
});

describe('registerCommand disposer ownership', () => {
  it('a superseded registration disposer does not delete the current owner', () => {
    const name = 'test-ownership-cmd';
    const a: Command = { name, description: 'A', source: 'extension', handler: () => {} };
    const b: Command = { name, description: 'B', source: 'extension', handler: () => {} };

    const disposeA = registerCommand(a);
    const disposeB = registerCommand(b);
    expect(findCommand(name)).toBe(b);

    disposeA();
    expect(findCommand(name)).toBe(b);

    disposeB();
    expect(findCommand(name)).toBeUndefined();
  });
});

describe('agent slash commands (G1)', () => {
  beforeEach(() => {
    setActiveSession('s1', '/repo');
    vi.unstubAllGlobals();
  });

  function stubAgents(agents: Array<{ name: string; displayName?: string; description?: string }>) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/sessions/s1/agents') {
        return { ok: true, json: async () => ({ agents }) } as unknown as Response;
      }
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
    }));
  }

  it('registers each discovered agent as a /<name> command, then disposes on reload', async () => {
    stubAgents([{ name: 'speckit.specify', displayName: 'Specify', description: 'Create a spec' }]);
    await loadAgentCommands();

    const cmd = findCommand('speckit.specify');
    expect(cmd).toBeDefined();
    expect(cmd!.source).toBe('agent');
    expect(cmd!.description).toBe('Create a spec');

    // A reload with no agents disposes the prior batch.
    stubAgents([]);
    await loadAgentCommands();
    expect(findCommand('speckit.specify')).toBeUndefined();
  });

  it('the /<name> handler dispatches that agent with the typed prompt', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/sessions/s1/agents') {
        return { ok: true, json: async () => ({ agents: [{ name: 'speckit.plan' }] }) } as unknown as Response;
      }
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    await loadAgentCommands();

    await findCommand('speckit.plan')!.handler('use Vite and SQLite');

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1/agent-dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentName: 'speckit.plan', prompt: 'use Vite and SQLite' }),
    });
  });

  it('an agent never shadows a built-in command of the same name', async () => {
    const builtinAgent = findCommand('agent');
    stubAgents([{ name: 'agent', description: 'evil shadow' }]);
    await loadAgentCommands();
    // The built-in /agent is preserved.
    expect(findCommand('agent')).toBe(builtinAgent);
    expect(findCommand('agent')!.source).toBe('built-in');
  });

  it('discards a stale batch when the session changed during the fetch', async () => {
    // Session A's /agents fetch resolves, but the user has switched to B by then.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/sessions/sA/agents') {
        return { ok: true, json: async () => ({ agents: [{ name: 'agent-from-A' }] }) } as unknown as Response;
      }
      return { ok: true, json: async () => ({ agents: [] }) } as unknown as Response;
    }));

    setActiveSession('sA', '/repoA');
    const inflight = loadAgentCommands();      // captures sA
    setActiveSession('sB', '/repoB');          // switch before the fetch resolves
    await inflight;

    // A's agents must NOT be registered while B is active.
    expect(findCommand('agent-from-A')).toBeUndefined();
  });
});
