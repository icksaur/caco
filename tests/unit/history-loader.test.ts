import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../public/ts/app-state.js', () => ({
  getActiveSessionId: vi.fn(() => 'test-session'),
  setLoadingHistory: vi.fn(),
  isLoadingHistory: vi.fn(() => false),
}));

vi.mock('../../public/ts/view-controller.js', () => ({
  setFormEnabled: vi.fn(),
}));

vi.mock('../../public/ts/context-footer.js', () => ({
  clearContextFooter: vi.fn(),
}));

vi.mock('../../public/ts/model-selector.js', () => ({
  loadModels: vi.fn(),
}));

vi.mock('../../public/ts/session-state-tracker.js', () => ({
  sessionTracker: { setBusy: vi.fn() },
}));

let historyCompleteCallback: ((data?: { isBusy?: boolean }) => void) | null = null;
const mockUnsub = vi.fn();
let connectionId = 1;

vi.mock('../../public/ts/websocket.js', () => ({
  onHistoryComplete: vi.fn((cb) => {
    historyCompleteCallback = cb;
    return mockUnsub;
  }),
  getConnectionId: vi.fn(() => connectionId),
  subscribeToSession: vi.fn(),
  requestHistory: vi.fn(),
}));

vi.mock('../../public/ts/dom-regions.js', () => ({
  regions: {
    chat: { el: { children: { length: 0 } }, clear: vi.fn() },
  },
}));

import { HistoryLoader } from '../../public/ts/history-loader.js';
import { setLoadingHistory } from '../../public/ts/app-state.js';
import { setFormEnabled } from '../../public/ts/view-controller.js';
import { requestHistory, subscribeToSession } from '../../public/ts/websocket.js';
import { sessionTracker } from '../../public/ts/session-state-tracker.js';
import { regions } from '../../public/ts/dom-regions.js';

describe('HistoryLoader', () => {
  let loader: HistoryLoader;

  beforeEach(() => {
    vi.clearAllMocks();
    historyCompleteCallback = null;
    connectionId = 1;
    loader = new HistoryLoader();
  });

  describe('load', () => {
    it('clears chat, subscribes, requests history', async () => {
      const promise = loader.load('session-1');
      
      expect(regions.chat.clear).toHaveBeenCalled();
      expect(subscribeToSession).toHaveBeenCalledWith('session-1');
      expect(requestHistory).toHaveBeenCalledWith('session-1');
      expect(setLoadingHistory).toHaveBeenCalledWith(true);
      
      historyCompleteCallback?.({ isBusy: false });
      await promise;
      
      expect(setLoadingHistory).toHaveBeenCalledWith(false);
      expect(setFormEnabled).toHaveBeenCalledWith(true);
    });

    it('sets busy state from server response', async () => {
      const promise = loader.load('session-1');
      historyCompleteCallback?.({ isBusy: true });
      await promise;
      
      expect(sessionTracker.setBusy).toHaveBeenCalledWith('test-session', true);
      expect(setFormEnabled).toHaveBeenCalledWith(false);
    });

    it('cancels previous in-flight load', async () => {
      const promise1 = loader.load('session-1');
      
      const promise2 = loader.load('session-2');
      
      // First load cancelled — promise resolved, loading reset
      await promise1;
      expect(setLoadingHistory).toHaveBeenCalledWith(false);
      
      // Second load completes normally
      historyCompleteCallback?.({ isBusy: false });
      await promise2;
      
      // Old callback was unsubscribed
      expect(mockUnsub).toHaveBeenCalled();
    });

    it('times out after 30s', async () => {
      vi.useFakeTimers();
      const promise = loader.load('session-1');
      
      vi.advanceTimersByTime(30000);
      await promise;
      
      expect(setLoadingHistory).toHaveBeenCalledWith(false);
      expect(setFormEnabled).toHaveBeenCalledWith(true);
      vi.useRealTimers();
    });
  });

  describe('isStale', () => {
    it('returns true when session never loaded', () => {
      expect(loader.isStale('any')).toBe(true);
    });

    it('returns false after successful load', async () => {
      const promise = loader.load('session-1');
      historyCompleteCallback?.({ isBusy: false });
      await promise;
      
      expect(loader.isStale('session-1')).toBe(false);
    });

    it('returns true for different session', async () => {
      const promise = loader.load('session-1');
      historyCompleteCallback?.({ isBusy: false });
      await promise;
      
      expect(loader.isStale('session-2')).toBe(true);
    });

    it('returns true after WS reconnect', async () => {
      const promise = loader.load('session-1');
      historyCompleteCallback?.({ isBusy: false });
      await promise;
      
      connectionId = 2;
      expect(loader.isStale('session-1')).toBe(true);
    });
  });

  describe('loading', () => {
    it('is true during load', () => {
      expect(loader.loading).toBe(false);
      void loader.load('session-1');
      expect(loader.loading).toBe(true);
    });

    it('is false after completion', async () => {
      const promise = loader.load('session-1');
      historyCompleteCallback?.({ isBusy: false });
      await promise;
      expect(loader.loading).toBe(false);
    });
  });

  describe('cancel (via load)', () => {
    it('is a no-op when nothing pending', () => {
      void loader.load('session-1');
    });

    it('resets loadingHistory on cancel', async () => {
      const promise1 = loader.load('session-1');
      void loader.load('session-2');
      await promise1;
      
      // cancel() inside load() should have called setLoadingHistory(false)
      const calls = (setLoadingHistory as ReturnType<typeof vi.fn>).mock.calls;
      // Pattern: true (load1), false (cancel), true (load2)
      expect(calls).toEqual([[true], [false], [true]]);
    });
  });
});
