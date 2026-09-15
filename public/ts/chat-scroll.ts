/**
 * Owns the chat well's scroll position: whether it follows new content, and
 * where the reader is anchored while it does not.
 *
 * CONTRACT: this module is the only writer of `#chatScroll.scrollTop` and the
 * only caller of a scrolling API against it. Every other module asks for a
 * scroll through `followLatest` (advisory) or `pinToLatest` (imperative). A
 * direct write elsewhere reintroduces the bug this module exists to fix — the
 * render path moving the well out from under a reader — so
 * `tests/unit/chat-scroll-mode.test.ts` scans the source for one.
 *
 * CONTRACT: every deferred writer re-checks the mode. A timer, frame callback,
 * or observer must not act on an intent the reader has since superseded.
 */

/**
 * view-latest follows new content; no-scroll holds the reader's position.
 *
 * The transition is deliberately ASYMMETRIC: leaving the bottom zone enters
 * no-scroll, and only `pinToLatest` leaves it. Do NOT make scrolling back into
 * the zone release the mode. Position is not intent — content removal, a
 * viewport resize, clamping, and our own anchor corrections can all land the
 * well in the zone with no user action, and each would silently re-arm
 * following under someone reading.
 */
export type ChatScrollMode = 'view-latest' | 'no-scroll';

interface Internal {
  mode: ChatScrollMode;
  subscribers: Set<(mode: ChatScrollMode) => void>;
}

const internal: Internal = {
  mode: 'view-latest',
  subscribers: new Set(),
};

export const chatScrollStore = {
  get(): ChatScrollMode {
    return internal.mode;
  },

  /** No-op if the mode is unchanged, so subscribers are not spammed. */
  set(mode: ChatScrollMode): void {
    if (internal.mode === mode) return;
    internal.mode = mode;
    for (const fn of internal.subscribers) fn(mode);
  },

  subscribe(fn: (mode: ChatScrollMode) => void): () => void {
    internal.subscribers.add(fn);
    return () => { internal.subscribers.delete(fn); };
  },
};

function getScroller(): HTMLElement | null {
  return document.getElementById('chatScroll');
}

/**
 * How close to the end still counts as "following". Sized against the two
 * failure modes it sits between: too small and a sub-pixel rounding error in a
 * zoomed browser strands the reader out of view-latest until they press the
 * button; too large and a deliberate small scroll-up near the end is ignored.
 */
export const BOTTOM_ZONE_PX = 48;

function isInBottomZone(el: HTMLElement): boolean {
  return el.scrollHeight - el.clientHeight - el.scrollTop <= BOTTOM_ZONE_PX;
}

function onUserScroll(): void {
  const el = getScroller();
  if (!el) return;
  // A zero viewport is the absence of a reading, not a position at the end: a
  // collapsed or not-yet-laid-out scroller reports clientHeight 0, which
  // computes as "at the bottom" and would anchor on zeroed rects.
  if (el.clientHeight === 0) return;

  if (!isInBottomZone(el)) {
    // The reader has taken the well over, so a scroll still waiting on layout is
    // an obligation they have superseded. Dropping the timer here is not the same
    // guard as the retry's own mode re-check: that one covers a mode change this
    // listener never saw.
    cancelRetry(el);
    chatScrollStore.set('no-scroll');
  }

  // Re-anchor on EVERY scroll taken while held, including one that lands back
  // inside the bottom zone. That scroll does not release the mode, so an anchor
  // left at the old position would yank the reader back there on the next
  // reflow.
  if (internal.mode === 'no-scroll') captureAnchor();
}

/**
 * Where the reader is looking: a direct child of `#chat` and its offset from
 * the scroller's top edge.
 *
 * Granularity is deliberate. Every in-place rebuild in the render path rewrites
 * the DESCENDANTS of a reused element — `textContent` assignment while
 * streaming, `textContent = ''` on tool completion — so `#chat`'s direct
 * children survive them. That is what makes a held reference safe here and is
 * exactly what defeats the native mechanism, which anchors on a leaf.
 */
interface ViewportAnchor {
  element: HTMLElement;
  offset: number;
}

let anchor: ViewportAnchor | null = null;

function captureAnchor(): void {
  const scroller = getScroller();
  const chat = document.getElementById('chat');
  anchor = null;
  if (!scroller || !chat) return;

  const viewportTop = scroller.getBoundingClientRect().top;
  for (const child of Array.from(chat.children) as HTMLElement[]) {
    const rect = child.getBoundingClientRect();
    if (rect.bottom > viewportTop) {
      anchor = { element: child, offset: rect.top - viewportTop };
      return;
    }
  }
}

/**
 * Put the anchor back where the reader left it. The ResizeObserver callback,
 * and the only `scrollTop` write permitted in no-scroll.
 *
 * Runs after layout and before paint, so a correction is never seen. The common
 * case — content appended below the viewport — moves the anchor by nothing and
 * writes nothing.
 */
export function restoreAnchor(): void {
  if (internal.mode !== 'no-scroll') return;
  const scroller = getScroller();
  if (!scroller || !anchor) return;

  // A torn-out anchor reports a zeroed rect, which would be read as an enormous
  // correction. Costing one frame of drift is the only safe reading.
  if (!anchor.element.isConnected) { captureAnchor(); return; }

  const viewportTop = scroller.getBoundingClientRect().top;
  const delta = (anchor.element.getBoundingClientRect().top - viewportTop) - anchor.offset;
  if (delta !== 0) scroller.scrollTop += delta;
}

/**
 * Scroll the chat well to the end.
 *
 * The chat can have no layout at the moment this is called. On mobile the
 * session list owns the screen, so `.chat-panel` is `display: none` while it is
 * open. A hidden element reports `scrollHeight` 0 and discards writes to
 * `scrollTop`, so the scroll silently did nothing and the user landed at the top
 * of the conversation.
 *
 * So a scroll that cannot happen yet is retried until the element is laid out,
 * rather than reported as done. Three bounds on that retry:
 *
 *  - a deadline, so a chat that is never shown cannot leave a timer running for
 *    the life of the page;
 *  - the retry is abandoned the moment the user has taken the well over, because
 *    a delayed jump to the bottom under someone reading is worse than the
 *    staleness it fixes;
 *  - it is keyed to the element it was armed for, so a retry for one scroller
 *    cannot be cancelled by, or fight with, a call about another.
 */
const RETRY_INTERVAL_MS = 50;
const RETRY_LIMIT_MS = 2000;
const pendingRetries = new WeakMap<Element, ReturnType<typeof setTimeout>>();

function cancelRetry(el: Element): void {
  const t = pendingRetries.get(el);
  if (t !== undefined) { clearTimeout(t); pendingRetries.delete(el); }
}

function scrollToBottom(): void {
  const chatScroll = getScroller();
  if (!chatScroll) return;
  cancelRetry(chatScroll);

  const deadline = Date.now() + RETRY_LIMIT_MS;
  const attempt = (isRetry: boolean): void => {
    pendingRetries.delete(chatScroll);

    // A retry is an obligation the user can supersede by taking the well over
    // between the arming call and the timer. The caller's own call is an
    // explicit request for now and is not subject to this.
    if (isRetry && internal.mode === 'no-scroll') return;

    // Zero means "no layout yet", not "empty": an element with content but no
    // box reports 0 for both. Either way there is nothing to scroll, so treat it
    // as not-yet rather than done.
    if (chatScroll.scrollHeight > 0) {
      chatScroll.scrollTop = chatScroll.scrollHeight;
      return;
    }
    if (Date.now() >= deadline) return;
    pendingRetries.set(chatScroll, setTimeout(() => attempt(true), RETRY_INTERVAL_MS));
  };

  attempt(false);
}

/**
 * Advisory scroll, for content the stream produced.
 *
 * CONTRACT: in no-scroll the only permitted `scrollTop` write is an anchor
 * correction. Following, settling, and retrying are all withheld.
 */
export function followLatest(): void {
  if (internal.mode === 'no-scroll') return;
  scrollToBottom();
}

/**
 * Imperative scroll, for an act of the user or a view transition. Releases
 * no-scroll — this is the ONLY thing that does.
 */
export function pinToLatest(): void {
  chatScrollStore.set('view-latest');
  scrollToBottom();
}

/** Test-only: reset mode, subscribers, listeners, and any armed retry. */
export function _resetChatScrollForTests(): void {
  disposeChatScroll();
  internal.mode = 'view-latest';
  internal.subscribers.clear();
  anchor = null;
  const el = getScroller();
  if (el) cancelRetry(el);
}

let installed: (() => void) | null = null;

function disposeChatScroll(): void {
  installed?.();
  installed = null;
}

/**
 * Install the scroll listener. Idempotent — a second call is a no-op rather
 * than a second listener, so a re-entered startup path cannot double-count a
 * user's scroll. Returns a disposer.
 */
export function initChatScroll(): () => void {
  if (installed) return disposeChatScroll;

  const scroller = getScroller();
  if (!scroller) return () => {};

  scroller.addEventListener('scroll', onUserScroll, { passive: true });

  // Observing #chat rather than wrapping the render sites catches the
  // asynchronous ones too — Mermaid, syntax highlighting, image loads — none of
  // which are reachable from the event that caused them.
  const chat = document.getElementById('chat');
  const observer = chat && typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => restoreAnchor())
    : null;
  observer?.observe(chat!);

  // CONTRACT: this subscriber is the ONLY thing that may show or hide the
  // button. Entering no-scroll without it appearing would strand the reader
  // with no way back, so visibility is derived, never remembered — including
  // the sync below, which keeps markup that ships hidden from disagreeing with
  // an already-set mode.
  const button = document.getElementById('viewLatestBtn');
  const applyMode = (mode: ChatScrollMode): void => {
    button?.classList.toggle('hidden', mode === 'view-latest');
  };
  const unsubscribe = chatScrollStore.subscribe(applyMode);
  applyMode(internal.mode);

  button?.addEventListener('click', pinToLatest);

  installed = () => {
    scroller.removeEventListener('scroll', onUserScroll);
    observer?.disconnect();
    unsubscribe();
    button?.removeEventListener('click', pinToLatest);
  };
  return disposeChatScroll;
}