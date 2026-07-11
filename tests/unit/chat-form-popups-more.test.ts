// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const seams = vi.hoisted(() => ({
  getCommands: vi.fn(),
  findCommand: vi.fn(),
  getCwd: vi.fn(),
  poundProvider: vi.fn(),
}));

vi.mock('../../public/ts/command-registry.js', () => ({
  getCommands: seams.getCommands,
  findCommand: seams.findCommand,
}));
vi.mock('../../public/ts/chat-view-controller.js', () => ({
  chatView: { getCwd: seams.getCwd },
}));
vi.mock('../../public/ts/multiline-input.js', () => ({
  poundProviders: [seams.poundProvider],
}));

import { FormPopups, autoResize } from '../../public/ts/chat-form-popups.js';
import type { PopupItem } from '../../public/ts/input-popup.js';

function must<T>(value: T | null | undefined, label: string): T {
  if (!value) throw new Error(`Missing ${label}`);
  return value;
}

function setupForm(): { textarea: HTMLTextAreaElement; anchor: HTMLElement; popups: FormPopups } {
  document.body.innerHTML = '<div id="anchor"></div><textarea></textarea>';
  const textarea = must(document.querySelector('textarea'), 'textarea');
  const anchor = must(document.getElementById('anchor'), 'anchor');
  const popups = new FormPopups(textarea, anchor);
  popups.attach();
  return { textarea, anchor, popups };
}

function input(textarea: HTMLTextAreaElement, value: string): void {
  textarea.value = value;
  textarea.setSelectionRange(value.length, value.length);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

async function letPopupListenersInstall(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ files: ['src/app.ts'] }),
  })));
  seams.getCommands.mockReturnValue([
    { name: 'agent', description: 'Pick an agent' },
    { name: 'review', description: 'Review code' },
  ]);
  seams.findCommand.mockImplementation((name: string) => (name === 'agent'
    ? { name: 'agent', picker: () => [{ id: 'reviewer', label: 'Reviewer', value: 'reviewer ' }] }
    : null));
  seams.getCwd.mockReturnValue('/workspace');
  seams.poundProvider.mockReturnValue([{ id: 'symbol', label: 'Symbol', value: '@symbol' }]);
});

afterEach(async () => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await letPopupListenersInstall();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('FormPopups additional DOM behavior', () => {
  it('opens a slash command popup, filters it, and inserts the selected command', async () => {
    const { textarea, popups } = setupForm();

    input(textarea, '/ag');

    expect(popups.isAnyVisible()).toBe(true);
    expect([...document.querySelectorAll('.input-popup-item')].map(el => el.textContent)).toEqual(['/agentPick an agent']);
    must(document.querySelector<HTMLElement>('.input-popup-item'), 'slash item')
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(textarea.value).toBe('/agent ');
    expect(popups.isAnyVisible()).toBe(false);
    await letPopupListenersInstall();
  });

  it('hides the slash popup when arguments are typed', async () => {
    const { textarea, popups } = setupForm();

    input(textarea, '/agent');
    expect(popups.isAnyVisible()).toBe(true);

    input(textarea, '/agent reviewer');
    expect(popups.isAnyVisible()).toBe(false);
    await letPopupListenersInstall();
  });

  it('opens a command picker and accepts Enter selection into the textarea', async () => {
    const { textarea, popups } = setupForm();

    await popups.openPicker('agent');
    expect([...document.querySelectorAll('.input-popup-item')].map(el => el.textContent)).toEqual(['Reviewer']);

    const handled = popups.handleKey(new KeyboardEvent('keydown', { key: 'Enter' }));

    expect(handled).toBe(true);
    expect(textarea.value).toBe('/agent reviewer ');
    expect(popups.isAnyVisible()).toBe(false);
    await letPopupListenersInstall();
  });

  it('dismisses a command picker with Escape and restores a command prefix', async () => {
    const { textarea, popups } = setupForm();
    await popups.openPicker('agent');

    expect(popups.handleKey(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(true);

    expect(textarea.value).toBe('/agent ');
    expect(popups.isAnyVisible()).toBe(false);
  });

  it('combines pound providers and fetched project files, then inserts the selected item', async () => {
    const { textarea, popups } = setupForm();

    input(textarea, 'open #s');
    await letPopupListenersInstall();

    expect(fetch).toHaveBeenCalledWith('/api/project-files?cwd=%2Fworkspace');
    expect([...document.querySelectorAll('.input-popup-item')].map(el => el.textContent)).toEqual(['Symbol', 'src/app.ts']);
    must(document.querySelector<HTMLElement>('.input-popup-item'), 'pound item')
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(textarea.value).toBe('open @symbol');
    expect(textarea.selectionStart).toBe('open @symbol'.length);
    expect(popups.isAnyVisible()).toBe(false);
    await letPopupListenersInstall();
  });

  it('uses backticked labels for pound items without explicit values', async () => {
    seams.poundProvider.mockReturnValue([{ id: 'label-only', label: 'LabelOnly' } satisfies PopupItem]);
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: () => Promise.resolve({ files: [] }) } as Response);
    const { textarea } = setupForm();

    input(textarea, 'see #');
    await letPopupListenersInstall();
    must(document.querySelector<HTMLElement>('.input-popup-item'), 'label-only pound item')
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(textarea.value).toBe('see `LabelOnly`');
  });

  it('resizes textareas to max height and toggles overflow', () => {
    const textarea = document.createElement('textarea');
    Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 240 });

    autoResize(textarea);

    expect(textarea.style.height).toBe('180px');
    expect(textarea.style.overflowY).toBe('auto');

    Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 80 });
    autoResize(textarea);

    expect(textarea.style.height).toBe('80px');
    expect(textarea.style.overflowY).toBe('hidden');
  });
});
