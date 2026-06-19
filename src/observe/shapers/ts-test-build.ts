import type { Shaper, ShapeResult } from '../types.js';
import { MAX_FAILURES } from '../types.js';

/**
 * Lines worth keeping: any failure/error/diagnostic signal. The keep set is a
 * deliberate superset of "failure signal" so a shaped result can never drop a
 * failure that the generic floor would have surfaced.
 */
const SIGNAL = [
  /\berror\s+TS\d+/,                         // tsc
  /\bnpm\s+ERR!/,                            // npm
  /(?:^|\s)[\w./\\@-]+\.\w+:\d+(?::\d+)?/,   // file:line(:col)
  /\b(?:FAIL|FAILED|ERROR)\b/,              // runners / generic
  /[✗✘×✖✕●]|(?:^|\s)not ok\b/,              // tap / vitest / jest fail glyphs
  /\bAssertionError\b|\bError:|\bException\b|\bpanic:/,
  /\bExpected\b|\bReceived\b|\bexpected\b.*\b(?:to|but)\b/i,
  /\b(?:error|warning)\b\s+[\w-]+\/[\w-]+/,  // eslint "  error  rule/name"
  /^\s{2,}(?:error|warning)\b/i,             // eslint stylish severity column
  /\b\d+\s+(?:failed|failing|error|errors|problem|problems)\b/i, // summaries with failures
];

/** Lines that are pure pass/progress noise — dropped unless they also signal. */
const NOISE = [
  /^[\s│]*[✓√]/,                 // passing test glyphs
  /\bPASS\b/,
  /(?:^|\s)ok\s+\d+/,            // tap passing
  /^\s*$/,                       // blank
];

/** Trailing summary markers always kept (end-of-run totals). */
const SUMMARY = /\bTest Files\b|\bTests:\b|\bTest Suites:\b|\b\d+\s+pass(?:ed|ing)\b|\bDuration\b|\bRan all test\b|\bproblems?\s*\(/i;

function isSignal(line: string): boolean {
  return SIGNAL.some((re) => re.test(line));
}

function isNoise(line: string): boolean {
  return NOISE.some((re) => re.test(line));
}

export const tsTestBuildShaper: Shaper = {
  id: 'ts-test-build',
  detect(raw: string): number {
    let score = 0;
    if (/\berror\s+TS\d+/.test(raw)) score += 2;
    if (/\bnpm\s+ERR!/.test(raw)) score += 1;
    if (/\bTest Files\b|\bFAIL\b|[✗✘×]/.test(raw)) score += 2;
    if (/\b(?:error|warning)\b\s+[\w-]+\/[\w-]+/.test(raw)) score += 1; // eslint rule
    if (/\bvitest\b|\bjest\b|\beslint\b|\btsc\b/.test(raw)) score += 1;
    return score >= 2 ? score : 0;
  },
  shape(raw: string): ShapeResult {
    const lines = raw.split('\n');
    const keep = new Array<boolean>(lines.length).fill(false);
    let blocks = 0;
    let omitted = 0;

    for (let i = 0; i < lines.length; i++) {
      if (!isSignal(lines[i])) continue;
      if (blocks >= MAX_FAILURES) {
        omitted++;
        continue;
      }
      blocks++;
      keep[i] = true;
      // Keep following indented context (assertion diffs / stack frames) until a
      // blank line, capped to avoid runaway capture.
      for (let j = i + 1; j < lines.length && j <= i + 5; j++) {
        if (lines[j].trim() === '') break;
        if (/^\s+/.test(lines[j]) || /\b(?:Expected|Received|at\s)\b/.test(lines[j])) {
          keep[j] = true;
        } else {
          break;
        }
      }
    }

    // Always keep the trailing summary lines.
    for (let i = lines.length - 1, kept = 0; i >= 0 && kept < 6; i--) {
      if (lines[i].trim() === '') continue;
      kept++;
      if (SUMMARY.test(lines[i]) || isSignal(lines[i])) keep[i] = true;
    }

    const out: string[] = [];
    let preserved = 0;
    let dropped = 0;
    let gap = false;
    for (let i = 0; i < lines.length; i++) {
      if (keep[i]) {
        out.push(lines[i]);
        preserved++;
        gap = false;
      } else {
        dropped++;
        if (!isNoise(lines[i]) && !gap) {
          out.push('  …');
          gap = true;
        }
      }
    }

    let shaped = out.join('\n');
    if (omitted > 0) {
      shaped += `\n[+${omitted} more failure lines elided — retrieve full output]`;
    }
    return { shaped, preserved, dropped };
  },
};
