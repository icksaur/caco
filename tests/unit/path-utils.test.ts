/**
 * Tests for path-utils.ts
 */

import { describe, it, expect } from 'vitest';
import { validatePath, validatePathMultiple } from '../../src/path-utils.js';

describe('validatePath', () => {
  const base = '/home/user/project';

  describe('valid paths', () => {
    it('accepts simple relative path', () => {
      const result = validatePath(base, 'src/app.ts');
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.resolved).toBe('/home/user/project/src/app.ts');
        expect(result.relative).toBe('src/app.ts');
      }
    });

    it('accepts nested relative path', () => {
      const result = validatePath(base, 'src/components/Button.tsx');
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.resolved).toBe('/home/user/project/src/components/Button.tsx');
      }
    });

    it('accepts current directory', () => {
      const result = validatePath(base, '.');
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.resolved).toBe('/home/user/project');
        expect(result.relative).toBe('.');
      }
    });

    it('accepts empty string as current directory', () => {
      const result = validatePath(base, '');
      expect(result.valid).toBe(false); // Empty is not allowed
    });

    it('normalizes redundant slashes', () => {
      const result = validatePath(base, 'src//app.ts');
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.resolved).toBe('/home/user/project/src/app.ts');
      }
    });

    it('normalizes internal ..', () => {
      const result = validatePath(base, 'src/../lib/util.ts');
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.resolved).toBe('/home/user/project/lib/util.ts');
        expect(result.relative).toBe('lib/util.ts');
      }
    });
  });

  describe('invalid paths - traversal attacks', () => {
    it('rejects simple parent traversal', () => {
      const result = validatePath(base, '../secrets.txt');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('escapes');
      }
    });

    it('rejects deep parent traversal', () => {
      const result = validatePath(base, '../../../etc/passwd');
      expect(result.valid).toBe(false);
    });

    it('rejects traversal after valid path', () => {
      const result = validatePath(base, 'src/../../secrets.txt');
      expect(result.valid).toBe(false);
    });

    it('rejects absolute path outside base', () => {
      const result = validatePath(base, '/etc/passwd');
      expect(result.valid).toBe(false);
    });

    it('rejects path that matches base prefix but escapes', () => {
      // /home/user/project-other should not be allowed
      const result = validatePath(base, '../project-other/file.txt');
      expect(result.valid).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('handles base with trailing slash', () => {
      const result = validatePath('/home/user/project/', 'src/app.ts');
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.resolved).toBe('/home/user/project/src/app.ts');
      }
    });

    it('handles path with special characters', () => {
      const result = validatePath(base, 'src/file with spaces.ts');
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.resolved).toBe('/home/user/project/src/file with spaces.ts');
      }
    });
  });
});

describe('validatePathMultiple', () => {
  const allowedBases = ['/home/user/project', '/home/user/.caco', '/tmp'];

  it('accepts path in first base', () => {
    const result = validatePathMultiple(allowedBases, '/home/user/project/src/app.ts');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.matchedBase).toBe('/home/user/project');
    }
  });

  it('accepts path in second base', () => {
    const result = validatePathMultiple(allowedBases, '/home/user/.caco/config.json');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.matchedBase).toBe('/home/user/.caco');
    }
  });

  it('accepts path in third base', () => {
    const result = validatePathMultiple(allowedBases, '/tmp/upload.txt');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.matchedBase).toBe('/tmp');
    }
  });

  it('rejects path not in any base', () => {
    const result = validatePathMultiple(allowedBases, '/etc/passwd');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('not in allowed directories');
    }
  });
});
