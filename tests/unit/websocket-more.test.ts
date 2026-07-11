// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type WsModule = typeof import('../../public/ts/websocket.js');

interface FakeSocket {
  url: string;
  readyState: number;
  sent: string[];
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  send: (data: string) => void;
  close: () => void;
}

let sockets: FakeSocket[];
let activeSessionId: string | null;
let showToast: ReturnType<typeof vi.fn>;
let markSessionObserved: ReturnType<typeof vi.fn>;
let currentModule: WsModule | null;

class FakeWebSocket implements FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  send = vi.fn((data: string) => {
    this.sent.push(data);
  });
  close = vi.fn(() => {
    this.readyState = FakeWebSocket.CLOSED;
    setTimeout(() => this.onclose?.(new Event('close')), 0);
  });

  constructor(url: string) {
    this.url = url;
    sockets.push(this);
  }
}

async function loadWebSocket(activeId: string | null = null): Promise<WsModule> {
  vi.resetModules();
  sockets = [];
  activeSessionId = activeId;
  showToast = vi.fn();
  markSessionObserved = vi.fn();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.doMock('../../public/ts/debug.js', () => ({ debug: vi.fn() }));
  vi.doMock('../../public/ts/toast.js', () => ({ showToast }));
  vi.doMock('../../public/ts/app-state.js', () => ({
    getActiveSessionId: vi.fn(() => activeSessionId),
  }));
  vi.doMock('../../public/ts/session-observed.js', () => ({ markSessionObserved }));
  currentModule = await import('../../public/ts/websocket.js');
  return currentModule;
}

function openSocket(socket: FakeSocket): void {
  socket.readyState = FakeWebSocket.OPEN;
  socket.onopen?.(new Event('open'));
}

function receive(socket: FakeSocket, message: Record<string, unknown>): void {
  socket.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
}

function sentObjects(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.sent.map(data => JSON.parse(data) as Record<string, unknown>);
}

beforeEach(() => {
  vi.useFakeTimers();
  currentModule = null;
});

afterEach(() => {
  currentModule?.disconnectWs();
  vi.runOnlyPendingTimers();
  vi.clearAllTimers();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('websocket client controller', () => {
  it('connects to the page websocket URL, resubscribes, and fires connect listeners', async () => {
    const ws = await loadWebSocket('sess-1');
    const onConnect = vi.fn();
    ws.onConnect(onConnect);

    ws.connectWs();
    openSocket(sockets[0]);

    expect(sockets[0].url).toBe('ws://localhost:3000/ws');
    expect(ws.isWsConnected()).toBe(true);
    expect(ws.getConnectionId()).toBe(1);
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(sentObjects(sockets[0])).toContainEqual({ type: 'subscribe', sessionId: 'sess-1' });
  });

  it('sends subscription, history, state, chat, and raw frames as JSON', async () => {
    const ws = await loadWebSocket('sess-1');
    ws.connectWs();
    openSocket(sockets[0]);
    sockets[0].sent = [];

    ws.subscribeToSession('sess-2');
    ws.requestHistory('sess-2');
    ws.wsSetState({ open: true });
    ws.wsSendMessage('hello', 'img', 'applet', 'files');
    ws.wsSendRaw({ type: 'custom', ok: true });

    expect(sentObjects(sockets[0])).toEqual([
      { type: 'subscribe', sessionId: 'sess-2' },
      { type: 'requestHistory', sessionId: 'sess-2', generation: 1 },
      { type: 'setState', sessionId: 'sess-1', data: { open: true } },
      { type: 'sendMessage', content: 'hello', imageData: 'img', source: 'applet', appletSlug: 'files' },
      { type: 'custom', ok: true },
    ]);
  });

  it('dispatches session-scoped events by active session and global events without filtering', async () => {
    const ws = await loadWebSocket('active');
    const onEvent = vi.fn();
    const onState = vi.fn();
    const onGlobal = vi.fn();
    const onHistory = vi.fn();
    ws.onEvent(onEvent);
    ws.onStateUpdate(onState);
    ws.onGlobalEvent(onGlobal);
    ws.onHistoryComplete(onHistory);
    ws.connectWs();
    openSocket(sockets[0]);

    receive(sockets[0], { type: 'event', sessionId: 'other', event: { type: 'assistant.message', data: {} } });
    receive(sockets[0], { type: 'event', sessionId: 'active', event: { type: 'assistant.message', data: { text: 'ok' } } });
    receive(sockets[0], { type: 'stateUpdate', sessionId: 'active', data: { busy: true } });
    receive(sockets[0], { type: 'globalEvent', sessionId: 'other', event: { type: 'session.updated', data: { id: 'other' } } });
    ws.requestHistory('active');
    receive(sockets[0], { type: 'event', sessionId: 'active', generation: 0, event: { type: 'assistant.message', data: { stale: true } } });
    receive(sockets[0], { type: 'historyComplete', sessionId: 'active', generation: 1, data: { isBusy: false } });

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({ type: 'assistant.message', data: { text: 'ok' } });
    expect(onState).toHaveBeenCalledWith({ busy: true });
    expect(onGlobal).toHaveBeenCalledWith({ type: 'session.updated', data: { id: 'other' } });
    expect(onHistory).toHaveBeenCalledWith('active', { isBusy: false });
    expect(markSessionObserved).toHaveBeenCalledWith('active');
  });

  it('unsubscribes listeners and replays cached events through the event path', async () => {
    const ws = await loadWebSocket('active');
    const onEvent = vi.fn();
    const unsubscribe = ws.onEvent(onEvent);

    ws.replayEvents([{ type: 'user.message', data: { text: 'cached' } }]);
    unsubscribe();
    ws.handleMessage({ type: 'event', sessionId: 'active', event: { type: 'assistant.message', data: {} } });

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({ type: 'user.message', data: { text: 'cached' } });
  });

  it('resolves request responses and rejects request errors by id', async () => {
    const ws = await loadWebSocket();
    ws.connectWs();
    openSocket(sockets[0]);

    const statePromise = ws.wsGetState();
    expect(sentObjects(sockets[0]).at(-1)).toMatchObject({ type: 'getState', id: 'req-1' });
    receive(sockets[0], { type: 'state', id: 'req-1', data: { theme: 'dark' } });
    await expect(statePromise).resolves.toEqual({ theme: 'dark' });

    const errorPromise = ws.wsGetState();
    receive(sockets[0], { type: 'error', id: 'req-2', error: 'nope' });
    await expect(errorPromise).rejects.toThrow('nope');
  });

  it('reconnects after close, reports reconnect, and resubscribes to the active session', async () => {
    const ws = await loadWebSocket('sess-1');
    const onReconnect = vi.fn();
    ws.connectWs();
    openSocket(sockets[0]);
    ws.onReconnect(onReconnect);

    sockets[0].close();
    await vi.advanceTimersByTimeAsync(0);
    expect(showToast).toHaveBeenCalledWith('Reconnecting…', { type: 'info', autoHideMs: 5000 });

    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
    openSocket(sockets[1]);

    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('✔ Connected', { type: 'success', autoHideMs: 2000 });
    expect(sentObjects(sockets[1])).toContainEqual({ type: 'subscribe', sessionId: 'sess-1' });
  });

  it('disconnects without reconnecting and reconnectIfNeeded starts a fresh socket', async () => {
    const ws = await loadWebSocket();
    ws.connectWs();
    openSocket(sockets[0]);

    ws.disconnectWs();
    await vi.advanceTimersByTimeAsync(20000);
    expect(sockets).toHaveLength(1);
    expect(ws.isWsConnected()).toBe(false);

    ws.reconnectIfNeeded();
    expect(sockets).toHaveLength(2);
  });

  it('waitForConnect resolves on open and onConnect fires immediately when already open', async () => {
    const ws = await loadWebSocket();
    ws.connectWs();
    const connected = vi.fn();
    const waitPromise = ws.waitForConnect().then(connected);

    openSocket(sockets[0]);
    await waitPromise;
    const immediate = vi.fn();
    const unsubscribe = ws.onConnect(immediate);
    unsubscribe();

    expect(connected).toHaveBeenCalledTimes(1);
    expect(immediate).toHaveBeenCalledTimes(1);
  });
});
