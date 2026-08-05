import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isPseudoServer } from '../../src/tool-registry.js';

/**
 * The pseudo-server defer guard (spec-defer-default-inversion row 5).
 *
 * "Caco"/"Built-in" are synthetic groupings in the mcp-servers applet. They own no
 * learned MCP keys, so `setServerDeferred('Caco')` is INERT today — an earlier draft
 * of the spec wrongly claimed it would strip `caco_enable_tools`. The guard exists
 * because that inertness is incidental: the name would still land in persisted state
 * and render a deferred badge for a group that actually defers by usage.
 */

const store = { file: null as string[] | null, written: null as string[] | null };

vi.mock('fs', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    readFileSync: (p: string, enc: string) => {
      if (String(p).includes('manual-defer.json')) {
        if (store.file === null) throw new Error('ENOENT');
        return JSON.stringify(store.file);
      }
      return (actual.readFileSync as (p: string, e: string) => string)(p, enc);
    },
    writeFileSync: (p: string, data: string, enc: string) => {
      if (String(p).includes('manual-defer.json')) { store.written = JSON.parse(data) as string[]; return; }
      return (actual.writeFileSync as (p: string, d: string, e: string) => void)(p, data, enc);
    },
    mkdirSync: (p: string, o: unknown) => {
      if (String(p).includes('.caco')) return undefined;
      return (actual.mkdirSync as (p: string, o: unknown) => unknown)(p, o);
    },
  };
});

beforeEach(() => {
  store.file = null;
  store.written = null;
  vi.resetModules();
});

describe('isPseudoServer', () => {
  it('separates the synthetic groupings from real MCP servers', () => {
    expect(isPseudoServer('Caco')).toBe(true);
    expect(isPseudoServer('Built-in')).toBe(true);
    expect(isPseudoServer('github-mcp-server')).toBe(false);
    expect(isPseudoServer('')).toBe(false);
  });
});

describe('manual-defer store ignores persisted pseudo-servers', () => {
  it('drops a Caco entry an earlier build could have written', async () => {
    // A write-path guard cannot clean state already on disk, so the read path has
    // to be the one that makes the invariant hold for existing installs.
    store.file = ['Caco', 'github-mcp-server', 'Built-in'];

    const mod = await import('../../src/manual-defer-store.js');

    expect(mod.isServerDeferred('Caco')).toBe(false);
    expect(mod.isServerDeferred('Built-in')).toBe(false);
    expect(mod.isServerDeferred('github-mcp-server')).toBe(true);
  });

  it('keeps a real server deferrable through the normal path', async () => {
    store.file = [];
    const mod = await import('../../src/manual-defer-store.js');

    mod.setServerDeferred('github-mcp-server', true);

    expect(mod.isServerDeferred('github-mcp-server')).toBe(true);
    expect(store.written).toEqual(['github-mcp-server']);
  });
});
