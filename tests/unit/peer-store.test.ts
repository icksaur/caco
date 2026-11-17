/**
 * Peer registry (spec-session-overview, O8): CACO_PEERS seeds, merge-only
 * legacy POST, add/remove one entry, origin validation, remote allowlist.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

const env = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: j } = await import('node:path');
  const home = mkdtempSync(j(tmpdir(), 'caco-peers-'));
  process.env.CACO_HOME = home;
  return { home };
});

const store = await import('../../src/peer-store.js');
const file = join(env.home, 'peers.json');
const read = () => JSON.parse(readFileSync(file, 'utf8'));

beforeEach(() => { rmSync(file, { force: true }); });
afterAll(() => { rmSync(env.home, { recursive: true, force: true }); });

describe('normalizeOrigin', () => {
  it.each([
    ['http://localhost:53001', 'http://localhost:53001'],
    ['http://LOCALHOST:53001/', 'http://localhost:53001'],
    ['https://box.example.com', 'https://box.example.com:443'],
    ['http://127.0.0.1', 'http://127.0.0.1:80'],
    ['http://[::1]:53000', 'http://[::1]:53000'],
  ])('%s -> %s', (raw, want) => {
    expect(store.normalizeOrigin(raw)).toBe(want);
  });

  it.each([
    'ftp://host', 'file:///c:/x', 'http://user:pw@host:1', 'http://host:1/path', 'http://host:1/?q=1',
    'http://host:1/#frag', 'http://host:1?', 'http://host:1#', 'not a url', '',
  ])('rejects %s', (raw) => {
    expect(store.normalizeOrigin(raw)).toBeNull();
  });

  it('knows loopback hosts', () => {
    expect(store.isLoopbackOrigin('http://localhost:1')).toBe(true);
    expect(store.isLoopbackOrigin('http://127.0.0.5:1')).toBe(true);
    expect(store.isLoopbackOrigin('http://[::1]:1')).toBe(true);
    expect(store.isLoopbackOrigin('http://10.0.0.1:1')).toBe(false);
    expect(store.isLoopbackOrigin('http://localhost.evil.com:1')).toBe(false);
  });
});

describe('reading', () => {
  it('reads a legacy {url, hostname} file as portal peers with a derived origin', () => {
    writeFileSync(file, JSON.stringify([{ url: 'http://localhost:53001', hostname: 'devbox' }, { url: 'http://x:1/odd/path', hostname: 'odd' }, 'junk']));
    const peers = store.getPeers({});
    expect(peers).toEqual([
      { url: 'http://localhost:53001', hostname: 'devbox', name: 'devbox', origin: 'http://localhost:53001', addedBy: 'portal', rev: 0 },
      { url: 'http://x:1/odd/path', hostname: 'odd', name: 'odd', addedBy: 'portal', rev: 0 },
    ]);
  });

  it('a missing or corrupt file is empty', () => {
    expect(store.getPeers({})).toEqual([]);
    writeFileSync(file, '{not json');
    expect(store.getPeers({})).toEqual([]);
  });
});

describe('CACO_PEERS', () => {
  it('seeds config peers ahead of stored ones; config wins on the same origin', () => {
    writeFileSync(file, JSON.stringify([{ url: 'http://localhost:53001', hostname: 'old-name', id: 'peer-id' }, { url: 'http://localhost:53003', hostname: 'other' }]));
    const peers = store.getPeers({ CACO_PEERS: 'devbox=http://localhost:53001, bad=ftp://x, =http://y:1, two=http://localhost:53002/' });
    expect(peers.map(p => [p.name, p.origin, p.addedBy])).toEqual([
      ['devbox', 'http://localhost:53001', 'config'],
      ['two', 'http://localhost:53002', 'config'],
      ['other', 'http://localhost:53003', 'portal'],
    ]);
    expect(peers[0].id).toBe('peer-id');
  });

  it('config peers cannot be removed', () => {
    const r = store.removePeer('http://localhost:53001', { CACO_PEERS: 'devbox=http://localhost:53001' });
    expect(r).toEqual({ ok: false, status: 403, error: expect.stringContaining('config') });
  });
});

describe('mutations', () => {
  it('the legacy whole-list write merges and never deletes', () => {
    store.mergePeers([{ url: 'http://localhost:53001', hostname: 'a' }, { url: 'http://localhost:53002', hostname: 'b' }]);
    expect(store.mergePeers([{ url: 'http://localhost:53001/', hostname: 'a2' }])).toEqual({ added: 0, updated: 1 });
    expect(store.mergePeers([])).toEqual({ added: 0, updated: 0 });
    const peers = read();
    expect(peers.map((p: { name: string }) => p.name)).toEqual(['a2', 'b']);
    expect(peers[0].rev).toBe(2);
  });

  it('add validates the origin, stores one entry, and renames in place', () => {
    expect(store.addPeer('http://host:1/path')).toMatchObject({ ok: false });
    expect(store.addPeer('http://user@host:1')).toMatchObject({ ok: false });
    const a = store.addPeer('http://localhost:53001/', 'devbox');
    expect(a).toMatchObject({ ok: true, added: true, peer: { url: 'http://localhost:53001', origin: 'http://localhost:53001', name: 'devbox', addedBy: 'portal', rev: 1 } });
    expect(store.addPeer('http://localhost:53001', 'renamed')).toMatchObject({ ok: true, added: false, peer: { name: 'renamed', rev: 2 } });
    expect(store.addPeer('http://localhost:53002')).toMatchObject({ peer: { name: 'localhost' } });
    expect(read()).toHaveLength(2);
    expect(existsSync(`${file}.tmp.${process.pid}`)).toBe(false);
  });

  it('remove deletes one entry by origin or legacy url; unknown is 404', () => {
    writeFileSync(file, JSON.stringify([{ url: 'http://localhost:53001', hostname: 'a' }, { url: 'http://x:1/odd', hostname: 'odd' }]));
    expect(store.removePeer('http://localhost:53001/', {})).toEqual({ ok: true });
    expect(store.removePeer('http://x:1/odd', {})).toEqual({ ok: true });
    expect(read()).toEqual([]);
    expect(store.removePeer('http://localhost:53001', {})).toMatchObject({ ok: false, status: 404 });
  });

  it('records a learned instance id once; a config peer gets a stored entry for it', () => {
    store.addPeer('http://localhost:53001', 'a');
    store.recordPeerIdentity('http://localhost:53001', 'id-1', {});
    store.recordPeerIdentity('http://localhost:53001', 'id-1', {});
    expect(read()[0]).toMatchObject({ id: 'id-1', rev: 2 });
    const cfg = { CACO_PEERS: 'cfg=http://localhost:53009' };
    store.recordPeerIdentity('http://localhost:53009', 'id-9', cfg);
    expect(store.getPeers(cfg).find(p => p.origin === 'http://localhost:53009')).toMatchObject({ id: 'id-9', addedBy: 'config' });
    store.recordPeerIdentity('http://localhost:59999', 'nobody', {});
    expect(read()).toHaveLength(2);
  });
});

describe('CACO_PEERS_ALLOW_REMOTE', () => {
  it('is an explicit origin allowlist', () => {
    const s = store.parseAllowRemote('https://box.example.com, http://10.0.0.5:53000/, junk, http://h:1/path');
    expect([...s]).toEqual(['https://box.example.com:443', 'http://10.0.0.5:53000']);
    expect(store.parseAllowRemote(undefined).size).toBe(0);
  });
});
