/**
 * Server Restarter
 * 
 * Spawned by server when graceful restart requested.
 * Polls until port is free, then starts new server.
 * Cross-platform: works on Windows, Mac, Linux.
 */

import { spawn } from 'child_process';
import { createConnection } from 'net';
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');

const PORT = 3000;
const POLL_INTERVAL = 500;  // ms
const MAX_WAIT = 30000;     // 30s timeout

/**
 * Check if port is in use
 */
function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);  // Port in use
    });
    
    socket.once('error', () => {
      resolve(false);  // Port free
    });
    
    // Timeout after 1s
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Wait for port to become free
 */
async function waitForPortFree(): Promise<boolean> {
  const start = Date.now();
  
  while (Date.now() - start < MAX_WAIT) {
    const inUse = await isPortInUse(PORT);
    if (!inUse) {
      console.log('[RESTARTER] Port is free');
      return true;
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
  
  console.error('[RESTARTER] Timeout waiting for port to free');
  return false;
}

/**
 * Start the server
 */
function startServer(): void {
  console.log('[RESTARTER] Starting server...');
  
  // Use npx tsx to run server.ts
  const child = spawn('npx', ['tsx', 'server.ts'], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: 'ignore',
    shell: true  // Required for Windows
  });
  
  // Write PID file so stop.sh works
  if (child.pid) {
    const pidFile = join(PROJECT_ROOT, 'server.pid');
    writeFileSync(pidFile, String(child.pid));
    console.log(`[RESTARTER] Server spawned with PID ${child.pid}`);
  } else {
    console.log('[RESTARTER] Server spawned (PID unknown)');
  }
  
  child.unref();
}

/**
 * Main
 */
async function main(): Promise<void> {
  console.log('[RESTARTER] Waiting for server to exit...');
  
  // Small delay to let the old server start exiting
  await new Promise(r => setTimeout(r, 500));
  
  const portFree = await waitForPortFree();
  
  if (portFree) {
    startServer();
  } else {
    console.error('[RESTARTER] Giving up - server did not exit');
  }
  
  process.exit(0);
}

main().catch(err => {
  console.error('[RESTARTER] Error:', err);
  process.exit(1);
});
