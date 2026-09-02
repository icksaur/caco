// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface LoadResult {
  module: typeof import('../../public/ts/message-streaming.js');
  eventCallback: ((event: { type: string; data?: Record<string, unknown> }) => void) | null;
  reconnectCallback: (() => void) | null;
  trackerCallback: ((sessionId: string, state: { busy: boolean }) => void) | null;
  archiveCallback: ((sessionId: string) => void) | null;
  activeSessionId: { value: string | null };
  loadingHistory: { value: boolean };
  viewState: { value: boolean };
  chatRegionInstance: {
    removeThinking: ReturnType<typeof vi.fn>;
    removeStreamingCursors: ReturnType<typeof vi.fn>;
    finalizeReasoning: ReturnType<typeof vi.fn>;
    renderEvent: ReturnType<typeof vi.fn>;
    setupClickHandler: ReturnType<typeof vi.fn>;
  } | null;
  mocks: {
    formStateSet: ReturnType<typeof vi.fn>;
    fetchWithTimeout: ReturnType<typeof vi.fn>;
    notifyMessageSent: ReturnType<typeof vi.fn>;
    sessionSetBusy: ReturnType<typeof vi.fn>;
    sessionIsBusy: ReturnType<typeof vi.fn>;
    getIntent: ReturnType<typeof vi.fn>;
    chatView: Record<string, ReturnType<typeof vi.fn>>;
    regionsChatClear: ReturnType<typeof vi.fn>;
    showToast: ReturnType<typeof vi.fn>;
    markSessionObserved: ReturnType<typeof vi.fn>;
    notifySessionComplete: ReturnType<typeof vi.fn>;
    clearSession: ReturnType<typeof vi.fn>;
    dropCachedTranscript: ReturnType<typeof vi.fn>;
    onEventDisposer: ReturnType<typeof vi.fn>;
    onReconnectDisposer: ReturnType<typeof vi.fn>;
    onTrackerDisposer: ReturnType<typeof vi.fn>;
    onArchiveDisposer: ReturnType<typeof vi.fn>;
    scrollToBottom: ReturnType<typeof vi.fn>;
    fetch: ReturnType<typeof vi.fn>;
  };
}

async function loadMessageStreaming(): Promise<LoadResult> {
  vi.resetModules();
  const activeSessionId = { value: 'sess-1' as string | null };
  const loadingHistory = { value: false };
  const viewState = { value: true };
  let eventCallback: LoadResult['eventCallback'] = null;
  let reconnectCallback: LoadResult['reconnectCallback'] = null;
  let trackerCallback: LoadResult['trackerCallback'] = null;
  let archiveCallback: LoadResult['archiveCallback'] = null;
  let chatRegionInstance: LoadResult['chatRegionInstance'] = null;
  const onEventDisposer = vi.fn();
  const onReconnectDisposer = vi.fn();
  const onTrackerDisposer = vi.fn();
  const onArchiveDisposer = vi.fn();
  const formStateSet = vi.fn();
  const fetchWithTimeout = vi.fn();
  const notifyMessageSent = vi.fn();
  const sessionSetBusy = vi.fn();
  const sessionIsBusy = vi.fn(() => true);
  const getIntent = vi.fn(() => 'answering');
  const showToast = vi.fn();
  const markSessionObserved = vi.fn();
  const notifySessionComplete = vi.fn();
  const clearSession = vi.fn();
  const dropCachedTranscript = vi.fn();
  const scrollToBottom = vi.fn();
  const regionsChatClear = vi.fn();
  const chatView = {
    updateContextFiles: vi.fn(),
    updateUsage: vi.fn(),
    updateThroughputData: vi.fn(),
    getChattingForm: vi.fn(() => ({ resetSteerCount: vi.fn() })),
    restoreFailedPrompt: vi.fn(),
    setFormEnabled: vi.fn(),
    reloadHistory: vi.fn(),
    savePrompt: vi.fn(),
    onNewSessionCreated: vi.fn(),
    restoreNewChatPrompt: vi.fn(),
    getViewState: vi.fn(() => 'chatting'),
  };
  const fetchMock = vi.fn(() => Promise.resolve({
    json: () => Promise.resolve({ responseOptions: ['Retry'] }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.doMock('../../public/ts/debug.js', () => ({ debug: vi.fn() }));
  vi.doMock('../../public/ts/ui-utils.js', () => ({ scrollToBottom }));
  vi.doMock('../../public/ts/app-state.js', () => ({
    getActiveSessionId: vi.fn(() => activeSessionId.value),
    isLoadingHistory: vi.fn(() => loadingHistory.value),
    getSelectedModel: vi.fn(() => 'model-a'),
    notifyMessageSent,
    onSessionArchived: vi.fn((cb: (sessionId: string) => void) => {
      archiveCallback = cb;
      return onArchiveDisposer;
    }),
  }));
  vi.doMock('../../public/ts/view-controller.js', () => ({
    isViewState: vi.fn(() => viewState.value),
  }));
  vi.doMock('../../public/ts/websocket.js', () => ({
    onEvent: vi.fn((cb: NonNullable<LoadResult['eventCallback']>) => {
      eventCallback = cb;
      return onEventDisposer;
    }),
    onReconnect: vi.fn((cb: () => void) => {
      reconnectCallback = cb;
      return onReconnectDisposer;
    }),
  }));
  vi.doMock('../../public/ts/toast.js', () => ({ showToast }));
  vi.doMock('../../public/ts/applet-runtime.js', () => ({
    getAndClearPendingAppletState: vi.fn(() => ({ panel: true })),
    getNavigationContext: vi.fn(() => ({ slug: 'files' })),
  }));
  vi.doMock('../../public/ts/terminal-events.js', () => ({
    isTerminalEvent: vi.fn((type: string) => type === 'session.idle' || type === 'session.error'),
  }));
  vi.doMock('../../public/ts/dom-regions.js', () => ({
    hasInserter: vi.fn((type: string) => type === 'assistant.message'),
    ChatRegion: class {
      removeThinking = vi.fn();
      removeStreamingCursors = vi.fn();
      finalizeReasoning = vi.fn(() => false);
      renderEvent = vi.fn();
      setupClickHandler = vi.fn();

      constructor(_region: unknown) {
        chatRegionInstance = this;
      }
    },
    regions: { chat: { clear: regionsChatClear } },
    CONTENT_EVENTS: new Set(['assistant.message', 'user.message']),
  }));
  vi.doMock('../../public/ts/notifications.js', () => ({ notifySessionComplete }));
  vi.doMock('../../public/ts/session-observed.js', () => ({ markSessionObserved }));
  vi.doMock('../../public/ts/session-state-tracker.js', () => ({
    sessionTracker: {
      setBusy: sessionSetBusy,
      isBusy: sessionIsBusy,
      getIntent,
      onChange: vi.fn((cb: NonNullable<LoadResult['trackerCallback']>) => {
        trackerCallback = cb;
        return onTrackerDisposer;
      }),
    },
  }));
  vi.doMock('../../public/ts/adhoc-bar.js', () => ({ adHocBar: { clearSession } }));
  vi.doMock('../../public/ts/fetch-timeout.js', () => ({ fetchWithTimeout }));
  vi.doMock('../../public/ts/chat-view-controller.js', () => ({ chatView }));
  vi.doMock('../../public/ts/form-state-store.js', () => ({ formStateStore: { set: formStateSet } }));
  vi.doMock('../../public/ts/transcript-cache.js', () => ({ dropCachedTranscript }));
  const module = await import('../../public/ts/message-streaming.js');
  return {
    module,
    get eventCallback() {
      return eventCallback;
    },
    get reconnectCallback() {
      return reconnectCallback;
    },
    get trackerCallback() {
      return trackerCallback;
    },
    get archiveCallback() {
      return archiveCallback;
    },
    activeSessionId,
    loadingHistory,
    viewState,
    get chatRegionInstance() {
      return chatRegionInstance;
    },
    mocks: {
      formStateSet,
      fetchWithTimeout,
      notifyMessageSent,
      sessionSetBusy,
      sessionIsBusy,
      getIntent,
      chatView,
      regionsChatClear,
      showToast,
      markSessionObserved,
      notifySessionComplete,
      clearSession,
      dropCachedTranscript,
      onEventDisposer,
      onReconnectDisposer,
      onTrackerDisposer,
      onArchiveDisposer,
      scrollToBottom,
      fetch: fetchMock,
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('message-streaming additional controller coverage', () => {
  it('sets response options and dispatches a prompt through the selected model seam', async () => {
    const ctx = await loadMessageStreaming();
    ctx.mocks.fetchWithTimeout.mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({}) });

    ctx.module.setResponseOptions(['Continue']);
    ctx.module.dispatchPrompt({ message: 'hello', imageData: 'img', newChat: false });
    await vi.waitFor(() => expect(ctx.mocks.fetchWithTimeout).toHaveBeenCalled());

    expect(ctx.mocks.formStateSet).toHaveBeenCalledWith({ options: ['Continue'] });
    expect(ctx.mocks.chatView.savePrompt).toHaveBeenCalledWith('hello', 'sess-1');
    expect(ctx.mocks.notifyMessageSent).toHaveBeenCalledWith('sess-1');
    expect(ctx.mocks.sessionSetBusy).toHaveBeenCalledWith('sess-1', true);
    expect(ctx.mocks.fetchWithTimeout).toHaveBeenCalledWith(
      '/api/sessions/sess-1/messages',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          prompt: 'hello',
          imageData: 'img',
          appletState: { panel: true },
          appletNavigation: { slug: 'files' },
        }),
      }),
      30000,
    );
  });

  it('posts immediate steer messages and stop requests through fetch seams', async () => {
    const ctx = await loadMessageStreaming();
    ctx.mocks.fetch.mockResolvedValue({ json: () => Promise.resolve({ forced: true }) });

    await ctx.module.dispatchSteer('sess-1', 'steer');
    ctx.module.stopStreaming();
    await vi.waitFor(() => expect(ctx.mocks.showToast).toHaveBeenCalledWith(
      'Session force-stopped',
      { type: 'info', autoHideMs: 3000 },
    ));

    expect(ctx.mocks.fetch).toHaveBeenCalledWith('/api/sessions/sess-1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'steer', mode: 'immediate' }),
    });
    expect(ctx.mocks.fetch).toHaveBeenCalledWith('/api/sessions/sess-1/cancel', { method: 'POST' });
  });

  it('wires websocket, tracker, reconnect, and archive disposers exactly once', async () => {
    const ctx = await loadMessageStreaming();

    ctx.module.initMessageStreaming();
    ctx.module.initMessageStreaming();
    ctx.trackerCallback?.('sess-1', { busy: false });
    ctx.reconnectCallback?.();
    ctx.archiveCallback?.('sess-1');
    ctx.module.disposeMessageStreaming();

    expect(ctx.chatRegionInstance?.setupClickHandler).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.chatView.setFormEnabled).toHaveBeenCalledWith(true);
    expect(ctx.mocks.chatView.reloadHistory).toHaveBeenCalledWith('sess-1');
    expect(ctx.mocks.dropCachedTranscript).toHaveBeenCalledWith('sess-1');
    expect(ctx.mocks.onEventDisposer).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.onReconnectDisposer).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.onTrackerDisposer).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.onArchiveDisposer).toHaveBeenCalledTimes(1);
  });

  it('routes side-channel events to chat-view metadata updaters instead of rendering', async () => {
    const ctx = await loadMessageStreaming();
    ctx.module.initMessageStreaming();

    ctx.eventCallback?.({ type: 'caco.context', data: { context: { files: ['a.ts'] } } });
    ctx.eventCallback?.({ type: 'session.usage_info', data: { tokenLimit: 100, currentTokens: 5 } });
    ctx.eventCallback?.({ type: 'caco.throughput', data: { tokensPerSecond: 10 } });

    expect(ctx.mocks.chatView.updateContextFiles).toHaveBeenCalledWith('sess-1', { files: ['a.ts'] });
    expect(ctx.mocks.chatView.updateUsage).toHaveBeenCalledWith('sess-1', { tokenLimit: 100, currentTokens: 5 });
    expect(ctx.mocks.chatView.updateThroughputData).toHaveBeenCalledWith('sess-1', { tokensPerSecond: 10 });
    expect(ctx.chatRegionInstance?.renderEvent).not.toHaveBeenCalled();
  });

  it('settles terminal idle events and restores response options from session state', async () => {
    const ctx = await loadMessageStreaming();
    ctx.module.initMessageStreaming();

    ctx.eventCallback?.({ type: 'session.idle', data: {} });
    await vi.waitFor(() => expect(ctx.mocks.formStateSet).toHaveBeenCalledWith({ options: ['Retry'] }));

    expect(ctx.chatRegionInstance?.removeStreamingCursors).toHaveBeenCalledTimes(1);
    expect(ctx.chatRegionInstance?.removeThinking).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.sessionSetBusy).toHaveBeenCalledWith('sess-1', false);
    expect(ctx.mocks.markSessionObserved).toHaveBeenCalledWith('sess-1');
    expect(ctx.mocks.clearSession).toHaveBeenCalledWith('sess-1');
    expect(ctx.mocks.notifySessionComplete).toHaveBeenCalledWith('answering');
    expect(ctx.mocks.fetch).toHaveBeenCalledWith('/api/sessions/sess-1/state');
    expect(ctx.mocks.scrollToBottom).toHaveBeenCalled();
  });

  it('suppresses the completion notification for an idle the server will auto-continue', async () => {
    const ctx = await loadMessageStreaming();
    ctx.module.initMessageStreaming();

    ctx.eventCallback?.({ type: 'session.idle', data: { willAutoContinue: true } });
    await vi.waitFor(() => expect(ctx.mocks.formStateSet).toHaveBeenCalledWith({ options: ['Retry'] }));

    expect(ctx.mocks.notifySessionComplete).not.toHaveBeenCalled();
    // Every other idle side-effect must still run — the annotation suppresses
    // the notification only, not the settle.
    expect(ctx.mocks.sessionSetBusy).toHaveBeenCalledWith('sess-1', false);
    expect(ctx.mocks.markSessionObserved).toHaveBeenCalledWith('sess-1');
    expect(ctx.mocks.clearSession).toHaveBeenCalledWith('sess-1');
    expect(ctx.mocks.scrollToBottom).toHaveBeenCalled();
  });

  it('drops stale errors, finalizes reasoning, and renders content events with scroll', async () => {
    const ctx = await loadMessageStreaming();
    ctx.module.initMessageStreaming();
    ctx.mocks.sessionIsBusy.mockReturnValue(false);

    ctx.eventCallback?.({ type: 'session.error', data: { restorePrompt: true } });
    expect(ctx.chatRegionInstance?.renderEvent).not.toHaveBeenCalled();

    ctx.mocks.sessionIsBusy.mockReturnValue(true);
    ctx.chatRegionInstance?.finalizeReasoning.mockReturnValue(true);
    ctx.eventCallback?.({ type: 'assistant.reasoning', data: { text: 'done' } });
    expect(ctx.chatRegionInstance?.finalizeReasoning).toHaveBeenCalled();

    ctx.chatRegionInstance?.finalizeReasoning.mockReturnValue(false);
    ctx.eventCallback?.({ type: 'assistant.message', data: { text: 'hi' } });
    expect(ctx.chatRegionInstance?.removeThinking).toHaveBeenCalled();
    expect(ctx.chatRegionInstance?.renderEvent).toHaveBeenCalledWith({ type: 'assistant.message', data: { text: 'hi' } });
    expect(ctx.mocks.scrollToBottom).toHaveBeenCalled();
  });
});
