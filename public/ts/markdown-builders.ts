/**
 * Markdown Builders
 * 
 * Pure functions for building markdown strings from output data.
 * Extracted from display-output.ts for testability.
 */

export interface TerminalMarkdownOptions {
  command: string;
  exitCode?: number;
  output: string;
}

export interface CodeMarkdownOptions {
  data: string;
  path?: string;
  highlight?: string;
  startLine?: number;
  endLine?: number;
  totalLines?: number;
}

/**
 * Build markdown for terminal command output.
 * 
 * @example
 * buildTerminalMarkdown({ command: 'ls -la', exitCode: 0, output: 'file1\nfile2' })
 * // => '```bash\n$ ls -la\nfile1\nfile2\n```'
 * 
 * buildTerminalMarkdown({ command: 'cat missing', exitCode: 1, output: 'not found' })
 * // => '```bash\n$ cat missing (exit 1)\nnot found\n```'
 */
export function buildTerminalMarkdown(options: TerminalMarkdownOptions): string {
  const { command, exitCode, output } = options;
  const exitInfo = exitCode === 0 || exitCode === undefined ? '' : ` (exit ${exitCode})`;
  return '```bash\n$ ' + command + exitInfo + '\n' + output + '\n```';
}

/**
 * Build markdown for code/file content.
 * 
 * @example
 * buildCodeMarkdown({ data: 'const x = 1;', path: 'index.ts', highlight: 'typescript' })
 * // => '**index.ts**\n\n```typescript\nconst x = 1;\n```'
 * 
 * buildCodeMarkdown({ 
 *   data: 'line 10', 
 *   path: 'file.ts', 
 *   startLine: 10, 
 *   endLine: 10, 
 *   totalLines: 100 
 * })
 * // => '**file.ts** (lines 10-10 of 100)\n\n```\nline 10\n```'
 */
export function buildCodeMarkdown(options: CodeMarkdownOptions): string {
  const { data, path, highlight, startLine, endLine, totalLines } = options;
  
  const lang = highlight || '';
  const pathInfo = path ? `**${path}**` : '';
  const lineInfo = startLine && endLine 
    ? ` (lines ${startLine}-${endLine} of ${totalLines})`
    : '';
  
  return pathInfo + lineInfo + '\n\n```' + lang + '\n' + data + '\n```';
}
