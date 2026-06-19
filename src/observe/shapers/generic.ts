import type { Shaper, ShapeResult } from '../types.js';
import { GENERIC_HEAD_LINES, GENERIC_TAIL_LINES, GENERIC_HARD_CAP_BYTES } from '../types.js';

function headBytes(s: string, max: number): string {
  const buf = Buffer.from(s, 'utf8');
  return buf.length <= max ? s : buf.subarray(0, max).toString('utf8');
}

function tailBytes(s: string, max: number): string {
  const buf = Buffer.from(s, 'utf8');
  return buf.length <= max ? s : buf.subarray(buf.length - max).toString('utf8');
}

/**
 * The correctness floor: keep the first and last N lines, hard-capped by bytes
 * so the result is ALWAYS smaller than a fixed ceiling -- even for a single
 * multi-megabyte line. Always recoverable via the raw handle; never claims to
 * find failures, so it can never hide one it didn't look for. Every format
 * shaper's output is unioned with this floor's lines (see shape.ts).
 */
export const genericShaper: Shaper = {
  id: 'generic',
  shape(raw: string): ShapeResult {
    const rawBytes = Buffer.byteLength(raw, 'utf8');
    const lines = raw.split('\n');
    const overLines = lines.length > GENERIC_HEAD_LINES + GENERIC_TAIL_LINES + 1;
    const overBytes = rawBytes > GENERIC_HARD_CAP_BYTES;
    if (!overLines && !overBytes) {
      return { shaped: raw, preserved: lines.length, dropped: 0 };
    }

    const headCount = Math.min(GENERIC_HEAD_LINES, lines.length);
    const tailCount = Math.min(GENERIC_TAIL_LINES, Math.max(0, lines.length - headCount));
    const dropped = lines.length - headCount - tailCount;

    const half = Math.floor(GENERIC_HARD_CAP_BYTES / 2);
    const head = headBytes(lines.slice(0, headCount).join('\n'), half);
    const tail = tailCount > 0 ? tailBytes(lines.slice(lines.length - tailCount).join('\n'), half) : '';
    const hiddenBytes = Math.max(0, rawBytes - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8'));
    const marker = `… [elided — ${dropped} lines / ${hiddenBytes} bytes hidden; retrieve full output] …`;

    const shaped = tail ? `${head}\n${marker}\n${tail}` : `${head}\n${marker}`;
    return { shaped, preserved: headCount + tailCount, dropped };
  },
  detect: () => 1,
};
