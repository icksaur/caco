import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { BUILTIN_COMMANDS, findCommand, restoreCommandInput, registerCommand, type Command } from '../../public/ts/command-registry.js';
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
