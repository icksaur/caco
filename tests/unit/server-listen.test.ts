import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import {
  listenWithFallback,
  formatStartupFailure,
  StartupPortError,
  PORT_FALLBACK_COUNT,
  PORT_RETRY_COUNT,
} from '../../src/server-listen.js';

/**
 * Binding the server. A port reservation (EACCES) never changes within one
 * boot, so it is skipped at once; a port mid-release after a restart
 * (EADDRINUSE on the requested port) is retried; anything else is fatal.
 *
 * The fake server scripts each port's outcome and records every listen call.
 * Assertions check that trace, including ports that must NOT be attempted, so
 * a test can't pass by agreeing with the code's own bookkeeping.
 */

type Outcome = 'ok' | string;

function fakeServer(script: (port: number, attempt: number) => Outcome) {
  const emitter = new EventEmitter();
  const calls: number[] = [];
  const attempts = new Map<number, number>();
  const server = Object.assign(emitter, {
    listen(port: number, _host: string, cb: () => void) {
      calls.push(port);
      const n = attempts.get(port) ?? 0;
      attempts.set(port, n + 1);
      const outcome = script(port, n);
      queueMicrotask(() => {
        if (outcome === 'ok') cb();
        else emitter.emit('error', Object.assign(new Error(outcome), { code: outcome }));
      });
      return server;
    },
  });
  return { server, calls };
}

const BASE = 53000;
const opts = { host: '127.0.0.1', port: BASE };
const deps = () => ({ sleep: vi.fn(async () => {}) });

describe('listenWithFallback', () => {
  it('binds the requested port when it is free', async () => {
    const { server, calls } = fakeServer(() => 'ok');
    const result = await listenWithFallback(server, opts, deps());

    expect(result).toEqual({ port: BASE, skipped: [] });
    expect(calls).toEqual([BASE]);
  });

  it('skips a denied port at once and binds the next', async () => {
    const { server, calls } = fakeServer(port => (port === BASE ? 'EACCES' : 'ok'));
    const d = deps();
    const result = await listenWithFallback(server, opts, d);

    expect(result).toEqual({ port: BASE + 1, skipped: [{ port: BASE, code: 'EACCES' }] });
    // A reservation does not lift within one boot, so it is never retried.
    expect(calls).toEqual([BASE, BASE + 1]);
    expect(d.sleep).not.toHaveBeenCalled();
  });

  it('reports every candidate when all are denied', async () => {
    const { server, calls } = fakeServer(() => 'EACCES');

    const error = await listenWithFallback(server, opts, deps()).catch(e => e);

    expect(error).toBeInstanceOf(StartupPortError);
    const expected = Array.from({ length: PORT_FALLBACK_COUNT + 1 }, (_, i) => ({ port: BASE + i, code: 'EACCES' }));
    expect(error.attempts).toEqual(expected);
    expect(calls).toEqual(expected.map(a => a.port));
  });

  it('retries a persistently busy requested port, then falls back', async () => {
    const { server, calls } = fakeServer(port => (port === BASE ? 'EADDRINUSE' : 'ok'));
    const d = deps();
    const result = await listenWithFallback(server, opts, d);

    expect(result.port).toBe(BASE + 1);
    expect(result.skipped).toEqual([{ port: BASE, code: 'EADDRINUSE' }]);
    // One first attempt plus PORT_RETRY_COUNT retries, each after a pause.
    expect(calls).toEqual([...Array(PORT_RETRY_COUNT + 1).fill(BASE), BASE + 1]);
    expect(d.sleep).toHaveBeenCalledTimes(PORT_RETRY_COUNT);
  });

  it('binds the requested port once a restart releases it, without falling back', async () => {
    const { server, calls } = fakeServer((port, attempt) => (attempt < 2 ? 'EADDRINUSE' : 'ok'));
    const result = await listenWithFallback(server, opts, deps());

    expect(result).toEqual({ port: BASE, skipped: [] });
    expect(calls).toEqual([BASE, BASE, BASE]);
  });

  it('tries a busy fallback port only once', async () => {
    const { server, calls } = fakeServer(port => (port === BASE ? 'EACCES' : port === BASE + 1 ? 'EADDRINUSE' : 'ok'));
    const result = await listenWithFallback(server, opts, deps());

    expect(result.port).toBe(BASE + 2);
    expect(calls).toEqual([BASE, BASE + 1, BASE + 2]);
  });

  it('rethrows an unexpected error without trying further ports', async () => {
    const { server, calls } = fakeServer(() => 'EINVAL');

    await expect(listenWithFallback(server, opts, deps())).rejects.toMatchObject({ code: 'EINVAL' });
    expect(calls).toEqual([BASE]);
  });

  it('leaves no error listener behind after binding', async () => {
    const { server } = fakeServer(port => (port === BASE ? 'EACCES' : 'ok'));
    await listenWithFallback(server, opts, deps());
    expect(server.listenerCount('error')).toBe(0);
  });
});

describe('formatStartupFailure', () => {
  const denied = new StartupPortError([
    { port: BASE, code: 'EACCES' },
    { port: BASE + 1, code: 'EADDRINUSE' },
  ], '127.0.0.1');

  it('names every attempted port and its reason', () => {
    const text = formatStartupFailure(denied, 'linux');
    expect(text).toContain(`127.0.0.1:${BASE}`);
    expect(text).toContain('EACCES');
    expect(text).toContain(`127.0.0.1:${BASE + 1}`);
    expect(text).toContain('EADDRINUSE');
  });

  it('points Windows users at reserved port ranges for access denied', () => {
    expect(formatStartupFailure(denied, 'win32')).toContain('netsh interface ipv4 show excludedportrange protocol=tcp');
    expect(formatStartupFailure(denied, 'linux')).not.toContain('netsh');
  });

  it('gives no reservation hint when nothing was denied', () => {
    const busy = new StartupPortError([{ port: BASE, code: 'EADDRINUSE' }], '127.0.0.1');
    expect(formatStartupFailure(busy, 'win32')).not.toContain('netsh');
  });
});
