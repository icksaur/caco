/**
 * Terminal Panel (client)
 *
 * A real user-identity terminal below the meta-context footer, bound to the
 * active Caco session. A footer glyph (`>_`) or Ctrl+` toggles a panel that
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
import type { SessionEvent } from './types.js';

interface TermEntry {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
}

const terms = new Map<string, TermEntry>();
let panelEl: HTMLDivElement | null = null;
let toggleBtn: HTMLButtonElement | null = null;
let open = false;

const TERM_THEME = {
  background: '#0c0d10',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
};

export function initTerminalPanel(): void {
  const footer = document.getElementById('contextFooter');
  const chatFooter = document.getElementById('chatFooter');
  if (!footer || !chatFooter) return;

  toggleBtn = document.createElement('button');
  toggleBtn.id = 'termToggle';
  toggleBtn.type = 'button';
  toggleBtn.className = 'term-toggle';
  toggleBtn.textContent = '>_';
  toggleBtn.title = 'Toggle terminal (Ctrl+`)';
  toggleBtn.addEventListener('click', () => toggle());
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
  if (open) {
    attachActive();
    const sid = getActiveSessionId();
    if (sid) terms.get(sid)?.term.focus();
  }
}

/** Ensure the active session's xterm exists, is the only one visible, fit it,
 *  reset it and (re-)attach so the server replays the ring. The reset makes the
 *  ring replay an exact reconstruction (no backlog duplication on reopen). */
function attachActive(): void {
  const sid = getActiveSessionId();
  if (!sid || !panelEl || !open) return;

  let entry = terms.get(sid);
  if (!entry) {
    const el = document.createElement('div');
    el.className = 'terminal-instance';
    panelEl.appendChild(el);
    const term = new Terminal({
      fontFamily: 'var(--font-mono, monospace)',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: TERM_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    term.onData(d => wsSendRaw({ type: 'caco.term.input', data: { data: d } }));
    entry = { term, fit, el };
    terms.set(sid, entry);
  }
  entry.term.reset();

  for (const [id, e] of terms) e.el.style.display = id === sid ? 'block' : 'none';

  try {
    entry.fit.fit();
  } catch {
    /* element not yet measurable */
  }
  wsSendRaw({ type: 'caco.term.attach', data: { cols: entry.term.cols, rows: entry.term.rows } });
}

function fitActive(): void {
  const sid = getActiveSessionId();
  if (!sid) return;
  const entry = terms.get(sid);
  if (!entry) return;
  try {
    entry.fit.fit();
  } catch {
    return;
  }
  wsSendRaw({ type: 'caco.term.resize', data: { cols: entry.term.cols, rows: entry.term.rows } });
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
    entry.term.write('\r\n\x1b[2m[process exited — press any key or re-open to restart]\x1b[0m\r\n');
  }
}
