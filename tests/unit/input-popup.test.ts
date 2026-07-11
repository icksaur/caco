// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputPopup, type PopupItem } from '../../public/ts/input-popup.js';

const popupItems: PopupItem[] = [
  { id: 'open', label: 'Open File', description: 'Show a file', icon: 'icon-open' },
  { id: 'delete', label: 'Delete File', description: 'Dangerous action', danger: true },
  { id: 'rename', label: 'Rename Symbol' },
];

let popups: InputPopup[] = [];

function must<T>(value: T | null | undefined, label: string): T {
  if (!value) throw new Error(`Missing ${label}`);
  return value;
}

function makePopup() {
  const anchor = document.createElement('input');
  document.body.appendChild(anchor);
  const onSelect = vi.fn();
  const onDismiss = vi.fn();
  const popup = new InputPopup({ anchor, onSelect, onDismiss, direction: 'down' });
  popups.push(popup);
  return { popup, anchor, onSelect, onDismiss };
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  document.body.innerHTML = '';
  popups = [];
});

afterEach(() => {
  for (const popup of popups) {
    popup.hide();
    popup.destroy();
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('InputPopup', () => {
  it('shows rows with icons, descriptions, danger, and selected state', () => {
    const { popup } = makePopup();

    popup.show(popupItems);

    const rows = [...document.querySelectorAll<HTMLElement>('.input-popup-item')];
    expect(popup.isVisible()).toBe(true);
    expect(rows).toHaveLength(3);
    expect(rows[0].classList.contains('selected')).toBe(true);
    expect(must(rows[0].querySelector('.popup-icon'), 'icon').classList.contains('icon-open')).toBe(true);
    expect(must(rows[0].querySelector('.popup-description'), 'description').textContent).toBe('Show a file');
    expect(rows[1].classList.contains('danger')).toBe(true);
  });

  it('filters by label and description and hides when no item matches', () => {
    const { popup } = makePopup();
    popup.show(popupItems);

    popup.filter('danger');

    expect([...document.querySelectorAll('.input-popup-item')].map(el => el.textContent)).toEqual(['Delete FileDangerous action']);
    expect(popup.isVisible()).toBe(true);

    popup.filter('zzz');

    expect(popup.isVisible()).toBe(false);
    expect(document.querySelectorAll('.input-popup-item')).toHaveLength(1);
  });

  it('selects hovered and clicked rows with the matching item', () => {
    const { popup, onSelect } = makePopup();
    popup.show(popupItems);

    const second = must(document.querySelectorAll<HTMLElement>('.input-popup-item')[1], 'second item');
    second.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(second.classList.contains('selected')).toBe(true);
    second.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(onSelect).toHaveBeenCalledWith(popupItems[1]);
  });

  it('handles arrow, enter, tab, and escape keys as popup commands', () => {
    const { popup, onSelect, onDismiss } = makePopup();
    popup.show(popupItems);

    expect(popup.handleKey(new KeyboardEvent('keydown', { key: 'ArrowDown' }))).toBe(true);
    expect(must(document.querySelectorAll<HTMLElement>('.input-popup-item')[1], 'second row').classList.contains('selected')).toBe(true);
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    expect(popup.handleKey(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(true);
    expect(onSelect).toHaveBeenCalledWith(popupItems[1]);

    expect(popup.handleKey(new KeyboardEvent('keydown', { key: 'ArrowUp' }))).toBe(true);
    expect(popup.handleKey(new KeyboardEvent('keydown', { key: 'Tab' }))).toBe(true);
    expect(onSelect).toHaveBeenLastCalledWith(popupItems[0]);

    expect(popup.handleKey(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(true);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(popup.handleKey(new KeyboardEvent('keydown', { key: 'x' }))).toBe(false);
  });

  it('dismisses from global outside click and Escape after listener installation', async () => {
    const { popup, onDismiss } = makePopup();
    popup.show(popupItems);
    await vi.advanceTimersByTimeAsync(0);

    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it('hides, clears items, and ignores keys when not visible', () => {
    const { popup } = makePopup();
    popup.show(popupItems);

    popup.hide();

    expect(popup.isVisible()).toBe(false);
    expect(popup.handleKey(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(false);
    popup.filter('');
    expect(popup.isVisible()).toBe(false);
  });
});
