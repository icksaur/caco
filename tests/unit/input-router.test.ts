// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

let keydownHandler: ((e: KeyboardEvent) => void) | null;
let getViewState: ReturnType<typeof vi.fn>;
let isAppletPanelVisible: ReturnType<typeof vi.fn>;
let toggleAppletExpanded: ReturnType<typeof vi.fn>;
let toggleSessions: ReturnType<typeof vi.fn>;
let toggleApplet: ReturnType<typeof vi.fn>;
let getCurrentCwd: ReturnType<typeof vi.fn>;
let getNewChatCwd: ReturnType<typeof vi.fn>;
let panelSet: ReturnType<typeof vi.fn>;

async function loadInputRouter() {
  vi.resetModules();
  keydownHandler = null;
  getViewState = vi.fn(() => 'chatting');
  isAppletPanelVisible = vi.fn(() => true);
  toggleAppletExpanded = vi.fn();
  toggleSessions = vi.fn();
  toggleApplet = vi.fn();
  getCurrentCwd = vi.fn(() => '/current project');
  getNewChatCwd = vi.fn(() => '/new project');
  panelSet = vi.fn();
  vi.spyOn(document, 'addEventListener').mockImplementation((type, listener) => {
    if (type === 'keydown') keydownHandler = listener as (e: KeyboardEvent) => void;
  });
  vi.doMock('../../public/ts/view-controller.js', () => ({
    getViewState,
    isAppletPanelVisible,
    toggleAppletExpanded,
  }));
  vi.doMock('../../public/ts/router.js', () => ({ toggleSessions, toggleApplet }));
  vi.doMock('../../public/ts/app-state.js', () => ({ getCurrentCwd, getNewChatCwd }));
  vi.doMock('../../public/ts/panel-state.js', () => ({
    getPanelState: vi.fn(() => ({ set: panelSet })),
  }));
  const mod = await import('../../public/ts/input-router.js');
  mod.initInputRouter();
  expect(keydownHandler).not.toBeNull();
  return mod;
}

function fireKey(key: string, init: KeyboardEventInit = {}, target: HTMLElement = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, 'target', { value: target });
  keydownHandler!(event);
  return event;
}

beforeEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(window, 'navigation', {
    value: undefined,
    configurable: true,
  });
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  document.body.innerHTML = `
    <div id="terminalPanel"><input id="terminalInput"></div>
    <input id="plainInput">
    <textarea id="plainTextarea"></textarea>
    <div id="editable" contenteditable="true"></div>
  `;
  Object.defineProperty(document.getElementById('editable'), 'isContentEditable', {
    value: true,
    configurable: true,
  });
});

describe('input-router', () => {
  it('routes Escape leader sequences through router and view seams', async () => {
    await loadInputRouter();

    const escape = fireKey('Escape');
    fireKey('l');
    fireKey('Escape');
    fireKey('.');
    fireKey('Escape');
    fireKey(',');

    expect(escape.defaultPrevented).toBe(true);
    expect(toggleSessions).toHaveBeenCalledTimes(1);
    expect(toggleApplet).toHaveBeenCalledTimes(1);
    expect(isAppletPanelVisible).toHaveBeenCalledTimes(1);
    expect(toggleAppletExpanded).toHaveBeenCalledTimes(1);
  });

  it('does not expand the applet when the leader comma runs with the panel hidden', async () => {
    await loadInputRouter();
    isAppletPanelVisible.mockReturnValue(false);

    fireKey('Escape');
    const comma = fireKey(',');

    expect(comma.defaultPrevented).toBe(true);
    expect(toggleAppletExpanded).not.toHaveBeenCalled();
  });

  it('opens files through the Navigation API while chatting', async () => {
    await loadInputRouter();
    const navigate = vi.fn();
    Object.defineProperty(window, 'navigation', {
      value: { navigate },
      configurable: true,
    });

    const event = fireKey('p', { ctrlKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(panelSet).toHaveBeenCalledWith({ applet: true }, 'deep-link');
    expect(navigate).toHaveBeenCalledWith('?applet=files&openFinder=1');
  });

  it('falls back to the new-chat cwd lookup for Ctrl+P on the new-chat surface', async () => {
    await loadInputRouter();
    getViewState.mockReturnValue('newChat');
    const locationSymbols = Object.getOwnPropertySymbols(window.location);
    const locationImpl = (window.location as unknown as Record<symbol, unknown>)[locationSymbols[0]] as {
      _locationObjectSetterNavigate: (url: { query: string | null }) => void;
    };
    const navigateToLocation = vi.spyOn(locationImpl, '_locationObjectSetterNavigate').mockImplementation(() => {});

    const event = fireKey('p', { metaKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(getNewChatCwd).toHaveBeenCalledTimes(1);
    expect(getCurrentCwd).not.toHaveBeenCalled();
    expect(panelSet).not.toHaveBeenCalled();
    expect(navigateToLocation).toHaveBeenCalledWith(expect.objectContaining({
      query: 'applet=files&openFinder=1&openFinderRoot=%2Fnew%20project',
    }));
  });

  it('routes normal non-input keys to the registered chat handler for chat views', async () => {
    const router = await loadInputRouter();
    const chatHandler = vi.fn();
    router.registerChatKeyHandler(chatHandler);

    const event = fireKey('x');

    expect(chatHandler).toHaveBeenCalledWith(event);
  });

  it('leaves terminal, native input, textarea, and contenteditable keys alone', async () => {
    const router = await loadInputRouter();
    const chatHandler = vi.fn();
    router.registerChatKeyHandler(chatHandler);

    fireKey('x', {}, document.getElementById('terminalInput')!);
    fireKey('x', {}, document.getElementById('plainInput')!);
    fireKey('x', {}, document.getElementById('plainTextarea')!);
    fireKey('x', {}, document.getElementById('editable')!);

    expect(chatHandler).not.toHaveBeenCalled();
  });
});
