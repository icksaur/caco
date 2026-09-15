// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BOTTOM_ZONE_PX,
  chatScrollStore,
  followLatest,
  initChatScroll,
  pinToLatest,
  _resetChatScrollForTests,
} from '../../public/ts/chat-scroll.js';

/**
 * Every rendered event used to call `scrollToBottom()` unconditionally, so the
 * chat well was a pure function of the newest event and the reader's position
 * existed nowhere. These fixtures pin the mode that makes it state.
 *
 * jsdom does no layout: a real element reports 0 for every scroll metric and
 * assigning `scrollTop` fires nothing. The harness models the browser facts the
 * policy depends on — a laid-out scroller reports its content height, a hidden
 * one reports zero, and writes to `scrollTop` are recorded.
 */
interface Harness {
  scroller: HTMLElement;
  writes: number[];
  setHidden: (hidden: boolean) => void;
  scrollTo: (top: number) => void;
}

const CONTENT_HEIGHT = 5000;
const VIEWPORT_HEIGHT = 800;

function mount(): Harness {
  document.body.innerHTML = `
    <div id="chatPanel" class="chat-panel">
      <div id="chatScroll" class="chat-scroll"><div id="chat"></div></div>
      <footer id="chatFooter">
        <button id="viewLatestBtn" class="view-latest-btn hidden" type="button">View latest</button>
      </footer>
    </div>`;
  const scroller = document.getElementById('chatScroll')!;
  const writes: number[] = [];
  let hidden = false;
  let top = 0;
  Object.defineProperty(scroller, 'scrollHeight', { get: () => (hidden ? 0 : CONTENT_HEIGHT) });
  Object.defineProperty(scroller, 'clientHeight', { get: () => (hidden ? 0 : VIEWPORT_HEIGHT) });
  Object.defineProperty(scroller, 'scrollTop', {
    get: () => top,
    set: (v: number) => { if (hidden) return; top = v; writes.push(v); },
  });
  return {
    scroller,
    writes,
    setHidden: (h: boolean) => { hidden = h; if (h) top = 0; },
    scrollTo: (t: number) => { top = t; scroller.dispatchEvent(new Event('scroll')); },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  _resetChatScrollForTests();
});

describe('chat scroll mode', () => {
  it('starts following the latest content', () => {
    mount();
    expect(chatScrollStore.get()).toBe('view-latest');
  });

  it('follows the stream in view-latest', () => {
    const h = mount();
    followLatest();
    expect(h.writes).toEqual([CONTENT_HEIGHT]);
  });

  it('writes nothing in no-scroll', () => {
    const h = mount();
    chatScrollStore.set('no-scroll');
    followLatest();
    expect(h.writes).toEqual([]);
  });

  it('pins from either mode', () => {
    const h = mount();
    chatScrollStore.set('no-scroll');
    pinToLatest();
    expect(chatScrollStore.get()).toBe('view-latest');
    expect(h.writes).toEqual([CONTENT_HEIGHT]);

    pinToLatest();
    expect(h.writes).toEqual([CONTENT_HEIGHT, CONTENT_HEIGHT]);
  });

  it('notifies subscribers only on a real change', () => {
    mount();
    const seen: string[] = [];
    chatScrollStore.subscribe(m => seen.push(m));
    chatScrollStore.set('no-scroll');
    chatScrollStore.set('no-scroll');
    chatScrollStore.set('view-latest');
    expect(seen).toEqual(['no-scroll', 'view-latest']);
  });
});

/**
 * The transition is deliberately ASYMMETRIC. Position is not intent: content
 * removal, a resize, clamping, and our own anchor corrections can all put the
 * well back in the bottom zone with no user action, and a symmetric rule would
 * let any of them silently re-arm following under a reader.
 */
describe('entering no-scroll', () => {
  const MAX_TOP = CONTENT_HEIGHT - VIEWPORT_HEIGHT;

  it('stays in view-latest at the bottom', () => {
    const h = mount();
    initChatScroll();
    h.scrollTo(MAX_TOP);
    expect(chatScrollStore.get()).toBe('view-latest');
  });

  it('stays in view-latest inside the bottom zone', () => {
    const h = mount();
    initChatScroll();
    h.scrollTo(MAX_TOP - (BOTTOM_ZONE_PX - 1));
    expect(chatScrollStore.get()).toBe('view-latest');
  });

  it('enters no-scroll outside the bottom zone', () => {
    const h = mount();
    initChatScroll();
    h.scrollTo(MAX_TOP - BOTTOM_ZONE_PX - 1);
    expect(chatScrollStore.get()).toBe('no-scroll');
  });

  it('does not release no-scroll by scrolling back to the bottom', () => {
    const h = mount();
    initChatScroll();
    h.scrollTo(0);
    expect(chatScrollStore.get()).toBe('no-scroll');

    h.scrollTo(MAX_TOP);
    expect(chatScrollStore.get()).toBe('no-scroll');
  });

  it('ignores a scroller that has no layout', () => {
    const h = mount();
    initChatScroll();
    h.setHidden(true);
    // A display:none panel reports zero for every metric, which reads as
    // "at the bottom". Nothing about the mode may turn on that accident.
    h.scrollTo(0);
    expect(chatScrollStore.get()).toBe('view-latest');
  });

  it('installs one listener however many times it is initialized', () => {
    const h = mount();
    const seen: string[] = [];
    chatScrollStore.subscribe(m => seen.push(m));
    initChatScroll();
    initChatScroll();
    h.scrollTo(0);
    expect(seen).toEqual(['no-scroll']);
  });

  it('leaves nothing installed behind a second init', () => {
    // A second install that overwrote the first disposer would strand the
    // first's subscriptions: disposing then looks clean and is not.
    mount();
    initChatScroll();
    const dispose = initChatScroll();
    dispose();

    chatScrollStore.set('no-scroll');
    expect(document.getElementById('viewLatestBtn')!.classList.contains('hidden')).toBe(true);
  });

  it('stops listening once disposed', () => {
    const h = mount();
    const dispose = initChatScroll();
    dispose();
    h.scrollTo(0);
    expect(chatScrollStore.get()).toBe('view-latest');
  });
});

/**
 * The ask's one hard requirement: entering no-scroll without the button
 * appearing strands the reader with no way back. So visibility is not a thing
 * any code path remembers to do — it is a pure function of the mode, applied by
 * one subscriber and synced once at install (I2).
 */
describe('the view-latest button', () => {
  const button = (): HTMLElement => document.getElementById('viewLatestBtn')!;

  it('follows the mode in both directions', () => {
    mount();
    initChatScroll();
    expect(button().classList.contains('hidden')).toBe(true);

    chatScrollStore.set('no-scroll');
    expect(button().classList.contains('hidden')).toBe(false);

    chatScrollStore.set('view-latest');
    expect(button().classList.contains('hidden')).toBe(true);
  });

  it('syncs at install, so the DOM cannot start out of step', () => {
    mount();
    chatScrollStore.set('no-scroll');
    // The markup ships hidden; nothing has run the subscriber yet.
    expect(button().classList.contains('hidden')).toBe(true);

    initChatScroll();
    expect(button().classList.contains('hidden')).toBe(false);
  });

  it('returns to following when pressed', () => {
    const h = mount();
    initChatScroll();
    h.scrollTo(0);
    expect(chatScrollStore.get()).toBe('no-scroll');

    button().dispatchEvent(new Event('click'));

    expect(chatScrollStore.get()).toBe('view-latest');
    expect(button().classList.contains('hidden')).toBe(true);
    expect(h.writes).toEqual([CONTENT_HEIGHT]);
  });

  it('stops following the mode once disposed', () => {
    mount();
    const dispose = initChatScroll();
    dispose();
    chatScrollStore.set('no-scroll');
    expect(button().classList.contains('hidden')).toBe(true);
  });
});

/**
 * The deferred retry.
 *
 * A scroll armed against a not-yet-laid-out panel writes `scrollTop` from a
 * timer, long after the call that armed it. Gating only the arming call would
 * leave that timer as a second, ungated writer: the user enters no-scroll while
 * the well is still at the top, and the timer scrolls them anyway.
 *
 * Two independent mechanisms, so neither oracle can pass on the other's work:
 * a real scroll cancels the pending retry, and the retry re-checks the mode.
 */
describe('the deferred retry', () => {
  it('scrolls once the panel is laid out', () => {
    const h = mount();
    h.setHidden(true);
    pinToLatest();
    expect(h.writes).toEqual([]);

    h.setHidden(false);
    vi.runOnlyPendingTimers();
    expect(h.writes).toEqual([CONTENT_HEIGHT]);
  });

  it('does not write once the mode has moved on', () => {
    const h = mount();
    h.setHidden(true);
    pinToLatest();

    // Set the store directly: this is the path that no cancellation hook sees,
    // so only the retry's own re-check can protect the reader.
    chatScrollStore.set('no-scroll');
    h.setHidden(false);
    vi.runOnlyPendingTimers();
    expect(h.writes).toEqual([]);
  });

  it('is cancelled by the scroll that enters no-scroll', () => {
    const h = mount();
    initChatScroll();
    h.setHidden(true);
    pinToLatest();
    expect(vi.getTimerCount()).toBe(1);

    h.setHidden(false);
    h.scrollTo(0);
    expect(chatScrollStore.get()).toBe('no-scroll');
    expect(vi.getTimerCount()).toBe(0);
  });
});

/**
 * I1 as an enforced rule rather than a convention.
 *
 * The whole bug was that a render-path call moved the well unconditionally. One
 * new call site written the old way brings it back, and nothing about that
 * site's own tests would notice. So the ban is checked against the source: not
 * "no module imports the old helper" — TypeScript already rejects that, which
 * would make the oracle vacuous — but "no module moves the scroller".
 */
describe('sole ownership of the chat scroller', () => {
  const dir = join(process.cwd(), 'public', 'ts');
  const sources = readdirSync(dir)
    .filter(f => f.endsWith('.ts') && f !== 'chat-scroll.ts')
    .map(f => ({ file: f, text: readFileSync(join(dir, f), 'utf8') }));

  it('scans a plausible number of modules', () => {
    // Guards the scan itself: a glob that silently matched nothing would make
    // every assertion below pass.
    expect(sources.length).toBeGreaterThan(40);
  });

  it('lets no other module assign scrollTop', () => {
    const offenders = sources
      .filter(s => /\.scrollTop\s*[+\-*/]?=[^=]/.test(s.text))
      .map(s => s.file);
    expect(offenders).toEqual([]);
  });

  it('lets no module that reaches for #chatScroll move it', () => {
    const offenders = sources
      .filter(s => s.text.includes('chatScroll'))
      .filter(s => /\.scrollTop|\.scrollTo\(|\.scrollBy\(|scrollIntoView\(/.test(s.text))
      .map(s => s.file);
    expect(offenders).toEqual([]);
  });

  it('leaves no inline scroll handler in the markup', () => {
    const html = readFileSync(join(process.cwd(), 'public', 'index.html'), 'utf8');
    expect(html).not.toMatch(/on\w+="[^"]*scroll/i);
  });
});

/**
 * Facts of the shipped page the module's behavior rests on. Each one is
 * invisible from the module's own tests: the button can toggle a class
 * perfectly and still never hide, or sit inside a form and submit it.
 */
describe('the structural premise behind the button', () => {
  const read = (p: string): string =>
    readFileSync(join(process.cwd(), 'public', p), 'utf8');

  it('puts the button in the footer, outside both forms, shipped hidden', () => {
    const page = new DOMParser().parseFromString(read('index.html'), 'text/html');
    const button = page.getElementById('viewLatestBtn');
    expect(button).not.toBeNull();
    expect(button!.closest('#chatFooter')).not.toBeNull();
    expect(button!.closest('form')).toBeNull();
    expect(button!.classList.contains('hidden')).toBe(true);
  });

  it('declares its own hidden rule, because there is no global one', () => {
    const css = read('style.css').replace(/\s+/g, ' ');
    expect(css).toContain('.view-latest-btn.hidden { display: none; }');
  });

  it('keeps native anchoring off and smooth scrolling absent on the scroller', () => {
    // Comments are stripped first: the rule carries a "do not add
    // scroll-behavior" contract comment, which would otherwise read as the
    // declaration it forbids.
    const css = read('style.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = css.slice(css.indexOf('.chat-scroll {'));
    const body = rule.slice(0, rule.indexOf('}'));
    expect(body).toContain('overflow-anchor: none');
    expect(body).not.toContain('scroll-behavior');
  });
});
