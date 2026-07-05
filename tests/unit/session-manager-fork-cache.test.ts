import { describe, it, expect } from 'vitest';
import { shouldUseForkReplaceSystemMessage, resolveResumeSystemMessage } from '../../src/session-manager.js';

// Gate for fork cache preservation (spec-session-fork "Prompt-cache preservation").
// A forked interactive child's FIRST genuine activation reuses the parent's
// mode:'replace' system message so the parent's cached prefix is served from cache.
const fork = { parentSessionId: 'p1', kind: 'interactive' };
const firstActivation = { alreadyActive: false };

describe('shouldUseForkReplaceSystemMessage — fork cache gate', () => {
  it('is TRUE for a forked interactive child on first activation', () => {
    expect(shouldUseForkReplaceSystemMessage(fork, firstActivation)).toBe(true);
  });

  it('is FALSE for a swarm/agent child even with a parentSessionId (wants its own agent prompt)', () => {
    expect(shouldUseForkReplaceSystemMessage({ parentSessionId: 'p1', kind: 'agent' }, firstActivation)).toBe(false);
    expect(shouldUseForkReplaceSystemMessage({ parentSessionId: 'p1', kind: 'swarm' }, firstActivation)).toBe(false);
  });

  it('is FALSE for a normal (non-forked) session with no parentSessionId', () => {
    expect(shouldUseForkReplaceSystemMessage({ kind: 'interactive' }, firstActivation)).toBe(false);
    expect(shouldUseForkReplaceSystemMessage(undefined, firstActivation)).toBe(false);
  });

  it('is FALSE when kind is missing (legacy meta) — only an explicit interactive fork qualifies', () => {
    expect(shouldUseForkReplaceSystemMessage({ parentSessionId: 'p1' }, firstActivation)).toBe(false);
  });

  it('is FALSE when the session is already active (first activation only)', () => {
    expect(shouldUseForkReplaceSystemMessage(fork, { alreadyActive: true })).toBe(false);
  });

  it('is FALSE on a warm recreate or model switch of a forked child (must not bust its warm cache)', () => {
    // Warm recreates (setModel / context-budget change) delete activeSessions then
    // resume, so alreadyActive is false — the guard must still exclude them.
    expect(shouldUseForkReplaceSystemMessage(fork, { alreadyActive: false, warmRecreate: true })).toBe(false);
    expect(shouldUseForkReplaceSystemMessage(fork, { alreadyActive: false, modelOverride: 'gpt-5.5' })).toBe(false);
  });
});

describe('resolveResumeSystemMessage — the exact object _doResume sends to resumeSession', () => {
  it('forked child (useForkReplace) → mode:replace with the parent-identical content', () => {
    expect(resolveResumeSystemMessage({ useForkReplace: true, replaceContent: 'PARENT-SYS', memoryContent: 'mem' }))
      .toEqual({ mode: 'replace', content: 'PARENT-SYS' });
  });

  it('normal resume with memory → mode:append memory (unchanged historical behaviour)', () => {
    expect(resolveResumeSystemMessage({ useForkReplace: false, replaceContent: '', memoryContent: '## User Memory\n- k: v' }))
      .toEqual({ mode: 'append', content: '## User Memory\n- k: v' });
  });

  it('normal resume with no memory → undefined (no systemMessage sent)', () => {
    expect(resolveResumeSystemMessage({ useForkReplace: false, replaceContent: '', memoryContent: '' }))
      .toBeUndefined();
  });

  it('fork-replace takes precedence over memory (memory is inside the rebuilt replace content)', () => {
    expect(resolveResumeSystemMessage({ useForkReplace: true, replaceContent: 'PARENT-SYS', memoryContent: 'mem' })!.mode)
      .toBe('replace');
  });
});
