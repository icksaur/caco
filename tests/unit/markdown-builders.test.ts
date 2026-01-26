/**
 * Tests for markdown-builders.ts - Terminal/code markdown generation
 */
import { describe, it, expect } from 'vitest';
import { buildTerminalMarkdown, buildCodeMarkdown } from '../../public/ts/markdown-builders.js';

describe('buildTerminalMarkdown', () => {
  it('formats command with output in bash code block', () => {
    const result = buildTerminalMarkdown({
      command: 'ls -la',
      exitCode: 0,
      output: 'file1\nfile2'
    });
    expect(result).toBe('```bash\n$ ls -la\nfile1\nfile2\n```');
  });

  it('shows exit code for failed commands', () => {
    const result = buildTerminalMarkdown({
      command: 'cat missing.txt',
      exitCode: 1,
      output: 'No such file'
    });
    expect(result).toContain('(exit 1)');
  });

  it('omits exit code when 0 or undefined', () => {
    expect(buildTerminalMarkdown({ command: 'true', exitCode: 0, output: '' }))
      .not.toContain('exit');
    expect(buildTerminalMarkdown({ command: 'true', output: '' }))
      .not.toContain('exit');
  });
});

describe('buildCodeMarkdown', () => {
  it('formats code with path and language', () => {
    const result = buildCodeMarkdown({
      data: 'const x = 1;',
      path: 'index.ts',
      highlight: 'typescript'
    });
    expect(result).toBe('**index.ts**\n\n```typescript\nconst x = 1;\n```');
  });

  it('shows line range when provided', () => {
    const result = buildCodeMarkdown({
      data: 'code',
      path: 'file.ts',
      startLine: 10,
      endLine: 15,
      totalLines: 100
    });
    expect(result).toContain('(lines 10-15 of 100)');
  });

  it('omits line range when incomplete', () => {
    expect(buildCodeMarkdown({ data: 'x', startLine: 1 })).not.toContain('lines');
    expect(buildCodeMarkdown({ data: 'x', endLine: 10 })).not.toContain('lines');
  });
});
