import { describe, it, expect } from 'vitest';
import { resolve, join } from 'path';
import { homedir } from 'os';

/**
 * Test MCP route path security logic
 * 
 * These tests verify the isPathAllowed() logic without requiring
 * the full Express server to be running.
 */

// Duplicate the logic from src/routes/mcp.ts for testing
const ALLOWED_BASES = [
  process.cwd(),
  join(homedir(), '.caco'),
  '/tmp'
];

function isPathAllowed(requestedPath: string): boolean {
  const resolved = resolve(requestedPath);
  return ALLOWED_BASES.some(base => resolved.startsWith(resolve(base)));
}

describe('MCP path security', () => {
  describe('allowed paths', () => {
    it('allows workspace root', () => {
      expect(isPathAllowed(process.cwd())).toBe(true);
    });

    it('allows files in workspace subdirectories', () => {
      expect(isPathAllowed(join(process.cwd(), 'src', 'file.ts'))).toBe(true);
      expect(isPathAllowed(join(process.cwd(), 'public', 'index.html'))).toBe(true);
    });

    it('allows .caco directory', () => {
      expect(isPathAllowed(join(homedir(), '.caco'))).toBe(true);
      expect(isPathAllowed(join(homedir(), '.caco', 'applets', 'test', 'meta.json'))).toBe(true);
    });

    it('allows /tmp directory', () => {
      expect(isPathAllowed('/tmp')).toBe(true);
      expect(isPathAllowed('/tmp/test.txt')).toBe(true);
    });

    it('handles relative paths within workspace', () => {
      // Relative paths should resolve to workspace when cwd is workspace
      expect(isPathAllowed('./src/file.ts')).toBe(true);
      expect(isPathAllowed('./src/../src/file.ts')).toBe(true);
    });
  });

  describe('denied paths', () => {
    it('denies /etc', () => {
      expect(isPathAllowed('/etc/passwd')).toBe(false);
    });

    it('denies /root', () => {
      expect(isPathAllowed('/root/.bashrc')).toBe(false);
    });

    it('denies home directory outside .caco', () => {
      expect(isPathAllowed(join(homedir(), '.ssh', 'id_rsa'))).toBe(false);
      expect(isPathAllowed(join(homedir(), 'Documents', 'secret.txt'))).toBe(false);
    });

    it('denies /var', () => {
      expect(isPathAllowed('/var/log/system.log')).toBe(false);
    });

    it('denies absolute paths outside allowed bases', () => {
      expect(isPathAllowed('/usr/bin/bash')).toBe(false);
      expect(isPathAllowed('/opt/app/config')).toBe(false);
    });
  });

  describe('path traversal attacks', () => {
    it('prevents ../.. escape from workspace', () => {
      // Try to escape workspace with ../../
      const malicious = join(process.cwd(), '..', '..', 'etc', 'passwd');
      expect(isPathAllowed(malicious)).toBe(false);
    });

    it('prevents escaping /tmp', () => {
      expect(isPathAllowed('/tmp/../etc/passwd')).toBe(false);
    });

    it('prevents symbolic link-style attacks', () => {
      // resolve() handles these, but test anyway
      expect(isPathAllowed('/tmp/../root/.bashrc')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('handles trailing slashes', () => {
      expect(isPathAllowed(process.cwd() + '/')).toBe(true);
      expect(isPathAllowed('/tmp/')).toBe(true);
    });

    it('handles multiple slashes', () => {
      expect(isPathAllowed('/tmp//test.txt')).toBe(true);
    });

    it('handles . and .. in allowed paths', () => {
      expect(isPathAllowed(join(process.cwd(), 'src', '.', 'file.ts'))).toBe(true);
      expect(isPathAllowed(join(process.cwd(), 'src', 'routes', '..', 'file.ts'))).toBe(true);
    });
  });

  describe('ALLOWED_BASES configuration', () => {
    it('includes workspace (cwd)', () => {
      expect(ALLOWED_BASES).toContain(process.cwd());
    });

    it('includes .caco directory', () => {
      expect(ALLOWED_BASES).toContain(join(homedir(), '.caco'));
    });

    it('includes /tmp', () => {
      expect(ALLOWED_BASES).toContain('/tmp');
    });

    it('has exactly 3 allowed bases', () => {
      expect(ALLOWED_BASES).toHaveLength(3);
    });
  });
});
