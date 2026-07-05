/**
 * System-wide auto-defer LATCH (spec-auto-defer-latch).
 *
 * A persisted `Set<ToolKey>` of tools that have been auto-deferred because they went
 * stale (unused past the staleness threshold) at a cache-free seam. Distinct from the
 * usage store: the usage store is a live recency signal that ages in BOTH directions;
 * this latch is one-way. Staleness ADDS a key (SET); only an operator manual un-defer
 * REMOVES one (CLEAR). A fresh usage stamp never shrinks the latch, so a rare tool used
 * by one session does not silently re-enable it for every other session.
 *
 * Keyed by the model-facing `ToolKey` — the SAME key space as `excludedTools`, the
 * manual-defer store's resolved keys, and the usage store.
 *
 * Persistence is best-effort: a failed write logs and continues (a lost entry only
 * means a tool shows enabled until it goes stale again). It must never throw into the
 * session create/resume path it feeds.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import type { ToolKey } from './tool-key.js';

const STORE_FILE = join(homedir(), '.caco', 'auto-defer.json');

const latched = new Set<ToolKey>();
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const arr = JSON.parse(readFileSync(STORE_FILE, 'utf-8')) as string[];
    if (Array.isArray(arr)) for (const k of arr) latched.add(k as ToolKey);
  } catch {
    // No file yet — start empty.
  }
}

function persist(): void {
  try {
    mkdirSync(dirname(STORE_FILE), { recursive: true });
    writeFileSync(STORE_FILE, JSON.stringify([...latched]), 'utf-8');
  } catch (e) {
    // Fed from session create/resume — log loudly but never throw into setup.
    console.error('[TOOLS] auto-defer-store persist failed:', e instanceof Error ? e.message : e);
  }
}

/** The current auto-deferred latch (read-only view). */
export function getAutoDeferred(): ReadonlySet<ToolKey> {
  ensureLoaded();
  return latched;
}

/** Latch keys into the auto-defer set (union, add-only). Persists only on change. */
export function addAutoDeferred(keys: Iterable<ToolKey>): void {
  ensureLoaded();
  let changed = false;
  for (const k of keys) if (!latched.has(k)) { latched.add(k); changed = true; }
  if (changed) persist();
}

/** Clear keys from the latch — the operator manual-un-defer path ONLY. Persists on change. */
export function removeAutoDeferred(keys: Iterable<ToolKey>): void {
  ensureLoaded();
  let changed = false;
  for (const k of keys) if (latched.delete(k)) changed = true;
  if (changed) persist();
}

/** Test-only: clear in-memory state + force reload on next access. */
export function _resetAutoDeferForTest(): void {
  latched.clear();
  loaded = false;
}
