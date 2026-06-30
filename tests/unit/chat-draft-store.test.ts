/**
 * chat-draft-store tests
 *
 * Verifies the per-session and new-chat draft stores. See
 * docs/spec-chat-form.md.
 *
 * Critical invariant: setSessionDraft must NOT create the session
 * directory. The unconditional ensureDir pattern would resurrect
 * ghost sessions on every keystroke from a stale browser tab; we
 * verify that doesn't happen by writing into a fresh CACO_HOME and
 * checking the directory tree.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('chat-draft-store', () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'caco-draft-test-'));
    originalHome = process.env.CACO_HOME;
    process.env.CACO_HOME = tmpHome;
    // Re-import after env mutation so storage-paths reads the new value.
    // Vite caches modules; nuke the cache for these.
    const { vi } = await import('vitest');
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.CACO_HOME;
    else process.env.CACO_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  describe('per-session draft', () => {
    it('returns null when session dir does not exist', async () => {
      const { getSessionDraft } = await import('../../src/chat-draft-store.js');
      expect(getSessionDraft('nonexistent-session')).toBeNull();
    });

    it('returns null when session dir exists but draft file does not', async () => {
      mkdirSync(join(tmpHome, 'sessions', 'sess-1'), { recursive: true });
      const { getSessionDraft } = await import('../../src/chat-draft-store.js');
      expect(getSessionDraft('sess-1')).toBeNull();
    });

    it('round-trips text', async () => {
      mkdirSync(join(tmpHome, 'sessions', 'sess-1'), { recursive: true });
      const { setSessionDraft, getSessionDraft } = await import('../../src/chat-draft-store.js');
      expect(setSessionDraft('sess-1', 'hello\nworld')).toBe('ok');
      expect(getSessionDraft('sess-1')).toBe('hello\nworld');
    });

    it('setSessionDraft returns missing-session and does NOT create the directory', async () => {
      const { setSessionDraft } = await import('../../src/chat-draft-store.js');
      const result = setSessionDraft('ghost-session', 'should not persist');
      expect(result).toBe('missing-session');
      // Critical: the sessions directory either does not exist, or
      // exists but does not contain ghost-session.
      const sessionsDir = join(tmpHome, 'sessions');
      const ghostDir = join(sessionsDir, 'ghost-session');
      expect(existsSync(ghostDir)).toBe(false);
      // Ensure we didn't accidentally create siblings either.
      if (existsSync(sessionsDir)) {
        expect(readdirSync(sessionsDir)).not.toContain('ghost-session');
      }
    });

    it('deleteSessionDraft is idempotent', async () => {
      mkdirSync(join(tmpHome, 'sessions', 'sess-1'), { recursive: true });
      const { setSessionDraft, deleteSessionDraft, getSessionDraft } = await import('../../src/chat-draft-store.js');
      setSessionDraft('sess-1', 'x');
      expect(deleteSessionDraft('sess-1')).toBe('ok');
      expect(getSessionDraft('sess-1')).toBeNull();
      // Second delete still 'ok' (session dir still exists).
      expect(deleteSessionDraft('sess-1')).toBe('ok');
    });

    it('deleteSessionDraft returns missing-session for unknown session', async () => {
      const { deleteSessionDraft } = await import('../../src/chat-draft-store.js');
      expect(deleteSessionDraft('ghost')).toBe('missing-session');
    });

    it('overwrites existing draft (PUT semantics)', async () => {
      mkdirSync(join(tmpHome, 'sessions', 'sess-1'), { recursive: true });
      const { setSessionDraft, getSessionDraft } = await import('../../src/chat-draft-store.js');
      setSessionDraft('sess-1', 'first');
      setSessionDraft('sess-1', 'second');
      expect(getSessionDraft('sess-1')).toBe('second');
    });
  });

  describe('new-chat draft', () => {
    it('returns null when file does not exist', async () => {
      const { getNewChatDraft } = await import('../../src/chat-draft-store.js');
      expect(getNewChatDraft()).toBeNull();
    });

    it('round-trips text and creates the drafts/ subdir on first write', async () => {
      const { setNewChatDraft, getNewChatDraft } = await import('../../src/chat-draft-store.js');
      setNewChatDraft('new chat content');
      expect(existsSync(join(tmpHome, 'drafts'))).toBe(true);
      expect(getNewChatDraft()).toBe('new chat content');
    });

    it('deleteNewChatDraft is idempotent', async () => {
      const { setNewChatDraft, deleteNewChatDraft, getNewChatDraft } = await import('../../src/chat-draft-store.js');
      setNewChatDraft('x');
      deleteNewChatDraft();
      expect(getNewChatDraft()).toBeNull();
      // Second delete: silent no-op.
      expect(() => deleteNewChatDraft()).not.toThrow();
    });
  });
});
