// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

type RuntimeModule = typeof import('../../public/ts/applet-runtime.js');
type SessionEvent = { type: string; data?: Record<string, unknown> };

type Harness = {
  runtime: RuntimeModule;
  appletRoot: HTMLElement;
  fetchMock: Mock;
  loadAppletMock: Mock;
  showToastMock: Mock;
  fetchWithRetryMock: Mock;
  wsSetStateMock: Mock;
  isWsConnectedMock: Mock;
  onEventMock: Mock;
  onStateUpdateMock: Mock;
  onGlobalEventMock: Mock;
  getActiveSessionIdMock: Mock;
  getCurrentCwdMock: Mock;
  isLoadingHistoryMock: Mock;
  activeSessionCallbacks: Array<() => void>;
  sessionEventCallbacks: Array<(event: SessionEvent) => void>;
  stateUpdateCallbacks: Array<(state: Record<string, unknown>) => void>;
  globalEventCallbacks: Array<(event: { type: string; data?: Record<string, unknown> }) => void>;
};

const originalPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;

function installCssRuleConstructors(): void {
  const win = window as unknown as Record<string, unknown>;
  const global = globalThis as unknown as Record<string, unknown>;
  global.CSSKeyframesRule = win.CSSKeyframesRule ?? class CSSKeyframesRule {};
  global.CSSMediaRule = win.CSSMediaRule ?? class CSSMediaRule {};
  global.CSSStyleRule = win.CSSStyleRule ?? class CSSStyleRule {};
}

async function createHarness(url = '/?applet=initial&foo=bar'): Promise<Harness> {
  vi.resetModules();
  vi.restoreAllMocks();
  installCssRuleConstructors();
  window.history.replaceState(null, '', url);
  document.body.innerHTML = '<main data-applet-view></main>';
  document.head.innerHTML = '';

  const appletRoot = document.querySelector<HTMLElement>('[data-applet-view]');
  if (!appletRoot) throw new Error('missing applet root');

  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);

  const loadAppletMock = vi.fn().mockResolvedValue(undefined);
  const showToastMock = vi.fn();
  const fetchWithRetryMock = vi.fn().mockResolvedValue(new Response('ok'));
  const wsSetStateMock = vi.fn();
  const isWsConnectedMock = vi.fn(() => false);
  const sessionEventCallbacks: Array<(event: SessionEvent) => void> = [];
  const stateUpdateCallbacks: Array<(state: Record<string, unknown>) => void> = [];
  const globalEventCallbacks: Array<(event: { type: string; data?: Record<string, unknown> }) => void> = [];
  const activeSessionCallbacks: Array<() => void> = [];
  const onEventMock = vi.fn((cb: (event: SessionEvent) => void) => {
    sessionEventCallbacks.push(cb);
    return vi.fn(() => {
      const index = sessionEventCallbacks.indexOf(cb);
      if (index >= 0) sessionEventCallbacks.splice(index, 1);
    });
  });
  const onStateUpdateMock = vi.fn((cb: (state: Record<string, unknown>) => void) => {
    stateUpdateCallbacks.push(cb);
    return vi.fn(() => {
      const index = stateUpdateCallbacks.indexOf(cb);
      if (index >= 0) stateUpdateCallbacks.splice(index, 1);
    });
  });
  const onGlobalEventMock = vi.fn((cb: (event: { type: string; data?: Record<string, unknown> }) => void) => {
    globalEventCallbacks.push(cb);
    return vi.fn(() => {
      const index = globalEventCallbacks.indexOf(cb);
      if (index >= 0) globalEventCallbacks.splice(index, 1);
    });
  });
  const getActiveSessionIdMock = vi.fn(() => 'session-1');
  const getCurrentCwdMock = vi.fn(() => 'workspace/project');
  const isLoadingHistoryMock = vi.fn(() => false);

  vi.doMock('../../public/ts/debug.js', () => ({ debug: vi.fn() }));
  vi.doMock('../../public/ts/websocket.js', () => ({
    wsSetState: wsSetStateMock,
    onStateUpdate: onStateUpdateMock,
    onEvent: onEventMock,
    onGlobalEvent: onGlobalEventMock,
    isWsConnected: isWsConnectedMock,
  }));
  vi.doMock('../../public/ts/app-state.js', () => ({
    getActiveSessionId: getActiveSessionIdMock,
    getCurrentCwd: getCurrentCwdMock,
    isLoadingHistory: isLoadingHistoryMock,
    onActiveSessionChange: vi.fn((cb: () => void) => {
      activeSessionCallbacks.push(cb);
      return vi.fn();
    }),
  }));
  vi.doMock('../../public/ts/dom-regions.js', () => ({
    regions: { applet: { el: appletRoot } },
  }));
  vi.doMock('../../public/ts/applet-loader.js', () => ({ loadApplet: loadAppletMock }));
  vi.doMock('../../public/ts/toast.js', () => ({ showToast: showToastMock }));
  vi.doMock('../../public/ts/fetch-retry.js', () => ({ fetchWithRetry: fetchWithRetryMock }));

  const runtime = await import('../../public/ts/applet-runtime.js');

  return {
    runtime,
    appletRoot,
    fetchMock,
    loadAppletMock,
    showToastMock,
    fetchWithRetryMock,
    wsSetStateMock,
    isWsConnectedMock,
    onEventMock,
    onStateUpdateMock,
    onGlobalEventMock,
    getActiveSessionIdMock,
    getCurrentCwdMock,
    isLoadingHistoryMock,
    activeSessionCallbacks,
    sessionEventCallbacks,
    stateUpdateCallbacks,
    globalEventCallbacks,
  };
}

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('applet-runtime orchestration', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    window.history.replaceState(null, '', originalPath);
  });

  it('renders applet DOM and scoped CSS without executing applet JavaScript', async () => {
    const h = await createHarness();

    h.runtime.pushApplet('demo', 'Demo Applet', {
      html: '<section class="panel"><button>Run</button></section>',
      css: '.panel { color: red; }',
    });

    const instance = h.appletRoot.querySelector<HTMLElement>('.applet-instance[data-slug="demo"]');
    expect(instance).not.toBeNull();
    expect(instance?.querySelector('.applet-label')?.textContent).toBe('Demo Applet');
    expect(instance?.querySelector('button')?.textContent).toBe('Run');
    const style = document.head.querySelector<HTMLStyleElement>('style[data-applet-slug="demo"]');
    expect(style?.dataset.appletSlug).toBe('demo');
    expect(style?.dataset.applet).toBe('true');
    expect(style?.textContent).toContain('.applet-instance[data-slug="demo"]');
    expect(h.runtime.getActiveAppletSlug()).toBe('demo');
    expect(h.runtime.getActiveAppletLabel()).toBe('Demo Applet');
    expect(h.runtime.hasAppletContent()).toBe(true);
  });

  it('loads an applet from URL params and reports loader errors as false', async () => {
    const h = await createHarness('/?applet=files&path=src%2Findex.ts&mode=diff');

    await expect(h.runtime.loadAppletFromUrl()).resolves.toBe(true);
    expect(h.loadAppletMock).toHaveBeenCalledWith('files', { path: 'src/index.ts', mode: 'diff' });

    h.loadAppletMock.mockRejectedValueOnce(new Error('load failed'));
    await expect(h.runtime.loadAppletFromUrl()).resolves.toBe(false);

    window.history.replaceState(null, '', '/?path=alone');
    await expect(h.runtime.loadAppletFromUrl()).resolves.toBe(false);
  });

  it('updates and navigates applet URL params, then syncs only non-applet params', async () => {
    vi.useFakeTimers();
    const h = await createHarness('/?applet=files&path=old');
    h.fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    h.runtime.updateAppletUrlParam('path', 'new');
    expect(window.location.search).toContain('path=new');
    h.runtime.navigateAppletUrlParam('mode', 'preview');
    expect(window.location.search).toContain('mode=preview');
    h.runtime.navigateAppletUrlParam('path', '');
    expect(window.location.search).not.toContain('path=');

    await vi.advanceTimersByTimeAsync(300);
    expect(h.fetchMock).toHaveBeenCalledWith('/api/sessions/session-1/applet', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ appletParams: { mode: 'preview' } }),
    }));
    expect(h.runtime.getAppletUrlParams()).toEqual({ mode: 'preview' });
    expect(h.runtime.getAppletSlug()).toBe('files');
  });

  it('exposes applet API and routes state, toast, fetchWithRetry, and session metadata through seams', async () => {
    const h = await createHarness();
    h.runtime.initAppletRuntime();
    h.isWsConnectedMock.mockReturnValue(true);
    h.fetchMock.mockResolvedValueOnce(jsonResponse({ sessionId: 'session-1', cwd: 'cwd', name: 'Name', kind: 'chat', model: 'm', currentIntent: 'work', isBusy: true }));

    window.appletAPI.setAppletState({ selected: 'file.ts' });
    expect(h.wsSetStateMock).toHaveBeenCalledWith({ selected: 'file.ts' });
    expect(h.runtime.getAndClearPendingAppletState()).toEqual({ selected: 'file.ts' });
    expect(h.runtime.getAndClearPendingAppletState()).toBeNull();

    window.appletAPI.toast('Saved', { type: 'success' });
    expect(h.showToastMock).toHaveBeenCalledWith('Saved', { type: 'success' });

    await window.appletAPI.fetchWithRetry('/api/example', { method: 'GET' }, { retries: 2 });
    expect(h.fetchWithRetryMock).toHaveBeenCalledWith('/api/example', { method: 'GET' }, { retries: 2 });

    await expect(window.appletAPI.getSessionMeta()).resolves.toEqual({
      sessionId: 'session-1',
      cwd: 'cwd',
      name: 'Name',
      kind: 'chat',
      model: 'm',
      currentIntent: 'work',
      busy: true,
    });
  });

  it('routes agent messages, temp files, file API calls, applet fetches, and list requests through fetch', async () => {
    const h = await createHarness();
    h.runtime.initAppletRuntime();
    h.runtime.pushApplet('sender', 'Sender', { html: '<p>ready</p>' });
    h.fetchMock
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ path: 'virtual/image.png', filename: 'image.png' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, content: 'file body' }))
      .mockResolvedValueOnce(new Response('pong', { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ applets: [{ slug: 'a', name: 'A', description: null, updatedAt: 'now' }] }));

    await window.appletAPI.sendAgentMessage('summarize this');
    expect(h.fetchMock).toHaveBeenNthCalledWith(1, '/api/sessions/session-1/messages', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ prompt: 'summarize this', source: 'applet', appletSlug: 'sender' }),
    }));

    await expect(window.appletAPI.saveTempFile('data:image/png;base64,AAA', { filename: 'image.png', mimeType: 'image/png' }))
      .resolves.toEqual({ path: 'virtual/image.png', filename: 'image.png' });
    expect(h.fetchMock).toHaveBeenNthCalledWith(2, '/api/tmpfile', expect.objectContaining({ method: 'POST' }));

    await expect(window.appletAPI.callFileApi('read_file', { path: 'README.md' }))
      .resolves.toEqual({ ok: true, content: 'file body' });
    expect(h.fetchMock).toHaveBeenNthCalledWith(3, '/api/mcp/read_file', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ path: 'README.md' }),
    }));

    await expect(window.appletAPI.fetch('/api/ping')).resolves.toBeInstanceOf(Response);
    await expect(window.appletAPI.listApplets()).resolves.toEqual([{ slug: 'a', name: 'A', description: null, updatedAt: 'now' }]);
  });

  it('surfaces validation and HTTP errors from applet API helpers', async () => {
    const h = await createHarness();
    h.runtime.initAppletRuntime();

    h.getActiveSessionIdMock.mockReturnValueOnce(null);
    await expect(window.appletAPI.sendAgentMessage('hello')).rejects.toThrow('No active session');

    await expect(window.appletAPI.sendAgentMessage('hello', { imageData: 'x'.repeat(100 * 1024 + 1) }))
      .rejects.toThrow('Image too large');

    h.fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'server rejected' }, false, 400));
    await expect(window.appletAPI.sendAgentMessage('hello')).rejects.toThrow('server rejected');

    h.fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, error: 'bad file' }));
    await expect(window.appletAPI.callFileApi('read_file', {})).rejects.toThrow('bad file');

    h.fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'missing' }, false, 404));
    await expect(window.appletAPI.fetch('/api/missing')).rejects.toThrow('missing');
  });

  it('times out applet fetches with an abort error message', async () => {
    vi.useFakeTimers();
    const h = await createHarness();
    h.runtime.initAppletRuntime();
    h.fetchMock.mockImplementation((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    }));

    const request = window.appletAPI.fetch('/api/slow', { timeout: 25 });
    const assertion = expect(request).rejects.toThrow('Request timeout after 25ms');
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
  });

  it('routes session, global, state, and session-change callbacks and suppresses private events', async () => {
    const h = await createHarness();
    h.runtime.initAppletRuntime();
    const sessionCb = vi.fn();
    const globalCb = vi.fn();
    const stateCb = vi.fn();
    const sessionChangeCb = vi.fn();

    const unsubscribeSession = window.appletAPI.onSessionEvent(sessionCb);
    window.appletAPI.onGlobalEvent(globalCb);
    window.appletAPI.onStateUpdate(stateCb);
    window.appletAPI.onSessionChange(sessionChangeCb);

    expect(sessionChangeCb).toHaveBeenCalledWith('session-1', { sessionId: 'session-1', cwd: 'workspace/project' });

    h.sessionEventCallbacks[0]({ type: 'assistant.message', data: { content: 'hi' } });
    h.sessionEventCallbacks[0]({ type: 'caco.term.data', data: { bytes: 'private' } });
    h.isLoadingHistoryMock.mockReturnValueOnce(true);
    h.sessionEventCallbacks[0]({ type: 'assistant.message', data: { content: 'history' } });
    expect(sessionCb).toHaveBeenCalledTimes(1);
    expect(sessionCb).toHaveBeenCalledWith({ type: 'assistant.message', data: { content: 'hi' } });

    h.globalEventCallbacks[0]({ type: 'global', data: { ok: true } });
    h.stateUpdateCallbacks[0]({ state: 1 });
    expect(globalCb).toHaveBeenCalledWith({ type: 'global', data: { ok: true } });
    expect(stateCb).toHaveBeenCalledWith({ state: 1 });

    unsubscribeSession();
    expect(h.sessionEventCallbacks).toHaveLength(0);
  });

  it('acquires watch leases, routes watch events once, and closes idempotently', async () => {
    const h = await createHarness();
    h.runtime.initAppletRuntime();
    h.fetchMock
      .mockResolvedValueOnce(jsonResponse({ ok: true, leaseId: 'lease-1' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const handle = await window.appletAPI.watchPath('src', { scope: 'dir' });
    const onChange = vi.fn();
    handle.onChange(onChange);

    const event = { type: 'caco.fs.changed', data: { leaseId: 'lease-1', path: 'src/a.ts', eventType: 'change', filename: 'a.ts' } };
    expect(h.runtime.deliverWatchEvent(event)).toBe(true);
    expect(h.runtime.deliverWatchEvent(event)).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ path: 'src/a.ts', eventType: 'change', filename: 'a.ts' });
    expect(h.runtime.deliverWatchEvent({ type: 'assistant.message', data: {} })).toBe(false);

    await handle.close();
    await handle.close();
    expect(h.fetchMock).toHaveBeenNthCalledWith(1, '/api/sessions/session-1/watch', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ path: 'src', scope: 'dir' }),
    }));
    expect(h.fetchMock).toHaveBeenNthCalledWith(2, '/api/sessions/session-1/watch/lease-1', { method: 'DELETE' });
  });

  it('tears down previous applet DOM, style, URL listener, cleanup callbacks, and pending state on replacement', async () => {
    const h = await createHarness('/?applet=first&tab=one');
    h.runtime.initAppletRuntime();
    h.runtime.pushApplet('first', 'First', { html: '<p id="first">one</p>', css: '.first { color: red; }' });
    window.appletAPI.setAppletState({ draft: 'stale' });
    const urlParamCb = vi.fn();
    window.appletAPI.onUrlParamsChange(urlParamCb);
    const stateCb = vi.fn();
    window.appletAPI.onStateUpdate(stateCb);

    h.runtime.pushApplet('second', 'Second', { html: '<p id="second">two</p>' });

    expect(h.appletRoot.querySelector('#first')).toBeNull();
    expect(document.head.querySelector('style[data-applet-slug="first"]')).toBeNull();
    expect(h.appletRoot.querySelector('#second')?.textContent).toBe('two');
    expect(h.stateUpdateCallbacks).toHaveLength(0);
    expect(h.runtime.getAndClearPendingAppletState()).toBeNull();

    const callsBeforePop = urlParamCb.mock.calls.length;
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(urlParamCb).toHaveBeenCalledTimes(callsBeforePop);
  });

  it('clears pending applet state on active session changes', async () => {
    const h = await createHarness();
    h.runtime.initAppletRuntime();
    window.appletAPI.setAppletState({ transient: true });

    h.activeSessionCallbacks[0]();

    expect(h.runtime.getAndClearPendingAppletState()).toBeNull();
  });
});
