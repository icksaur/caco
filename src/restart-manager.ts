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
import { appendFileSync } from 'fs';
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

/** Reset state (for testing only). */
export function _resetForTest(): void {
  restartRequested = false;
  onAllIdleCallback = null;
  exitHandler = null;
  spawnHandler = null;
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
  } else {
    spawnServer();
  }

  // Defer exit to let event loop flush WebSocket buffers.
  // Without this, session.idle may not reach the client before
  // process.exit() tears down all connections.
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
    setTimeout(doExit, 250);
  }
}

function spawnServer(): void {
  log('Spawning new server...');
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env }
    });
    child.unref();
    log(`New server spawned with PID: ${child.pid}`);
  } catch (err) {
    log(`Failed to spawn server: ${err}`);
  }
}
