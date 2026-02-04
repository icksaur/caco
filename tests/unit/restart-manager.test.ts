import { describe, it, expect, beforeEach } from 'vitest';
import {
  dispatchStarted,
  dispatchComplete,
  getActiveDispatches,
  requestRestart,
  isRestartRequested,
  onAllIdle,
  _resetForTest,
  _setTestHandlers
} from '../../src/restart-manager.js';

describe('restart-manager', () => {
  beforeEach(() => {
    _resetForTest();
  });

  describe('dispatch counting', () => {
    it('starts at zero', () => {
      expect(getActiveDispatches()).toBe(0);
    });

    it('increments on dispatchStarted', () => {
      dispatchStarted();
      expect(getActiveDispatches()).toBe(1);
      dispatchStarted();
      expect(getActiveDispatches()).toBe(2);
    });

    it('decrements on dispatchComplete', () => {
      dispatchStarted();
      dispatchStarted();
      dispatchComplete();
      expect(getActiveDispatches()).toBe(1);
    });

    it('never goes negative', () => {
      dispatchComplete();
      dispatchComplete();
      expect(getActiveDispatches()).toBe(0);
    });
  });

  describe('requestRestart', () => {
    it('sets restart flag', () => {
      _setTestHandlers({ onSpawn: () => {}, onExit: () => {} });
      
      expect(isRestartRequested()).toBe(false);
      requestRestart();
      expect(isRestartRequested()).toBe(true);
    });

    it('triggers restart immediately when idle', () => {
      let spawned = false;
      let exited = false;
      _setTestHandlers({
        onSpawn: () => { spawned = true; },
        onExit: () => { exited = true; }
      });

      requestRestart();

      expect(spawned).toBe(true);
      expect(exited).toBe(true);
    });

    it('waits for active dispatches before restart', () => {
      let spawned = false;
      let exited = false;
      _setTestHandlers({
        onSpawn: () => { spawned = true; },
        onExit: () => { exited = true; }
      });

      dispatchStarted();
      requestRestart();

      // Should not restart yet
      expect(spawned).toBe(false);
      expect(exited).toBe(false);
      expect(isRestartRequested()).toBe(true);
    });

    it('restarts when last dispatch completes', () => {
      let spawned = false;
      let exited = false;
      _setTestHandlers({
        onSpawn: () => { spawned = true; },
        onExit: () => { exited = true; }
      });

      dispatchStarted();
      dispatchStarted();
      requestRestart();

      // Still active
      expect(spawned).toBe(false);

      dispatchComplete();
      // Still one active
      expect(spawned).toBe(false);

      dispatchComplete();
      // Now should restart
      expect(spawned).toBe(true);
      expect(exited).toBe(true);
    });
  });

  describe('onAllIdle callback', () => {
    it('calls cleanup callback before spawn', () => {
      const callOrder: string[] = [];
      
      onAllIdle(() => { callOrder.push('cleanup'); });
      _setTestHandlers({
        onSpawn: () => { callOrder.push('spawn'); },
        onExit: () => { callOrder.push('exit'); }
      });

      requestRestart();

      expect(callOrder).toEqual(['cleanup', 'spawn', 'exit']);
    });

    it('continues restart even if callback throws', () => {
      let spawned = false;
      
      onAllIdle(() => { throw new Error('cleanup failed'); });
      _setTestHandlers({
        onSpawn: () => { spawned = true; },
        onExit: () => {}
      });

      // Should not throw
      expect(() => requestRestart()).not.toThrow();
      expect(spawned).toBe(true);
    });
  });

  describe('reset', () => {
    it('clears all state', () => {
      dispatchStarted();
      dispatchStarted();
      _setTestHandlers({ onExit: () => {} });
      
      _resetForTest();

      expect(getActiveDispatches()).toBe(0);
      expect(isRestartRequested()).toBe(false);
    });
  });
});
