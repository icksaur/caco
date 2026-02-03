/**
 * Graceful Restart Manager
 * 
 * Tracks active dispatches and handles graceful server restart.
 * When restart is requested via tool, waits for all sessions to be idle
 * before spawning restarter and exiting.
 */

import { spawn } from 'child_process';
import { appendFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

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
let activeDispatches = 0;
let onAllIdleCallback: (() => void) | null = null;

/**
 * Request a graceful restart.
 * Server will restart when all active dispatches complete.
 */
export function requestRestart(): void {
  log('Restart requested');
  restartRequested = true;
  checkAndRestart();
}

/**
 * Check if restart has been requested
 */
export function isRestartRequested(): boolean {
  return restartRequested;
}

/**
 * Mark a dispatch as started (increment active count)
 */
export function dispatchStarted(): void {
  activeDispatches++;
  log(`Dispatch started, active: ${activeDispatches}`);
}

/**
 * Mark a dispatch as complete (decrement active count)
 * Triggers restart check if restart was requested.
 */
export function dispatchComplete(): void {
  activeDispatches = Math.max(0, activeDispatches - 1);
  log(`Dispatch complete, active: ${activeDispatches}`);
  checkAndRestart();
}

/**
 * Get current active dispatch count
 */
export function getActiveDispatches(): number {
  return activeDispatches;
}

/**
 * Set callback for when all dispatches are idle
 * Used for cleanup before restart
 */
export function onAllIdle(callback: () => void): void {
  onAllIdleCallback = callback;
}

/**
 * Check if we should restart and do so
 */
function checkAndRestart(): void {
  if (!restartRequested) return;
  if (activeDispatches > 0) {
    log(`Waiting for ${activeDispatches} active dispatches`);
    return;
  }
  
  log('All dispatches complete, initiating restart');
  
  // Call cleanup callback if set
  if (onAllIdleCallback) {
    try {
      onAllIdleCallback();
    } catch (err) {
      log(`Cleanup callback error: ${err}`);
    }
  }
  
  // Spawn restarter
  spawnRestarter();
  
  // Exit gracefully
  log('Exiting for restart...');
  process.exit(0);
}

/**
 * Spawn the new server process directly (no restarter needed)
 * Server has retry logic for port binding.
 */
function spawnRestarter(): void {
  log('Spawning new server...');
  
  // Spawn server directly - it will retry binding until port is free
  const child = spawn('node', ['--import', 'tsx', 'server.ts'], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  
  child.unref();
  log(`New server spawned with PID: ${child.pid}`);
}
