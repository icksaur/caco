/**
 * Per-session metadata (~/.caco/sessions/<id>/meta.json) and the MRU session-order index.
 *
 * SessionMeta holds Caco-specific session state: custom name, kind, parent, last-idle/observed
 * timestamps, current intent + history, env hint, context map, model preference, folder
 * assignment, response options, active applet + params, and panel visibility.
 *
 * The SDK stores its own session data in ~/.copilot/session-state/<id>/; we keep our
 * metadata separate to avoid coupling with SDK internals.
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { STORAGE_ROOT, getSessionDir, ensureDir } from './storage-paths.js';

export type SessionKind = 'interactive' | 'agent' | 'swarm' | 'scheduled';

export interface SessionMeta {
  name: string;
  kind?: SessionKind;
  parentSessionId?: string;
  lastObservedAt?: string;
  lastIdleAt?: string;
  lastUsedAt?: string;
  currentIntent?: string;
  intentHistory?: Array<{ text: string; ts: number }>;
  envHint?: string;
  context?: Record<string, string[]>;
  model?: string;
  folder?: string;
  responseOptions?: string[];
  activeApplet?: string;
  appletParams?: Record<string, string>;
  appletPanelVisible?: boolean;
  /** @deprecated Use kind === 'swarm' instead */
  isSwarmSession?: boolean;
}

const INTENT_HISTORY_LIMIT = 5;

// ============================================================================
// Icon
// ============================================================================

/** Prefer animated icon.gif over static icon.png. Returns null if neither exists. */
export function getSessionIconPath(sessionId: string): string | null {
  const dir = getSessionDir(sessionId);
  return [join(dir, 'icon.gif'), join(dir, 'icon.png')].find(existsSync) ?? null;
}

// ============================================================================
// Meta CRUD
// ============================================================================

/** Create meta.json with empty defaults if it doesn't exist yet. */
export function ensureSessionMeta(sessionId: string): void {
  const sessionDir = getSessionDir(sessionId);
  ensureDir(sessionDir);
  const metaPath = join(sessionDir, 'meta.json');
  if (!existsSync(metaPath)) {
    writeFileSync(metaPath, JSON.stringify({ name: '' }, null, 2));
  }
}

export function getSessionMeta(sessionId: string): SessionMeta | undefined {
  const metaPath = join(getSessionDir(sessionId), 'meta.json');
  if (!existsSync(metaPath)) return undefined;
  try {
    const meta: SessionMeta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    if (!meta.kind) {
      if (meta.isSwarmSession) meta.kind = 'swarm';
      else if (meta.parentSessionId) meta.kind = 'agent';
      else meta.kind = 'interactive';
    }
    return meta;
  } catch {
    return undefined;
  }
}

export function setSessionMeta(sessionId: string, meta: SessionMeta): void {
  const sessionDir = getSessionDir(sessionId);
  ensureDir(sessionDir);
  writeFileSync(join(sessionDir, 'meta.json'), JSON.stringify(meta, null, 2));
}

// ============================================================================
// Observed / idle tracking
// ============================================================================

/** Mark session as observed (user viewed the chat panel for it). */
export function markSessionObserved(sessionId: string): void {
  const meta = getSessionMeta(sessionId) ?? { name: '' };
  meta.lastObservedAt = new Date().toISOString();
  setSessionMeta(sessionId, meta);
  console.log(`[STORAGE] markSessionObserved: ${sessionId.slice(0, 8)} lastObservedAt=${meta.lastObservedAt}`);
}

/** Mark session as idle (assistant finished its turn). */
export function markSessionIdle(sessionId: string): void {
  const meta = getSessionMeta(sessionId) ?? { name: '' };
  meta.lastIdleAt = new Date().toISOString();
  setSessionMeta(sessionId, meta);
  console.log(`[STORAGE] markSessionIdle: ${sessionId.slice(0, 8)} lastIdleAt=${meta.lastIdleAt}`);
}

/** True if the session went idle after the user last observed it. */
export function isSessionUnobserved(sessionId: string): boolean {
  const meta = getSessionMeta(sessionId);
  if (!meta?.lastIdleAt) return false; // Never went idle
  if (!meta.lastObservedAt) return true; // Never observed
  const result = new Date(meta.lastIdleAt) > new Date(meta.lastObservedAt);
  if (result) {
    console.log(`[STORAGE] isSessionUnobserved: ${sessionId.slice(0, 8)} = true (idle=${meta.lastIdleAt}, obs=${meta.lastObservedAt})`);
  }
  return result;
}

// ============================================================================
// Intent
// ============================================================================

/** Update the session's current intent and append to its bounded history. */
export function setSessionIntent(sessionId: string, intent: string): void {
  const meta = getSessionMeta(sessionId) ?? { name: '' };
  meta.currentIntent = intent;
  const history = meta.intentHistory ?? [];
  history.push({ text: intent, ts: Date.now() });
  if (history.length > INTENT_HISTORY_LIMIT) {
    history.splice(0, history.length - INTENT_HISTORY_LIMIT);
  }
  meta.intentHistory = history;
  setSessionMeta(sessionId, meta);
}

// ============================================================================
// Session order (MRU snapshot)
// ============================================================================

const SESSION_ORDER_FILE = join(STORAGE_ROOT, 'session-order.json');

export function getSessionOrder(): string[] {
  if (!existsSync(SESSION_ORDER_FILE)) return [];
  try {
    return JSON.parse(readFileSync(SESSION_ORDER_FILE, 'utf-8')) as string[];
  } catch { return []; }
}

export function setSessionOrder(ids: string[]): void {
  ensureDir(STORAGE_ROOT);
  writeFileSync(SESSION_ORDER_FILE, JSON.stringify(ids));
}
