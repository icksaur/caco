/**
 * Tests for application state (non-view)
 * View state tests are in view-controller.test.ts
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
      appState.setActiveSession('snapshot-test', '/snapshot');
      appState.setStreaming(true);
      
      const snapshot = appState.getState();
      
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
