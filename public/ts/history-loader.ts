/**
 * HistoryLoader
 * 
 * Single owner of the history request→stream→complete lifecycle.
 * One way to load history. Impossible to double-request.
 * 
 * Replaces: waitForHistoryComplete, isHistoryPending, isHistoryStale,
 * historyGeneration counter, and server-side pendingHistory dedup.
 */

import { debug } from './debug.js';
import { getActiveSessionId, setLoadingHistory } from './app-state.js';
import { setFormEnabled } from './view-controller.js';
import { onHistoryComplete, getConnectionId, subscribeToSession, requestHistory, advanceHistoryGeneration, onEvent, replayEvents, type SessionEvent } from './websocket.js';
import { clearContextFooter, updateContextUsage } from './context-footer.js';
import { regions } from './dom-regions.js';
import { scrollToBottom } from './ui-utils.js';
import { sessionTracker } from './session-state-tracker.js';
import { loadModels } from './model-selector.js';
import { getCachedTranscript, putCachedTranscript, versionsEqual, type EventVersion } from './transcript-cache.js';
import { markSessionObserved } from './session-observed.js';

const TIMEOUT_MS = 30000;

interface PendingLoad {
  sessionId: string;
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
  unsub: () => void;
  /** Events collected during this load, cached for a later fast re-render. */
  events: SessionEvent[];
  /** Server events.jsonl version at load (the freshness token), if known. */
  version?: EventVersion | null;
}

class HistoryLoader {
  private pending: PendingLoad | null = null;
  private lastSessionId: string | null = null;
  private lastConnectionId = -1;

  /**
   * Load history for a session. Cancels any in-flight request.
   * Clears chat, subscribes to WS, requests history, waits for completion.
   * Sets tracker busy state and form state from server response.
   */
  async load(sessionId: string, version?: EventVersion | null, isBusy = false): Promise<void> {
    this.cancel();

    // Fast path: a fresh cached transcript (same events.jsonl version, same WS
    // connection, not currently streaming) re-renders locally instead of
    // re-streaming history over the WebSocket.
    const cached = getCachedTranscript(sessionId);
    if (cached && version && versionsEqual(cached.version, version)
        && cached.connectionId === getConnectionId() && !isBusy) {
      this.reuseFromCache(sessionId, cached.events);
      return;
    }

    setLoadingHistory(true);
    regions.chat.clear();
    clearContextFooter();
    subscribeToSession(sessionId);

    const events: SessionEvent[] = [];
    const tRequest = performance.now();
    let tFirstEvent = 0;
    let eventCount = 0;
    const unsubEvent = onEvent(e => {
      events.push(e);
      eventCount += 1;
      if (tFirstEvent === 0) tFirstEvent = performance.now();
    });

    requestHistory(sessionId);

    return new Promise<void>(resolve => {
      const wrappedResolve = () => {
        unsubEvent();
        const tComplete = performance.now();
        const waitMs = (tFirstEvent || tComplete) - tRequest;
        const streamMs = tFirstEvent ? tComplete - tFirstEvent : 0;
        debug('PERF', `history ${sessionId.slice(0,8)}: ttfe=${waitMs.toFixed(1)}ms stream=${streamMs.toFixed(1)}ms events=${eventCount}`);
        resolve();
      };
      const timer = setTimeout(() => {
        console.warn('[HISTORY] Timed out waiting for historyComplete');
        this.finish(wrappedResolve);
      }, TIMEOUT_MS);

      const unsub = onHistoryComplete((completedId, data) => {
        if (this.pending && completedId && completedId !== this.pending.sessionId) return;
        this.finish(wrappedResolve, data);
      });

      this.pending = { sessionId, resolve: wrappedResolve, timer, unsub, events, version };
    });
  }

  /**
   * Whether the last loaded history is stale.
   * True if sessionId differs or WS reconnected since last load.
   */
  isStale(sessionId: string): boolean {
    return this.lastSessionId !== sessionId
        || getConnectionId() !== this.lastConnectionId;
  }

  /**
   * Whether a history load is currently in-flight.
   */
  get loading(): boolean {
    return this.pending !== null;
  }

  private finish(resolve: () => void, data?: { isBusy?: boolean; usage?: { tokenLimit: number; currentTokens: number } }): void {
    if (!this.pending) return;
    const { sessionId, timer, unsub, events, version } = this.pending;
    clearTimeout(timer);
    unsub();
    this.pending = null;

    // Cache the freshly streamed transcript for an instant re-render on a later
    // switch-back. Only on a real completion (data present, not a timeout), with
    // a freshness token, and an idle session (a busy session's array is mid-stream).
    if (data && version && !data.isBusy) {
      putCachedTranscript(sessionId, {
        events: events.slice(),
        version,
        connectionId: getConnectionId(),
      });
    }

    this.settle(sessionId, data);
    resolve();
  }

  /** Re-render a cached transcript locally, skipping the WS history round trip. */
  private reuseFromCache(sessionId: string, events: SessionEvent[]): void {
    setLoadingHistory(true);
    // Advance the history-load generation so any in-flight replay frames from a
    // superseded slow load are fenced out by isStaleReplay (the fast path issues
    // no requestHistory, which is what normally bumps the generation).
    advanceHistoryGeneration();
    regions.chat.clear();
    clearContextFooter();
    subscribeToSession(sessionId);
    // Replay through the same callback path the WS stream drives, with
    // loadingHistory set, so handleEvent renders identically to a real replay
    // (rebuilds footer context + usage, no per-event scroll).
    replayEvents(events);
    // The slow path marks the session observed via the historyComplete WS
    // message (websocket.ts); the fast path issues no requestHistory and its
    // replayed session.idle is suppressed by the loadingHistory guard, so it
    // must clear the unobserved dot itself — otherwise switching back to a
    // cached session leaves its dot stranded.
    if (sessionId === getActiveSessionId()) {
      void markSessionObserved(sessionId);
    }
    this.settle(sessionId, { isBusy: false });
  }

  /** Post-stream settle, shared by the streamed and cached-replay paths. */
  private settle(sessionId: string, data?: { isBusy?: boolean; usage?: { tokenLimit: number; currentTokens: number } }): void {
    this.lastSessionId = sessionId;
    this.lastConnectionId = getConnectionId();

    setLoadingHistory(false);
    scrollToBottom();

    const isBusy = data?.isBusy ?? false;
    sessionTracker.setBusy(sessionId, isBusy);
    if (data?.usage) {
      updateContextUsage(data.usage, sessionId);
    }
    const isActiveSession = sessionId === getActiveSessionId();
    if (isActiveSession) {
      setFormEnabled(!isBusy);
    }

    // Clean up stale thinking indicator from history replay
    if (!isBusy && isActiveSession) {
      const chat = regions.chat as { removeThinking?: () => void; removeStreamingCursors?: () => void };
      chat.removeThinking?.();
      chat.removeStreamingCursors?.();
    }

    if (regions.chat.el.children.length === 0) {
      loadModels();
    }
  }

  private cancel(): void {
    if (!this.pending) return;
    const { timer, unsub, resolve } = this.pending;
    clearTimeout(timer);
    unsub();
    setLoadingHistory(false);
    this.pending = null;
    resolve();
  }
}

export const historyLoader = new HistoryLoader();

export { HistoryLoader };
