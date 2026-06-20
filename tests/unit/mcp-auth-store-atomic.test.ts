import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { MCPAuthState } from '../../src/mcp-auth-store.js';

/**
 * Oracle for the atomic updateMcpServerAuth read-modify-write boundary.
 *
 * The property under test: a concurrent write that lands during another
 * writer's async gap must survive. This is the lost-update the boundary closes.
 * We drive the REAL store against a temp CACO_HOME so the merge against the
 * persisted file is exercised, not a mock.
 */

let tempHome: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'caco-mcp-auth-'));
  process.env.CACO_HOME = tempHome;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.CACO_HOME;
  rmSync(tempHome, { recursive: true, force: true });
});

async function freshStore() {
  // Re-import with the temp CACO_HOME active (STORAGE_ROOT is read at import).
  // vi.resetModules() in beforeEach forces re-evaluation of the module graph.
  return await import('../../src/mcp-auth-store.js');
}

const base: MCPAuthState = {
  url: 'https://api.example.com',
  authorizationEndpoint: 'a',
  tokenEndpoint: 't',
  clientId: 'c0',
  token: 'tok0',
  needsAuth: false,
  needsClientId: false,
};

describe('updateMcpServerAuth atomic boundary', () => {
  it('keeps a concurrent edit that interleaves with an in-flight refresh', async () => {
    const { setMcpServerAuth, getMcpServerAuth, updateMcpServerAuth } = await freshStore();

    setMcpServerAuth('srv', { ...base });

    // Refresh begins: it reads its precheck snapshot (clientId c0) BEFORE its
    // network round-trip. We then simulate the network gap.
    const precheck = getMcpServerAuth('srv');
    expect(precheck?.clientId).toBe('c0');

    // During the gap, an independent clientId edit lands through the boundary.
    updateMcpServerAuth('srv', (prev) => ({ ...prev!, clientId: 'c1', needsClientId: false }));

    // Refresh completes and writes its token THROUGH the boundary, merging onto
    // the freshest persisted state rather than its stale precheck snapshot.
    updateMcpServerAuth('srv', (prev) => ({ ...prev!, token: 'tok1', needsAuth: false }));

    const final = getMcpServerAuth('srv');
    // Both mutations survive: the boundary re-read the fresh clientId.
    expect(final?.token).toBe('tok1');
    expect(final?.clientId).toBe('c1');
  });

  it('reference: the old snapshot-write pattern loses the concurrent edit', async () => {
    const { setMcpServerAuth, getMcpServerAuth, updateMcpServerAuth } = await freshStore();

    setMcpServerAuth('srv', { ...base });

    // Old refresh pattern: capture snapshot BEFORE the gap.
    const staleSnapshot = getMcpServerAuth('srv')!;

    // Concurrent edit lands during the gap.
    updateMcpServerAuth('srv', (prev) => ({ ...prev!, clientId: 'c1', needsClientId: false }));

    // Old write merges onto the STALE snapshot (what setMcpServerAuth did).
    setMcpServerAuth('srv', { ...staleSnapshot, token: 'tok1', needsAuth: false });

    const final = getMcpServerAuth('srv');
    expect(final?.token).toBe('tok1');
    // The clientId edit is clobbered — this is the bug the boundary prevents.
    expect(final?.clientId).toBe('c0');
  });
});
