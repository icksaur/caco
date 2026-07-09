import { describe, it, expect } from 'vitest';
import { getLastAssistantMessage } from '../../src/session-history.js';
import type { SessionEvent } from '../../src/types.js';

function ev(type: string, content?: unknown): SessionEvent {
  return { type, data: content === undefined ? {} : { content } } as unknown as SessionEvent;
}

describe('getLastAssistantMessage', () => {
  it('returns the content of the LAST assistant.message', async () => {
    const history: SessionEvent[] = [
      ev('user.message', 'hi'),
      ev('assistant.message', 'first answer'),
      ev('tool.execution_complete'),
      ev('assistant.message', 'final answer'),
    ];
    const out = await getLastAssistantMessage('s1', async () => history);
    expect(out).toBe('final answer');
  });

  it('skips non-string assistant content and keeps scanning backwards', async () => {
    const history: SessionEvent[] = [
      ev('assistant.message', 'earlier'),
      ev('assistant.message', { not: 'a string' }),
    ];
    const out = await getLastAssistantMessage('s1', async () => history);
    expect(out).toBe('earlier');
  });

  it('returns a sentinel when there is no assistant message', async () => {
    const out = await getLastAssistantMessage('s1', async () => [ev('user.message', 'hi')]);
    expect(out).toBe('(no assistant response found)');
  });

  it('returns a sentinel on empty history', async () => {
    const out = await getLastAssistantMessage('s1', async () => []);
    expect(out).toBe('(no assistant response found)');
  });

  it('never throws — a failing provider yields an error sentinel', async () => {
    const out = await getLastAssistantMessage('s1', async () => { throw new Error('disk gone'); });
    expect(out).toMatch(/error reading history/i);
    expect(out).toContain('disk gone');
  });
});
