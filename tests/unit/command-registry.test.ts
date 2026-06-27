import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { BUILTIN_COMMANDS, findCommand, restoreCommandInput, registerCommand, loadSkillCommands, type Command } from '../../public/ts/command-registry.js';
import { setActiveSession } from '../../public/ts/app-state.js';
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

  it('all built-ins live in the caco. namespace', () => {
    for (const cmd of BUILTIN_COMMANDS) {
      expect(cmd.name.startsWith('caco.'), `${cmd.name} is not caco.*-prefixed`).toBe(true);
    }
  });

  it('resolves a legacy bare name to its caco.* built-in', () => {
    expect(findCommand('restart')).toBe(findCommand('caco.restart'));
    expect(findCommand('session-new')).toBe(findCommand('caco.session-new'));
    expect(findCommand('agent')).toBe(findCommand('caco.agent'));
  });

  it('does not invent a bare alias for an unknown name', () => {
    expect(findCommand('definitely-not-a-command')).toBeUndefined();
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

  it('/agent picker lists SDK agents by slug (select-only, no trailing prompt space)', async () => {
    setActiveSession('s1', '/repo');
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        agents: [
          { id: 'reviewer', name: 'reviewer', displayName: 'Reviewer', description: 'Reviews code', model: 'gpt-5.5' },
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
        value: 'reviewer',
      },
    ]);
  });

  it('/agent posts the raw identifier to agent-select for the server to resolve', async () => {
    setActiveSession('s1', '/repo');
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await findCommand('agent')!.handler('smoke user test');

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1/agent-select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'smoke user test' }),
    });
  });

  it('/agent selection does not save a prompt (no turn is sent)', async () => {
    setActiveSession('s1', '/repo');
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true }),
    })));
    const savePrompt = vi.spyOn(chatView, 'savePrompt').mockImplementation(() => {});

    await findCommand('agent')!.handler('reviewer');

    expect(savePrompt).not.toHaveBeenCalled();
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

describe('skill slash commands', () => {
  beforeEach(() => {
    setActiveSession('s1', '/repo');
    vi.unstubAllGlobals();
  });

  function stubSkills(skills: Array<{ name: string; description?: string; hint?: string }>) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/sessions/s1/skills') {
        return { ok: true, json: async () => ({ skills }) } as unknown as Response;
      }
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
    }));
  }

  it('registers each discovered skill as a /<name> command, then disposes on reload', async () => {
    stubSkills([{ name: 'code-review', description: 'Do a review' }]);
    await loadSkillCommands();

    const cmd = findCommand('code-review');
    expect(cmd).toBeDefined();
    expect(cmd!.source).toBe('skill');
    expect(cmd!.description).toBe('Do a review');

    stubSkills([]);
    await loadSkillCommands();
    expect(findCommand('code-review')).toBeUndefined();
  });

  it('the /<name> handler posts name + input to skill-invoke', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/sessions/s1/skills') {
        return { ok: true, json: async () => ({ skills: [{ name: 'code-review' }] }) } as unknown as Response;
      }
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    await loadSkillCommands();

    await findCommand('code-review')!.handler('check reliability');

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1/skill-invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'code-review', input: 'check reliability' }),
    });
  });

  it('a skill cannot shadow a built-in (canonical caco.* name)', async () => {
    const builtin = findCommand('caco.session-new');
    stubSkills([{ name: 'caco.session-new', description: 'evil shadow' }]);
    await loadSkillCommands();
    expect(findCommand('caco.session-new')).toBe(builtin);
    expect(findCommand('caco.session-new')!.source).toBe('built-in');
  });

  it('a skill claiming a bare legacy name wins it; the caco.* built-in still resolves', async () => {
    // The bare `restart` alias yields to a real skill named `restart` (the bare
    // namespace belongs to the SDK/skills); the Caco command stays reachable as caco.restart.
    stubSkills([{ name: 'restart', description: 'a real skill' }]);
    await loadSkillCommands();
    expect(findCommand('restart')!.source).toBe('skill');
    expect(findCommand('caco.restart')!.source).toBe('built-in');
  });

  it('discards a stale batch when the session changed during the fetch', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/sessions/sA/skills') {
        return { ok: true, json: async () => ({ skills: [{ name: 'skill-from-A' }] }) } as unknown as Response;
      }
      return { ok: true, json: async () => ({ skills: [] }) } as unknown as Response;
    }));

    setActiveSession('sA', '/repoA');
    const inflight = loadSkillCommands();
    setActiveSession('sB', '/repoB');
    await inflight;

    expect(findCommand('skill-from-A')).toBeUndefined();
  });

  it('prunes the prior batch on a pointer change even if the next fetch fails', async () => {
    stubSkills([{ name: 'skill-a' }]);
    await loadSkillCommands();
    expect(findCommand('skill-a')).toBeDefined();

    // Pointer change (e.g. new chat / switch) disposes immediately, independent of any
    // subsequent (possibly failing) skill fetch.
    setActiveSession('s2', '/repo2');
    expect(findCommand('skill-a')).toBeUndefined();
  });
});
