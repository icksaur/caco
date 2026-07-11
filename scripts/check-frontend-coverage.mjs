#!/usr/bin/env node
/**
 * Frontend coverage gate (spec-frontend-coverage).
 *
 * Sibling of check-backend-coverage.mjs. Vitest's global thresholds include
 * public/ts but are not a public/ts-only metric; this script sums the
 * `public/ts/**` statements from the coverage summary and enforces that frontend
 * statement coverage meets FLOOR, failing the gate otherwise.
 *
 * FLOOR is a RATCHET: it starts at the current achieved level and is raised one
 * phase at a time toward the GOAL of 60 (the honest jsdom ceiling; 80 needs a
 * separate Playwright + coverage-merge phase). It never lowers. The denominator
 * is FIXED up front: terminal-panel.ts (xterm canvas, jsdom-impossible) is
 * excluded via vitest.config coverage.exclude, so it never appears here. Override
 * with CACO_FE_COV_TARGET only to probe a higher bar (never to lower the FLOOR).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const GOAL = 60;
const FLOOR = Number(process.env.CACO_FE_COV_TARGET ?? '31');
const SUMMARY = join(process.cwd(), 'coverage', 'coverage-summary.json');

let summary;
try {
  summary = JSON.parse(readFileSync(SUMMARY, 'utf8'));
} catch {
  console.error(
    `[check:frontend-coverage] ${SUMMARY} not found. Run \`npm test\` (which emits the json-summary reporter) before this check.`
  );
  process.exit(2);
}

let total = 0;
let covered = 0;
for (const [file, metrics] of Object.entries(summary)) {
  if (file === 'total') continue;
  const rel = file.replaceAll('\\', '/');
  if (!rel.includes('/public/ts/') && !rel.startsWith('public/ts/')) continue;
  total += metrics.statements.total;
  covered += metrics.statements.covered;
}

if (total === 0) {
  console.error('[check:frontend-coverage] No public/ts/** files found in coverage summary.');
  process.exit(2);
}

const pct = (100 * covered) / total;
const ok = pct >= FLOOR;
const goalNote = FLOOR < GOAL ? ` (goal ${GOAL}%)` : '';
const line = `[check:frontend-coverage] frontend public/ts/** statements: ${pct.toFixed(2)}% (${covered}/${total}), floor ${FLOOR}%${goalNote}`;

if (ok) {
  console.log(`${line} — OK`);
  process.exit(0);
}
console.error(`${line} — FAIL (need ${(FLOOR - pct).toFixed(2)}pt more)`);
process.exit(1);
