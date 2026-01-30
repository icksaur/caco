/**
 * Graceful Restart Manager
 * 
 * Tracks active dispatches and handles graceful server restart.
 * When restart is requested via tool, waits for all sessions to be idle
 * before spawning restarter and exiting.
 */

import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let restartRequested = false;
let activeDispatches = 0;
let onAllIdleCallback: (() => void) | null = null;

/**
 * Request a graceful restart.
 * Server will restart when all active dispatches complete.
 */
export function requestRestart(): void {
  console.log('[RESTART] Restart requested');
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
  console.log(`[RESTART] Dispatch started, active: ${activeDispatches}`);
}

/**
 * Mark a dispatch as complete (decrement active count)
 * Triggers restart check if restart was requested.
 */
export function dispatchComplete(): void {
  activeDispatches = Math.max(0, activeDispatches - 1);
  console.log(`[RESTART] Dispatch complete, active: ${activeDispatches}`);
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
    console.log(`[RESTART] Waiting for ${activeDispatches} active dispatches`);
    return;
  }
  
  console.log('[RESTART] All dispatches complete, initiating restart');
  
  // Call cleanup callback if set
  if (onAllIdleCallback) {
    try {
      onAllIdleCallback();
    } catch (err) {
      console.error('[RESTART] Cleanup callback error:', err);
    }
  }
  
  // Spawn restarter
  spawnRestarter();
  
  // Exit gracefully
  console.log('[RESTART] Exiting for restart...');
  process.exit(0);
}

/**
 * Spawn the restarter process
 */
function spawnRestarter(): void {
  const restarterPath = join(__dirname, 'restarter.ts');
  
  console.log(`[RESTART] Spawning restarter: ${restarterPath}`);
  
  const child = spawn('npx', ['tsx', restarterPath], {
    cwd: join(__dirname, '..'),
    detached: true,
    stdio: 'ignore',
    shell: true  // Required for Windows
  });
  
  child.unref();
  console.log('[RESTART] Restarter spawned');
}
