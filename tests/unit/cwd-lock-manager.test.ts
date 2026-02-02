/**
 * Tests for cwd-lock-manager.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CwdLockManager } from '../../src/cwd-lock-manager.js';
import { CwdLockedError } from '../../src/types.js';

describe('CwdLockManager', () => {
  let manager: CwdLockManager;

  beforeEach(() => {
    manager = new CwdLockManager();
  });

  describe('acquire', () => {
    it('acquires lock for new cwd', () => {
      expect(() => manager.acquire('/test/path', 'session-1')).not.toThrow();
      expect(manager.getHolder('/test/path')).toBe('session-1');
    });

    it('allows same session to re-acquire', () => {
      manager.acquire('/test/path', 'session-1');
      expect(() => manager.acquire('/test/path', 'session-1')).not.toThrow();
    });

    it('throws CwdLockedError when busy session holds lock', () => {
      manager.acquire('/test/path', 'session-1');
      manager.markBusy('session-1');
      
      expect(() => manager.acquire('/test/path', 'session-2')).toThrow(CwdLockedError);
    });

    it('clears stale lock from idle session', () => {
      manager.acquire('/test/path', 'session-1');
      // session-1 is idle (not marked busy)
      
      expect(() => manager.acquire('/test/path', 'session-2')).not.toThrow();
      expect(manager.getHolder('/test/path')).toBe('session-2');
    });
  });

  describe('release', () => {
    it('releases lock and clears busy state', () => {
      manager.acquire('/test/path', 'session-1');
      manager.markBusy('session-1');
      
      manager.release('session-1');
      
      expect(manager.getHolder('/test/path')).toBeNull();
      expect(manager.isBusy('session-1')).toBe(false);
    });

    it('handles release of non-existent session gracefully', () => {
      expect(() => manager.release('non-existent')).not.toThrow();
    });
  });

  describe('busy state', () => {
    it('tracks busy state correctly', () => {
      expect(manager.isBusy('session-1')).toBe(false);
      
      manager.markBusy('session-1');
      expect(manager.isBusy('session-1')).toBe(true);
      
      manager.markIdle('session-1');
      expect(manager.isBusy('session-1')).toBe(false);
    });
  });

  describe('isBlocked', () => {
    it('returns false for unlocked cwd', () => {
      expect(manager.isBlocked('/test/path')).toBe(false);
    });

    it('returns false when holder is idle', () => {
      manager.acquire('/test/path', 'session-1');
      expect(manager.isBlocked('/test/path')).toBe(false);
    });

    it('returns true when holder is busy', () => {
      manager.acquire('/test/path', 'session-1');
      manager.markBusy('session-1');
      expect(manager.isBlocked('/test/path')).toBe(true);
    });

    it('excludes specified session from blocking check', () => {
      manager.acquire('/test/path', 'session-1');
      manager.markBusy('session-1');
      expect(manager.isBlocked('/test/path', 'session-1')).toBe(false);
    });
  });

  describe('getHolder', () => {
    it('returns null for unlocked cwd', () => {
      expect(manager.getHolder('/test/path')).toBeNull();
    });

    it('returns session id for locked cwd', () => {
      manager.acquire('/test/path', 'session-1');
      expect(manager.getHolder('/test/path')).toBe('session-1');
    });
  });

  describe('clearLock', () => {
    it('clears lock directly', () => {
      manager.acquire('/test/path', 'session-1');
      manager.clearLock('/test/path');
      expect(manager.getHolder('/test/path')).toBeNull();
    });
  });
});
