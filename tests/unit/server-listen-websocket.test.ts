import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import { createServer as createNetServer, type Server as NetServer } from 'net';

/**
 * The production composition: a real HTTP server with the real WebSocket
 * server attached, binding over a real port collision.
 *
 * WHY this exists: `ws` re-emits the HTTP server's 'error' event on the
 * WebSocketServer. With no listener there, a failed bind (EACCES, EADDRINUSE)
 * became an uncaught exception that killed startup before any bind handler
 * ran, so neither the fallback nor the old restart retry could ever work. A
 * fake server cannot show this; only the real `ws` attachment does.
 */

vi.mock('../../src/extension-store.js', () => ({ watchExtensions: vi.fn(() => ({ close: vi.fn() })) }));
vi.mock('../../src/session-manager.js', () => ({
  sessionManager: { getHistory: vi.fn(async () => []), isBusy: vi.fn(() => false), on: vi.fn() },
}));
vi.mock('../../src/applet-state.js', () => ({ setAppletUserState: vi.fn(), getAppletUserState: vi.fn(() => null) }));
vi.mock('../../src/extension-runtime.js', () => ({ getClientMessageHandler: vi.fn(() => null) }));
vi.mock('../../src/sdk-session-store.js', () => ({ readLastTurnsResult: vi.fn(() => null) }));
vi.mock('../../src/storage.js', () => ({ getSessionMeta: vi.fn(() => null) }));
vi.mock('../../src/session-usage-cache.js', () => ({ setSessionUsage: vi.fn(), getSessionUsage: vi.fn(() => null) }));

const HOST = '127.0.0.1';
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

/** Hold a free port with a plain listener, and return it. */
async function occupyFreePort(): Promise<number> {
  const blocker: NetServer = createNetServer();
  await new Promise<void>(r => blocker.listen(0, HOST, () => r()));
  closers.push(() => new Promise(r => blocker.close(() => r())));
  return (blocker.address() as { port: number }).port;
}

describe('binding with the WebSocket server attached', () => {
  it('falls back past a held port instead of crashing on the forwarded error', async () => {
    const { setupWebSocket } = await import('../../src/routes/websocket.js');
    const { listenWithFallback } = await import('../../src/server-listen.js');

    const held = await occupyFreePort();
    const server: Server = createServer();
    const { wss } = setupWebSocket(server) as unknown as { wss: { close: (cb?: () => void) => void } };
    closers.push(async () => {
      await new Promise<void>(r => wss.close(() => r()));
      await new Promise<void>(r => server.close(() => r()));
    });

    const uncaught = vi.fn();
    process.on('uncaughtException', uncaught);
    try {
      // No retries needed to prove the point; skip the requested-port waits.
      const result = await listenWithFallback(server, { host: HOST, port: held }, { sleep: async () => {} });

      expect(result.skipped).toEqual([{ port: held, code: 'EADDRINUSE' }]);
      expect(result.port).toBeGreaterThan(held);
      expect((server.address() as { port: number }).port).toBe(result.port);
      expect(uncaught).not.toHaveBeenCalled();
    } finally {
      process.off('uncaughtException', uncaught);
    }
  });
});
