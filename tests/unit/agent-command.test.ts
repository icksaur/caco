import { describe, expect, it } from 'vitest';
import {
  resolveAgentSelection,
  visibleAgents,
  isUsableSlug,
  filterSkillCommands,
  type SdkAgentInfo,
  type SdkCommandInfo,
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

describe('resolveAgentSelection', () => {
  const list = visibleAgents(agents);

  it('resolves an exact slug to that agent (no prompt — select only)', () => {
    expect(resolveAgentSelection(list, 'reviewer')).toEqual({ ok: true, agentId: 'reviewer' });
  });

  it('resolves a multi-word frontmatter name to its slug', () => {
    expect(resolveAgentSelection(list, 'smoke user test')).toEqual({ ok: true, agentId: 'smoke-user' });
  });

  it('resolves the slug form for a spaced-name agent', () => {
    expect(resolveAgentSelection(list, 'smoke-user')).toEqual({ ok: true, agentId: 'smoke-user' });
  });

  it('trims surrounding whitespace before matching', () => {
    expect(resolveAgentSelection(list, '  reviewer  ')).toEqual({ ok: true, agentId: 'reviewer' });
  });

  it('treats the full payload as the identifier — trailing text is NOT a prompt', () => {
    // "reviewer check" is neither a slug nor a full name → not found (no prompt parsing).
    expect(resolveAgentSelection(list, 'reviewer check')).toEqual({
      ok: false, status: 404, error: 'Agent not found: reviewer check',
    });
  });

  it('prefers the slug id over a name collision', () => {
    const l = visibleAgents([agent({ id: 'foo', name: 'foo' }), agent({ id: 'bar', name: 'foo' })]);
    expect(resolveAgentSelection(l, 'foo')).toEqual({ ok: true, agentId: 'foo' });
  });

  it('404s an unknown agent (only known ids reach select)', () => {
    expect(resolveAgentSelection(list, 'nope')).toEqual({
      ok: false, status: 404, error: 'Agent not found: nope',
    });
  });

  it('400s empty input', () => {
    expect(resolveAgentSelection(list, '   ')).toEqual({ ok: false, status: 400, error: 'Usage: /agent <agent-name>' });
  });

  it('does not resolve a non-invocable agent (filtered before resolution)', () => {
    expect(resolveAgentSelection(list, 'hidden')).toEqual({
      ok: false, status: 404, error: 'Agent not found: hidden',
    });
  });
});

describe('filterSkillCommands', () => {
  const commands: SdkCommandInfo[] = [
    { name: 'code-review', description: 'Do a review', kind: 'skill', input: { hint: 'what to review' } },
    { name: 'plan', description: 'Builtin plan', kind: 'builtin' },
    { name: 'mcp-thing', description: 'A client cmd', kind: 'client' },
    { name: 'disabled-skill', kind: 'skill', userInvocable: false },
    { name: '', kind: 'skill' },
  ];

  it('keeps only user-invocable skill commands with a name', () => {
    expect(filterSkillCommands(commands)).toEqual([
      { name: 'code-review', description: 'Do a review', hint: 'what to review' },
    ]);
  });

  it('defaults a missing description to empty string', () => {
    expect(filterSkillCommands([{ name: 'bare', kind: 'skill' }])).toEqual([
      { name: 'bare', description: '', hint: undefined },
    ]);
  });
});
