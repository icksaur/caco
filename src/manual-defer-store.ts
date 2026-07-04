/**
 * Manual per-server defer preference (spec-tool-reveal Phase D).
 *
 * A system-wide, persisted set of MCP server names the OPERATOR has chosen to defer
 * (hide all their tools from every turn) via the mcp-servers applet. Distinct from
 * Phase-C auto-defer (usage-driven, cold-only): this is a deliberate override that also
 * applies to WARM sessions (the applet tooltip warns of the one-time cache-bust).
 *
 * Stores server NAMES, not keys — the actual model-facing exclusion keys are resolved
 * from the persisted tool-key-registry (`keysForServer`) at apply/seed time, so a
 * deferred server automatically covers any of its tools whose keys are already known,
 * with no active-session dependency.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

const STORE_FILE = join(homedir(), '.caco', 'manual-defer.json');

const deferred = new Set<string>();
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const arr = JSON.parse(readFileSync(STORE_FILE, 'utf-8')) as string[];
    if (Array.isArray(arr)) for (const s of arr) deferred.add(s);
  } catch {
    // No file yet — start empty.
  }
}

function persist(): void {
  mkdirSync(dirname(STORE_FILE), { recursive: true });
  writeFileSync(STORE_FILE, JSON.stringify([...deferred]), 'utf-8');
}

/** Whether the operator has manually deferred this MCP server. */
export function isServerDeferred(serverName: string): boolean {
  ensureLoaded();
  return deferred.has(serverName);
}

/**
 * Set/clear the manual-defer preference for a server. Persists on change.
 * Throws (and reverts the in-memory change) if the write fails, so the caller
 * never applies a defer live / reports success while the system-wide preference
 * is not actually on disk — future sessions must be able to pick it up via seed.
 */
export function setServerDeferred(serverName: string, value: boolean): void {
  ensureLoaded();
  const has = deferred.has(serverName);
  if (value === has) return;
  if (value) deferred.add(serverName); else deferred.delete(serverName);
  try {
    persist();
  } catch (e) {
    if (value) deferred.delete(serverName); else deferred.add(serverName);
    throw e;
  }
}

/** All manually-deferred server names. */
export function getDeferredServers(): string[] {
  ensureLoaded();
  return [...deferred];
}

/** Test-only: clear in-memory state + force reload. */
export function _resetManualDeferForTest(): void {
  deferred.clear();
  loaded = false;
}
