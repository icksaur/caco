/**
 * Tests for streamResponse() send transactions (P3-3b) in message-streaming.ts.
 *
 * Verifies the dispatch binds to a target session captured at send time, so a
 * mid-flight navigation cannot misroute the view switch or the failure
 * recovery.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ activeId: null as string | null }));

const chatView = vi.hoisted(() => ({
  savePrompt: vi.fn(),
  setFormEnabled: vi.fn(),
  onNewSessionCreated: vi.fn(),
  restoreFailedPrompt: vi.fn(),
  restoreNewChatPrompt: vi.fn(),
}));
const sessionTracker = vi.hoisted(() => ({ setBusy: vi.fn() }));
const fetchWithTimeout = vi.hoisted(() => vi.fn());

vi.mock('../../public/ts/debug.js', () => ({ debug: vi.fn() }));
vi.mock('../../public/ts/ui-utils.js', () => ({ scrollToBottom: vi.fn() }));
vi.mock('../../public/ts/app-state.js', () => ({
  getActiveSessionId: vi.fn(() => state.activeId),
  isLoadingHistory: vi.fn(() => false),
  getSelectedModel: vi.fn(() => 'm'),
  notifyMessageSent: vi.fn(),
}));
vi.mock('../../public/ts/view-controller.js', () => ({ isViewState: vi.fn(() => false) }));
vi.mock('../../public/ts/websocket.js', () => ({ onEvent: vi.fn(() => () => {}), onReconnect: vi.fn(() => () => {}) }));
vi.mock('../../public/ts/toast.js', () => ({ showToast: vi.fn() }));
vi.mock('../../public/ts/applet-runtime.js', () => ({
  getAndClearPendingAppletState: vi.fn(() => null),
  getNavigationContext: vi.fn(() => null),
}));
vi.mock('../../public/ts/terminal-events.js', () => ({ isTerminalEvent: vi.fn(() => false) }));
vi.mock('../../public/ts/dom-regions.js', () => ({
  hasInserter: vi.fn(() => false),
  ChatRegion: class { setupClickHandler() {} },
  regions: { chat: { clear: vi.fn() } },
  CONTENT_EVENTS: [],
}));
vi.mock('../../public/ts/notifications.js', () => ({ notifySessionComplete: vi.fn() }));
vi.mock('../../public/ts/session-observed.js', () => ({ markSessionObserved: vi.fn() }));
vi.mock('../../public/ts/session-state-tracker.js', () => ({ sessionTracker }));
vi.mock('../../public/ts/adhoc-bar.js', () => ({ adHocBar: { activateSession: vi.fn() } }));
vi.mock('../../public/ts/context-footer.js', () => ({ refreshRoadmapLink: vi.fn() }));
vi.mock('../../public/ts/fetch-timeout.js', () => ({ fetchWithTimeout }));
vi.mock('../../public/ts/chat-view-controller.js', () => ({ chatView }));
vi.mock('../../public/ts/form-state-store.js', () => ({ formStateStore: { set: vi.fn() } }));

import { streamResponse } from '../../public/ts/message-streaming.js';

const okJson = (body: unknown) => ({ ok: true, json: vi.fn().mockResolvedValue(body) }) as unknown as Response;
const errJson = (status: number, body: unknown) => ({ ok: false, status, json: vi.fn().mockResolvedValue(body) }) as unknown as Response;

beforeEach(() => {
  vi.clearAllMocks();
  state.activeId = null;
});

describe('streamResponse new-chat supersession (P3-3b)', () => {
  it('still POSTs to the created session but does NOT switch the view when the user navigated away', async () => {
    fetchWithTimeout.mockImplementation((url: string) => {
      if (url === '/api/sessions') {
        // Simulate the user clicking another session during create.
        return Promise.resolve({ ok: true, json: async () => { state.activeId = 'other'; return { sessionId: 'new1', cwd: '/x' }; } } as unknown as Response);
      }
      return Promise.resolve(okJson({}));
    });

    await streamResponse('hello', 'm', '', true);

    expect(fetchWithTimeout).toHaveBeenCalledWith('/api/sessions/new1/messages', expect.anything(), expect.anything());
    expect(chatView.savePrompt).toHaveBeenCalledWith('hello', 'new1');
    expect(sessionTracker.setBusy).toHaveBeenCalledWith('new1', true);
    expect(chatView.onNewSessionCreated).not.toHaveBeenCalled();
  });

  it('switches the view normally when the user stayed on the new-chat surface', async () => {
    fetchWithTimeout.mockImplementation((url: string) =>
      Promise.resolve(url === '/api/sessions' ? okJson({ sessionId: 'new1', cwd: '/x' }) : okJson({})));

    await streamResponse('hi', 'm', '', true);

    expect(chatView.onNewSessionCreated).toHaveBeenCalledWith('new1', '/x');
  });
});

describe('streamResponse failure recovery (P3-3b)', () => {
  it('restores the prompt/busy to the dispatch target, not the now-active session', async () => {
    fetchWithTimeout.mockImplementation((url: string) => {
      if (url === '/api/sessions') {
        return Promise.resolve({ ok: true, json: async () => { state.activeId = 'other'; return { sessionId: 'new1', cwd: '/x' }; } } as unknown as Response);
      }
      return Promise.resolve(errJson(500, { error: 'boom' }));
    });

    await streamResponse('hello', 'm', '', true);

    expect(sessionTracker.setBusy).toHaveBeenCalledWith('new1', false);
    expect(chatView.restoreFailedPrompt).toHaveBeenCalledWith('new1');
    expect(chatView.restoreFailedPrompt).not.toHaveBeenCalledWith('other');
  });

  it('restores the new-chat prompt when create fails before a session exists', async () => {
    fetchWithTimeout.mockImplementation((url: string) =>
      Promise.resolve(url === '/api/sessions' ? errJson(500, { error: 'nope' }) : okJson({})));

    await streamResponse('lost text', 'm', '', true);

    expect(chatView.restoreNewChatPrompt).toHaveBeenCalledWith('lost text');
    expect(chatView.restoreFailedPrompt).not.toHaveBeenCalled();
    expect(sessionTracker.setBusy).not.toHaveBeenCalled();
  });

  it('existing-session send failure restores to that session', async () => {
    state.activeId = 'sessX';
    fetchWithTimeout.mockResolvedValue(errJson(500, { error: 'bad' }));

    await streamResponse('msg', 'm', '', false);

    expect(sessionTracker.setBusy).toHaveBeenCalledWith('sessX', false);
    expect(chatView.restoreFailedPrompt).toHaveBeenCalledWith('sessX');
  });
});
