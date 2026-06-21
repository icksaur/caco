#!/usr/bin/env node
/**
 * Tool-diet benchmark reporter. Reads ~/.caco/metrics/requests.jsonl (the
 * per-request log) and prints per-commit aggregates so before/after diet
 * changes can be compared. Grouped by gitSha; the headline columns are turns
 * and reasoning tokens (the dominant latency terms).
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

const groups = new Map();
for (const r of rows) {
  const key = r.gitSha || 'unknown';
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}

const avg = (xs, f) => (xs.length ? xs.reduce((s, x) => s + (f(x) || 0), 0) / xs.length : 0);
const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

const header = ['gitSha', 'n', 'turns', 'reasoning', 'toolCalls', 'fails', 'wallMs', 'in', 'cache', 'out', 'wfBytes'];
const widths = header.map((h) => h.length);
const lines = [];
for (const [sha, xs] of groups) {
  const cells = [
    sha,
    String(xs.length),
    fmt(avg(xs, (x) => x.requestTurns)),
    fmt(avg(xs, (x) => x.requestReasoning)),
    fmt(avg(xs, (x) => x.requestToolCalls)),
    fmt(avg(xs, (x) => x.requestToolFailures)),
    fmt(avg(xs, (x) => x.requestWallMs)),
    fmt(avg(xs, (x) => x.requestIn)),
    fmt(avg(xs, (x) => x.requestCache)),
    fmt(avg(xs, (x) => x.requestOut)),
    fmt(avg(xs, (x) => x.requestWorkflowCodeBytes)),
  ];
  cells.forEach((c, i) => { widths[i] = Math.max(widths[i], c.length); });
  lines.push(cells);
}

const pad = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
console.log(`Tool-diet benchmark — per-commit averages (${rows.length} requests)\n`);
console.log(pad(header));
console.log(widths.map((w) => '-'.repeat(w)).join('  '));
for (const cells of lines) console.log(pad(cells));
