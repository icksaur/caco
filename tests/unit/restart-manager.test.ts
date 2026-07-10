import { describe, it, expect, beforeEach } from 'vitest';
import {
  getActiveDispatches,
  requestRestart,
  isRestartRequested,
  onAllIdle,
  _resetForTest,
  _setTestHandlers,
  setAnyPendingProvider
} from '../../src/restart-manager.js';
import { dispatchState } from '../../src/dispatch-state.js';

// Convenience wrappers: restart-manager no longer counts dispatches itself,
// it watches dispatchState. Tests drive the source-of-truth directly.
function start(id: string): void {
  dispatchState.start(id, `corr-${id}`);
}
function end(id: string): void {
  dispatchState.end(id);
}

describe('restart-manager', () => {
  beforeEach(() => {
    _resetForTest();
    // Clear residual dispatchState entries from prior tests.
    for (const id of Array.from(dispatchState.getAllActive().keys())) {
      dispatchState.end(id);
    }
  });

  describe('dispatch counting (via dispatchState)', () => {
    it('starts at zero', () => {
      expect(getActiveDispatches()).toBe(0);
    });

    it('reflects dispatchState.start', () => {
      start('s1');
      expect(getActiveDispatches()).toBe(1);
      start('s2');
      expect(getActiveDispatches()).toBe(2);
    });

    it('reflects dispatchState.end', () => {
      start('s1');
      start('s2');
      end('s1');
      expect(getActiveDispatches()).toBe(1);
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

      start('s1');
      requestRestart();

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

      start('s1');
      start('s2');
      requestRestart();
      expect(spawned).toBe(false);

      end('s1');
      expect(spawned).toBe(false);

      end('s2');
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

      expect(() => requestRestart()).not.toThrow();
      expect(spawned).toBe(true);
    });
  });

  describe('pending auto-continue gate (spec-idle-suppression-central)', () => {
    it('defers the immediate restart check while a reveal-continuation is pending', () => {
      let spawned = false;
      _setTestHandlers({ onSpawn: () => { spawned = true; }, onExit: () => {} });
      // getActiveCount()===0 but a continuation is pending — must NOT restart.
      const pending = true;
      setAnyPendingProvider(() => pending);

      requestRestart();

      expect(spawned).toBe(false);
      expect(isRestartRequested()).toBe(true);
    });

    it('restarts once the pending continuation clears and a later idle re-fires', () => {
      let spawned = false;
      _setTestHandlers({ onSpawn: () => { spawned = true; }, onExit: () => {} });
      let pending = true;
      setAnyPendingProvider(() => pending);

      // Reveal dispatch running, restart requested mid-flight.
      start('s1');
      requestRestart();
      expect(spawned).toBe(false);

      // Reveal-dispatch end() emit is suppressed by the central suppressor in prod,
      // so drive the interleaving directly: dispatch ends (count→0) while pending.
      end('s1');
      expect(spawned).toBe(false); // gated on anyPending

      // Continuation reaches its real idle: pending clears, then idle re-fires.
      pending = false;
      dispatchState.signalIdle('s1');

      expect(spawned).toBe(true);
    });
  });

  describe('reset', () => {
    it('clears restart flag (dispatchState is the source of truth for count)', () => {
      _setTestHandlers({ onExit: () => {} });
      start('s1');
      requestRestart();

      _resetForTest();

      // Restart flag cleared; idle listener removed. Active count is still
      // governed by dispatchState (it lives on its own).
      expect(isRestartRequested()).toBe(false);
      expect(getActiveDispatches()).toBe(1);

      // Clean up
      end('s1');
    });
  });
});
