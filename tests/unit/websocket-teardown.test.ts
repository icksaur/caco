import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServer } from 'http';

const ext = vi.hoisted(() => {
  const close = vi.fn();
  return { close, watchExtensions: vi.fn(() => ({ close })) };
});

vi.mock('../../src/extension-store.js', () => ({ watchExtensions: ext.watchExtensions }));
vi.mock('../../src/session-manager.js', () => ({
  sessionManager: {
    getHistory: vi.fn(async () => []),
    isBusy: vi.fn(() => false),
    on: vi.fn(),
  },
}));
vi.mock('../../src/applet-state.js', () => ({
  setAppletUserState: vi.fn(),
  getAppletUserState: vi.fn(() => null),
}));
vi.mock('../../src/extension-runtime.js', () => ({ getClientMessageHandler: vi.fn(() => null) }));
vi.mock('../../src/sdk-session-store.js', () => ({ readLastTurnsResult: vi.fn(() => null) }));
vi.mock('../../src/storage.js', () => ({
  listEmbedOutputs: vi.fn(() => []),
  parseOutputMarkers: vi.fn(() => []),
  getSessionMeta: vi.fn(() => null),
}));
vi.mock('../../src/session-usage-cache.js', () => ({
  setSessionUsage: vi.fn(),
  getSessionUsage: vi.fn(() => null),
}));

describe('setupWebSocket extension-watcher teardown wiring', () => {
  beforeEach(() => {
    ext.close.mockClear();
    ext.watchExtensions.mockClear();
  });

  it('closes the extension watcher when the WebSocketServer closes', async () => {
    const { setupWebSocket } = await import('../../src/routes/websocket.js');
    const server = createServer();
    const { wss } = setupWebSocket(server) as unknown as { wss: { close: (cb?: () => void) => void } };

    expect(ext.watchExtensions).toHaveBeenCalledTimes(1);
    expect(ext.close).not.toHaveBeenCalled();

    await new Promise<void>((resolve) => wss.close(() => resolve()));

    expect(ext.close).toHaveBeenCalledTimes(1);
    server.close();
  });
});
