import { describe, it, expect } from 'vitest';
import { buildTerminalMarkdown, buildCodeMarkdown } from '../../public/ts/markdown-builders.js';

describe('buildTerminalMarkdown', () => {
  describe('successful commands', () => {
    it('formats simple command with output', () => {
      const result = buildTerminalMarkdown({
        command: 'ls',
        exitCode: 0,
        output: 'file1\nfile2'
      });
      expect(result).toBe('```bash\n$ ls\nfile1\nfile2\n```');
    });

    it('formats command with arguments', () => {
      const result = buildTerminalMarkdown({
        command: 'ls -la /home',
        exitCode: 0,
        output: 'total 4\ndrwxr-xr-x 2 user user 4096 Jan 1 00:00 .'
      });
      expect(result).toBe('```bash\n$ ls -la /home\ntotal 4\ndrwxr-xr-x 2 user user 4096 Jan 1 00:00 .\n```');
    });

    it('omits exit code when 0', () => {
      const result = buildTerminalMarkdown({
        command: 'echo hello',
        exitCode: 0,
        output: 'hello'
      });
      expect(result).not.toContain('exit');
    });

    it('omits exit code when undefined', () => {
      const result = buildTerminalMarkdown({
        command: 'echo hello',
        output: 'hello'
      });
      expect(result).not.toContain('exit');
    });
  });

  describe('failed commands', () => {
    it('shows exit code 1', () => {
      const result = buildTerminalMarkdown({
        command: 'cat missing.txt',
        exitCode: 1,
        output: 'cat: missing.txt: No such file or directory'
      });
      expect(result).toBe('```bash\n$ cat missing.txt (exit 1)\ncat: missing.txt: No such file or directory\n```');
    });

    it('shows non-standard exit codes', () => {
      const result = buildTerminalMarkdown({
        command: 'custom-cmd',
        exitCode: 127,
        output: 'command not found'
      });
      expect(result).toContain('(exit 127)');
    });

    it('shows negative exit codes (signals)', () => {
      const result = buildTerminalMarkdown({
        command: 'sleep 100',
        exitCode: -9,
        output: ''
      });
      expect(result).toContain('(exit -9)');
    });
  });

  describe('edge cases', () => {
    it('handles empty output', () => {
      const result = buildTerminalMarkdown({
        command: 'true',
        exitCode: 0,
        output: ''
      });
      expect(result).toBe('```bash\n$ true\n\n```');
    });

    it('handles multiline output', () => {
      const result = buildTerminalMarkdown({
        command: 'cat file',
        exitCode: 0,
        output: 'line1\nline2\nline3'
      });
      expect(result).toBe('```bash\n$ cat file\nline1\nline2\nline3\n```');
    });

    it('handles commands with special characters', () => {
      const result = buildTerminalMarkdown({
        command: 'echo "hello $USER"',
        exitCode: 0,
        output: 'hello carl'
      });
      expect(result).toContain('echo "hello $USER"');
    });
  });
});

describe('buildCodeMarkdown', () => {
  describe('simple code blocks', () => {
    it('formats code without metadata', () => {
      const result = buildCodeMarkdown({
        data: 'const x = 1;'
      });
      expect(result).toBe('\n\n```\nconst x = 1;\n```');
    });

    it('formats code with language highlight', () => {
      const result = buildCodeMarkdown({
        data: 'const x = 1;',
        highlight: 'typescript'
      });
      expect(result).toBe('\n\n```typescript\nconst x = 1;\n```');
    });

    it('formats code with path', () => {
      const result = buildCodeMarkdown({
        data: 'const x = 1;',
        path: 'src/index.ts'
      });
      expect(result).toBe('**src/index.ts**\n\n```\nconst x = 1;\n```');
    });

    it('formats code with path and highlight', () => {
      const result = buildCodeMarkdown({
        data: 'const x = 1;',
        path: 'index.ts',
        highlight: 'typescript'
      });
      expect(result).toBe('**index.ts**\n\n```typescript\nconst x = 1;\n```');
    });
  });

  describe('line range info', () => {
    it('shows line range with total', () => {
      const result = buildCodeMarkdown({
        data: 'function foo() {}',
        path: 'utils.ts',
        startLine: 10,
        endLine: 15,
        totalLines: 100
      });
      expect(result).toBe('**utils.ts** (lines 10-15 of 100)\n\n```\nfunction foo() {}\n```');
    });

    it('shows single line range', () => {
      const result = buildCodeMarkdown({
        data: 'import x from "y";',
        path: 'file.ts',
        startLine: 1,
        endLine: 1,
        totalLines: 50
      });
      expect(result).toContain('(lines 1-1 of 50)');
    });

    it('omits line info when startLine missing', () => {
      const result = buildCodeMarkdown({
        data: 'code',
        path: 'file.ts',
        endLine: 10,
        totalLines: 100
      });
      expect(result).not.toContain('lines');
    });

    it('omits line info when endLine missing', () => {
      const result = buildCodeMarkdown({
        data: 'code',
        path: 'file.ts',
        startLine: 1,
        totalLines: 100
      });
      expect(result).not.toContain('lines');
    });
  });

  describe('edge cases', () => {
    it('handles empty data', () => {
      const result = buildCodeMarkdown({
        data: '',
        path: 'empty.txt'
      });
      expect(result).toBe('**empty.txt**\n\n```\n\n```');
    });

    it('handles multiline code', () => {
      const result = buildCodeMarkdown({
        data: 'line1\nline2\nline3',
        highlight: 'text'
      });
      expect(result).toBe('\n\n```text\nline1\nline2\nline3\n```');
    });

    it('handles code with backticks', () => {
      const result = buildCodeMarkdown({
        data: 'const md = `template`;',
        highlight: 'typescript'
      });
      expect(result).toContain('const md = `template`;');
    });

    it('handles paths with special characters', () => {
      const result = buildCodeMarkdown({
        data: 'content',
        path: 'src/components/[id]/page.tsx'
      });
      expect(result).toContain('**src/components/[id]/page.tsx**');
    });
  });
});
