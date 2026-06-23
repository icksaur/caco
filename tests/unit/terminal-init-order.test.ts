import { describe, it, expect } from 'vitest';
import { initTerminalManager } from '../../src/terminal-manager.js';

/**
 * Boot-order contract: initTerminalManager registers sessionState.onSessionEnd, so
 * it must run AFTER createSessionState(). In a fresh module registry (no
 * createSessionState call) the `sessionState` singleton is undefined; the guard
 * must throw a descriptive error rather than a cryptic
 * "Cannot read properties of undefined (reading 'onSessionEnd')".
 *
 * This pins the ordering: if someone moves initTerminalManager() before
 * createSessionState() in server.ts, this test (and the clear error) catch it.
 */
describe('initTerminalManager boot-order guard', () => {
  it('throws a descriptive error when called before createSessionState', () => {
    expect(() => initTerminalManager()).toThrow(/before createSessionState/);
  });
});
