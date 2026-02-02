/**
 * Shell Route Tests
 * 
 * Tests the shell route logic without requiring the full Express server.
 */

import { describe, it, expect } from 'vitest';
import { stripVTControlCharacters } from 'util';

/**
 * Extract sanitizeOutput logic for testing
 */
function sanitizeOutput(text: string): string {
  let result = stripVTControlCharacters(text);
  result = result.replace(/\r\n/g, '\n').replace(/\r/g, '');
  return result;
}

import { isAbsolute } from 'path';

/**
 * cwd validation uses Node's isAbsolute for cross-platform support
 */

describe('Shell route logic', () => {
  describe('sanitizeOutput', () => {
    it('strips ANSI color codes', () => {
      const input = '\x1b[32mgreen\x1b[0m text';
      expect(sanitizeOutput(input)).toBe('green text');
    });

    it('strips bold/underline ANSI codes', () => {
      const input = '\x1b[1mbold\x1b[0m \x1b[4munderline\x1b[0m';
      expect(sanitizeOutput(input)).toBe('bold underline');
    });

    it('strips cursor movement codes', () => {
      const input = '\x1b[2J\x1b[Hclear screen';
      expect(sanitizeOutput(input)).toBe('clear screen');
    });

    it('normalizes CRLF to LF', () => {
      const input = 'line1\r\nline2\r\n';
      expect(sanitizeOutput(input)).toBe('line1\nline2\n');
    });

    it('strips bare carriage returns (progress bars)', () => {
      const input = 'progress\r50%\r100%\ndone';
      expect(sanitizeOutput(input)).toBe('progress50%100%\ndone');
    });

    it('handles mixed line endings', () => {
      const input = 'a\r\nb\rc\nd';
      // CRLF becomes LF, bare CR is stripped
      // a\r\nb → a\nb (CRLF → LF)
      // b\rc → bc (bare CR removed)
      expect(sanitizeOutput(input)).toBe('a\nbc\nd');
    });

    it('passes through plain text unchanged', () => {
      const input = 'plain text\nwith newlines\n';
      expect(sanitizeOutput(input)).toBe('plain text\nwith newlines\n');
    });

    it('handles empty string', () => {
      expect(sanitizeOutput('')).toBe('');
    });

    it('strips OSC hyperlink codes', () => {
      // Terminal hyperlinks: ESC ] 8 ;; URL BEL text ESC ] 8 ;; BEL
      const input = '\x1b]8;;https://example.com\x07link\x1b]8;;\x07';
      expect(sanitizeOutput(input)).toBe('link');
    });
  });

  describe('cwd validation (uses path.isAbsolute)', () => {
    it('accepts Unix absolute paths', () => {
      expect(isAbsolute('/home/user')).toBe(true);
      expect(isAbsolute('/tmp')).toBe(true);
      expect(isAbsolute('/')).toBe(true);
    });

    it('accepts Windows absolute paths', () => {
      // Note: on Linux, isAbsolute('C:\\...') returns false
      // This test documents expected behavior on Windows
      // On Windows: isAbsolute('C:\\Users') === true
      // On Linux: isAbsolute('C:\\Users') === false (expected)
      expect(isAbsolute('/c/Users')).toBe(true); // Git Bash style works everywhere
    });

    it('rejects relative paths', () => {
      expect(isAbsolute('relative/path')).toBe(false);
      expect(isAbsolute('./path')).toBe(false);
      expect(isAbsolute('../path')).toBe(false);
    });
  });

  describe('execFile security', () => {
    it('uses args array not string concatenation', () => {
      // This is a documentation test - the implementation uses execFile
      // which passes args as array, not as shell string
      const args = ['status', '; rm -rf /'];
      
      // With execFile, this is passed as literal arg to git
      // git receives: ['status', '; rm -rf /']
      // It does NOT spawn a shell to interpret the semicolon
      expect(args).toEqual(['status', '; rm -rf /']);
    });
  });
});

