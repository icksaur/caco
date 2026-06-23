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
import { onEvent, onReconnect, wsSendRaw } from './websocket.js';
import { getActiveSessionId, onActiveSessionChange } from './app-state.js';
import { showToast } from './toast.js';
import type { SessionEvent } from './types.js';

interface TermEntry {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  exited: boolean;
}

const terms = new Map<string, TermEntry>();
let panelEl: HTMLDivElement | null = null;
let toggleBtn: HTMLButtonElement | null = null;
let open = false;

const LONG_PRESS_MS = 600;

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
  // subscription frame; defer the attach so it reaches the server after the
  // ws is subscribed to the new session (term ops are keyed by subscription).
  onActiveSessionChange(() => {
    if (open) setTimeout(() => attachActive(), 0);
  });
  onReconnect(() => {
    if (open) setTimeout(() => attachActive(), 0);
  });
}

function toggle(): void {
  if (!panelEl || !toggleBtn) return;
  open = !open;
  panelEl.classList.toggle('hidden', !open);
  toggleBtn.classList.toggle('active', open);
  if (open) revealActive();
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

/** Reveal the active session's terminal. Creates + attaches (with ring replay)
 *  on first use; for an already-live xterm it only re-shows it — NO reset — so a
 *  running program (vim, etc.) survives a hide/show toggle. An exited terminal is
 *  respawned. */
function revealActive(): void {
  const sid = getActiveSessionId();
  if (!sid || !panelEl) return;
  const entry = terms.get(sid);
  if (entry && !entry.exited) {
    showOnly(sid);
    fitAndResize(entry);
    entry.term.focus();
  } else {
    attachActive();
  }
}

/** Kill the server pty and respawn a fresh shell (long-press escape hatch). */
function restartTerminal(): void {
  const sid = getActiveSessionId();
  if (!sid) return;
  // Kill first; the subsequent attach (in-order on the same ws) respawns.
  wsSendRaw({ type: 'caco.term.kill', data: {} });
  const entry = terms.get(sid);
  if (entry) { entry.term.dispose(); entry.el.remove(); terms.delete(sid); }
  if (!open) {
    open = true;
    panelEl?.classList.remove('hidden');
    toggleBtn?.classList.add('active');
  }
  attachActive();
  terms.get(sid)?.term.focus();
  showToast('Terminal restarted', { type: 'info', autoHideMs: 1500 });
}

/** Create (if needed), reset, show, fit and (re-)attach the active terminal so
 *  the server replays its ring. Used for first open, session switch and
 *  reconnect — paths where the local xterm may be stale and needs a resync. */
function attachActive(): void {
  const sid = getActiveSessionId();
  if (!sid || !panelEl || !open) return;

  let entry = terms.get(sid);
  if (!entry) {
    const el = document.createElement('div');
    el.className = 'terminal-instance';
    panelEl.appendChild(el);
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
    // After the shell exits, the next keystroke respawns it (matches the
    // "press any key … to restart" hint); otherwise it's normal pty input.
    term.onData(d => {
      const cur = terms.get(sid);
      if (cur?.exited) { attachActive(); return; }
      wsSendRaw({ type: 'caco.term.input', data: { data: d } });
    });
    entry = { term, fit, el, exited: false };
    terms.set(sid, entry);
  }
  entry.exited = false;
  entry.term.reset();

  showOnly(sid);
  try {
    entry.fit.fit();
  } catch {
    /* element not yet measurable */
  }
  wsSendRaw({ type: 'caco.term.attach', data: { cols: entry.term.cols, rows: entry.term.rows } });
  entry.term.focus();
}

function fitActive(): void {
  const sid = getActiveSessionId();
  if (!sid) return;
  const entry = terms.get(sid);
  if (!entry) return;
  fitAndResize(entry);
}

function handleTermEvent(event: SessionEvent): void {
  if (event.type !== 'caco.term.output' && event.type !== 'caco.term.exit') return;
  const sid = getActiveSessionId();
  if (!sid) return;
  const entry = terms.get(sid);
  if (!entry) return;

  if (event.type === 'caco.term.output') {
    const data = (event.data as { data?: string } | undefined)?.data;
    if (typeof data === 'string') entry.term.write(data);
  } else {
    entry.exited = true;
    entry.term.write('\r\n\x1b[2m[process exited — press any key or toggle to restart]\x1b[0m\r\n');
  }
}
