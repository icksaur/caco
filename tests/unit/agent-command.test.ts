import { describe, expect, it } from 'vitest';
import {
  resolveAgentDispatch,
  visibleAgents,
  isUsableSlug,
  type SdkAgentInfo,
} from '../../src/agent-command.js';

function agent(partial: Partial<SdkAgentInfo> & { id: string }): SdkAgentInfo {
  return {
    name: partial.id,
    displayName: partial.id,
    description: '',
    ...partial,
  };
}

const agents: SdkAgentInfo[] = [
  agent({ id: 'reviewer', name: 'reviewer', displayName: 'Reviewer' }),
  agent({ id: 'smoke-user', name: 'smoke user test', displayName: 'smoke user test' }),
  agent({ id: 'hidden', name: 'hidden', userInvocable: false }),
];

describe('isUsableSlug', () => {
  it('accepts whitespace-free non-empty ids', () => {
    expect(isUsableSlug('smoke-user')).toBe(true);
    expect(isUsableSlug('speckit.specify')).toBe(true);
  });
  it('rejects empty, whitespace, or non-string ids', () => {
    expect(isUsableSlug('')).toBe(false);
    expect(isUsableSlug('has space')).toBe(false);
    expect(isUsableSlug(' leading')).toBe(false);
    expect(isUsableSlug(undefined)).toBe(false);
  });
});

describe('visibleAgents', () => {
  it('keeps user-invocable agents with a usable slug, regardless of name whitespace', () => {
    // smoke-user has a spaced frontmatter name but a clean slug — must NOT be dropped.
    expect(visibleAgents(agents).map(a => a.id)).toEqual(['reviewer', 'smoke-user']);
  });
  it('drops agents with an unusable slug', () => {
    expect(visibleAgents([agent({ id: 'bad slug', name: 'x' })])).toEqual([]);
  });
});

describe('resolveAgentDispatch', () => {
  const list = visibleAgents(agents);

  it('resolves an exact slug on the first token, rest is the prompt', () => {
    expect(resolveAgentDispatch(list, 'reviewer check reliability')).toEqual({
      ok: true, agentId: 'reviewer', prompt: 'check reliability',
    });
  });

  it('resolves a multi-word frontmatter name to its slug', () => {
    expect(resolveAgentDispatch(list, 'smoke user test do something')).toEqual({
      ok: true, agentId: 'smoke-user', prompt: 'do something',
    });
  });

  it('also accepts the slug form for a spaced-name agent', () => {
    expect(resolveAgentDispatch(list, 'smoke-user do something')).toEqual({
      ok: true, agentId: 'smoke-user', prompt: 'do something',
    });
  });

  it('slug on the first token wins over a longer name match', () => {
    // id 'foo' + another agent name 'foo bar' → '/agent foo bar x' means slug foo.
    const l = visibleAgents([agent({ id: 'foo' }), agent({ id: 'foobar', name: 'foo bar' })]);
    expect(resolveAgentDispatch(l, 'foo bar x')).toEqual({ ok: true, agentId: 'foo', prompt: 'bar x' });
  });

  it('matches the longest identifier when several are prefixes', () => {
    const l = visibleAgents([agent({ id: 'a', name: 'spec' }), agent({ id: 'b', name: 'spec kit' })]);
    expect(resolveAgentDispatch(l, 'spec kit go')).toEqual({ ok: true, agentId: 'b', prompt: 'go' });
  });

  it('requires a boundary — a name is not matched mid-token', () => {
    const l = visibleAgents([agent({ id: 'x', name: 'agent' })]);
    expect(resolveAgentDispatch(l, 'agentic prompt')).toEqual({
      ok: false, status: 404, error: 'Agent not found: agentic',
    });
  });

  it('requires a prompt (no select-only) when a slug consumes the whole input', () => {
    expect(resolveAgentDispatch(list, 'reviewer')).toEqual({ ok: false, status: 400, error: 'prompt is required' });
  });

  it('requires a prompt when a full name consumes the whole input', () => {
    expect(resolveAgentDispatch(list, 'smoke user test')).toEqual({ ok: false, status: 400, error: 'prompt is required' });
  });

  it('404s an unknown agent (only known ids reach select)', () => {
    expect(resolveAgentDispatch(list, 'nope hello there')).toEqual({
      ok: false, status: 404, error: 'Agent not found: nope',
    });
  });

  it('rejects empty input', () => {
    expect(resolveAgentDispatch(list, '   ')).toEqual({ ok: false, status: 400, error: 'Usage: /agent <agent> <prompt>' });
  });

  it('does not resolve a non-invocable agent (filtered before resolution)', () => {
    expect(resolveAgentDispatch(list, 'hidden do x')).toEqual({
      ok: false, status: 404, error: 'Agent not found: hidden',
    });
  });
});
