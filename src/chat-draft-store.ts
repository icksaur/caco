/**
 * Chat-draft persistence store.
 *
 * Per-session and new-chat draft text, stored as plain UTF-8 files.
 * See docs/chat-draft-persistence.md.
 *
 *   ~/.caco/sessions/<sessionId>/chat-draft.txt    per-session
 *   ~/.caco/drafts/newchat.txt                     pre-session (global)
 *
 * Stored as plain text (not JSON) — the only content is a string,
 * the file is read/written whole, and inspection-from-disk stays trivial.
 *
 * setSessionDraft is INTENTIONALLY strict about the session directory:
 * it requires the directory to already exist and never creates it. This
 * prevents a stale browser tab pointing at a deleted session from
 * resurrecting a ghost directory on every keystroke. The unconditional
 * ensureDir pattern used by setSessionData would defeat the cleanup
 * guarantee at session-manager.ts (rmSync of the whole session dir).
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { STORAGE_ROOT, getSessionDir, ensureDir } from './storage-paths.js';

const DRAFT_FILE = 'chat-draft.txt';
const NEWCHAT_DRAFT_PATH = join(STORAGE_ROOT, 'drafts', 'newchat.txt');

/** Result of a write/delete: either it landed, or the session was missing. */
export type DraftWriteResult = 'ok' | 'missing-session';

function sessionDraftPath(sessionId: string): string {
  return join(getSessionDir(sessionId), DRAFT_FILE);
}

/** Read a per-session draft. Returns null when the session dir or the
 *  draft file is missing, or on read error. */
export function getSessionDraft(sessionId: string): string | null {
  const path = sessionDraftPath(sessionId);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Write a per-session draft. Returns 'missing-session' if the session
 *  directory does not exist (no ghost-dir creation). Also returns
 *  'missing-session' on the TOCTOU race where the dir is rm'd between
 *  the existsSync check and writeFileSync. */
export function setSessionDraft(sessionId: string, text: string): DraftWriteResult {
  if (!existsSync(getSessionDir(sessionId))) return 'missing-session';
  try {
    writeFileSync(sessionDraftPath(sessionId), text, 'utf8');
    return 'ok';
  } catch (err) {
    if (err && typeof err === 'object' && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'missing-session';
    }
    throw err;
  }
}

/** Delete a per-session draft. Returns 'missing-session' if the session
 *  directory itself does not exist; 'ok' whether or not the draft file
 *  was actually present (idempotent). */
export function deleteSessionDraft(sessionId: string): DraftWriteResult {
  if (!existsSync(getSessionDir(sessionId))) return 'missing-session';
  const path = sessionDraftPath(sessionId);
  if (existsSync(path)) {
    try { unlinkSync(path); } catch { /* swallow; next write overwrites */ }
  }
  return 'ok';
}

/** Read the new-chat draft. Returns null when the file is missing. */
export function getNewChatDraft(): string | null {
  if (!existsSync(NEWCHAT_DRAFT_PATH)) return null;
  try {
    return readFileSync(NEWCHAT_DRAFT_PATH, 'utf8');
  } catch {
    return null;
  }
}

/** Write the new-chat draft. Creates ~/.caco/drafts/ on first write. */
export function setNewChatDraft(text: string): void {
  ensureDir(join(STORAGE_ROOT, 'drafts'));
  writeFileSync(NEWCHAT_DRAFT_PATH, text, 'utf8');
}

/** Delete the new-chat draft. Idempotent. */
export function deleteNewChatDraft(): void {
  if (!existsSync(NEWCHAT_DRAFT_PATH)) return;
  try { unlinkSync(NEWCHAT_DRAFT_PATH); } catch { /* swallow */ }
}
