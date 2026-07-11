import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('fs')>();
  return { ...original, appendFileSync: vi.fn() };
});

import { dispatchState } from '../../src/dispatch-state.js';
import {
  _resetForTest,
  _setTestHandlers,
  getActiveDispatches,
  isRestartRequested,
  onAllIdle,
  requestRestart,
  setAnyPendingProvider,
} from '../../src/restart-manager.js';

function startDispatch(sessionId: string): void {
  dispatchState.start(sessionId, `corr-${sessionId}`);
}

function endDispatch(sessionId: string): void {
  dispatchState.end(sessionId);
}

function clearDispatches(): void {
  for (const sessionId of dispatchState.getAllActive().keys()) {
    dispatchState.end(sessionId);
  }
}

describe('restart-manager additional branches', () => {
  beforeEach(() => {
    _resetForTest();
    clearDispatches();
  });

  it('runs onAllIdle only after active dispatches drain to zero', () => {
    const events: string[] = [];
    startDispatch('one');
    startDispatch('two');
    onAllIdle(() => {
      events.push('cleanup');
    });
    _setTestHandlers({
      onSpawn: () => {
        events.push('spawn');
      },
      onExit: () => {
        events.push('exit');
      },
    });

    requestRestart();
    endDispatch('one');
    expect(events).toEqual([]);

    endDispatch('two');

    expect(events).toEqual(['cleanup', 'spawn', 'exit']);
  });

  it('installs one idle listener for repeated restart requests while busy', () => {
    let spawnCount = 0;
    let exitCount = 0;
    startDispatch('busy');
    _setTestHandlers({
      onSpawn: () => {
        spawnCount += 1;
      },
      onExit: () => {
        exitCount += 1;
      },
    });

    requestRestart();
    requestRestart();
    expect(isRestartRequested()).toBe(true);
    expect(spawnCount).toBe(0);

    endDispatch('busy');

    expect(spawnCount).toBe(1);
    expect(exitCount).toBe(1);
  });

  it('counts active dispatches from the dispatch-state source of truth', () => {
    expect(getActiveDispatches()).toBe(0);

    startDispatch('a');
    startDispatch('b');
    endDispatch('a');

    expect(getActiveDispatches()).toBe(1);
  });

  it('defers restart while any pending provider returns true, then restarts on a later idle signal', () => {
    const events: string[] = [];
    let pending = true;
    setAnyPendingProvider(() => pending);
    _setTestHandlers({
      onSpawn: () => {
        events.push('spawn');
      },
      onExit: () => {
        events.push('exit');
      },
    });

    requestRestart();
    expect(events).toEqual([]);

    pending = false;
    dispatchState.signalIdle('after-pending');

    expect(events).toEqual(['spawn', 'exit']);
  });
});
