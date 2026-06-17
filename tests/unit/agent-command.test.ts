import { describe, expect, it } from 'vitest';
import {
  parseAgentDispatchInput,
  validateAgentForUserDispatch,
  visibleAgents,
  type SdkAgentInfo,
} from '../../src/agent-command.js';

const agents: SdkAgentInfo[] = [
  { name: 'reviewer', id: 'reviewer', displayName: 'Reviewer', description: 'Reviews code' },
  { name: 'hidden', id: 'hidden', displayName: 'Hidden', description: 'Internal', userInvocable: false },
  { name: 'space agent', id: 'space agent', displayName: 'Space Agent', description: 'Unsupported' },
];

describe('agent command helpers', () => {
  it('parses a whitespace-free agent name and preserves the remaining prompt', () => {
    expect(parseAgentDispatchInput('reviewer check reliability and tests')).toEqual({
      agentName: 'reviewer',
      prompt: 'check reliability and tests',
    });
  });

  it('rejects missing prompt or agent name', () => {
    expect(parseAgentDispatchInput('')).toBeNull();
    expect(parseAgentDispatchInput('reviewer')).toBeNull();
  });

  it('filters hidden and whitespace-named agents from the visible picker list', () => {
    expect(visibleAgents(agents).map(agent => agent.name)).toEqual(['reviewer']);
  });

  it('validates selected agents before dispatch', () => {
    expect(validateAgentForUserDispatch(agents, 'reviewer')).toEqual({ ok: true, agent: agents[0] });
    expect(validateAgentForUserDispatch(agents, 'missing')).toEqual({ ok: false, status: 404, error: 'Agent not found: missing' });
    expect(validateAgentForUserDispatch(agents, 'hidden')).toEqual({ ok: false, status: 404, error: 'Agent not invocable: hidden' });
    expect(validateAgentForUserDispatch(agents, 'space agent')).toEqual({ ok: false, status: 400, error: 'Agent names with whitespace are not supported' });
  });
});
