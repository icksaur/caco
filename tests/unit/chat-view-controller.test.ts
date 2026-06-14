import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../public/ts/app-state.js', () => ({
  setActiveSession: vi.fn(),
  getActiveSessionId: vi.fn(() => null),
  getCurrentCwd: vi.fn(() => '/current'),
  getSelectedModel: vi.fn(() => 'claude-sonnet-4'),
  getAvailableModels: vi.fn(() => [{ id: 'claude-sonnet-4', name: 'Claude Sonnet 4', cost: 1 }]),
  releaseActiveSessionForNewChat: vi.fn(),
  getNewChatCwd: vi.fn(() => '/new-chat-cwd'),
}));

vi.mock('../../public/ts/view-controller.js', () => {
  let _mockState = 'newChat';
  return {
    setFormEnabled: vi.fn(),
    setViewState: vi.fn((s: string) => { _mockState = s; }),
    getViewState: vi.fn(() => _mockState),
    showSessionPanel: vi.fn(),
    showAppletPanel: vi.fn(),
    hideAppletPanel: vi.fn(),
    isAppletPanelVisible: vi.fn(() => true),
  };
});

vi.mock('../../public/ts/applet-loader.js', () => ({
  loadApplet: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../public/ts/context-footer.js', () => ({
  renderSessionStatus: vi.fn(),
  renderNewChatStatus: vi.fn(),
  clearStatus: vi.fn(),
  clearContextFooter: vi.fn(),
  clearContextUsage: vi.fn(),
  restoreContextUsage: vi.fn(),
  renderContextFooter: vi.fn(),
  updateContextUsage: vi.fn(),
  refreshRoadmapLink: vi.fn(),
  clearThroughput: vi.fn(),
  restoreThroughput: vi.fn(),
  updateThroughput: vi.fn(),
  setActiveThroughputModel: vi.fn(),
}));

vi.mock('../../public/ts/model-selector.js', () => ({
  loadModels: vi.fn(),
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

vi.mock('../../public/ts/adhoc-bar.js', () => ({
  adHocBar: { activateSession: vi.fn(), deactivate: vi.fn(), clearSession: vi.fn() },
}));

vi.mock('../../public/ts/chat-draft-api.js', () => ({
  getDraft: vi.fn(async () => null),
  putDraft: vi.fn(async () => true),
  deleteDraft: vi.fn(async () => true),
  _resetDraftQueueForTests: vi.fn(),
}));

import { ChatViewController } from '../../public/ts/chat-view-controller.js';
import { setViewState, getViewState } from '../../public/ts/view-controller.js';
import { clearStatus, clearContextFooter, renderSessionStatus, renderNewChatStatus } from '../../public/ts/context-footer.js';
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
    let mockState: string = 'newChat';
    vi.mocked(setViewState).mockImplementation((s: string) => { mockState = s; });
    vi.mocked(getViewState).mockImplementation(() => mockState as 'newChat' | 'chatting');
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
      // Controller logs the failure via console.error intentionally.
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
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
      errSpy.mockRestore();
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

  describe('savePrompt / restoreFailedPrompt', () => {
    it('does not throw when session matches (no DOM in test)', () => {
      vi.mocked(getActiveSessionId).mockReturnValue('s1');
      cvc.savePrompt('hello', 's1');
      expect(() => cvc.restoreFailedPrompt('s1')).not.toThrow();
    });

    it('saves as draft when session differs', () => {
      vi.mocked(getActiveSessionId).mockReturnValue('s2');
      cvc.savePrompt('hello', 's1');
      cvc.restoreFailedPrompt('s1');
      vi.mocked(getActiveSessionId).mockReturnValue('s1');
      expect(cvc.getLastInput()).toBe('hello');
    });
  });

  describe('getLastInput', () => {
    it('returns last prompt for matching session', () => {
      vi.mocked(getActiveSessionId).mockReturnValue('s1');
      cvc.savePrompt('my message', 's1');
      expect(cvc.getLastInput()).toBe('my message');
    });

    it('returns prompt for active session only', () => {
      cvc.savePrompt('msg for s1', 's1');
      cvc.savePrompt('msg for s2', 's2');
      vi.mocked(getActiveSessionId).mockReturnValue('s1');
      expect(cvc.getLastInput()).toBe('msg for s1');
      vi.mocked(getActiveSessionId).mockReturnValue('s2');
      expect(cvc.getLastInput()).toBe('msg for s2');
    });

    it('returns empty string when no active session (new chat)', () => {
      vi.mocked(getActiveSessionId).mockReturnValue(null);
      cvc.savePrompt('my message', 's1');
      expect(cvc.getLastInput()).toBe('');
    });
  });

  describe('updateStatus', () => {
    it('resolves model name and calls renderNewChatStatus without sessionId', () => {
      cvc.updateStatus('/path', 'claude-sonnet-4');
      expect(renderNewChatStatus).toHaveBeenCalledWith('Claude Sonnet 4', '/path');
    });

    it('falls back to model ID suffix when model not found', () => {
      cvc.updateStatus('/path', 'unknown-model');
      expect(renderNewChatStatus).toHaveBeenCalledWith('unknown-model', '/path');
    });

    it('calls renderSessionStatus with sessionId', () => {
      cvc.updateStatus('/path', 'claude-sonnet-4', true, 'My Session', 'sess-123', false, 'main');
      expect(renderSessionStatus).toHaveBeenCalledWith({
        modelName: 'Claude Sonnet 4', cwd: '/path', hasGit: true,
        sessionName: 'My Session', sessionId: 'sess-123', hasIcon: false, gitBranch: 'main'
      });
    });
  });

  describe('restoreApplet visibility invariant', () => {
    type RestoreApplet = (
      activeApplet?: string | null,
      appletParams?: Record<string, string> | null,
      panelVisible?: boolean,
    ) => Promise<void>;

    function restoreApplet(c: ChatViewController): RestoreApplet {
      return (c as unknown as { restoreApplet: RestoreApplet }).restoreApplet.bind(c);
    }

    it('never calls showAppletPanel or hideAppletPanel — regardless of panelVisible value', async () => {
      const view = await import('../../public/ts/view-controller.js');
      await restoreApplet(cvc)('applet-a', {}, true);
      await restoreApplet(cvc)('applet-b', {}, false);
      await restoreApplet(cvc)('applet-c', {}, undefined);
      expect(view.showAppletPanel).not.toHaveBeenCalled();
      expect(view.hideAppletPanel).not.toHaveBeenCalled();
    });

    it('returns early on null applet without touching anything', async () => {
      const view = await import('../../public/ts/view-controller.js');
      const router = await import('../../public/ts/applet-loader.js');
      vi.mocked(router.loadApplet).mockClear();
      await restoreApplet(cvc)(null, {}, true);
      await restoreApplet(cvc)(undefined, {}, false);
      expect(router.loadApplet).not.toHaveBeenCalled();
      expect(view.showAppletPanel).not.toHaveBeenCalled();
      expect(view.hideAppletPanel).not.toHaveBeenCalled();
    });

    it('calls loadApplet with restore:true exactly once per call', async () => {
      const router = await import('../../public/ts/applet-loader.js');
      vi.mocked(router.loadApplet).mockClear();
      vi.mocked(getActiveSessionId).mockReturnValue('s1');
      await restoreApplet(cvc)('applet-a', { path: '/x' });
      expect(router.loadApplet).toHaveBeenCalledTimes(1);
      expect(router.loadApplet).toHaveBeenCalledWith('applet-a', { path: '/x' }, { restore: true });
    });

    it('aborts late restore when active session changed mid-flight', async () => {
      const router = await import('../../public/ts/applet-loader.js');
      vi.mocked(router.loadApplet).mockClear();
      vi.mocked(getActiveSessionId).mockReturnValue('s1');

      // Start the restore but flip the active session before its imports resolve.
      const inFlight = restoreApplet(cvc)('applet-a', {});
      vi.mocked(getActiveSessionId).mockReturnValue('s2');
      await inFlight;

      // Stale restore must not have called loadApplet.
      expect(router.loadApplet).not.toHaveBeenCalled();
    });
  });
});
