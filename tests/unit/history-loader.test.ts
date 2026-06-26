import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../public/ts/app-state.js', () => ({
  getActiveSessionId: vi.fn(() => 'session-1'),
  setLoadingHistory: vi.fn(),
  isLoadingHistory: vi.fn(() => false),
}));

vi.mock('../../public/ts/view-controller.js', () => ({
  setFormEnabled: vi.fn(),
}));

vi.mock('../../public/ts/context-footer.js', () => ({
  clearContextFooter: vi.fn(),
  updateContextUsage: vi.fn(),
}));

vi.mock('../../public/ts/model-selector.js', () => ({
  loadModels: vi.fn(),
}));

vi.mock('../../public/ts/session-state-tracker.js', () => ({
  sessionTracker: { setBusy: vi.fn() },
}));

let historyCompleteCallback: ((sessionId?: string, data?: { isBusy?: boolean }) => void) | null = null;
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
  onEvent: vi.fn(() => mockUnsub),
  replayEvents: vi.fn(),
}));

vi.mock('../../public/ts/dom-regions.js', () => ({
  regions: {
    chat: { el: { children: { length: 0 } }, clear: vi.fn() },
  },
}));

vi.mock('../../public/ts/ui-utils.js', () => ({
  scrollToBottom: vi.fn(),
}));

import { HistoryLoader } from '../../public/ts/history-loader.js';
import { setLoadingHistory, getActiveSessionId } from '../../public/ts/app-state.js';
import { setFormEnabled } from '../../public/ts/view-controller.js';
import { requestHistory, subscribeToSession, replayEvents } from '../../public/ts/websocket.js';
import { sessionTracker } from '../../public/ts/session-state-tracker.js';
import { regions } from '../../public/ts/dom-regions.js';
import { putCachedTranscript, getCachedTranscript, clearTranscriptCache } from '../../public/ts/transcript-cache.js';
import type { SessionEvent } from '../../public/ts/types.js';

function ev(id: string): SessionEvent {
  return { type: 'assistant.message', data: { id } } as unknown as SessionEvent;
}

describe('HistoryLoader', () => {
  let loader: HistoryLoader;

  beforeEach(() => {
    vi.clearAllMocks();
    clearTranscriptCache();
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
      
      historyCompleteCallback?.('session-1', { isBusy: false });
      await promise;
      
      expect(setLoadingHistory).toHaveBeenCalledWith(false);
      expect(setFormEnabled).toHaveBeenCalledWith(true);
    });

    it('sets busy state from server response', async () => {
      const promise = loader.load('session-1');
      historyCompleteCallback?.('session-1', { isBusy: true });
      await promise;
      
      expect(sessionTracker.setBusy).toHaveBeenCalledWith('session-1', true);
      expect(setFormEnabled).toHaveBeenCalledWith(false);
    });

    it('cancels previous in-flight load', async () => {
      const promise1 = loader.load('session-1');
      
      const promise2 = loader.load('session-2');
      
      // First load cancelled — promise resolved, loading reset
      await promise1;
      expect(setLoadingHistory).toHaveBeenCalledWith(false);
      
      // Second load completes normally
      historyCompleteCallback?.('session-2', { isBusy: false });
      await promise2;
      
      // Old callback was unsubscribed
      expect(mockUnsub).toHaveBeenCalled();
    });

    it('times out after 30s', async () => {
      // Loader logs the timeout via console.warn intentionally.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.useFakeTimers();
      const promise = loader.load('session-1');
      
      vi.advanceTimersByTime(30000);
      await promise;
      
      expect(setLoadingHistory).toHaveBeenCalledWith(false);
      expect(setFormEnabled).toHaveBeenCalledWith(true);
      vi.useRealTimers();
      warnSpy.mockRestore();
    });
  });

  describe('completion correlation (P3-3c)', () => {
    it('ignores a completion for a different session than the pending load', async () => {
      const promise = loader.load('session-1');

      // A stale completion for another session must not resolve this load.
      historyCompleteCallback?.('other-session', { isBusy: true });
      expect(loader.loading).toBe(true);
      expect(sessionTracker.setBusy).not.toHaveBeenCalled();

      // The matching completion resolves it.
      historyCompleteCallback?.('session-1', { isBusy: false });
      await promise;
      expect(sessionTracker.setBusy).toHaveBeenCalledWith('session-1', false);
    });

    it('applies state to the pending session and skips form toggle when it is not active', async () => {
      // Active session is B, but the in-flight load is for A.
      vi.mocked(getActiveSessionId).mockReturnValue('session-B');
      const promise = loader.load('session-A');
      historyCompleteCallback?.('session-A', { isBusy: true });
      await promise;

      // Busy applies to the request's session, not the active one.
      expect(sessionTracker.setBusy).toHaveBeenCalledWith('session-A', true);
      // The visible form (session-B) is not toggled by A's background load.
      expect(setFormEnabled).not.toHaveBeenCalled();
    });
  });

  describe('isStale', () => {
    it('returns true when session never loaded', () => {
      expect(loader.isStale('any')).toBe(true);
    });

    it('returns false after successful load', async () => {
      const promise = loader.load('session-1');
      historyCompleteCallback?.('session-1', { isBusy: false });
      await promise;
      
      expect(loader.isStale('session-1')).toBe(false);
    });

    it('returns true for different session', async () => {
      const promise = loader.load('session-1');
      historyCompleteCallback?.('session-1', { isBusy: false });
      await promise;
      
      expect(loader.isStale('session-2')).toBe(true);
    });

    it('returns true after WS reconnect', async () => {
      const promise = loader.load('session-1');
      historyCompleteCallback?.('session-1', { isBusy: false });
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
      historyCompleteCallback?.('session-1', { isBusy: false });
      await promise;
      expect(loader.loading).toBe(false);
    });
  });

  describe('transcript cache (MRU fast path)', () => {
    const V = { size: 100, mtimeMs: 50 };

    beforeEach(() => {
      // clearAllMocks doesn't reset mockReturnValue set by earlier tests.
      vi.mocked(getActiveSessionId).mockReturnValue('session-1');
    });

    it('re-renders from cache and skips requestHistory when version+connection match and idle', async () => {
      putCachedTranscript('session-1', { events: [ev('a'), ev('b')], version: V, connectionId: 1 });

      await loader.load('session-1', V, false);

      expect(requestHistory).not.toHaveBeenCalled();
      expect(replayEvents).toHaveBeenCalledWith([ev('a'), ev('b')]);
      expect(setLoadingHistory).toHaveBeenCalledWith(true);
      expect(setLoadingHistory).toHaveBeenCalledWith(false);
      expect(setFormEnabled).toHaveBeenCalledWith(true);
    });

    it('re-streams when the events.jsonl version differs', async () => {
      putCachedTranscript('session-1', { events: [ev('a')], version: V, connectionId: 1 });
      const p = loader.load('session-1', { size: 101, mtimeMs: 50 }, false);
      expect(requestHistory).toHaveBeenCalledWith('session-1');
      expect(replayEvents).not.toHaveBeenCalled();
      historyCompleteCallback?.('session-1', { isBusy: false });
      await p;
    });

    it('re-streams when the WS connection changed since cache', async () => {
      putCachedTranscript('session-1', { events: [ev('a')], version: V, connectionId: 99 });
      const p = loader.load('session-1', V, false);
      expect(requestHistory).toHaveBeenCalledWith('session-1');
      historyCompleteCallback?.('session-1', { isBusy: false });
      await p;
    });

    it('re-streams when the session is busy', async () => {
      putCachedTranscript('session-1', { events: [ev('a')], version: V, connectionId: 1 });
      const p = loader.load('session-1', V, true);
      expect(requestHistory).toHaveBeenCalledWith('session-1');
      historyCompleteCallback?.('session-1', { isBusy: true });
      await p;
    });

    it('re-streams when no freshness token is provided', async () => {
      putCachedTranscript('session-1', { events: [ev('a')], version: V, connectionId: 1 });
      const p = loader.load('session-1');
      expect(requestHistory).toHaveBeenCalledWith('session-1');
      historyCompleteCallback?.('session-1', { isBusy: false });
      await p;
    });

    it('caches a freshly streamed idle transcript; a later load hits the cache', async () => {
      const p = loader.load('session-1', V, false);
      historyCompleteCallback?.('session-1', { isBusy: false });
      await p;

      expect(getCachedTranscript('session-1')?.version).toEqual(V);

      const p2 = loader.load('session-1', V, false);
      await p2;
      expect(requestHistory).toHaveBeenCalledTimes(1); // only the first (slow) load
      expect(replayEvents).toHaveBeenCalled();
    });

    it('does not cache a busy completion', async () => {
      const p = loader.load('session-1', V, false);
      historyCompleteCallback?.('session-1', { isBusy: true });
      await p;
      expect(getCachedTranscript('session-1')).toBeUndefined();
    });

    it('does not cache on timeout (no completion data)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.useFakeTimers();
      const p = loader.load('session-1', V, false);
      vi.advanceTimersByTime(30000);
      await p;
      expect(getCachedTranscript('session-1')).toBeUndefined();
      vi.useRealTimers();
      warnSpy.mockRestore();
    });
  });
});
