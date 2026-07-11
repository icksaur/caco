/**
 * usage-state tests — hermetic via a tmp CACO_HOME (usage.json derives from
 * STORAGE_ROOT). Modules are reset per test so the module-level singleton and
 * the STORAGE_ROOT-derived path pick up the test-scoped CACO_HOME.
 *
 * Oracle for `changed`: it must be true on the first snapshot, on any value
 * delta, and when superseding a disk-loaded (fromCache) value; false when the
 * snapshot is absent/empty or byte-identical to the current one.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const snap = (over: Partial<{
  remainingPercentage: number;
  resetDate: string;
  isUnlimitedEntitlement: boolean;
}> = {}) => ({
  main: {
    isUnlimitedEntitlement: false,
    entitlementRequests: 300,
    usedRequests: 30,
    remainingPercentage: 90,
    resetDate: '2026-08-01',
    ...over,
  },
});

let cacoHome: string;
let originalCacoHome: string | undefined;

beforeEach(() => {
  originalCacoHome = process.env.CACO_HOME;
  cacoHome = mkdtempSync(join(tmpdir(), 'caco-usage-test-'));
  process.env.CACO_HOME = cacoHome;
  vi.resetModules();
});

afterEach(() => {
  if (originalCacoHome === undefined) delete process.env.CACO_HOME;
  else process.env.CACO_HOME = originalCacoHome;
  rmSync(cacoHome, { recursive: true, force: true });
});

describe('updateUsage', () => {
  it('reports changed=false for absent or empty snapshots', async () => {
    const { updateUsage, getUsage } = await import('../../src/usage-state.js');
    expect(updateUsage(undefined).changed).toBe(false);
    expect(updateUsage({}).changed).toBe(false);
    expect(getUsage()).toBeNull();
  });

  it('reports changed=true on first snapshot and persists it', async () => {
    const { updateUsage, getUsage } = await import('../../src/usage-state.js');
    expect(updateUsage(snap()).changed).toBe(true);
    const usage = getUsage();
    expect(usage?.remainingPercentage).toBe(90);
    expect(usage?.isUnlimited).toBe(false);
    expect(usage?.fromCache).toBe(false);
    expect(existsSync(join(cacoHome, 'usage.json'))).toBe(true);
    const persisted = JSON.parse(readFileSync(join(cacoHome, 'usage.json'), 'utf-8'));
    expect(persisted.remainingPercentage).toBe(90);
  });

  it('reports changed=false for a byte-identical follow-up', async () => {
    const { updateUsage } = await import('../../src/usage-state.js');
    updateUsage(snap());
    expect(updateUsage(snap()).changed).toBe(false);
  });

  it('reports changed=true when any tracked value differs', async () => {
    const { updateUsage } = await import('../../src/usage-state.js');
    updateUsage(snap());
    expect(updateUsage(snap({ remainingPercentage: 80 })).changed).toBe(true);
    expect(updateUsage(snap({ remainingPercentage: 80, resetDate: '2026-09-01' })).changed).toBe(true);
    expect(updateUsage(snap({ remainingPercentage: 80, resetDate: '2026-09-01', isUnlimitedEntitlement: true })).changed).toBe(true);
  });

  it('uses the first snapshot key when several are present', async () => {
    const { updateUsage, getUsage } = await import('../../src/usage-state.js');
    updateUsage({ ...snap({ remainingPercentage: 42 }), other: snap({ remainingPercentage: 7 }).main });
    expect(getUsage()?.remainingPercentage).toBe(42);
  });
});

describe('loadUsageCache', () => {
  it('marks a disk-loaded value fromCache, and the next update supersedes it as changed', async () => {
    const first = await import('../../src/usage-state.js');
    first.updateUsage(snap({ remainingPercentage: 55 }));

    vi.resetModules();
    const fresh = await import('../../src/usage-state.js');
    expect(fresh.getUsage()).toBeNull();
    fresh.loadUsageCache();
    expect(fresh.getUsage()?.fromCache).toBe(true);
    expect(fresh.getUsage()?.remainingPercentage).toBe(55);

    expect(fresh.updateUsage(snap({ remainingPercentage: 55 })).changed).toBe(true);
    expect(fresh.getUsage()?.fromCache).toBe(false);
  });

  it('is a no-op when no cache file exists', async () => {
    const { loadUsageCache, getUsage } = await import('../../src/usage-state.js');
    loadUsageCache();
    expect(getUsage()).toBeNull();
  });
});
