import { describe, it, expect } from 'vitest';
import { buildServerInventory, assembleKeyOrigin } from '../../src/mcp-inventory.js';
import type { ToolKey } from '../../src/tool-key.js';

const K = (s: string) => s as ToolKey;

describe('buildServerInventory — state bucketing (never over-hide)', () => {
  it('discover null ⇒ discoverOk false, empty state', () => {
    const inv = buildServerInventory({
      discover: null,
      liveServers: [{ name: 'ADO', status: 'connected' }],
      enumeratedServers: new Set(['ADO']),
      liveKeysByServer: new Map([['ADO', new Set([K('ADO-a')])]]),
    });
    expect(inv.discoverOk).toBe(false);
    expect(inv.state.size).toBe(0);
    // With empty state, no server counts as enumerated, so no live keys leak through.
    expect(inv.liveKeysByServer.size).toBe(0);
  });

  it('enumerated: connected + listTools succeeded', () => {
    const inv = buildServerInventory({
      discover: [{ name: 'ADO', enabled: true }],
      liveServers: [{ name: 'ADO', status: 'connected' }],
      enumeratedServers: new Set(['ADO']),
      liveKeysByServer: new Map([['ADO', new Set([K('ADO-a')])]]),
    });
    expect(inv.state.get('ADO')).toBe('enumerated');
    expect(inv.liveKeysByServer.get('ADO')?.has(K('ADO-a'))).toBe(true);
  });

  it('disabled via discover enabled:false', () => {
    const inv = buildServerInventory({
      discover: [{ name: 'ADO', enabled: false }],
      liveServers: [],
      enumeratedServers: new Set(),
      liveKeysByServer: new Map(),
    });
    expect(inv.state.get('ADO')).toBe('disabled');
  });

  it('disabled via live status disabled', () => {
    const inv = buildServerInventory({
      discover: [{ name: 'ADO', enabled: true }],
      liveServers: [{ name: 'ADO', status: 'disabled' }],
      enumeratedServers: new Set(),
      liveKeysByServer: new Map(),
    });
    expect(inv.state.get('ADO')).toBe('disabled');
  });

  it('connected but listTools FAILED ⇒ down (retain, not authoritative-negative)', () => {
    const inv = buildServerInventory({
      discover: [{ name: 'ADO', enabled: true }],
      liveServers: [{ name: 'ADO', status: 'connected' }],
      enumeratedServers: new Set(), // enumeration did NOT succeed
      liveKeysByServer: new Map(),
    });
    expect(inv.state.get('ADO')).toBe('down');
  });

  it.each(['failed', 'needs-auth', 'pending', 'not_configured'] as const)(
    'present in mcp.list with status %s ⇒ down (retain)',
    status => {
      const inv = buildServerInventory({
        discover: [{ name: 'ADO', enabled: true }],
        liveServers: [{ name: 'ADO', status }],
        enumeratedServers: new Set(),
        liveKeysByServer: new Map(),
      });
      expect(inv.state.get('ADO')).toBe('down');
    },
  );

  it('discovered enabled but absent from mcp.list ⇒ down (configured, not connected)', () => {
    const inv = buildServerInventory({
      discover: [{ name: 'ADO', enabled: true }],
      liveServers: [],
      enumeratedServers: new Set(),
      liveKeysByServer: new Map(),
    });
    expect(inv.state.get('ADO')).toBe('down');
  });

  it('absent from BOTH discover and mcp.list ⇒ removed (not in state)', () => {
    const inv = buildServerInventory({
      discover: [{ name: 'other', enabled: true }],
      liveServers: [{ name: 'other', status: 'connected' }],
      enumeratedServers: new Set(['other']),
      liveKeysByServer: new Map(),
    });
    expect(inv.state.has('ADO')).toBe(false);
  });

  it('live-enumerated but NOT in discover ⇒ enumerated (live overrides discover silence)', () => {
    const inv = buildServerInventory({
      discover: [], // discover succeeded but omits ADO (snapshot inconsistency)
      liveServers: [{ name: 'ADO', status: 'connected' }],
      enumeratedServers: new Set(['ADO']),
      liveKeysByServer: new Map([['ADO', new Set([K('ADO-a')])]]),
    });
    expect(inv.state.get('ADO')).toBe('enumerated');
    expect(inv.liveKeysByServer.get('ADO')?.has(K('ADO-a'))).toBe(true);
  });

  it('COMBINED critical: previously-correlated + absent from discover + in mcp.list + listTools FAILED ⇒ down, retained', () => {
    const inv = buildServerInventory({
      discover: [], // ADO absent from discover
      liveServers: [{ name: 'ADO', status: 'connected' }], // but present in mcp.list
      enumeratedServers: new Set(), // listTools failed
      liveKeysByServer: new Map(),
    });
    expect(inv.state.get('ADO')).toBe('down'); // NOT removed
  });

  it('empty successful enumeration is authoritative-negative for its keys (enumerated, no live keys)', () => {
    const inv = buildServerInventory({
      discover: [{ name: 'ADO', enabled: true }],
      liveServers: [{ name: 'ADO', status: 'connected' }],
      enumeratedServers: new Set(['ADO']),
      liveKeysByServer: new Map([['ADO', new Set<ToolKey>()]]), // empty but successful
    });
    expect(inv.state.get('ADO')).toBe('enumerated');
    expect(inv.liveKeysByServer.get('ADO')?.size).toBe(0);
  });
});

describe('assembleKeyOrigin — proven correlation vs uncorrelated retention', () => {
  const serversForKey = (map: Record<string, string[]>) => (k: ToolKey) => map[k as string] ?? [];
  const configKeyForServer = (map: Record<string, string>) => (m: string) => map[m];

  it('proven correlation pushes config key into servers (even if absent from all inventory)', () => {
    const origin = assembleKeyOrigin({
      keys: [K('ADO-a')],
      serversForKey: serversForKey({ 'ADO-a': ['ADO'] }),
      configKeyForServer: configKeyForServer({ ADO: 'ado-cfg' }),
    });
    expect(origin.get(K('ADO-a'))).toEqual({ servers: ['ado-cfg'], uncorrelated: false });
  });

  it('unmapped supplier ⇒ uncorrelated true (ANY-supplier rule), no fabricated key', () => {
    const origin = assembleKeyOrigin({
      keys: [K('web_search')],
      serversForKey: serversForKey({ web_search: ['srvA', 'srvB'] }),
      configKeyForServer: configKeyForServer({ srvA: 'a-cfg' }), // srvB unmapped
    });
    expect(origin.get(K('web_search'))).toEqual({ servers: ['a-cfg'], uncorrelated: true });
  });

  it('no supplier servers at all ⇒ {servers:[], uncorrelated:false} (over-advertise)', () => {
    const origin = assembleKeyOrigin({
      keys: [K('mystery')],
      serversForKey: serversForKey({}),
      configKeyForServer: configKeyForServer({}),
    });
    expect(origin.get(K('mystery'))).toEqual({ servers: [], uncorrelated: false });
  });

  it('dedupes repeated config keys across suppliers', () => {
    const origin = assembleKeyOrigin({
      keys: [K('dup')],
      serversForKey: serversForKey({ dup: ['m1', 'm2'] }),
      configKeyForServer: configKeyForServer({ m1: 'same', m2: 'same' }),
    });
    expect(origin.get(K('dup'))).toEqual({ servers: ['same'], uncorrelated: false });
  });
});
