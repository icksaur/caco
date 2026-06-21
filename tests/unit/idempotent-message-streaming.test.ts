/**
 * P4: initMessageStreaming() must be idempotent — a second call must NOT
 * register a second copy of any WS/tracker subscription. Anonymous closures
 * (sessionTracker.onChange, onReconnect) would otherwise accumulate and, via a
 * double onReconnect → double reloadHistory, re-stream append-based history into
 * the same DOM.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const counts = vi.hoisted(() => ({ onEvent: 0, onReconnect: 0, onChange: 0 }));

const sessionTracker = vi.hoisted(() => ({
  onChange: vi.fn(() => { counts.onChange++; return () => {}; }),
  setBusy: vi.fn(),
}));

vi.mock('../../public/ts/debug.js', () => ({ debug: vi.fn() }));
vi.mock('../../public/ts/ui-utils.js', () => ({ scrollToBottom: vi.fn() }));
vi.mock('../../public/ts/app-state.js', () => ({
  getActiveSessionId: vi.fn(() => null),
  isLoadingHistory: vi.fn(() => false),
  getSelectedModel: vi.fn(() => 'm'),
  notifyMessageSent: vi.fn(),
}));
vi.mock('../../public/ts/view-controller.js', () => ({ isViewState: vi.fn(() => false) }));
vi.mock('../../public/ts/websocket.js', () => ({
  onEvent: vi.fn(() => { counts.onEvent++; return () => {}; }),
  onReconnect: vi.fn(() => { counts.onReconnect++; return () => {}; }),
}));
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
vi.mock('../../public/ts/fetch-timeout.js', () => ({ fetchWithTimeout: vi.fn() }));
vi.mock('../../public/ts/chat-view-controller.js', () => ({ chatView: { setFormEnabled: vi.fn(), getViewState: vi.fn(), reloadHistory: vi.fn() } }));
vi.mock('../../public/ts/form-state-store.js', () => ({ formStateStore: { set: vi.fn() } }));

import { initMessageStreaming, disposeMessageStreaming } from '../../public/ts/message-streaming.js';

beforeEach(() => {
  disposeMessageStreaming();
  counts.onEvent = 0;
  counts.onReconnect = 0;
  counts.onChange = 0;
});

describe('initMessageStreaming idempotency (P4)', () => {
  it('registers each WS/tracker subscription exactly once across two init calls', () => {
    initMessageStreaming();
    initMessageStreaming();

    expect(counts.onEvent).toBe(1);
    expect(counts.onReconnect).toBe(1);
    expect(counts.onChange).toBe(1);
  });

  it('re-registers after an explicit dispose', () => {
    initMessageStreaming();
    disposeMessageStreaming();
    initMessageStreaming();

    expect(counts.onEvent).toBe(2);
    expect(counts.onReconnect).toBe(2);
    expect(counts.onChange).toBe(2);
  });
});
