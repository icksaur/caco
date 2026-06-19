import type { Shaper, ShapeResult } from '../types.js';
import { GENERIC_HEAD_LINES, GENERIC_TAIL_LINES } from '../types.js';

/**
 * The correctness floor: keep the first and last N lines with an elision marker.
 * Always recoverable via the raw handle; never claims to find failures, so it
 * can never hide one it didn't look for. Every format shaper must preserve a
 * superset of what this keeps.
 */
export const genericShaper: Shaper = {
  id: 'generic',
  detect: () => 1,
  shape(raw: string): ShapeResult {
    const lines = raw.split('\n');
    if (lines.length <= GENERIC_HEAD_LINES + GENERIC_TAIL_LINES + 1) {
      return { shaped: raw, preserved: lines.length, dropped: 0 };
    }
    const head = lines.slice(0, GENERIC_HEAD_LINES);
    const tail = lines.slice(lines.length - GENERIC_TAIL_LINES);
    const dropped = lines.length - head.length - tail.length;
    const shaped = [
      ...head,
      `… [${dropped} lines elided — retrieve full output for the middle] …`,
      ...tail,
    ].join('\n');
    return { shaped, preserved: head.length + tail.length, dropped };
  },
};
