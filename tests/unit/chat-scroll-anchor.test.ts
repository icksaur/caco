// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  chatScrollStore,
  initChatScroll,
  pinToLatest,
  restoreAnchor,
  _resetChatScrollForTests,
} from '../../public/ts/chat-scroll.js';

/**
 * Withholding the scroll is not enough to hold the reader still. Caco rebuilds
 * content in place while streaming — `streaming-markdown.ts` assigns
 * `textContent` over the element it is rendering into, `dom-regions.ts` empties
 * tool elements on completion, Mermaid renders asynchronously — so a message
 * ABOVE the viewport can change height at any moment and push the text under
 * the reader's eyes. Native `overflow-anchor` cannot help: it picks its own
 * anchor node and is defeated by exactly that node replacement.
 *
 * jsdom does no layout, so this models it: children of `#chat` stack from the
 * top, and a rect is content position minus `scrollTop`. That makes the
 * expected correction independently computable — the anchor's offset from the
 * scroller's top edge must be the same number after the mutation as before,
 * which is a different calculation from the one the module performs.
 */
const VIEWPORT_HEIGHT = 800;
const SCROLL_TOP = 1500;

interface Harness {
  scroller: HTMLElement;
  chat: HTMLElement;
  children: HTMLElement[];
  writes: number[];
  scrollTop: () => number;
  setHeight: (index: number, height: number) => void;
  append: (height: number) => void;
  remove: (index: number) => void;
  scrollTo: (top: number) => void;
  setViewportHeight: (height: number) => void;
  /** Reference model: where a child's top edge sits relative to the viewport. */
  expectedOffset: (index: number) => number;
}

function mount(heights: number[]): Harness {
  document.body.innerHTML = '<div id="chatScroll"><div id="chat"></div></div>';
  const scroller = document.getElementById('chatScroll')!;
  const chat = document.getElementById('chat')!;
  const boxes = new Map<HTMLElement, number>();
  const writes: number[] = [];
  let top = 0;
  let viewport = VIEWPORT_HEIGHT;

  const contentTop = (el: HTMLElement): number => {
    let acc = 0;
    for (const child of Array.from(chat.children) as HTMLElement[]) {
      if (child === el) return acc;
      acc += boxes.get(child) ?? 0;
    }
    return acc;
  };
  const totalHeight = (): number =>
    (Array.from(chat.children) as HTMLElement[]).reduce((a, c) => a + (boxes.get(c) ?? 0), 0);

  scroller.getBoundingClientRect = () => ({ top: 0, bottom: viewport }) as DOMRect;
  Object.defineProperty(scroller, 'clientHeight', { get: () => viewport });
  Object.defineProperty(scroller, 'scrollHeight', { get: () => totalHeight() });
  Object.defineProperty(scroller, 'scrollTop', {
    get: () => top,
    set: (v: number) => { top = v; writes.push(v); },
  });

  const makeChild = (height: number): HTMLElement => {
    const el = document.createElement('div');
    boxes.set(el, height);
    el.getBoundingClientRect = () => {
      const t = contentTop(el) - top;
      return { top: t, bottom: t + (boxes.get(el) ?? 0) } as DOMRect;
    };
    chat.appendChild(el);
    return el;
  };

  const children = heights.map(makeChild);
  top = SCROLL_TOP;

  return {
    scroller, chat, children, writes,
    scrollTop: () => top,
    setHeight: (i, h) => { boxes.set(children[i], h); },
    append: h => { makeChild(h); },
    remove: i => { children[i].remove(); },
    scrollTo: t => { top = t; scroller.dispatchEvent(new Event('scroll')); },
    setViewportHeight: v => { viewport = v; },
    expectedOffset: i => contentTop(children[i]) - top,
  };
}

/** Enter no-scroll the way a user does, so the anchor is captured for real. */
function readHistory(h: Harness): void {
  initChatScroll();
  h.scrollTo(SCROLL_TOP);
  expect(chatScrollStore.get()).toBe('no-scroll');
}

beforeEach(() => {
  vi.useFakeTimers();
  _resetChatScrollForTests();
});

describe('viewport anchoring in no-scroll', () => {
  it('holds the reader still when content above the viewport grows', () => {
    const h = mount([1000, 1000, 1000]);
    readHistory(h);
    const before = h.expectedOffset(1);

    h.setHeight(0, 1200);
    restoreAnchor();

    expect(h.expectedOffset(1)).toBe(before);
    expect(h.writes).toEqual([SCROLL_TOP + 200]);
  });

  it('holds the reader still when content above the viewport shrinks', () => {
    const h = mount([1000, 1000, 1000]);
    readHistory(h);
    const before = h.expectedOffset(1);

    h.setHeight(0, 700);
    restoreAnchor();

    expect(h.expectedOffset(1)).toBe(before);
    expect(h.writes).toEqual([SCROLL_TOP - 300]);
  });

  it('writes nothing when content is appended below the viewport', () => {
    const h = mount([1000, 1000, 1000]);
    readHistory(h);

    h.append(4000);
    restoreAnchor();

    expect(h.writes).toEqual([]);
  });

  it('skips one correction when the anchor is torn out, then recovers', () => {
    const h = mount([1000, 1000, 1000]);
    readHistory(h);

    h.remove(1);
    restoreAnchor();
    expect(h.writes).toEqual([]);

    const before = h.expectedOffset(2);
    h.setHeight(0, 1200);
    restoreAnchor();
    expect(h.expectedOffset(2)).toBe(before);
    expect(h.writes).toEqual([SCROLL_TOP + 200]);
  });

  it('re-anchors after each correction so drift cannot accumulate', () => {
    const h = mount([1000, 1000, 1000]);
    readHistory(h);
    const before = h.expectedOffset(1);

    h.setHeight(0, 1200);
    restoreAnchor();
    h.setHeight(0, 1500);
    restoreAnchor();

    expect(h.expectedOffset(1)).toBe(before);
    expect(h.writes).toEqual([SCROLL_TOP + 200, SCROLL_TOP + 500]);
  });

  it('re-anchors on a scroll that lands back inside the bottom zone', () => {
    // That scroll does NOT release no-scroll, so it is a position the reader
    // chose. An anchor still pointing at where they were would drag them back
    // there on the next reflow.
    const h = mount([1000, 1000, 1000]);
    readHistory(h);

    const nearEnd = 3000 - VIEWPORT_HEIGHT;
    h.scrollTo(nearEnd);
    expect(chatScrollStore.get()).toBe('no-scroll');
    const before = h.expectedOffset(2);

    h.setHeight(0, 1200);
    restoreAnchor();

    expect(h.expectedOffset(2)).toBe(before);
    expect(h.writes).toEqual([nearEnd + 200]);
  });

  it('does not anchor once the reader has pressed view latest', () => {
    // The anchor outlives the mode. Correcting after the release would fight
    // the follow it just handed the well back to.
    const h = mount([1000, 1000, 1000]);
    readHistory(h);
    pinToLatest();
    h.writes.length = 0;

    h.setHeight(0, 1200);
    restoreAnchor();

    expect(h.writes).toEqual([]);
  });

  it('takes no anchor from a scroller with no layout', () => {
    const h = mount([1000, 1000, 1000]);
    initChatScroll();
    h.setViewportHeight(0);
    h.scrollTo(SCROLL_TOP);

    h.setViewportHeight(VIEWPORT_HEIGHT);
    chatScrollStore.set('no-scroll');
    h.setHeight(0, 1200);
    restoreAnchor();

    expect(h.writes).toEqual([]);
  });

  it('does not anchor in view-latest, where following owns the position', () => {
    const h = mount([1000, 1000, 1000]);
    initChatScroll();

    h.setHeight(0, 1200);
    restoreAnchor();

    expect(h.writes).toEqual([]);
  });
});
