#!/usr/bin/env node
/**
 * Per-request metrics reporter. Reads ~/.caco/metrics/requests.jsonl (the
 * per-request log) and prints aggregate averages. The headline columns are turns
 * and reasoning tokens (the dominant latency terms). For a before/after
 * comparison, snapshot or clear the log between the two runs.
 *
 * Usage: node scripts/bench-report.mjs
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const LOG = join(process.env.CACO_HOME || join(homedir(), '.caco'), 'metrics', 'requests.jsonl');

if (!existsSync(LOG)) {
  console.log(`No metrics log at ${LOG}. Run some benchmark prompts first (see docs/tool-diet-bench.md).`);
  process.exit(0);
}

const rows = readFileSync(LOG, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);

const avg = (xs, f) => (xs.length ? xs.reduce((s, x) => s + (f(x) || 0), 0) / xs.length : 0);
const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

const header = ['n', 'turns', 'reasoning', 'toolCalls', 'fails', 'wallMs', 'in', 'cache', 'out', 'wfBytes'];
const cells = [
  String(rows.length),
  fmt(avg(rows, (x) => x.requestTurns)),
  fmt(avg(rows, (x) => x.requestReasoning)),
  fmt(avg(rows, (x) => x.requestToolCalls)),
  fmt(avg(rows, (x) => x.requestToolFailures)),
  fmt(avg(rows, (x) => x.requestWallMs)),
  fmt(avg(rows, (x) => x.requestIn)),
  fmt(avg(rows, (x) => x.requestCache)),
  fmt(avg(rows, (x) => x.requestOut)),
  fmt(avg(rows, (x) => x.requestWorkflowCodeBytes)),
];
const widths = header.map((h, i) => Math.max(h.length, cells[i].length));
const pad = (xs) => xs.map((c, i) => c.padEnd(widths[i])).join('  ');

console.log(`Tool-diet benchmark — averages over ${rows.length} requests\n`);
console.log(pad(header));
console.log(widths.map((w) => '-'.repeat(w)).join('  '));
console.log(pad(cells));
