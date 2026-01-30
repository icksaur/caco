/**
 * Server Restarter
 * 
 * Spawned by server when graceful restart requested.
 * Polls until port is free, then starts new server.
 * Cross-platform: works on Windows, Mac, Linux.
 */

import { spawn } from 'child_process';
import { createConnection } from 'net';
import { writeFileSync, appendFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { PORT } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');
const POLL_INTERVAL = 500;  // ms
const MAX_WAIT = 30000;     // 30s timeout
const LOG_FILE = join(PROJECT_ROOT, 'restart.log');

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] [RESTARTER] ${msg}\n`;
  console.log(`[RESTARTER] ${msg}`);
  try {
    appendFileSync(LOG_FILE, line);
  } catch {
    // Ignore write errors
  }
}

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
      log(`Port ${PORT} is free`);
      return true;
    }
    log(`Port ${PORT} still in use, waiting...`);
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
  
  log(`Timeout waiting for port ${PORT} to free`);
  return false;
}

/**
 * Start the server
 */
function startServer(): void {
  log('Starting server...');
  
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
    log(`Server spawned with PID ${child.pid}`);
  } else {
    log('Server spawned (PID unknown)');
  }
  
  child.unref();
}

/**
 * Main
 */
async function main(): Promise<void> {
  log('Restarter started, waiting for server to exit...');
  
  // Small delay to let the old server start exiting
  await new Promise(r => setTimeout(r, 500));
  
  const portFree = await waitForPortFree();
  
  if (portFree) {
    startServer();
  } else {
    log('Giving up - server did not exit');
  }
  
  log('Restarter exiting');
  process.exit(0);
}

main().catch(err => {
  log(`Error: ${err}`);
  process.exit(1);
});
