/**
 * Tests for output-cache.ts - Output storage and language detection
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { storeOutput, getOutput, detectLanguage } from '../../src/output-cache.js';

describe('storeOutput and getOutput', () => {
  beforeEach(() => {
    // Use fake timers for TTL testing
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores and retrieves string content', () => {
    const id = storeOutput('test content', { type: 'test' });
    
    expect(id).toMatch(/^out_\d+_\w+$/);
    
    const entry = getOutput(id);
    expect(entry).toBeDefined();
    expect(entry?.data).toBe('test content');
    expect(entry?.metadata.type).toBe('test');
  });

  it('stores and retrieves Buffer content', () => {
    const buffer = Buffer.from('binary data');
    const id = storeOutput(buffer, { type: 'binary' });
    
    const entry = getOutput(id);
    expect(entry?.data).toEqual(buffer);
  });

  it('stores with empty metadata by default', () => {
    const id = storeOutput('content');
    
    const entry = getOutput(id);
    expect(entry?.metadata).toEqual({});
  });

  it('includes createdAt timestamp', () => {
    const now = Date.now();
    vi.setSystemTime(now);
    
    const id = storeOutput('content');
    const entry = getOutput(id);
    
    expect(entry?.createdAt).toBe(now);
  });

  it('returns undefined for non-existent IDs', () => {
    expect(getOutput('out_nonexistent_abc123')).toBeUndefined();
  });

  it('generates unique IDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(storeOutput(`content ${i}`));
    }
    expect(ids.size).toBe(100);
  });

  it('auto-cleans after TTL (30 minutes)', () => {
    const id = storeOutput('ephemeral content');
    
    // Verify it exists
    expect(getOutput(id)).toBeDefined();
    
    // Fast-forward 29 minutes - should still exist
    vi.advanceTimersByTime(29 * 60 * 1000);
    expect(getOutput(id)).toBeDefined();
    
    // Fast-forward past 30 minutes - should be gone
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(getOutput(id)).toBeUndefined();
  });
});

describe('detectLanguage', () => {
  describe('JavaScript variants', () => {
    it('detects .js as javascript', () => {
      expect(detectLanguage('app.js')).toBe('javascript');
    });

    it('detects .mjs as javascript', () => {
      expect(detectLanguage('module.mjs')).toBe('javascript');
    });

    it('detects .cjs as javascript', () => {
      expect(detectLanguage('config.cjs')).toBe('javascript');
    });
  });

  describe('TypeScript', () => {
    it('detects .ts as typescript', () => {
      expect(detectLanguage('app.ts')).toBe('typescript');
    });

    it('detects .tsx as typescript', () => {
      expect(detectLanguage('component.tsx')).toBe('typescript');
    });
  });

  describe('Common languages', () => {
    const cases: [string, string][] = [
      ['script.py', 'python'],
      ['app.rb', 'ruby'],
      ['main.go', 'go'],
      ['lib.rs', 'rust'],
      ['Main.java', 'java'],
      ['program.c', 'c'],
      ['header.h', 'c'],
      ['program.cpp', 'cpp'],
      ['header.hpp', 'cpp'],
      ['Program.cs', 'csharp'],
      ['index.php', 'php'],
      ['app.swift', 'swift'],
      ['Main.kt', 'kotlin'],
      ['App.scala', 'scala'],
    ];

    for (const [filename, expected] of cases) {
      it(`detects ${filename} as ${expected}`, () => {
        expect(detectLanguage(filename)).toBe(expected);
      });
    }
  });

  describe('Shell scripts', () => {
    it('detects .sh as bash', () => {
      expect(detectLanguage('script.sh')).toBe('bash');
    });

    it('detects .bash as bash', () => {
      expect(detectLanguage('script.bash')).toBe('bash');
    });

    it('detects .zsh as bash', () => {
      expect(detectLanguage('script.zsh')).toBe('bash');
    });
  });

  describe('Data formats', () => {
    const cases: [string, string][] = [
      ['data.json', 'json'],
      ['config.yaml', 'yaml'],
      ['config.yml', 'yaml'],
      ['data.xml', 'xml'],
      ['config.toml', 'toml'],
      ['settings.ini', 'ini'],
      ['app.conf', 'ini'],
    ];

    for (const [filename, expected] of cases) {
      it(`detects ${filename} as ${expected}`, () => {
        expect(detectLanguage(filename)).toBe(expected);
      });
    }
  });

  describe('Web technologies', () => {
    const cases: [string, string][] = [
      ['page.html', 'html'],
      ['page.htm', 'html'],
      ['styles.css', 'css'],
      ['styles.scss', 'scss'],
      ['styles.sass', 'scss'],
    ];

    for (const [filename, expected] of cases) {
      it(`detects ${filename} as ${expected}`, () => {
        expect(detectLanguage(filename)).toBe(expected);
      });
    }
  });

  describe('Special files', () => {
    it('detects .md as markdown', () => {
      expect(detectLanguage('README.md')).toBe('markdown');
    });

    it('detects .sql as sql', () => {
      expect(detectLanguage('query.sql')).toBe('sql');
    });

    it('detects .env as shell', () => {
      expect(detectLanguage('.env')).toBe('shell');
    });
  });

  describe('Edge cases', () => {
    it('returns plaintext for unknown extensions', () => {
      expect(detectLanguage('file.xyz')).toBe('plaintext');
    });

    it('detects Makefile by extension match', () => {
      // 'makefile' is in the langMap as an extension
      expect(detectLanguage('Makefile')).toBe('makefile');
    });

    it('returns plaintext for truly unknown files', () => {
      expect(detectLanguage('README')).toBe('plaintext');
    });

    it('handles paths with directories', () => {
      expect(detectLanguage('/home/user/project/src/app.ts')).toBe('typescript');
    });

    it('is case-insensitive for extensions', () => {
      expect(detectLanguage('file.JS')).toBe('javascript');
      expect(detectLanguage('file.PY')).toBe('python');
    });
  });
});
