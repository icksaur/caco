/**
 * Peer store — list of known Caco peers (other Caco instances on the LAN
 * or remote, used by the portal applet).
 *
 * Persisted as ~/.caco/peers.json. Small, infrequently mutated, no caching.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { STORAGE_ROOT, ensureDir } from './storage-paths.js';

const PEERS_FILE = join(STORAGE_ROOT, 'peers.json');

export interface CacoPeer {
  url: string;
  hostname: string;
}

export function getPeers(): CacoPeer[] {
  if (!existsSync(PEERS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(PEERS_FILE, 'utf-8')) as CacoPeer[];
  } catch {
    return [];
  }
}

export function setPeers(peers: CacoPeer[]): void {
  ensureDir(STORAGE_ROOT);
  writeFileSync(PEERS_FILE, JSON.stringify(peers, null, 2), 'utf-8');
}
