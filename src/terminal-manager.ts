/**
 * Terminal Manager
 *
 * One real user-identity pty per Caco session, spawned lazily on first attach in
 * the session's cwd and killed when the session ends. Output is delivered live to
 * the session's WebSocket subscribers via the event bus and captured in a bounded
 * ring buffer that is replayed (targeted) to a client on (re-)attach, so switching
 * sessions restores the terminal view.
 *
 * Lifetime = session lifetime. The pty is killed only on: session delete
 * (`onSessionEnd`), explicit `killTerminal`, pty self-exit, max-terminal cap
 * (LRU evict), or process exit. Panel/tab close is a detach, never a kill.
 *
 * Terminal output is NEVER persisted to SDK/session history — it flows only via
 * `broadcastEvent` (live) + the in-memory ring (replay).
 */

import { spawn, type IPty } from 'node-pty';
import { existsSync } from 'fs';
import { sessionManager } from './session-manager.js';
import { sessionState } from './session-state.js';
import { broadcastEvent } from './event-bus.js';
import { resolveShell, type ShellSpec } from './workflow/shell.js';

const RING_CAP_BYTES = 256 * 1024;
const MAX_TERMINALS = 16;
const OUTPUT_FLUSH_MS = 16;
const MAX_FRAME_BYTES = 64 * 1024;
const MIN_DIM = 1;
const MAX_DIM = 1000;

/** Bounded byte-capped FIFO of output chunks, replayed on attach. */
export class RingBuffer {
  private chunks: string[] = [];
  private bytes = 0;
  constructor(private readonly cap: number = RING_CAP_BYTES) {}

  push(s: string): void {
    if (!s) return;
    this.chunks.push(s);
    this.bytes += Buffer.byteLength(s);
    while (this.bytes > this.cap && this.chunks.length > 1) {
      const removed = this.chunks.shift()!;
      this.bytes -= Buffer.byteLength(removed);
    }
  }

  snapshot(): string {
    return this.chunks.join('');
  }
}

interface TerminalEntry {
  pty: IPty;
  ring: RingBuffer;
  attachCount: number;
  lastActivity: number;
  pendingOut: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
  exited: boolean;
}

const terminals = new Map<string, TerminalEntry>();
let lifecycleHooked = false;

/**
 * Interactive shell args for a pty (NOT the workflow's `-c`/`-Command` exec
 * flags). PowerShell launches with `-NoLogo`; bash/sh become interactive
 * automatically when stdin is a tty, so no args are needed.
 */
export function interactiveShellArgs(spec: ShellSpec): string[] {
  return spec.dialect === 'powershell' ? ['-NoLogo'] : [];
}

export interface InteractiveShell {
  file: string;
  args: string[];
}

/**
 * Shell for the interactive terminal. Honors the user's login shell ($SHELL,
 * e.g. fish/zsh) on POSIX so the terminal feels native — unlike the workflow
 * tool, which deliberately uses bash for predictable scripting. Falls back to
 * the workflow resolver (bash→sh; pwsh on Windows). Pure + injectable for tests.
 */
export function resolveInteractiveShell(opts: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists: (p: string) => boolean;
}): InteractiveShell {
  const { platform, env, exists } = opts;
  if (platform !== 'win32') {
    const login = env.SHELL;
    if (login && exists(login)) return { file: login, args: [] };
  }
  const spec = resolveShell({ platform, env, exists });
  return { file: spec.file, args: interactiveShellArgs(spec) };
}

function clampDim(n: number | undefined, fallback: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.min(MAX_DIM, Math.max(MIN_DIM, Math.floor(n)));
}

function cleanEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function flushOutput(sessionId: string, entry: TerminalEntry): void {
  if (entry.flushTimer) {
    clearTimeout(entry.flushTimer);
    entry.flushTimer = null;
  }
  if (!entry.pendingOut) return;
  const data = entry.pendingOut;
  entry.pendingOut = '';
  // Ring holds only already-broadcast bytes, so an attach snapshot never
  // overlaps with output still queued for live broadcast (no double-render).
  entry.ring.push(data);
  broadcastEvent(sessionId, { type: 'caco.term.output', data: { data } });
}

function onPtyData(sessionId: string, entry: TerminalEntry, d: string): void {
  entry.pendingOut += d;
  entry.lastActivity = Date.now();
  if (Buffer.byteLength(entry.pendingOut) >= MAX_FRAME_BYTES) {
    flushOutput(sessionId, entry);
    return;
  }
  if (!entry.flushTimer) {
    entry.flushTimer = setTimeout(() => flushOutput(sessionId, entry), OUTPUT_FLUSH_MS);
  }
}

function teardown(entry: TerminalEntry): void {
  if (entry.flushTimer) {
    clearTimeout(entry.flushTimer);
    entry.flushTimer = null;
  }
  try {
    entry.pty.kill();
  } catch {
    /* already gone */
  }
}

/** Evict least-recently-active terminals once the cap is exceeded. */
function enforceCap(): void {
  if (terminals.size <= MAX_TERMINALS) return;
  const ordered = [...terminals.entries()].sort((a, b) => a[1].lastActivity - b[1].lastActivity);
  for (const [sid, entry] of ordered) {
    if (terminals.size <= MAX_TERMINALS) break;
    teardown(entry);
    terminals.delete(sid);
  }
}

export type EnsureResult = { ring: string } | { error: string };

/**
 * Ensure a pty exists for the session and return its ring snapshot for replay.
 * Spawns lazily in the session's cwd on first attach (or after the prior pty
 * exited). The returned ring should be delivered ONLY to the attaching client.
 */
export function ensureTerminal(sessionId: string, cols: number, rows: number): EnsureResult {
  const existing = terminals.get(sessionId);
  if (existing && !existing.exited) {
    existing.attachCount++;
    existing.lastActivity = Date.now();
    // Honor the (re-)attaching client's fitted size so the pty winsize never
    // goes stale across session-swap / reconnect.
    try {
      existing.pty.resize(clampDim(cols, 80), clampDim(rows, 24));
    } catch {
      /* pty may be mid-exit */
    }
    return { ring: existing.ring.snapshot() };
  }
  if (existing) terminals.delete(sessionId);

  const cwd = sessionManager.getSessionCwd(sessionId);
  if (!cwd) return { error: 'no working directory for session' };

  const shell = resolveInteractiveShell({ platform: process.platform, env: process.env, exists: existsSync });

  let ptyProc: IPty;
  try {
    ptyProc = spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cols: clampDim(cols, 80),
      rows: clampDim(rows, 24),
      cwd,
      env: cleanEnv(),
    });
  } catch (err) {
    return { error: `failed to spawn shell: ${(err as Error).message}` };
  }

  const entry: TerminalEntry = {
    pty: ptyProc,
    ring: new RingBuffer(),
    attachCount: 1,
    lastActivity: Date.now(),
    pendingOut: '',
    flushTimer: null,
    exited: false,
  };
  terminals.set(sessionId, entry);

  ptyProc.onData(d => onPtyData(sessionId, entry, d));
  ptyProc.onExit(({ exitCode, signal }) => {
    entry.exited = true;
    flushOutput(sessionId, entry);
    if (entry.flushTimer) {
      clearTimeout(entry.flushTimer);
      entry.flushTimer = null;
    }
    terminals.delete(sessionId);
    broadcastEvent(sessionId, { type: 'caco.term.exit', data: { exitCode, signal } });
  });

  enforceCap();
  return { ring: '' };
}

/**
 * Decode a terminal-input frame for the pty. onData frames are UTF-8 text
 * (written as a string); onBinary frames (DA/DSR/report replies) are a Latin-1
 * byte string and must become raw bytes. Pure + exported for testing.
 */
export function decodeTerminalInput(data: string, binary: boolean): string | Buffer {
  return binary ? Buffer.from(data, 'binary') : data;
}

export function writeTerminalInput(sessionId: string, data: string, binary = false): void {
  const entry = terminals.get(sessionId);
  if (!entry || entry.exited) return;
  entry.pty.write(decodeTerminalInput(data, binary));
  entry.lastActivity = Date.now();
}

export function resizeTerminal(sessionId: string, cols: number, rows: number): void {
  const entry = terminals.get(sessionId);
  if (!entry || entry.exited) return;
  try {
    entry.pty.resize(clampDim(cols, 80), clampDim(rows, 24));
  } catch {
    /* pty may be mid-exit */
  }
}

/** Panel/tab close: decrement the attach count. Never kills the pty. */
export function detachTerminal(sessionId: string): void {
  const entry = terminals.get(sessionId);
  if (!entry) return;
  entry.attachCount = Math.max(0, entry.attachCount - 1);
  entry.lastActivity = Date.now();
}

/** Explicitly terminate a session's pty (process-group kill) and drop it. */
export function killTerminal(sessionId: string): void {
  const entry = terminals.get(sessionId);
  if (!entry) return;
  teardown(entry);
  terminals.delete(sessionId);
}

function killAllTerminals(): void {
  for (const entry of terminals.values()) teardown(entry);
  terminals.clear();
}

/** Test/observability hook. */
export function terminalCount(): number {
  return terminals.size;
}

/**
 * Wire session + process lifecycle. Idempotent; call once after the session
 * state singleton is created (e.g. alongside setupWebSocket).
 *
 * Only a non-suppressing `exit` hook is registered here — owning SIGINT/SIGTERM
 * would override the server's graceful-shutdown path. The server's SIGINT
 * handler calls `process.exit`, which fires `exit` and reaps the ptys.
 */
export function initTerminalManager(): void {
  if (lifecycleHooked) return;
  if (!sessionState) {
    throw new Error(
      'initTerminalManager() called before createSessionState(); it registers ' +
      'sessionState.onSessionEnd and must run after session state exists.',
    );
  }
  lifecycleHooked = true;
  sessionState.onSessionEnd(sessionId => killTerminal(sessionId));
  process.once('exit', killAllTerminals);
}
