// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adHocBar, type AdHocWidget } from '../../public/ts/adhoc-bar.js';

let container: HTMLElement;
let sessions: string[];

function widget(id: string, priority: number, text: string, dispose = vi.fn()): AdHocWidget {
  return {
    id,
    priority,
    dispose,
    render: vi.fn(() => {
      const button = document.createElement('button');
      button.className = `widget-${id}`;
      button.textContent = text;
      return button;
    }),
  };
}

beforeEach(() => {
  document.body.innerHTML = '<section id="adhoc"></section>';
  container = document.getElementById('adhoc') as HTMLElement;
  sessions = [];
  adHocBar.init(container);
  adHocBar.deactivate();
});

afterEach(() => {
  for (const sessionId of sessions) adHocBar.clearSession(sessionId);
  adHocBar.deactivate();
  document.body.innerHTML = '';
});

function track(sessionId: string): string {
  sessions.push(sessionId);
  return sessionId;
}

describe('adHocBar', () => {
  it('renders active-session widgets in priority order and marks the bar visible', () => {
    const sessionId = track('adhoc-order-session');
    const low = widget('low', 20, 'Low');
    const high = widget('high', 1, 'High');

    adHocBar.addWidget(sessionId, low);
    adHocBar.addWidget(sessionId, high);
    adHocBar.activateSession(sessionId);

    expect(container.classList.contains('visible')).toBe(true);
    expect([...container.querySelectorAll('button')].map(el => el.textContent)).toEqual(['High', 'Low']);
    expect(high.render).toHaveBeenCalledTimes(1);
    expect(low.render).toHaveBeenCalledTimes(1);
  });

  it('keeps inactive-session widgets hidden until their session activates', () => {
    const inactiveId = track('adhoc-inactive-session');
    const activeId = track('adhoc-active-session');
    adHocBar.addWidget(inactiveId, widget('inactive', 1, 'Inactive'));

    adHocBar.activateSession(activeId);
    expect(container.classList.contains('visible')).toBe(false);
    expect(container.children).toHaveLength(0);

    adHocBar.activateSession(inactiveId);
    expect(container.classList.contains('visible')).toBe(true);
    expect(container.textContent).toBe('Inactive');
  });

  it('rerenders through the returned update handle', () => {
    const sessionId = track('adhoc-update-session');
    let text = 'Before';
    const render = vi.fn(() => {
      const el = document.createElement('span');
      el.textContent = text;
      return el;
    });
    const handle = adHocBar.addWidget(sessionId, { id: 'changing', priority: 1, render });
    adHocBar.activateSession(sessionId);

    text = 'After';
    handle.update();

    expect(render).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe('After');
  });

  it('disposes removed and cleared widgets and hides empty sessions', () => {
    const sessionId = track('adhoc-remove-session');
    const disposeA = vi.fn();
    const disposeB = vi.fn();
    const handle = adHocBar.addWidget(sessionId, widget('a', 1, 'A', disposeA));
    adHocBar.addWidget(sessionId, widget('b', 2, 'B', disposeB));
    adHocBar.activateSession(sessionId);

    handle.remove();
    expect(disposeA).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe('B');

    adHocBar.clearSession(sessionId);
    expect(disposeB).toHaveBeenCalledTimes(1);
    expect(container.classList.contains('visible')).toBe(false);
    expect(container.children).toHaveLength(0);
  });

  it('deactivates by clearing the visible DOM without disposing stored widgets', () => {
    const sessionId = track('adhoc-deactivate-session');
    const dispose = vi.fn();
    adHocBar.addWidget(sessionId, widget('stored', 1, 'Stored', dispose));
    adHocBar.activateSession(sessionId);

    adHocBar.deactivate();

    expect(container.classList.contains('visible')).toBe(false);
    expect(container.children).toHaveLength(0);
    expect(dispose).not.toHaveBeenCalled();
  });

  it('renders an error placeholder when a widget render throws', () => {
    const sessionId = track('adhoc-error-session');
    adHocBar.addWidget(sessionId, {
      id: 'broken',
      priority: 1,
      render: () => {
        throw new Error('boom');
      },
    });

    adHocBar.activateSession(sessionId);

    const error = container.querySelector('.adhoc-error');
    expect(error?.textContent).toBe('[widget error: broken]');
    expect(container.classList.contains('visible')).toBe(true);
  });
});
