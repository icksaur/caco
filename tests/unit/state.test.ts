/**
 * Tests for client state.ts - State management
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

let stateModule: typeof import('../../public/ts/state.js');

describe('client state', () => {
  beforeEach(async () => {
    vi.resetModules();
    stateModule = await import('../../public/ts/state.js');
  });

  it('has expected initial state', () => {
    expect(stateModule.DEFAULT_MODEL).toBe('claude-sonnet-4');
    expect(stateModule.getActiveSessionId()).toBeNull();
    expect(stateModule.getCurrentCwd()).toBe('');
    expect(stateModule.getSelectedModel()).toBe(stateModule.DEFAULT_MODEL);
    expect(stateModule.isStreaming()).toBe(false);
  });

  it('getState returns immutable copy', () => {
    const state = stateModule.getState() as { activeSessionId: string | null };
    state.activeSessionId = 'modified';
    expect(stateModule.getActiveSessionId()).toBeNull();
  });

  it('setActiveSession updates session and cwd', () => {
    stateModule.setActiveSession('sess-123', '/home/user');
    expect(stateModule.getActiveSessionId()).toBe('sess-123');
    expect(stateModule.getCurrentCwd()).toBe('/home/user');
  });

  it('setStreaming tracks streaming state', () => {
    stateModule.setStreaming(true);
    expect(stateModule.isStreaming()).toBe(true);
    
    stateModule.setStreaming(false);
    expect(stateModule.isStreaming()).toBe(false);
  });

  it('initFromSession handles both API response formats', () => {
    // /api/session format
    stateModule.initFromSession({ sessionId: 'a', cwd: '/path1' });
    expect(stateModule.getActiveSessionId()).toBe('a');
    
    // /api/sessions format
    stateModule.initFromSession({ activeSessionId: 'b', currentCwd: '/path2' });
    expect(stateModule.getActiveSessionId()).toBe('b');
  });

  it('initFromPreferences restores saved state', () => {
    const mockInput = { value: '' };
    globalThis.document = {
      getElementById: (id: string) => id === 'selectedModel' ? mockInput : null
    } as unknown as Document;
    
    stateModule.initFromPreferences({
      lastModel: 'gpt-4o',
      lastCwd: '/saved/path',
      lastSessionId: 'saved-sess'
    });
    
    expect(stateModule.getSelectedModel()).toBe('gpt-4o');
    expect(stateModule.getCurrentCwd()).toBe('/saved/path');
    expect(stateModule.getActiveSessionId()).toBe('saved-sess');
    
    delete (globalThis as Record<string, unknown>).document;
  });
});
