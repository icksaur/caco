import { type IndexResult, type IndexItem, OUTPUT_CAP_BYTES } from './types.js';

function renderItem(item: IndexItem, depth: number, showKind: boolean, lines: string[]): void {
  const indent = '  '.repeat(depth + 1);
  const head = showKind ? `${item.kind} ${item.label}` : item.label;
  lines.push(`${indent}${head} [${item.startLine}-${item.endLine}]`);
  if (item.children) {
    for (const child of item.children) renderItem(child, depth + 1, true, lines);
  }
}

/**
 * Render an IndexResult as compact text. Each entry ends with a `[start-end]`
 * range usable directly with view_range. Output is capped at OUTPUT_CAP_BYTES.
 */
export function formatIndex(result: IndexResult): string {
  const lines: string[] = [];
  lines.push(`${result.path} — ${result.language}, ${result.totalLines} lines`);

  if (result.sections.length === 0) {
    lines.push('  (no top-level declarations found)');
  }

  for (const section of result.sections) {
    const showKind = section.name !== 'imports';
    lines.push(`${section.name}:`);
    for (const item of section.items) renderItem(item, 0, showKind, lines);
  }

  for (const diag of result.diagnostics) lines.push(`note: ${diag}`);

  let text = lines.join('\n');
  if (Buffer.byteLength(text, 'utf8') > OUTPUT_CAP_BYTES) {
    text = capToBytes(text, OUTPUT_CAP_BYTES) + '\n… output truncated (byte cap). Use a narrower path or view_range on a listed range.';
  }
  return text;
}

function capToBytes(text: string, maxBytes: number): string {
  const reserve = 120;
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > maxBytes - reserve) {
    end = text.lastIndexOf('\n', end - 1);
    if (end <= 0) { end = Math.floor((maxBytes - reserve)); break; }
  }
  return text.slice(0, end);
}
