// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

let scrollToBottom: ReturnType<typeof vi.fn>;
let panelSnapshot: { session: boolean; applet: boolean };
let panelSet: ReturnType<typeof vi.fn>;

async function loadViewController() {
  vi.resetModules();
  scrollToBottom = vi.fn();
  panelSnapshot = { session: false, applet: false };
  panelSet = vi.fn((patch: Partial<typeof panelSnapshot>) => {
    panelSnapshot = { ...panelSnapshot, ...patch };
  });
  vi.doMock('../../public/ts/ui-utils.js', () => ({ scrollToBottom }));
  vi.doMock('../../public/ts/panel-state.js', () => ({
    getPanelState: vi.fn(() => ({
      get: vi.fn(() => panelSnapshot),
      set: panelSet,
    })),
  }));
  return import('../../public/ts/view-controller.js');
}

function installDom(): void {
  document.body.innerHTML = `
    <div id="chatScroll"></div>
    <div id="sessionView"></div>
    <div id="appletPanel"></div>
    <div id="appletView"></div>
    <div id="chat" class="hidden"></div>
    <div id="newChat"></div>
    <footer id="chatFooter"></footer>
    <button id="menuBtn"></button>
    <button id="appletBtn" class="hidden"></button>
    <button id="expandBtn"><span class="expand-icon">«</span></button>
    <form id="newChatForm"><textarea name="message"></textarea></form>
    <form id="chattingForm" hidden><textarea name="message"></textarea></form>
    <div id="workingCursor" class="hidden"></div>
    <div id="contextFooter"></div>
  `;
}

beforeEach(() => {
  vi.restoreAllMocks();
  installDom();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
});

describe('view-controller', () => {
  it('switches to chatting view and scrolls after the view transition', async () => {
    const view = await loadViewController();

    view.setViewState('chatting');

    expect(document.getElementById('chat')?.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('newChat')?.classList.contains('hidden')).toBe(true);
    expect((document.getElementById('newChatForm') as HTMLFormElement).hidden).toBe(true);
    expect((document.getElementById('chattingForm') as HTMLFormElement).hidden).toBe(false);
    expect(document.getElementById('appletBtn')?.classList.contains('hidden')).toBe(false);
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
    expect(view.getViewState()).toBe('chatting');
    expect(view.isViewState('chatting')).toBe(true);
  });

  it('switches back to new chat, resets the textarea, and enables the visible form', async () => {
    const view = await loadViewController();
    view.setViewState('chatting');
    const textarea = document.querySelector<HTMLTextAreaElement>('#newChatForm textarea');
    expect(textarea).not.toBeNull();
    textarea!.style.height = '42px';
    textarea!.style.overflowY = 'scroll';

    view.setViewState('newChat');

    expect(document.getElementById('newChat')?.classList.contains('hidden')).toBe(false);
    expect((document.getElementById('newChatForm') as HTMLFormElement).hidden).toBe(false);
    expect((document.getElementById('chattingForm') as HTMLFormElement).hidden).toBe(true);
    expect(textarea!.style.height).toBe('auto');
    expect(textarea!.style.overflowY).toBe('hidden');
    expect(document.activeElement).toBe(textarea);
  });

  it('marks only the active form and shared footer affordances busy', async () => {
    const view = await loadViewController();
    view.setViewState('chatting');

    view.setFormEnabled(false);

    expect(document.getElementById('chattingForm')?.classList.contains('busy')).toBe(true);
    expect(document.getElementById('workingCursor')?.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('contextFooter')?.classList.contains('is-busy')).toBe(true);

    view.setFormEnabled(true);

    expect(document.getElementById('chattingForm')?.classList.contains('busy')).toBe(false);
    expect(document.getElementById('workingCursor')?.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('contextFooter')?.classList.contains('is-busy')).toBe(false);
  });

  it('routes session and applet panel visibility through the panel-state seam', async () => {
    const view = await loadViewController();

    view.showSessionPanel();
    view.toggleSessionPanel();
    view.showAppletPanel();
    view.hideAppletPanel();

    expect(panelSet).toHaveBeenNthCalledWith(1, { session: true }, 'user-toggle-session');
    expect(panelSet).toHaveBeenNthCalledWith(2, { session: false }, 'user-toggle-session');
    expect(panelSet).toHaveBeenNthCalledWith(3, { applet: true }, 'user-toggle-applet');
    expect(panelSet).toHaveBeenNthCalledWith(4, { applet: false }, 'user-toggle-applet');
    expect(view.isSessionPanelVisible()).toBe(false);
    expect(view.isAppletPanelVisible()).toBe(false);
  });

  it('toggles applet expansion classes and icon text', async () => {
    const view = await loadViewController();

    view.toggleAppletExpanded();

    expect(view.isAppletExpanded()).toBe(true);
    expect(document.getElementById('appletPanel')?.classList.contains('expanded')).toBe(true);
    expect(document.getElementById('expandBtn')?.classList.contains('active')).toBe(true);
    expect(document.querySelector('.expand-icon')?.textContent).toBe('»');

    view.toggleAppletExpanded();

    expect(view.isAppletExpanded()).toBe(false);
    expect(document.getElementById('appletPanel')?.classList.contains('expanded')).toBe(false);
    expect(document.querySelector('.expand-icon')?.textContent).toBe('«');
  });

  it('detects the initial DOM view during initialization', async () => {
    const view = await loadViewController();

    view.initViewState();

    expect(view.getViewState()).toBe('newChat');
    expect(view.getCachedElement('newChat')).toBe(document.getElementById('newChat'));
    expect(document.title).toBe('Caco');
  });
});
