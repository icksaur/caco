// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scrollToBottom } from '../../public/ts/ui-utils.js';

/**
 * Selecting a session on mobile left the chat scrolled to the top.
 *
 * On mobile the session list owns the screen: `.work-area:has(.session-panel:
 * not(.hidden)) .chat-panel { display: none }`. `#chatScroll` lives inside that
 * panel, so while the list is open the chat has no layout at all — and
 * `sessionClick` awaits `activateSession()` (which loads history and scrolls)
 * BEFORE closing the panel. The scroll therefore ran against a display:none
 * element, where `scrollHeight` is 0 and `scrollTop = scrollHeight` is a no-op
 * that reports success.
 *
 * jsdom does no layout, so it cannot reproduce "display:none makes scrollHeight
 * 0" on its own. These fixtures model the browser fact explicitly: a hidden
 * container reports 0, a laid-out one reports its content height. What is under
 * test is whether scrollToBottom NOTICES that it cannot scroll yet.
 */

interface Harness { scroller: HTMLElement; setHidden: (hidden: boolean) => void }

function mount(): Harness {
  document.body.innerHTML = `
    <div class="work-area">
      <div id="sessionView" class="session-panel hidden"></div>
      <div id="chatPanel" class="chat-panel">
        <div id="chatScroll" class="chat-scroll"><div id="chat"></div></div>
      </div>
    </div>`;
  const scroller = document.getElementById('chatScroll')!;
  let hidden = false;
  let top = 0;
  // Model the browser: a display:none subtree has no scrollable metrics, and
  // assignments to scrollTop are discarded.
  Object.defineProperty(scroller, 'scrollHeight', { get: () => (hidden ? 0 : 5000) });
  Object.defineProperty(scroller, 'clientHeight', { get: () => (hidden ? 0 : 800) });
  Object.defineProperty(scroller, 'scrollTop', {
    get: () => top,
    set: (v: number) => { top = hidden ? 0 : v; },
  });
  return {
    scroller,
    setHidden: (h: boolean) => {
      hidden = h;
      document.getElementById('sessionView')!.classList.toggle('hidden', !h);
      document.getElementById('chatPanel')!.style.display = h ? 'none' : '';
      if (h) top = 0;
    },
  };
}

beforeEach(() => { vi.useFakeTimers(); });

describe('scrollToBottom while the chat panel has no layout', () => {
  it('scrolls once the panel is laid out', () => {
    const h = mount();
    scrollToBottom();
    expect(h.scroller.scrollTop).toBe(5000);
  });

  it('does not silently give up when the panel is hidden', async () => {
    const h = mount();
    h.setHidden(true);

    scrollToBottom();
    expect(h.scroller.scrollTop).toBe(0);   // nothing to scroll yet, as expected

    // The panel opens a moment later, exactly as it does when the mobile
    // session list closes after a pick. The chat must end up at the bottom
    // without any further call from the caller.
    h.setHidden(false);
    await vi.advanceTimersByTimeAsync(500);

    expect(h.scroller.scrollTop).toBe(5000);
  });

  it('gives up rather than retrying forever when the panel never appears', async () => {
    const h = mount();
    h.setHidden(true);

    scrollToBottom();
    await vi.advanceTimersByTimeAsync(10_000);

    // Still 0 — but the point is that the timers have drained, so a hidden
    // chat cannot leave a retry loop running for the life of the page.
    expect(h.scroller.scrollTop).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a later successful scroll cancels an outstanding retry', async () => {
    const h = mount();
    h.setHidden(true);
    scrollToBottom();          // arms a retry

    h.setHidden(false);
    scrollToBottom();          // succeeds immediately
    expect(h.scroller.scrollTop).toBe(5000);

    h.scroller.scrollTop = 1200;   // user scrolls up to read something
    await vi.advanceTimersByTimeAsync(10_000);

    // The stale retry must not yank them back to the bottom.
    expect(h.scroller.scrollTop).toBe(1200);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('abandons the retry once the user has scrolled, with no second call', async () => {
    const h = mount();
    h.setHidden(true);
    scrollToBottom();              // arms a retry; nothing cancels it later

    // The panel appears and the user immediately scrolls up to read. There is no
    // further scrollToBottom call, so only the retry's own guard can protect them.
    h.setHidden(false);
    h.scroller.scrollTop = 900;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(h.scroller.scrollTop).toBe(900);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still honours a direct call while the user is scrolled up', () => {
    // The guard is for delayed scrolls only. A direct call is an explicit
    // request — streamed content calls this on every chunk — and must keep
    // working exactly as it did before the retry existed.
    const h = mount();
    h.scroller.scrollTop = 900;

    scrollToBottom();

    expect(h.scroller.scrollTop).toBe(5000);
  });

  it('leaves only one retry outstanding when called repeatedly while hidden', async () => {
    const h = mount();
    h.setHidden(true);

    scrollToBottom();
    scrollToBottom();
    scrollToBottom();

    // Each call supersedes the last rather than stacking timers that all fire.
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

/**
 * The fixture above models a browser fact jsdom cannot produce. That is only
 * legitimate while the app really is shaped the way the fixture assumes, so
 * assert the two structural facts the whole bug rests on. If either changes,
 * these fail and the modelling above has to be revisited rather than silently
 * testing a premise that no longer holds.
 */
describe('the structural premise behind the fixture', () => {
  const read = (p: string): string =>
    readFileSync(join(process.cwd(), 'public', p), 'utf8');

  it('puts #chatScroll inside .chat-panel', () => {
    const html = read('index.html');
    const panel = html.indexOf('id="chatPanel"');
    const scroll = html.indexOf('id="chatScroll"');
    expect(panel).toBeGreaterThan(-1);
    expect(scroll).toBeGreaterThan(panel);   // nested within, so it inherits display:none
  });

  it('hides .chat-panel on mobile while the session list is open', () => {
    const css = read('style.css').replace(/\s+/g, ' ');
    expect(css).toContain('.work-area:has(.session-panel:not(.hidden)) .chat-panel { display: none; }');
  });
});
