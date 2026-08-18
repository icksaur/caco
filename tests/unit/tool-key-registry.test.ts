import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory fs: per-path read/write so persistence + reload are testable, plus a
// write-failure toggle for durability tests.
const store = vi.hoisted(() => ({ data: new Map<string, string>(), failWrites: false, failPaths: new Set<string>() }));
vi.mock('fs', () => ({
  readFileSync: vi.fn((path: string) => {
    const v = store.data.get(path);
    if (v === undefined) throw new Error('no file');
    return v;
  }),
  writeFileSync: vi.fn((path: string, content: string) => {
    if (store.failWrites) throw new Error('disk full');
    if (store.failPaths.has(path)) throw new Error('disk full');
    store.data.set(path, content);
  }),
  mkdirSync: vi.fn(),
}));

import { learnMcpKey, lookupMcpKey, learnFromMetadata, keysForServer, serversForKey, learnServerCorrelation, configKeyForServer, purgeServers, knownServers, _resetRegistryForTest } from '../../src/tool-key-registry.js';

beforeEach(() => { _resetRegistryForTest(); store.data.clear(); store.failWrites = false; store.failPaths.clear(); });

describe('tool-key-registry — discovered (server,raw) → model-facing key', () => {
  it('learns and looks up a model-facing key', () => {
    learnMcpKey('github-mcp-server', 'actions_get', 'github-mcp-server-actions_get');
    expect(lookupMcpKey('github-mcp-server', 'actions_get')).toBe('github-mcp-server-actions_get');
  });

  it('returns undefined for an unlearned (server,raw) — never fabricates', () => {
    expect(lookupMcpKey('unknown', 'nope')).toBeUndefined();
  });

  it('learns the irregular case (web_search: model name has no server prefix)', () => {
    learnMcpKey('github-mcp-server', 'web_search', 'web_search');
    // The lookup key is (server,raw); the VALUE is the irregular model-facing name.
    expect(lookupMcpKey('github-mcp-server', 'web_search')).toBe('web_search');
  });

  it('learnFromMetadata records every MCP tool (model name + raw identity)', () => {
    learnFromMetadata([
      { name: 'github-mcp-server-list_issues', mcpServerName: 'github-mcp-server', mcpToolName: 'list_issues' },
      { name: 'web_search', mcpServerName: 'github-mcp-server', mcpToolName: 'web_search' },
      { name: 'grep' }, // non-MCP: ignored (no server/raw)
    ]);
    expect(lookupMcpKey('github-mcp-server', 'list_issues')).toBe('github-mcp-server-list_issues');
    expect(lookupMcpKey('github-mcp-server', 'web_search')).toBe('web_search');
  });

  it('re-learning updates the mapping (idempotent, last wins)', () => {
    learnMcpKey('s', 't', 'old-name');
    learnMcpKey('s', 't', 'new-name');
    expect(lookupMcpKey('s', 't')).toBe('new-name');
  });

  it('keysForServer returns all learned keys for one server (for defer-whole-server)', () => {
    learnMcpKey('github-mcp-server', 'list_issues', 'github-mcp-server-list_issues');
    learnMcpKey('github-mcp-server', 'web_search', 'web_search');
    learnMcpKey('other-server', 'foo', 'other-server-foo');
    const keys = keysForServer('github-mcp-server').sort();
    expect(keys).toEqual(['github-mcp-server-list_issues', 'web_search'].sort());
    expect(keysForServer('nope')).toEqual([]);
  });
});

describe('tool-key-registry — C6 identity correlation, reverse lookup, purge', () => {
  it('serversForKey reverse-maps a model-facing key to its metadata server(s)', () => {
    learnMcpKey('ADO', 'get_pull_request_by_id', 'ADO-repo_get_pull_request_by_id');
    expect(serversForKey('ADO-repo_get_pull_request_by_id' as any)).toEqual(['ADO']);
    expect(serversForKey('never-learned' as any)).toEqual([]);
  });

  it('serversForKey returns multiple servers when a name is supplied by more than one', () => {
    learnMcpKey('srvA', 'web_search', 'web_search');
    learnMcpKey('srvB', 'web_search', 'web_search');
    expect(serversForKey('web_search' as any).sort()).toEqual(['srvA', 'srvB']);
  });

  it('learnServerCorrelation records a unique metadata→config-key linkage', () => {
    learnServerCorrelation('ADO', 'ado-devops');
    expect(configKeyForServer('ADO')).toBe('ado-devops');
    expect(configKeyForServer('never')).toBeUndefined();
  });

  it('learnServerCorrelation is idempotent; a later PROVEN mapping replaces a stale one (reconfig)', () => {
    learnServerCorrelation('ADO', 'ado-devops');
    learnServerCorrelation('ADO', 'ado-devops');           // idempotent, no-op
    expect(configKeyForServer('ADO')).toBe('ado-devops');
    // Server legitimately reconfigured → the new live observation is authoritative.
    learnServerCorrelation('ADO', 'ado-new-org');
    expect(configKeyForServer('ADO')).toBe('ado-new-org'); // latest proven mapping wins
  });

  it('knownServers lists registry servers AND correlation-only orphans', () => {
    learnMcpKey('ADO', 'a', 'ADO-a');
    learnMcpKey('icm-mcp', 'b', 'icm-mcp-b');
    learnServerCorrelation('orphan-srv', 'orphan-cfg'); // correlation only, no keys
    expect(knownServers().sort()).toEqual(['ADO', 'icm-mcp', 'orphan-srv']);
  });

  it('purgeServers removes a stranded server\'s keys + correlation and reports success', () => {
    learnMcpKey('ADO', 'a', 'ADO-a');
    learnMcpKey('ADO', 'b', 'ADO-b');
    learnMcpKey('icm-mcp', 'c', 'icm-mcp-c');
    learnServerCorrelation('ADO', 'ado-devops');
    const res = purgeServers(['ADO']);
    expect(res.removed).toBe(2);
    expect(res.persisted).toBe(true);
    expect(lookupMcpKey('ADO', 'a')).toBeUndefined();
    expect(configKeyForServer('ADO')).toBeUndefined();
    expect(lookupMcpKey('icm-mcp', 'c')).toBe('icm-mcp-c'); // other server intact
    expect(knownServers()).toEqual(['icm-mcp']);
  });

  it('purgeServers on an unknown server removes nothing', () => {
    learnMcpKey('ADO', 'a', 'ADO-a');
    const res = purgeServers(['not-a-server']);
    expect(res.removed).toBe(0);
    expect(lookupMcpKey('ADO', 'a')).toBe('ADO-a');
  });

  it('reloads registry and correlation from both persisted files after a restart', () => {
    learnMcpKey('ADO', 'a', 'ADO-a');
    learnServerCorrelation('ADO', 'ado-server');
    // Simulate a process restart: drop in-memory state, keep disk (store.data).
    _resetRegistryForTest();
    expect(lookupMcpKey('ADO', 'a')).toBe('ADO-a');
    expect(configKeyForServer('ADO')).toBe('ado-server');
  });

  it('purge reports persisted:false when the write fails', () => {
    learnMcpKey('ADO', 'a', 'ADO-a');
    store.failWrites = true;
    const res = purgeServers(['ADO']);
    expect(res.removed).toBe(1);
    expect(res.persisted).toBe(false);
  });

  it('a purge retry re-writes disk after a transient write failure (no false persisted:true)', () => {
    learnMcpKey('ADO', 'a', 'ADO-a');
    store.failWrites = true;
    expect(purgeServers(['ADO']).persisted).toBe(false); // memory purged, disk stale
    store.failWrites = false;
    // A subsequent purge (even of nothing new) must flush the dirty store.
    const retry = purgeServers(['unrelated']);
    expect(retry.persisted).toBe(true);
    // Disk now reflects the purge: a restart does not resurrect ADO-a.
    _resetRegistryForTest();
    expect(lookupMcpKey('ADO', 'a')).toBeUndefined();
  });

  it('a correlation retry re-writes disk after a transient write failure', () => {
    store.failWrites = true;
    learnServerCorrelation('ADO', 'ado-server'); // memory set, disk write failed
    store.failWrites = false;
    // Idempotent repeat must still flush the dirty correlation store.
    learnServerCorrelation('ADO', 'ado-server');
    _resetRegistryForTest();
    expect(configKeyForServer('ADO')).toBe('ado-server');
  });

  it('a failed correlation write does not resurrect a stale mapping on restart', () => {
    learnServerCorrelation('ADO', 'old-key');
    store.failWrites = true;
    learnServerCorrelation('ADO', 'new-key'); // memory updated, disk write fails
    // Without a flush, disk still holds old-key; a restart would read old-key.
    // Once writes recover, the next learn flushes new-key to disk.
    store.failWrites = false;
    learnServerCorrelation('ADO', 'new-key');
    _resetRegistryForTest();
    expect(configKeyForServer('ADO')).toBe('new-key');
  });

  it('purge reports persisted:false when only the correlation file write fails', () => {
    learnMcpKey('ADO', 'a', 'ADO-a');
    learnServerCorrelation('ADO', 'ado-devops');
    const correlationPath = [...store.data.keys()].find(p => p.includes('correlation'))!;
    store.failPaths.add(correlationPath); // only the correlation file rejects writes
    const res = purgeServers(['ADO']);
    expect(res.removed).toBe(1);
    expect(res.persisted).toBe(false); // one of the two stores failed to persist
    // The registry file DID persist: its purge survives a restart.
    store.failPaths.clear();
    _resetRegistryForTest();
    expect(lookupMcpKey('ADO', 'a')).toBeUndefined();
  });
});
