// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Picking a session on mobile must give the chat its layout BEFORE loading it.
 *
 * The session list owns the whole screen on mobile, which puts `.chat-panel` at
 * `display: none`. A chat with no layout reports `scrollHeight` 0 and discards
 * writes to `scrollTop`, so loading the history first — which is what scrolls to
 * the bottom — silently did nothing and left the user at the top of a long
 * conversation. `scrollToBottom` now retries as a safety net, but ordering is
 * the actual fix, and only ordering is asserted here.
 */

const calls: string[] = [];

const chatView = vi.hoisted(() => ({
  activateSession: vi.fn(async () => {}),
  showNewChat: vi.fn(),
}));
const panel = vi.hoisted(() => ({ set: vi.fn() }));
const device = vi.hoisted(() => ({ deviceClass: vi.fn(() => 'mobile') }));

vi.mock('../../public/ts/chat-view-controller.js', () => ({ chatView }));
vi.mock('../../public/ts/panel-state.js', () => ({
  getPanelState: () => panel,
  deviceClass: device.deviceClass,
}));

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
  chatView.activateSession.mockImplementation(async () => { calls.push('activate'); });
  panel.set.mockImplementation((patch: Record<string, boolean>) => {
    if (patch.session === false) calls.push('close-panel');
  });
  device.deviceClass.mockReturnValue('mobile');
  window.history.pushState(null, '', '/');
});

describe('sessionClick panel ordering', () => {
  it('closes the mobile session panel before loading the session', async () => {
    const { sessionClick } = await import('../../public/ts/router.js');
    await sessionClick('s-1');

    // Order is the whole point: activating first scrolls a chat that has no box.
    expect(calls).toEqual(['close-panel', 'activate']);
  });

  it('still loads the session on desktop, and leaves the list open', async () => {
    device.deviceClass.mockReturnValue('desktop');
    const { sessionClick } = await import('../../public/ts/router.js');
    await sessionClick('s-1');

    // Desktop keeps the list visible so the user can scrub between sessions.
    expect(calls).toEqual(['activate']);
    expect(panel.set).not.toHaveBeenCalled();
  });

  it('writes the clean session URL after loading', async () => {
    const { sessionClick } = await import('../../public/ts/router.js');
    await sessionClick('s-1');

    const url = new URL(window.location.href);
    expect(url.searchParams.get('session')).toBe('s-1');
  });
});
