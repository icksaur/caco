/**
 * P4: initSessionPanel() must be idempotent — a second call must NOT register a
 * second onGlobalEvent/onChange subscription or a second set of drag listeners
 * on #sessionView.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const counts = vi.hoisted(() => ({ onGlobalEvent: 0, onChange: 0 }));
const panelListeners = vi.hoisted(() => ({ add: 0, remove: 0 }));

const sessionTracker = vi.hoisted(() => ({
  onChange: vi.fn(() => { counts.onChange++; return () => {}; }),
  setBusy: vi.fn(),
}));

const fakePanel = vi.hoisted(() => ({
  addEventListener: vi.fn(() => { panelListeners.add++; }),
  removeEventListener: vi.fn(() => { panelListeners.remove++; }),
  classList: { add: vi.fn(), remove: vi.fn() },
}));

vi.hoisted(() => {
  (globalThis as Record<string, unknown>).document = { getElementById: () => fakePanel };
  (globalThis as Record<string, unknown>).localStorage = { getItem: () => '[]', setItem: () => {} };
});

vi.mock('../../public/ts/debug.js', () => ({ debug: vi.fn() }));
vi.mock('../../public/ts/ui-utils.js', () => ({ formatAge: vi.fn(), formatStatusParts: vi.fn() }));
vi.mock('../../public/ts/app-state.js', () => ({
  getActiveSessionId: vi.fn(() => null),
  getAvailableModels: vi.fn(() => []),
  notifySessionArchived: vi.fn(),
}));
vi.mock('../../public/ts/model-selector.js', () => ({ setAvailableModels: vi.fn() }));
vi.mock('../../public/ts/view-controller.js', () => ({ showSessionPanel: vi.fn() }));
vi.mock('../../public/ts/router.js', () => ({ sessionClick: vi.fn(), newSessionClick: vi.fn() }));
vi.mock('../../public/ts/websocket.js', () => ({
  onGlobalEvent: vi.fn(() => { counts.onGlobalEvent++; return () => {}; }),
}));
vi.mock('../../public/ts/session-state-tracker.js', () => ({ sessionTracker }));
vi.mock('../../public/ts/toast.js', () => ({ showToast: vi.fn() }));
vi.mock('../../public/ts/session-list-model.js', () => ({ buildSessionListModel: vi.fn() }));
vi.mock('../../public/ts/usage-display.js', () => ({ refreshUsageDisplays: vi.fn(), repaintUsageDisplays: vi.fn() }));

import { initSessionPanel, disposeSessionPanel } from '../../public/ts/session-panel.js';

beforeEach(() => {
  disposeSessionPanel();
  counts.onGlobalEvent = 0;
  counts.onChange = 0;
  panelListeners.add = 0;
  panelListeners.remove = 0;
});

describe('initSessionPanel idempotency (P4)', () => {
  it('registers subscriptions and drag listeners exactly once across two init calls', () => {
    initSessionPanel();
    initSessionPanel();

    expect(counts.onGlobalEvent).toBe(1);
    expect(counts.onChange).toBe(1);
    expect(panelListeners.add).toBe(4);
  });

  it('removes the drag listeners on dispose', () => {
    initSessionPanel();
    disposeSessionPanel();

    expect(panelListeners.remove).toBe(4);
  });
});
