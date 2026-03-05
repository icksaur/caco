import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../public/ts/app-state.js', () => ({
  setActiveSession: vi.fn(),
  getActiveSessionId: vi.fn(() => null),
  getCurrentCwd: vi.fn(() => '/current'),
  getSelectedModel: vi.fn(() => 'claude-sonnet-4'),
  getAvailableModels: vi.fn(() => [{ id: 'claude-sonnet-4', name: 'Claude Sonnet 4', cost: 1 }]),
}));

vi.mock('../../public/ts/view-controller.js', () => {
  let _mockState = 'sessions';
  return {
    setFormEnabled: vi.fn(),
    setViewState: vi.fn((s: string) => { _mockState = s; }),
    getViewState: vi.fn(() => _mockState),
  };
});

vi.mock('../../public/ts/context-footer.js', () => ({
  renderStatus: vi.fn(),
  clearStatus: vi.fn(),
  clearContextFooter: vi.fn(),
  clearContextUsage: vi.fn(),
  restoreContextUsage: vi.fn(),
  renderContextFooter: vi.fn(),
  updateContextUsage: vi.fn(),
}));

vi.mock('../../public/ts/model-selector.js', () => ({
  loadModels: vi.fn(),
  getNewChatCwd: vi.fn(() => '/new-chat-cwd'),
}));

vi.mock('../../public/ts/history-loader.js', () => ({
  historyLoader: {
    load: vi.fn(() => Promise.resolve()),
    isStale: vi.fn(() => true),
  },
}));

vi.mock('../../public/ts/session-state-tracker.js', () => ({
  sessionTracker: { setBusy: vi.fn() },
}));

vi.mock('../../public/ts/websocket.js', () => ({
  reconnectIfNeeded: vi.fn(),
  waitForConnect: vi.fn(() => Promise.resolve()),
  subscribeToSession: vi.fn(),
}));

vi.mock('../../public/ts/session-panel.js', () => ({
  setSessionLoading: vi.fn(),
  updateMenuIndicators: vi.fn(),
}));

vi.mock('../../public/ts/applet-runtime.js', () => ({
  notifySessionChange: vi.fn(),
}));

vi.mock('../../public/ts/toast.js', () => ({
  showToast: vi.fn(),
}));

vi.mock('../../public/ts/fetch-timeout.js', () => ({
  fetchWithTimeout: vi.fn(),
}));

vi.mock('../../public/ts/dom-regions.js', () => ({
  regions: { chat: { el: { children: { length: 0 } }, clear: vi.fn() } },
}));

import { ChatViewController } from '../../public/ts/chat-view-controller.js';
import { setViewState, getViewState } from '../../public/ts/view-controller.js';
import { clearStatus, clearContextFooter, renderStatus } from '../../public/ts/context-footer.js';
import { loadModels } from '../../public/ts/model-selector.js';
import { regions } from '../../public/ts/dom-regions.js';
import { showToast } from '../../public/ts/toast.js';
import { fetchWithTimeout } from '../../public/ts/fetch-timeout.js';
import { historyLoader } from '../../public/ts/history-loader.js';
import { getActiveSessionId } from '../../public/ts/app-state.js';

describe('ChatViewController', () => {
  let cvc: ChatViewController;

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-wire view state tracking (clearAllMocks preserves implementations
    // from the factory, but we need a fresh closure for each test)
    let mockState: string = 'sessions';
    vi.mocked(setViewState).mockImplementation((s: string) => { mockState = s; });
    vi.mocked(getViewState).mockImplementation(() => mockState as 'sessions' | 'newChat' | 'chatting');
    cvc = new ChatViewController();
  });

  describe('showNewChat', () => {
    it('clears chat and footer, sets view state, loads models', () => {
      cvc.showNewChat();

      expect(regions.chat.clear).toHaveBeenCalled();
      expect(clearStatus).toHaveBeenCalled();
      expect(clearContextFooter).toHaveBeenCalled();
      expect(setViewState).toHaveBeenCalledWith('newChat');
      expect(loadModels).toHaveBeenCalled();
      expect(cvc.getViewState()).toBe('newChat');
    });
  });

  describe('activateSession', () => {
    it('resumes session and loads history on success', async () => {
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({
          sessionId: 'test-id',
          cwd: '/test',
          isBusy: false,
          model: 'claude-sonnet-4'
        })
      };
      vi.mocked(fetchWithTimeout).mockResolvedValue(mockResponse as unknown as Response);

      await cvc.activateSession('test-id');

      expect(fetchWithTimeout).toHaveBeenCalled();
      expect(historyLoader.load).toHaveBeenCalledWith('test-id');
      expect(setViewState).toHaveBeenCalledWith('chatting');
      expect(cvc.getViewState()).toBe('chatting');
    });

    it('shows toast and stays on current view on resume failure', async () => {
      const mockResponse = {
        ok: false,
        status: 500,
        json: vi.fn().mockResolvedValue({ error: 'Session expired' })
      };
      vi.mocked(fetchWithTimeout).mockResolvedValue(mockResponse as unknown as Response);

      cvc.showNewChat();
      await cvc.activateSession('bad-id');

      expect(showToast).toHaveBeenCalledWith('Session expired');
      expect(cvc.getViewState()).toBe('newChat');
    });

    it('short-circuits when already showing this session', async () => {
      // Simulate: already chatting with content
      vi.mocked(getActiveSessionId).mockReturnValue('same-id');
      vi.mocked(historyLoader.isStale).mockReturnValue(false);
      (regions.chat.el as unknown as { children: { length: number } }).children = { length: 5 };
      
      // Set viewState to chatting (simulate prior activation)
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({ sessionId: 'same-id', cwd: '/test' })
      };
      vi.mocked(fetchWithTimeout).mockResolvedValue(mockResponse as unknown as Response);
      await cvc.activateSession('same-id');
      vi.clearAllMocks();
      
      // Now try again — should short-circuit
      await cvc.activateSession('same-id');

      expect(fetchWithTimeout).not.toHaveBeenCalled();
      expect(historyLoader.load).not.toHaveBeenCalled();
      
      (regions.chat.el as unknown as { children: { length: number } }).children = { length: 0 };
    });

    it('does NOT short-circuit when chat is empty', async () => {
      vi.mocked(getActiveSessionId).mockReturnValue('same-id');
      vi.mocked(historyLoader.isStale).mockReturnValue(false);
      // Set view to chatting so only chat-empty condition prevents short-circuit
      vi.mocked(setViewState)('chatting');
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({ sessionId: 'same-id', cwd: '/test' })
      };
      vi.mocked(fetchWithTimeout).mockResolvedValue(mockResponse as unknown as Response);

      await cvc.activateSession('same-id');

      expect(fetchWithTimeout).toHaveBeenCalled();
      expect(historyLoader.load).toHaveBeenCalled();
    });
  });

  describe('getCwd', () => {
    it('returns newChat CWD when in newChat view', () => {
      cvc.showNewChat();
      expect(cvc.getCwd()).toBe('/new-chat-cwd');
    });

    it('returns session CWD when in chatting view', async () => {
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({ sessionId: 'id', cwd: '/session' })
      };
      vi.mocked(fetchWithTimeout).mockResolvedValue(mockResponse as unknown as Response);
      await cvc.activateSession('id');

      expect(cvc.getCwd()).toBe('/current');
    });
  });

  describe('savePrompt / restorePromptIfSameSession', () => {
    it('does not throw when session matches (no DOM in test)', () => {
      vi.mocked(getActiveSessionId).mockReturnValue('s1');
      cvc.savePrompt('hello', 's1');
      // restorePromptIfSameSession calls document.querySelector which is
      // undefined in Node — verify save/match logic via getCwd-style test
      expect(() => cvc.restorePromptIfSameSession()).not.toThrow();
    });

    it('skips restore when session changed', () => {
      vi.mocked(getActiveSessionId).mockReturnValue('s2');
      cvc.savePrompt('hello', 's1');
      // Should be a no-op (different session)
      expect(() => cvc.restorePromptIfSameSession()).not.toThrow();
    });
  });

  describe('updateStatus', () => {
    it('resolves model name and calls renderStatus', () => {
      cvc.updateStatus('/path', 'claude-sonnet-4');
      expect(renderStatus).toHaveBeenCalledWith('Claude Sonnet 4', '/path', false);
    });

    it('falls back to model ID suffix when model not found', () => {
      cvc.updateStatus('/path', 'unknown-model');
      expect(renderStatus).toHaveBeenCalledWith('unknown-model', '/path', false);
    });

    it('passes hasGit flag through', () => {
      cvc.updateStatus('/path', 'claude-sonnet-4', true);
      expect(renderStatus).toHaveBeenCalledWith('Claude Sonnet 4', '/path', true);
    });
  });
});
