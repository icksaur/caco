/**
 * Minimal performance instrumentation.
 *
 * Wraps performance.mark/measure so spans show up in DevTools' Performance
 * tab (alongside the browser's own paint/script/network events) and also
 * log a `[PERF] name: 142.3ms` line to the console for at-a-glance reading.
 *
 * Usage:
 *   const span = perfSpan('session.activate');
 *   try { ... } finally { span.end(); }
 *
 * Or for a whole async block:
 *   await perfMeasure('session.resume.fetch', () => fetch(...));
 *
 * Flights group nested spans and print a console.table summary on end():
 *   const f = perfFlight('session.activate');
 *   f.span('resume.fetch'); ... ; f.end('resume.fetch');
 *   f.done(); // logs table
 */

import { makeDebug, debugTable } from './debug.js';

interface PerfSpan {
  end(): number;
}

interface PerfFlight {
  span(name: string): void;
  end(name: string): number;
  done(): void;
}

const debug = makeDebug('PERF');

let counter = 0;

function uniq(name: string): string {
  counter += 1;
  return `${name}#${counter}`;
}

export function perfSpan(name: string): PerfSpan {
  const id = uniq(name);
  const startMark = `${id}.start`;
  performance.mark(startMark);
  return {
    end(): number {
      const measure = performance.measure(name, { start: startMark });
      const ms = measure.duration;
      performance.clearMarks(startMark);
      debug(`${name}: ${ms.toFixed(1)}ms`);
      return ms;
    },
  };
}

export async function perfMeasure<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  const span = perfSpan(name);
  try {
    return await fn();
  } finally {
    span.end();
  }
}

export function perfFlight(flightName: string): PerfFlight {
  const flightStart = performance.now();
  const starts = new Map<string, number>();
  const rows: Array<{ span: string; ms: number }> = [];

  return {
    span(name: string): void {
      starts.set(name, performance.now());
    },
    end(name: string): number {
      const t = starts.get(name);
      if (t === undefined) return 0;
      const ms = performance.now() - t;
      starts.delete(name);
      rows.push({ span: name, ms: Number(ms.toFixed(1)) });
      return ms;
    },
    done(): void {
      const total = performance.now() - flightStart;
      rows.push({ span: '(total)', ms: Number(total.toFixed(1)) });
      debugTable('PERF', flightName, rows);
    },
  };
}
