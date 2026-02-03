/**
 * Tests for path-utils.ts
 */

import { describe, it, expect } from 'vitest';
import { join, sep } from 'path';
import { validatePath, validatePathMultiple } from '../../src/path-utils.js';

// Use OS-appropriate test paths
const isWindows = process.platform === 'win32';
const testRoot = isWindows ? 'C:\\Users\\test' : '/home/user';
const base = join(testRoot, 'project');

describe('validatePath', () => {
  describe('valid paths', () => {
    it('accepts simple relative path', () => {
      const result = validatePath(base, 'src/app.ts');
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.resolved).toBe(join(base, 'src', 'app.ts'));
        expect(result.relative).toBe(['src', 'app.ts'].join(sep));
      }
    });

    it('accepts nested relative path', () => {
      const result = validatePath(base, 'src/components/Button.tsx');
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.resolved).toBe(join(base, 'src', 'components', 'Button.tsx'));
      }
    });

    it('accepts current directory', () => {
      const result = validatePath(base, '.');
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.resolved).toBe(base);
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
        expect(result.resolved).toBe(join(base, 'src', 'app.ts'));
      }
    });

    it('normalizes internal ..', () => {
      const result = validatePath(base, 'src/../lib/util.ts');
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.resolved).toBe(join(base, 'lib', 'util.ts'));
        expect(result.relative).toBe(['lib', 'util.ts'].join(sep));
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
      const baseWithSlash = base + sep;
      const result = validatePath(baseWithSlash, 'src/app.ts');
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.resolved).toBe(join(base, 'src', 'app.ts'));
      }
    });

    it('handles path with special characters', () => {
      const result = validatePath(base, 'src/file with spaces.ts');
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.resolved).toBe(join(base, 'src', 'file with spaces.ts'));
      }
    });
  });
});

describe('validatePathMultiple', () => {
  const allowedBases = [
    join(testRoot, 'project'),
    join(testRoot, '.caco'),
    isWindows ? 'C:\\temp' : '/tmp'
  ];

  it('accepts path in first base', () => {
    const result = validatePathMultiple(allowedBases, join(testRoot, 'project', 'src', 'app.ts'));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.matchedBase).toBe(join(testRoot, 'project'));
    }
  });

  it('accepts path in second base', () => {
    const result = validatePathMultiple(allowedBases, join(testRoot, '.caco', 'config.json'));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.matchedBase).toBe(join(testRoot, '.caco'));
    }
  });

  it('accepts path in third base', () => {
    const tmpPath = isWindows ? 'C:\\temp\\upload.txt' : '/tmp/upload.txt';
    const result = validatePathMultiple(allowedBases, tmpPath);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.matchedBase).toBe(isWindows ? 'C:\\temp' : '/tmp');
    }
  });

  it('rejects path not in any base', () => {
    const etcPath = isWindows ? 'C:\\Windows\\System32\\config' : '/etc/passwd';
    const result = validatePathMultiple(allowedBases, etcPath);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('not in allowed directories');
    }
  });
});
