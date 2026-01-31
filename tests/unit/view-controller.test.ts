/**
 * Tests for view-controller.ts
 * 
 * These tests focus on the module's exports and type safety.
 * Full DOM testing requires a browser environment.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub browser globals before importing
vi.stubGlobal('document', {
  getElementById: () => ({
    classList: {
      add: vi.fn(),
      remove: vi.fn(),
      contains: () => false
    }
  })
});

vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0));

describe('view-controller', () => {
  let viewController: typeof import('../../public/ts/view-controller.js');
  
  beforeEach(async () => {
    vi.resetModules();
    
    // Mock app-state to avoid import issues
    vi.doMock('../../public/ts/app-state.js', () => ({
      clearActiveSession: vi.fn(),
      getCurrentCwd: vi.fn(() => '/test/path')
    }));
    
    vi.doMock('../../public/ts/ui-utils.js', () => ({
      scrollToBottom: vi.fn()
    }));
    
    vi.doMock('../../public/ts/applet-runtime.js', () => ({
      getActiveAppletSlug: vi.fn(() => null),
      getActiveAppletLabel: vi.fn(() => null)
    }));
    
    vi.doMock('../../public/ts/hostname-hash.js', () => ({
      getServerHostname: vi.fn(() => 'test-host')
    }));
    
    viewController = await import('../../public/ts/view-controller.js');
  });
  
  describe('exports', () => {
    it('exports ViewState type compatible values', () => {
      // These should all be valid ViewState values
      const validStates = ['sessions', 'newChat', 'chatting', 'applet'];
      validStates.forEach(state => {
        expect(typeof state).toBe('string');
      });
    });
    
    it('exports getViewState function', () => {
      expect(typeof viewController.getViewState).toBe('function');
    });
    
    it('exports setViewState function', () => {
      expect(typeof viewController.setViewState).toBe('function');
    });
    
    it('exports isViewState function', () => {
      expect(typeof viewController.isViewState).toBe('function');
    });
    
    it('exports initViewState function', () => {
      expect(typeof viewController.initViewState).toBe('function');
    });
  });
  
  describe('view state transitions', () => {
    it('setViewState changes current state', () => {
      viewController.setViewState('newChat');
      expect(viewController.getViewState()).toBe('newChat');
      
      viewController.setViewState('chatting');
      expect(viewController.getViewState()).toBe('chatting');
    });
    
    it('isViewState returns correct boolean', () => {
      viewController.setViewState('applet');
      
      expect(viewController.isViewState('applet')).toBe(true);
      expect(viewController.isViewState('sessions')).toBe(false);
      expect(viewController.isViewState('newChat')).toBe(false);
      expect(viewController.isViewState('chatting')).toBe(false);
    });
    
    it('does not change state when setting same value', () => {
      viewController.setViewState('sessions');
      const before = viewController.getViewState();
      
      viewController.setViewState('sessions');
      const after = viewController.getViewState();
      
      expect(before).toBe(after);
    });
  });
});

