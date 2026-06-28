/**
 * Terminal Panel (client)
 *
 * A real user-identity terminal below the meta-context footer, bound to the
 * active Caco session. A footer glyph (`>`) or Ctrl+` toggles a panel that
 * renders an xterm.js terminal for the active session. One xterm per session;
 * switching sessions swaps the visible terminal. On (re-)attach the client
 * resets the xterm and the server replays its ring buffer, so returning to a
 * session restores its recent output.
 *
 * Protocol over the existing /ws (session resolved server-side from the ws
 * subscription, never the payload):
 *   client → caco.term.attach { cols, rows } | input { data } | resize { cols, rows }
 *          | detach {} | kill {}
 *   server → caco.term.output { data } | caco.term.exit { exitCode?, signal? }
 */

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { CanvasAddon } from '@xterm/addon-canvas';
import { onEvent, onReconnect, wsSendRaw } from './websocket.js';
import { getActiveSessionId, onActiveSessionChange } from './app-state.js';
import { showToast } from './toast.js';
import { selectEvictions } from './terminal-lru.js';
import type { SessionEvent } from './types.js';

interface TermEntry {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  /** A live server pty is attached. False = idle/exited/never-started: showing a
   *  placeholder, where a keypress or explicit toggle spawns a real shell. */
  live: boolean;
}

const terms = new Map<string, TermEntry>();
let panelEl: HTMLDivElement | null = null;
let resizerEl: HTMLDivElement | null = null;
let toggleBtn: HTMLButtonElement | null = null;
let open = false;

const LONG_PRESS_MS = 600;
const MIN_TERM_HEIGHT = 120;
const TERM_HEIGHT_KEY = 'caco:terminalPanelHeight';

/** Max live client-side xterms. Each carries a canvas renderer + scrollback +
 *  xterm-internal listeners, so an unbounded set leaks as you browse sessions.
 *  Keep the active session plus the two most-recently-used; evict the rest. The
 *  server pty is untouched (capped separately), so an evicted session re-attaches
 *  and ring-replays on revisit. */
const MAX_TERMS = 3;

const TERM_THEME = {
  background: '#0c0d10',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
};

/**
 * Resolve the real --font-mono stack for xterm. xterm renders to canvas and
 * cannot interpret CSS var(), so we read the computed custom property and pass
 * the literal stack. Falls back to a Consolas-first stack (good on Windows) if
 * the variable is unset or unreadable.
 */
function resolveMonoFont(): string {
  const fallback = "'Consolas', 'Monaco', 'Courier New', monospace";
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

export function initTerminalPanel(): void {
  const footer = document.getElementById('contextFooter');
  const chatFooter = document.getElementById('chatFooter');
  if (!footer || !chatFooter) return;

  toggleBtn = document.createElement('button');
  toggleBtn.id = 'termToggle';
  toggleBtn.type = 'button';
  toggleBtn.className = 'term-toggle';
  toggleBtn.textContent = '>';
  toggleBtn.title = 'Toggle terminal (Ctrl+`) — long-press to restart';

  // Long-press = kill + respawn the pty (escape hatch for a wedged shell). A
  // long-press suppresses the click so it doesn't also toggle.
  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let longPressed = false;
  const cancelPress = () => { if (pressTimer !== null) { clearTimeout(pressTimer); pressTimer = null; } };
  toggleBtn.addEventListener('pointerdown', () => {
    longPressed = false;
    pressTimer = setTimeout(() => { longPressed = true; restartTerminal(); }, LONG_PRESS_MS);
  });
  toggleBtn.addEventListener('pointerup', cancelPress);
  toggleBtn.addEventListener('pointerleave', cancelPress);
  toggleBtn.addEventListener('click', e => {
    if (longPressed) { longPressed = false; e.preventDefault(); return; }
    toggle();
  });
  footer.appendChild(toggleBtn);

  panelEl = document.createElement('div');
  panelEl.id = 'terminalPanel';
  panelEl.className = 'terminal-panel hidden';

  // Top-edge vertical resize bar (blue on hover/drag, like the session/applet
  // panel resizers but row-resize). Sits directly above the panel; visible only
  // while the panel is open. Created dynamically and held by reference, so the
  // drag logic lives here rather than the width-only, id-bound panel-resizer.
  resizerEl = document.createElement('div');
  resizerEl.id = 'terminalResizer';
  resizerEl.className = 'terminal-resizer hidden';
  setupTerminalResize(resizerEl);

  const savedHeight = localStorage.getItem(TERM_HEIGHT_KEY);
  if (savedHeight) applyTermHeight(parseInt(savedHeight, 10));

  chatFooter.appendChild(resizerEl);
  chatFooter.appendChild(panelEl);

  document.addEventListener('keydown', e => {
    if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key === '`') {
      e.preventDefault();
      toggle();
    }
  });

  window.addEventListener('resize', () => {
    if (open) fitActive();
  });

  onEvent(handleTermEvent);
  // setActiveSession fires this BEFORE subscribeToSession sends the new
  // subscription frame; defer so the attach reaches the server after the ws is
  // subscribed to the new session (term ops are keyed by subscription). Session
  // switch + reconnect are PASSIVE: continue an existing pty, but never spawn —
  // browsing sessions must not start shells.
  onActiveSessionChange(() => {
    if (open) setTimeout(() => revealActive(), 0);
  });
  onReconnect(() => {
    if (open) setTimeout(() => revealActive(), 0);
  });
}

function toggle(): void {
  if (!panelEl || !toggleBtn) return;
  setPanelChrome(!open);
  // Expanding the panel is an EXPLICIT action: start or continue the shell.
  if (open) startTerminal();
}

/** Single owner of the panel's open/closed visual state so the panel, its resize
 *  bar, and the toggle glyph can never desync (toggle + restart both route here). */
function setPanelChrome(next: boolean): void {
  open = next;
  panelEl?.classList.toggle('hidden', !open);
  resizerEl?.classList.toggle('hidden', !open);
  toggleBtn?.classList.toggle('active', open);
}

/** Clamp a desired panel height to [MIN_TERM_HEIGHT, 80vh] and apply it. Used by
 *  the drag and the boot-time restore (a height saved on a taller display must not
 *  exceed a now-smaller viewport). */
function applyTermHeight(px: number): void {
  if (!panelEl || !Number.isFinite(px)) return;
  const max = window.innerHeight * 0.8;
  panelEl.style.height = `${Math.min(max, Math.max(MIN_TERM_HEIGHT, px))}px`;
}

/** Wire the top-edge bar to drag the panel height. Mirrors panel-resizer.ts but
 *  vertical: dragging up grows the panel. Refits the active xterm (rAF-throttled)
 *  during the drag and on release so the pty winsize tracks the new viewport. */
function setupTerminalResize(resizer: HTMLDivElement): void {
  let startY = 0;
  let startHeight = 0;
  let rafPending = false;

  const refit = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; fitActive(); });
  };

  const onMove = (e: MouseEvent) => {
    if (!panelEl) return;
    applyTermHeight(startHeight + (startY - e.clientY)); // drag up => taller
    refit();
  };

  const onUp = () => {
    resizer.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if (panelEl) localStorage.setItem(TERM_HEIGHT_KEY, panelEl.style.height);
    fitActive();
  };

  resizer.addEventListener('mousedown', (e) => {
    if (!panelEl) return;
    e.preventDefault();
    startY = e.clientY;
    startHeight = panelEl.getBoundingClientRect().height;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function showOnly(sid: string): void {
  for (const [id, e] of terms) e.el.style.display = id === sid ? 'block' : 'none';
}

function fitAndResize(entry: TermEntry): void {
  try {
    entry.fit.fit();
  } catch {
    return;
  }
  wsSendRaw({ type: 'caco.term.resize', data: { cols: entry.term.cols, rows: entry.term.rows } });
}

/** Create the xterm + wire IO for a session (once). The entry starts not-live;
 *  it goes live only when the server confirms a pty (caco.term.live). */
function ensureEntry(sid: string): TermEntry {
  let entry = terms.get(sid);
  if (entry) return entry;

  const el = document.createElement('div');
  el.className = 'terminal-instance';
  panelEl!.appendChild(el);
  const term = new Terminal({
    // xterm renders to canvas and does NOT resolve CSS var(); passing
    // 'var(--font-mono)' silently falls back to the browser's generic
    // monospace (Courier New on Windows — squat/narrow). Resolve the real
    // stack from the CSS variable so Windows gets Consolas like the rest of
    // the UI, with a literal fallback if the var is unset.
    fontFamily: resolveMonoFont(),
    fontSize: 14,
    // 1.0 (not 1.25): the Copilot CLI mascot is drawn with block/box-art
    // glyphs that tile edge-to-edge; extra line-height inserts vertical gaps
    // that break the art's continuity (looks misaligned). Terminals like
    // Windows Terminal render this art at line-height ~1.0.
    lineHeight: 1.0,
    cursorBlink: true,
    scrollback: 5000,
    theme: TERM_THEME,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);
  // Canvas renderer instead of the default DOM renderer: the DOM renderer
  // fails to repaint draw-then-idle full-screen apps (vim, Copilot CLI) after
  // their first frame, while continuously-redrawing apps (htop, micro) mask
  // it. Canvas is a separate render path and works on the iOS Safari target
  // (unlike WebGL, which suffers context loss there). Load after open().
  try {
    term.loadAddon(new CanvasAddon());
  } catch {
    /* canvas unsupported — fall back to the DOM renderer */
  }
  // While not live (idle/exited placeholder), the next keystroke is an EXPLICIT
  // request to start a shell — spawn rather than forwarding the key. When live,
  // forward keystrokes to the pty.
  term.onData(d => {
    const cur = terms.get(sid);
    if (!cur?.live) { startTerminal(); return; }
    wsSendRaw({ type: 'caco.term.input', data: { data: d } });
  });
  // Terminal report replies (DA/DSR/cursor-position) are emitted on onBinary
  // (Latin-1 byte string), NOT onData. Full-screen TUIs (vim, the Copilot CLI)
  // and fish block waiting for these, so they MUST be forwarded to the pty as
  // raw bytes — flagged so the server writes them with Buffer.from(d,'binary').
  term.onBinary(d => {
    const cur = terms.get(sid);
    if (!cur?.live) return;
    wsSendRaw({ type: 'caco.term.input', data: { data: d, binary: true } });
  });
  entry = { term, fit, el, live: false };
  terms.set(sid, entry);
  return entry;
}

/** Dispose a session's client-side xterm (canvas renderer, scrollback, internal
 *  listeners) and drop it. The server pty is NOT affected — it persists until
 *  session end / cap / kill / exit, so revisiting re-attaches and ring-replays.
 *  No detach is sent: the ws is subscribed only to the active session, and the
 *  server's attachCount doesn't gate teardown. */
function disposeEntry(sid: string): void {
  const entry = terms.get(sid);
  if (!entry) return;
  try { entry.term.dispose(); } catch { /* already disposed */ }
  entry.el.remove();
  terms.delete(sid);
}

/** Move a session to most-recently-used (end of the Map's insertion order). */
function touch(sid: string): void {
  const entry = terms.get(sid);
  if (!entry) return;
  terms.delete(sid);
  terms.set(sid, entry);
}

/** Pure LRU eviction policy lives in ./terminal-lru (dependency-free, unit-tested). */

/** Evict least-recently-used client xterms beyond MAX_TERMS, never the active. */
function evictExcess(activeSid: string): void {
  for (const sid of selectEvictions([...terms.keys()], activeSid, MAX_TERMS)) {
    disposeEntry(sid);
  }
}

/** Send an attach for the active session. `spawn` true = explicit (start or
 *  continue); false = passive (continue an existing pty, else go idle). */
function sendAttach(spawn: boolean): void {
  const sid = getActiveSessionId();
  if (!sid || !panelEl || !open) return;
  const entry = ensureEntry(sid);
  touch(sid);
  evictExcess(sid);
  entry.term.reset();
  showOnly(sid);
  try {
    entry.fit.fit();
  } catch {
    /* element not yet measurable */
  }
  wsSendRaw({ type: 'caco.term.attach', data: { cols: entry.term.cols, rows: entry.term.rows, spawn } });
  entry.term.focus();
}

/** Explicit start/continue (toggle open, keypress on idle, restart). Spawns. */
function startTerminal(): void {
  sendAttach(true);
}

/** Passive reveal (session switch, reconnect). Continues an existing pty but
 *  never spawns — browsing sessions must not start shells. */
function revealActive(): void {
  sendAttach(false);
}

/** Kill the server pty and respawn a fresh shell (long-press escape hatch). */
function restartTerminal(): void {
  const sid = getActiveSessionId();
  if (!sid) return;
  // Kill first; the subsequent attach (in-order on the same ws) respawns.
  wsSendRaw({ type: 'caco.term.kill', data: {} });
  disposeEntry(sid);
  if (!open) setPanelChrome(true);
  startTerminal();
  showToast('Terminal restarted', { type: 'info', autoHideMs: 1500 });
}

function fitActive(): void {
  const sid = getActiveSessionId();
  if (!sid) return;
  const entry = terms.get(sid);
  if (!entry) return;
  fitAndResize(entry);
}

function handleTermEvent(event: SessionEvent): void {
  if (!event.type.startsWith('caco.term.')) return;
  const sid = getActiveSessionId();
  if (!sid) return;
  const entry = terms.get(sid);
  if (!entry) return;

  switch (event.type) {
    case 'caco.term.live': {
      // Server confirmed a pty; render the ring replay (may be empty for a
      // freshly spawned shell — its prompt arrives as live output next).
      entry.live = true;
      const ring = (event.data as { ring?: string } | undefined)?.ring;
      if (ring) entry.term.write(ring);
      break;
    }
    case 'caco.term.idle':
      // No pty exists and we didn't ask to spawn (passive attach). Show the
      // placeholder; a keypress or toggle will start a shell.
      entry.live = false;
      entry.term.write('\x1b[2m[terminal idle — press any key or toggle to start]\x1b[0m');
      break;
    case 'caco.term.output': {
      // Live output. (Another tab may have spawned this session's pty; if so,
      // adopt live state so our keystrokes flow.)
      entry.live = true;
      const data = (event.data as { data?: string } | undefined)?.data;
      if (typeof data === 'string') entry.term.write(data);
      break;
    }
    case 'caco.term.exit':
      entry.live = false;
      entry.term.write('\r\n\x1b[2m[process exited — press any key or toggle to restart]\x1b[0m\r\n');
      break;
  }
}
