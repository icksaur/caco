/**
 * Graceful Restart Manager
 *
 * Watches dispatchState for active sessions and handles graceful server restart.
 * When restart is requested via tool, waits for all sessions to be idle before
 * spawning the replacement server and exiting.
 *
 * Active dispatch tracking lives in dispatchState (single source of truth);
 * this module only listens for its 'idle' event to drive the restart check.
 */

import { spawn } from 'child_process';
import { appendFileSync, openSync, statSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { dispatchState } from './dispatch-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');
const LOG_FILE = join(PROJECT_ROOT, 'restart.log');

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  console.log(`[RESTART] ${msg}`);
  try {
    appendFileSync(LOG_FILE, line);
  } catch {
    // Ignore write errors
  }
}

let restartRequested = false;
let onAllIdleCallback: (() => void) | null = null;
let idleListenerInstalled = false;

// Test hooks
let exitHandler: (() => void) | null = null;
let spawnHandler: (() => void) | null = null;

// Injected predicate (spec-idle-suppression-central): whether ANY session is about
// to auto-continue. requestRestart()/checkAndRestart() run an IMMEDIATE check that
// bypasses dispatchState's idle emit, so the central idle suppressor can't protect
// them; this gate defers the restart while a reveal-continuation is pending. Null
// until wired (treated as "none pending").
let anyPendingAutoContinue: (() => boolean) | null = null;

/** Wire the pending-auto-continue predicate (once, at startup). */
export function setAnyPendingProvider(fn: () => boolean): void {
  anyPendingAutoContinue = fn;
}

/** Reset state (for testing only). */
export function _resetForTest(): void {
  restartRequested = false;
  onAllIdleCallback = null;
  exitHandler = null;
  spawnHandler = null;
  anyPendingAutoContinue = null;
  if (idleListenerInstalled) {
    dispatchState.removeAllListeners('idle');
    idleListenerInstalled = false;
  }
}

/** Set custom handlers for testing (avoids process.exit and spawn). */
export function _setTestHandlers(handlers: { onExit?: () => void; onSpawn?: () => void }): void {
  exitHandler = handlers.onExit ?? null;
  spawnHandler = handlers.onSpawn ?? null;
}

/**
 * Whether this process should spawn its own replacement on restart.
 *
 * Standalone: yes — nothing else will bring the server back.
 *
 * Under systemd: NO. The replacement would land in the same cgroup, and when
 * this process then exits, a Type=forking unit treats that as the service
 * stopping: it runs ExecStop and, with the default KillMode=control-group,
 * kills whatever is left in the cgroup — including the replacement, which needs
 * 7-11s to boot and has not yet bound the port. Observed three times on
 * 2026-08-03; each left the machine with NO server, and because ExecStop
 * succeeded the unit reported success, so Restart=on-failure never fired.
 *
 * So under a service manager we exit and let it start a fresh unit. This
 * REQUIRES `Restart=always` in the unit — `on-failure` will not act on our
 * clean exit.
 *
 * `INVOCATION_ID` is systemd's per-unit marker on every process it manages.
 * `JOURNAL_STREAM` is deliberately not used: it only means output is captured
 * by journald, which an unsupervised process can inherit too.
 */
export function shouldSpawnReplacement(env: NodeJS.ProcessEnv): boolean {
  return !env.INVOCATION_ID;
}

function ensureIdleListener(): void {
  if (idleListenerInstalled) return;
  dispatchState.on('idle', () => {
    log(`Dispatch complete, active: ${dispatchState.getActiveCount()}`);
    checkAndRestart();
  });
  idleListenerInstalled = true;
}

/** Request a graceful restart. Server will restart when all dispatches complete. */
export function requestRestart(): void {
  log('Restart requested');
  restartRequested = true;
  ensureIdleListener();
  checkAndRestart();
}

export function isRestartRequested(): boolean {
  return restartRequested;
}

/** Number of sessions currently dispatching (a passthrough to dispatchState). */
export function getActiveDispatches(): number {
  return dispatchState.getActiveCount();
}

/** Set a callback to run when all dispatches are idle. Used for cleanup before restart. */
export function onAllIdle(callback: () => void): void {
  onAllIdleCallback = callback;
}

function checkAndRestart(): void {
  if (!restartRequested) return;
  const active = dispatchState.getActiveCount();
  if (active > 0) {
    log(`Waiting for ${active} active dispatches`);
    return;
  }
  // Defer while a reveal-continuation is pending: getActiveCount() can be 0 in the
  // window between a reveal-dispatch's end() and its continuation's start(), so
  // without this gate the immediate check would restart mid-continuation
  // (spec-idle-suppression-central). The continuation's own end() re-fires 'idle',
  // re-running this check.
  if (anyPendingAutoContinue?.()) {
    log('Waiting for pending auto-continue before restart');
    return;
  }

  log('All dispatches complete, initiating restart');

  if (onAllIdleCallback) {
    try {
      onAllIdleCallback();
    } catch (err) {
      log(`Cleanup callback error: ${err}`);
    }
  }

  if (spawnHandler) {
    spawnHandler();
  } else if (shouldSpawnReplacement(process.env)) {
    spawnServer();
  } else {
    log('Managed by systemd — exiting so the service manager starts the replacement (needs Restart=always)');
  }

  // Defer exit to let the event loop flush WebSocket buffers AND, on the
  // self-spawn path, to keep this process alive long enough for spawnServer's
  // early-exit listener to log a silent child crash to restart.log. 1s is a
  // tradeoff: most loader/import crashes fire within ~100ms; longer waits delay
  // the user's UI reconnect. If a child takes >1s to die we miss the trace —
  // accept that until we wire a proper child→parent "ready" signal. Under a
  // service manager there is no child to watch, so the delay only covers the
  // buffer flush.
  const doExit = () => {
    log('Exiting for restart...');
    if (exitHandler) {
      exitHandler();
    } else {
      process.exit(0);
    }
  };

  if (exitHandler) {
    doExit(); // Tests run synchronously
  } else {
    setTimeout(doExit, 1000);
  }
}

function spawnServer(): void {
  log('Spawning new server...');
  try {
    // Capture child startup output to a side-log so silent crashes (port
    // collisions, tsx loader errors, EADDRINUSE after retry) leave a trace.
    // The main server.log is held open by the parent process / shell redirect
    // on some platforms, so we use a distinct file.
    let outFd: number | 'ignore' = 'ignore';
    try {
      // Size-based rotation: this log appends on every restart and
      // would otherwise grow unbounded. At 5 MB, roll to
      // restart-spawn.log.1 (one generation kept) before reopening.
      const spawnLogPath = join(PROJECT_ROOT, 'restart-spawn.log');
      try {
        if (statSync(spawnLogPath).size > 5 * 1024 * 1024) {
          renameSync(spawnLogPath, join(PROJECT_ROOT, 'restart-spawn.log.1'));
        }
      } catch { /* no existing file or rotate failed — proceed */ }
      outFd = openSync(spawnLogPath, 'a');
    } catch (err) {
      log(`openSync(restart-spawn.log) failed; child stdio will be discarded: ${(err as Error).message}`);
    }

    const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: ['ignore', outFd, outFd],
      windowsHide: true,
      env: { ...process.env }
    });

    // Diagnostic: don't unref immediately. Briefly listen for early death so
    // a silent crash leaves a trace in restart.log (not just restart-spawn.log,
    // which only sees output the child managed to emit before dying). This
    // caught a real failure on 2026-05-31 where PID 543311 died with no log
    // output and we had nothing to debug.
    let earlyExitLogged = false;
    const earlyExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (earlyExitLogged) return;
      earlyExitLogged = true;
      log(`Spawned child PID ${child.pid} exited early: code=${code} signal=${signal}`);
    };
    const earlyError = (err: Error) => {
      if (earlyExitLogged) return;
      earlyExitLogged = true;
      log(`Spawned child PID ${child.pid} emitted error: ${err.message}`);
    };
    child.once('exit', earlyExit);
    child.once('error', earlyError);

    // Detach after a short watch window matching the parent's 1s exit delay.
    // .unref() on the timer so it doesn't itself hold the event loop open.
    setTimeout(() => {
      child.removeListener('exit', earlyExit);
      child.removeListener('error', earlyError);
      child.unref();
    }, 1000).unref();

    log(`New server spawned with PID: ${child.pid}`);
  } catch (err) {
    log(`Failed to spawn server: ${err}`);
  }
}
