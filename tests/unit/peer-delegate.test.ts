import { describe, it, expect, beforeEach, vi } from 'vitest';

const peerFetch = vi.hoisted(() => vi.fn());
vi.mock('../../src/peer-target.js', () => ({ peerFetch }));
vi.mock('../../src/instance-identity.js', () => ({ getInstanceIdentity: () => ({ id: 'self-id', name: 'Laptop' }) }));

import { peerPreflight, peerSend, peerWaitReply } from '../../src/peer-delegate.js';

const devbox = { origin: 'http://localhost:53001', name: 'devbox', id: 'dev-id' };
const ok = (json: unknown) => ({ status: 200, json });
const state = (turn: { active: string | null; lastCompleted: string | null }, extra: Record<string, unknown> = {}) =>
  ok({ status: turn.active ? 'busy' : 'idle', turn, ...extra });

beforeEach(() => { peerFetch.mockReset(); });

describe('peerPreflight', () => {
  it('passes an idle current peer and checks state without the reply', async () => {
    peerFetch.mockResolvedValue(state({ active: null, lastCompleted: null }));
    expect(await peerPreflight(devbox, 's1')).toBeNull();
    expect(peerFetch).toHaveBeenCalledWith('http://localhost:53001', '/api/sessions/s1/state');
  });

  it.each<[string, unknown, string]>([
    ['404', { status: 404, json: null }, 'Session abcdefgh not found on devbox.'],
    ['an older peer', ok({ status: 'idle' }), 'devbox runs an older Caco; update it first.'],
    ['a busy target', state({ active: 't', lastCompleted: null }), 'Session abcdefgh is busy processing another message on devbox. Wait and retry, or choose another session.'],
    ['HTTP 500', { status: 500, json: null }, 'Failed to get session state from devbox: HTTP 500'],
  ])('refuses %s', async (_label, res, text) => {
    peerFetch.mockResolvedValue(res);
    expect(await peerPreflight(devbox, 'abcdefgh-1234')).toBe(text);
  });

  it('reports an unreachable peer', async () => {
    peerFetch.mockRejectedValue(new Error('down'));
    expect(await peerPreflight(devbox, 's1')).toBe('Could not reach devbox.');
  });
});

describe('peerSend', () => {
  it('posts a peer message from this instance and returns the turn id', async () => {
    peerFetch.mockResolvedValue(ok({ ok: true, correlationId: 'turn-1' }));
    expect(await peerSend(devbox, 's1', 'do it', 'caller-1')).toEqual({ token: 'turn-1' });
    expect(peerFetch).toHaveBeenCalledWith('http://localhost:53001', '/api/sessions/s1/messages', {
      method: 'POST',
      body: { prompt: 'do it', source: 'peer', fromPeer: { instanceId: 'self-id', instanceName: 'Laptop', sessionId: 'caller-1' } },
    });
  });

  it('reports refusals, a missing turn id, and network failures', async () => {
    peerFetch.mockResolvedValueOnce({ status: 409, json: { error: 'is a herd child' } });
    expect(await peerSend(devbox, 's1', 'x', 'c')).toEqual({ error: '(send failed: HTTP 409 - is a herd child)' });
    peerFetch.mockResolvedValueOnce(ok({ ok: true }));
    expect(await peerSend(devbox, 's1', 'x', 'c')).toEqual({ error: '(send failed: devbox returned no turn id)' });
    peerFetch.mockRejectedValueOnce(new Error('down'));
    expect(await peerSend(devbox, 's1', 'x', 'c')).toEqual({ error: '(send failed: could not reach devbox)' });
  });
});

describe('peerWaitReply', () => {
  const sleep = vi.fn(async () => {});
  const wait = (o: Partial<Parameters<typeof peerWaitReply>[3]> = {}) =>
    peerWaitReply(devbox, 's1', 'turn-1', { maxTotalMs: 60 * 60_000, sleep, ...o });

  it('keeps waiting while the token runs and returns its reply', async () => {
    peerFetch
      .mockResolvedValueOnce(state({ active: 'turn-1', lastCompleted: null }))
      .mockResolvedValueOnce(state({ active: 'turn-1', lastCompleted: null }))
      .mockResolvedValueOnce(state({ active: null, lastCompleted: 'turn-1' }, { lastResponse: 'all done' }));
    expect(await wait()).toBe('all done');
    expect(peerFetch).toHaveBeenLastCalledWith('http://localhost:53001', '/api/sessions/s1/state?reply=1');
  });

  it('never returns another turn\'s reply', async () => {
    peerFetch
      .mockResolvedValueOnce(state({ active: null, lastCompleted: 'turn-0' }, { lastResponse: 'old' }))
      .mockResolvedValueOnce(state({ active: 'turn-2', lastCompleted: 'turn-0' }, { lastResponse: 'old' }));
    expect(await wait()).toBe('(reply not available; read it with get_session_state)');
  });

  it('gives up when another turn started after ours, and re-polls a snapshot without a reply', async () => {
    peerFetch.mockResolvedValueOnce(state({ active: 'turn-2', lastCompleted: 'turn-1' }, { lastResponse: 'turn-2 text' }));
    expect(await wait()).toBe('(reply not available; read it with get_session_state)');
    peerFetch.mockReset()
      .mockResolvedValueOnce(state({ active: null, lastCompleted: 'turn-1' }))
      .mockResolvedValueOnce(state({ active: null, lastCompleted: 'turn-1' }, { lastResponse: 'ours' }));
    expect(await wait()).toBe('ours');
  });

  it('tolerates two failed polls and gives up on the third', async () => {
    peerFetch
      .mockRejectedValueOnce(new Error('x'))
      .mockResolvedValueOnce({ status: 502, json: null })
      .mockResolvedValueOnce(state({ active: null, lastCompleted: 'turn-1' }, { lastResponse: 'ok' }));
    expect(await wait()).toBe('ok');
    peerFetch.mockReset().mockRejectedValue(new Error('x'));
    expect(await wait()).toBe('(lost contact with devbox; check later with get_session_state)');
  });

  it('reports a session that disappears and the total limit', async () => {
    peerFetch.mockResolvedValueOnce({ status: 404, json: null });
    expect(await wait()).toBe('(session disappeared during processing)');
    let t = 0;
    peerFetch.mockReset().mockResolvedValue(state({ active: 'turn-1', lastCompleted: null }));
    expect(await wait({ now: () => (t += 20 * 60_000) })).toBe('(still running on devbox after 60m; check later with get_session_state)');
  });
});
