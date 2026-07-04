import { describe, it, expect, beforeEach, vi } from 'vitest';

const fsMock = vi.hoisted(() => ({
  readFileSync: vi.fn(() => { throw new Error('no file'); }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('fs', () => fsMock);

import { isServerDeferred, setServerDeferred, getDeferredServers, _resetManualDeferForTest } from '../../src/manual-defer-store.js';

beforeEach(() => { _resetManualDeferForTest(); fsMock.writeFileSync.mockReset(); });

describe('manual-defer-store — persisted set of operator-deferred MCP servers', () => {
  it('defaults to not-deferred', () => {
    expect(isServerDeferred('github-mcp-server')).toBe(false);
    expect(getDeferredServers()).toEqual([]);
  });

  it('marks a server deferred and reflects it', () => {
    setServerDeferred('github-mcp-server', true);
    expect(isServerDeferred('github-mcp-server')).toBe(true);
    expect(getDeferredServers()).toEqual(['github-mcp-server']);
  });

  it('un-defers a server', () => {
    setServerDeferred('github-mcp-server', true);
    setServerDeferred('github-mcp-server', false);
    expect(isServerDeferred('github-mcp-server')).toBe(false);
    expect(getDeferredServers()).toEqual([]);
  });

  it('is idempotent (double-defer, double-undefer)', () => {
    setServerDeferred('s', true);
    setServerDeferred('s', true);
    expect(getDeferredServers()).toEqual(['s']);
    setServerDeferred('s', false);
    setServerDeferred('s', false);
    expect(getDeferredServers()).toEqual([]);
  });

  it('throws and reverts the in-memory change when the write fails', () => {
    fsMock.writeFileSync.mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(() => setServerDeferred('github', true)).toThrow('disk full');
    // Reverted: in-memory state must match the (failed) persisted state.
    expect(isServerDeferred('github')).toBe(false);
    expect(getDeferredServers()).toEqual([]);
  });
});

