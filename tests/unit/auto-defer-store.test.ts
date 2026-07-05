import { describe, it, expect, beforeEach, vi } from 'vitest';

const fsMock = vi.hoisted(() => ({
  readFileSync: vi.fn(() => { throw new Error('no file'); }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('fs', () => fsMock);

import { getAutoDeferred, addAutoDeferred, removeAutoDeferred, _resetAutoDeferForTest } from '../../src/auto-defer-store.js';
import { mcpKey } from '../../src/tool-key.js';

beforeEach(() => { _resetAutoDeferForTest(); fsMock.writeFileSync.mockReset(); });

describe('auto-defer-store — one-way system-wide staleness latch', () => {
  const a = mcpKey('github-list_issues');
  const b = mcpKey('github-get_pr');

  it('defaults to an empty latch', () => {
    expect([...getAutoDeferred()]).toEqual([]);
  });

  it('adds keys (union, dedupes) and reflects them', () => {
    addAutoDeferred([a, b, a]);
    expect(new Set(getAutoDeferred())).toEqual(new Set([a, b]));
  });

  it('removes keys (the operator un-defer path)', () => {
    addAutoDeferred([a, b]);
    removeAutoDeferred([a]);
    expect([...getAutoDeferred()]).toEqual([b]);
  });

  it('persists only on an actual change', () => {
    addAutoDeferred([a]);
    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
    addAutoDeferred([a]); // no-op: already latched
    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
    removeAutoDeferred([b]); // no-op: not present
    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it('logs-not-throws when the write fails (best-effort, never breaks session setup)', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    fsMock.writeFileSync.mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(() => addAutoDeferred([a])).not.toThrow();
    // In-memory latch still reflects the add (write is best-effort, self-heals later).
    expect([...getAutoDeferred()]).toEqual([a]);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
