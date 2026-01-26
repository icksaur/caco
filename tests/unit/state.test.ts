/**
 * Tests for client state.ts - State management
 * 
 * Note: These tests reveal a design limitation - the state module uses
 * module-level singleton state that persists between tests. We work around
 * this by testing in isolation where possible and resetting state explicitly.
 * 
 * A future refactoring could introduce a createState() factory for better testability.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// We need to reset the module state between tests
// This is a limitation of singleton state - tests can pollute each other
let stateModule: typeof import('../../public/ts/state.js');

describe('client state', () => {
  beforeEach(async () => {
    // Reset module cache to get fresh state
    vi.resetModules();
    stateModule = await import('../../public/ts/state.js');
  });

  describe('DEFAULT_MODEL', () => {
    it('has a default model defined', () => {
      expect(stateModule.DEFAULT_MODEL).toBe('claude-sonnet-4');
    });
  });

  describe('initial state', () => {
    it('starts with null session ID', () => {
      expect(stateModule.getActiveSessionId()).toBeNull();
    });

    it('starts with empty cwd', () => {
      expect(stateModule.getCurrentCwd()).toBe('');
    });

    it('starts with default model selected', () => {
      expect(stateModule.getSelectedModel()).toBe(stateModule.DEFAULT_MODEL);
    });

    it('starts not streaming', () => {
      expect(stateModule.isStreaming()).toBe(false);
    });

    it('starts with no active event source', () => {
      expect(stateModule.getActiveEventSource()).toBeNull();
    });

    it('starts with no image', () => {
      expect(stateModule.hasImage()).toBe(false);
    });
  });

  describe('getState', () => {
    it('returns a copy of all state', () => {
      const state = stateModule.getState();
      
      expect(state).toHaveProperty('activeSessionId');
      expect(state).toHaveProperty('currentCwd');
      expect(state).toHaveProperty('selectedModel');
      expect(state).toHaveProperty('isStreaming');
      expect(state).toHaveProperty('activeEventSource');
      expect(state).toHaveProperty('hasImage');
    });

    it('returns immutable copy (mutations do not affect actual state)', () => {
      const state = stateModule.getState() as { activeSessionId: string | null };
      state.activeSessionId = 'modified';
      
      expect(stateModule.getActiveSessionId()).toBeNull();
    });
  });

  describe('setActiveSession', () => {
    it('sets session ID and cwd', () => {
      stateModule.setActiveSession('sess-123', '/home/user/project');
      
      expect(stateModule.getActiveSessionId()).toBe('sess-123');
      expect(stateModule.getCurrentCwd()).toBe('/home/user/project');
    });

    it('can set session ID to null', () => {
      stateModule.setActiveSession('sess-123', '/path');
      stateModule.setActiveSession(null, '/other');
      
      expect(stateModule.getActiveSessionId()).toBeNull();
      expect(stateModule.getCurrentCwd()).toBe('/other');
    });
  });

  describe('setSelectedModel', () => {
    it('updates selected model (with DOM mock)', () => {
      // setSelectedModel accesses document - we need to mock it
      const mockInput = { value: '' };
      globalThis.document = {
        getElementById: (id: string) => id === 'selectedModel' ? mockInput : null
      } as unknown as Document;
      
      stateModule.setSelectedModel('gpt-4o');
      expect(stateModule.getSelectedModel()).toBe('gpt-4o');
      expect(mockInput.value).toBe('gpt-4o');
      
      // Clean up
      delete (globalThis as Record<string, unknown>).document;
    });

    // Note: setSelectedModel also syncs to DOM.
    // This is a design smell - the function does two things.
    // Future refactoring: separate state update from DOM sync.
  });

  describe('setStreaming', () => {
    it('sets streaming state', () => {
      stateModule.setStreaming(true);
      expect(stateModule.isStreaming()).toBe(true);
      
      stateModule.setStreaming(false);
      expect(stateModule.isStreaming()).toBe(false);
    });

    it('stores event source when streaming', () => {
      // We can't use a real EventSource in Node, so we use a mock
      const mockEventSource = { close: vi.fn() } as unknown as EventSource;
      
      stateModule.setStreaming(true, mockEventSource);
      
      expect(stateModule.isStreaming()).toBe(true);
      expect(stateModule.getActiveEventSource()).toBe(mockEventSource);
    });

    it('clears event source when stopping', () => {
      const mockEventSource = { close: vi.fn() } as unknown as EventSource;
      stateModule.setStreaming(true, mockEventSource);
      stateModule.setStreaming(false, null);
      
      expect(stateModule.getActiveEventSource()).toBeNull();
    });
  });

  describe('setHasImage', () => {
    it('sets image attachment state', () => {
      stateModule.setHasImage(true);
      expect(stateModule.hasImage()).toBe(true);
      
      stateModule.setHasImage(false);
      expect(stateModule.hasImage()).toBe(false);
    });
  });

  describe('initFromPreferences', () => {
    it('initializes model from preferences', () => {
      // Mock document for setSelectedModel call
      const mockInput = { value: '' };
      globalThis.document = {
        getElementById: (id: string) => id === 'selectedModel' ? mockInput : null
      } as unknown as Document;
      
      stateModule.initFromPreferences({ lastModel: 'o1-preview' });
      expect(stateModule.getSelectedModel()).toBe('o1-preview');
      
      delete (globalThis as Record<string, unknown>).document;
    });

    it('initializes cwd from preferences', () => {
      stateModule.initFromPreferences({ lastCwd: '/home/user/project' });
      expect(stateModule.getCurrentCwd()).toBe('/home/user/project');
    });

    it('initializes session ID from preferences', () => {
      stateModule.initFromPreferences({ lastSessionId: 'sess-abc' });
      expect(stateModule.getActiveSessionId()).toBe('sess-abc');
    });

    it('handles null lastSessionId', () => {
      stateModule.setActiveSession('existing', '/path');
      stateModule.initFromPreferences({ lastSessionId: null });
      expect(stateModule.getActiveSessionId()).toBeNull();
    });

    it('handles partial preferences', () => {
      stateModule.initFromPreferences({});
      // Should not throw, state should remain at defaults
      expect(stateModule.getSelectedModel()).toBe(stateModule.DEFAULT_MODEL);
    });
  });

  describe('initFromSession', () => {
    it('handles /api/session response format', () => {
      stateModule.initFromSession({
        sessionId: 'sess-123',
        cwd: '/path/to/project'
      });
      
      expect(stateModule.getActiveSessionId()).toBe('sess-123');
      expect(stateModule.getCurrentCwd()).toBe('/path/to/project');
    });

    it('handles /api/sessions response format', () => {
      stateModule.initFromSession({
        activeSessionId: 'sess-456',
        currentCwd: '/other/path'
      });
      
      expect(stateModule.getActiveSessionId()).toBe('sess-456');
      expect(stateModule.getCurrentCwd()).toBe('/other/path');
    });

    it('prefers sessionId over activeSessionId when both present', () => {
      stateModule.initFromSession({
        sessionId: 'primary',
        activeSessionId: 'secondary',
        cwd: '/path'
      });
      
      expect(stateModule.getActiveSessionId()).toBe('primary');
    });

    it('handles null sessionId', () => {
      stateModule.initFromSession({ sessionId: null, cwd: '/path' });
      expect(stateModule.getActiveSessionId()).toBeNull();
    });

    it('handles empty data', () => {
      stateModule.initFromSession({});
      expect(stateModule.getActiveSessionId()).toBeNull();
      expect(stateModule.getCurrentCwd()).toBe('');
    });
  });
});
