import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';

vi.mock('../../src/extension-store.js', () => ({ watchExtensions: vi.fn(() => ({ close: vi.fn() })) }));
vi.mock('../../src/session-manager.js', () => ({
  sessionManager: { getHistory: vi.fn(async () => []), isBusy: vi.fn(() => false), on: vi.fn() },
}));
vi.mock('../../src/applet-state.js', () => ({ setAppletUserState: vi.fn(), getAppletUserState: vi.fn(() => null) }));
vi.mock('../../src/extension-runtime.js', () => ({ getClientMessageHandler: vi.fn(() => null) }));
vi.mock('../../src/sdk-session-store.js', () => ({ readLastTurnsResult: vi.fn(() => null) }));
vi.mock('../../src/storage.js', () => ({ getSessionMeta: vi.fn(() => null) }));
vi.mock('../../src/session-usage-cache.js', () => ({ setSessionUsage: vi.fn(), getSessionUsage: vi.fn(() => null) }));

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

/** Upgrade routing (spec-portal-single-port): /ws to Caco, the rest to otherUpgrade or 400. */
describe('setupWebSocket upgrade routing', () => {
  async function start(otherUpgrade?: Parameters<typeof import('../../src/routes/websocket.js').setupWebSocket>[1]) {
    const { setupWebSocket } = await import('../../src/routes/websocket.js');
    const server: Server = createServer();
    const { wss } = setupWebSocket(server, otherUpgrade) as unknown as { wss: { close: (cb?: () => void) => void; clients: Set<WebSocket> } };
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    closers.push(async () => {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>(r => wss.close(() => r()));
      server.closeAllConnections?.();
      await new Promise<void>(r => server.close(() => r()));
    });
    return (server.address() as AddressInfo).port;
  }

  const connect = (port: number, path: string) => new Promise<number>(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    ws.on('open', () => { ws.close(); resolve(101); });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', () => resolve(-1));
  });

  it('accepts /ws and answers 400 to other paths', async () => {
    const port = await start();
    expect(await connect(port, '/ws')).toBe(101);
    expect(await connect(port, '/elsewhere')).toBe(400);
  });

  it('hands other paths to otherUpgrade, which may take or decline them', async () => {
    const seen: string[] = [];
    const port = await start({
      otherUpgrade: (req, socket) => {
        seen.push(req.url ?? '');
        if (req.url !== '/mine') return false;
        socket.end('HTTP/1.1 418 Teapot\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return true;
      },
    });
    expect(await connect(port, '/mine')).toBe(418);
    expect(await connect(port, '/other')).toBe(400);
    expect(await connect(port, '/ws')).toBe(101);
    expect(seen).toEqual(['/mine', '/other']);
  });
});
