/**
 * Tests for consolidated application state
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Module reference for dynamic import
let appState: typeof import('../../public/ts/app-state.js');

describe('app-state', () => {
  beforeEach(async () => {
    vi.resetModules();
    
    // Mock websocket before importing app-state
    vi.doMock('../../public/ts/websocket.js', () => ({
      setActiveSession: vi.fn(),
      isWsConnected: vi.fn(() => false),
      getActiveSessionId: vi.fn(() => null)
    }));
    
    appState = await import('../../public/ts/app-state.js');
  });
  
  describe('view state', () => {
    it('getViewState returns current view', () => {
      const state = appState.getState();
      expect(appState.getViewState()).toBe(state.viewState);
    });
    
    it('setViewState updates view and returns true on change', () => {
      const initial = appState.getViewState();
      const newState = initial === 'sessions' ? 'newChat' : 'sessions';
      
      const changed = appState.setViewState(newState);
      expect(changed).toBe(true);
      expect(appState.getViewState()).toBe(newState);
    });
    
    it('setViewState returns false when no change', () => {
      const current = appState.getViewState();
      const changed = appState.setViewState(current);
      expect(changed).toBe(false);
    });
    
    it('isViewState checks current view', () => {
      appState.setViewState('chatting');
      expect(appState.isViewState('chatting')).toBe(true);
      expect(appState.isViewState('sessions')).toBe(false);
    });
  });
  
  describe('session state', () => {
    it('setActiveSession updates sessionId and cwd', () => {
      appState.setActiveSession('test-session', '/test/path');
      
      expect(appState.getActiveSessionId()).toBe('test-session');
      expect(appState.getCurrentCwd()).toBe('/test/path');
    });
    
    it('clearActiveSession clears only sessionId, not cwd', () => {
      appState.setActiveSession('sess-123', '/my/project');
      appState.clearActiveSession();
      
      expect(appState.getActiveSessionId()).toBeNull();
      expect(appState.getCurrentCwd()).toBe('/my/project'); // Preserved
    });
  });
  
  describe('model state', () => {
    it('setSelectedModel updates model', () => {
      appState.setSelectedModel('gpt-4');
      expect(appState.getSelectedModel()).toBe('gpt-4');
    });
    
    it('setAvailableModels stores models', () => {
      const models = [
        { id: 'model-a', name: 'Model A', cost: 1 },
        { id: 'model-b', name: 'Model B', cost: 2 }
      ];
      
      appState.setAvailableModels(models);
      expect(appState.getAvailableModels()).toHaveLength(2);
      expect(appState.getAvailableModels()[0].id).toBe('model-a');
    });
    
    it('setAvailableModels makes defensive copy', () => {
      const models = [{ id: 'model-x', name: 'Model X', cost: 1 }];
      appState.setAvailableModels(models);
      
      // Mutate original
      models.push({ id: 'model-y', name: 'Model Y', cost: 2 });
      
      // State should not be affected
      expect(appState.getAvailableModels()).toHaveLength(1);
    });
  });
  
  describe('UI flags', () => {
    it('streaming state', () => {
      appState.setStreaming(true);
      expect(appState.isStreaming()).toBe(true);
      
      appState.setStreaming(false);
      expect(appState.isStreaming()).toBe(false);
    });
    
    it('loading history state', () => {
      appState.setLoadingHistory(true);
      expect(appState.isLoadingHistory()).toBe(true);
      
      appState.setLoadingHistory(false);
      expect(appState.isLoadingHistory()).toBe(false);
    });
    
    it('auto-scroll state', () => {
      appState.enableAutoScroll();
      expect(appState.isAutoScrollEnabled()).toBe(true);
      
      appState.disableAutoScroll();
      expect(appState.isAutoScrollEnabled()).toBe(false);
    });
    
    it('image attachment state', () => {
      appState.setHasImage(true);
      expect(appState.hasImage()).toBe(true);
      
      appState.setHasImage(false);
      expect(appState.hasImage()).toBe(false);
    });
  });
  
  describe('initialization', () => {
    it('initFromPreferences sets model, cwd, and sessionId', () => {
      appState.initFromPreferences({
        lastModel: 'claude-opus',
        lastCwd: '/projects/myapp',
        lastSessionId: 'pref-session-123'
      });
      
      expect(appState.getSelectedModel()).toBe('claude-opus');
      expect(appState.getCurrentCwd()).toBe('/projects/myapp');
      expect(appState.getActiveSessionId()).toBe('pref-session-123');
    });
    
    it('initFromSession handles both API formats', () => {
      // Format 1: sessionId/cwd
      appState.initFromSession({ sessionId: 'sess-a', cwd: '/path/a' });
      expect(appState.getActiveSessionId()).toBe('sess-a');
      expect(appState.getCurrentCwd()).toBe('/path/a');
      
      // Format 2: activeSessionId/currentCwd
      appState.initFromSession({ activeSessionId: 'sess-b', currentCwd: '/path/b' });
      expect(appState.getActiveSessionId()).toBe('sess-b');
      expect(appState.getCurrentCwd()).toBe('/path/b');
    });
  });
  
  describe('getState', () => {
    it('returns snapshot of all state', () => {
      appState.setViewState('applet');
      appState.setActiveSession('snapshot-test', '/snapshot');
      appState.setStreaming(true);
      
      const snapshot = appState.getState();
      
      expect(snapshot.viewState).toBe('applet');
      expect(snapshot.activeSessionId).toBe('snapshot-test');
      expect(snapshot.currentCwd).toBe('/snapshot');
      expect(snapshot.isStreaming).toBe(true);
    });
    
    it('returns copy, not reference', () => {
      const snapshot1 = appState.getState();
      appState.setStreaming(!snapshot1.isStreaming);
      const snapshot2 = appState.getState();
      
      // Original snapshot should not be mutated
      expect(snapshot1.isStreaming).not.toBe(snapshot2.isStreaming);
    });
  });
});
