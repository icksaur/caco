#!/usr/bin/env node
/**
 * Backend coverage gate (spec-backend-coverage-80).
 *
 * Vitest's own thresholds are global + per-directory floors; neither equals the
 * aggregate "src/** statements >= N%" metric this project ratchets toward. This
 * script reads the coverage summary emitted by `npm test` and enforces that
 * backend statement coverage meets FLOOR, failing the gate otherwise.
 *
 * FLOOR is a RATCHET: it starts at the current achieved level and is raised one
 * phase at a time toward the GOAL of 80. "Done" for the coverage push = FLOOR
 * reaches 80. It never lowers. Backend = files under src/; frontend
 * (public/ts/**) is intentionally excluded. Override with CACO_COV_TARGET only
 * to probe a higher bar (never to lower the committed FLOOR).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const GOAL = 80;
const FLOOR = Number(process.env.CACO_COV_TARGET ?? '80');
const SUMMARY = join(process.cwd(), 'coverage', 'coverage-summary.json');

let summary;
try {
  summary = JSON.parse(readFileSync(SUMMARY, 'utf8'));
} catch {
  console.error(
    `[check:coverage] ${SUMMARY} not found. Run \`npm test\` (which emits the json-summary reporter) before this check.`
  );
  process.exit(2);
}

let total = 0;
let covered = 0;
for (const [file, metrics] of Object.entries(summary)) {
  if (file === 'total') continue;
  const rel = file.replaceAll('\\', '/');
  if (!rel.includes('/src/') && !rel.startsWith('src/')) continue;
  total += metrics.statements.total;
  covered += metrics.statements.covered;
}

if (total === 0) {
  console.error('[check:coverage] No src/** files found in coverage summary.');
  process.exit(2);
}

const pct = (100 * covered) / total;
const ok = pct >= FLOOR;
const goalNote = FLOOR < GOAL ? ` (goal ${GOAL}%)` : '';
const line = `[check:coverage] backend src/** statements: ${pct.toFixed(2)}% (${covered}/${total}), floor ${FLOOR}%${goalNote}`;

if (ok) {
  console.log(`${line} — OK`);
  process.exit(0);
}
console.error(`${line} — FAIL (need ${(FLOOR - pct).toFixed(2)}pt more)`);
process.exit(1);

