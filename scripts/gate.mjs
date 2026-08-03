#!/usr/bin/env node
/**
 * The gate runner: every check that must pass before a push (husky pre-push runs
 * `npm run build`, which is this).
 *
 * Runs phases concurrently, because most of them are independent readers of the
 * same tree and the sequential chain spent most of its wall time idle on one core
 * (measured 23.3s sequential vs 15.2s parallel). Ordering constraints are declared
 * per phase via `after`, not by position, so adding a phase cannot silently
 * reorder an existing dependency.
 *
 * Portable: Node ESM, zero dependencies, no shell builtins.
 *
 * Usage:
 *   node scripts/gate.mjs            run every phase
 *   node scripts/gate.mjs --serial   run strictly in order (debugging a suspected
 *                                    concurrency problem, or a loaded machine)
 */

import { spawn } from 'node:child_process';

const isWindows = process.platform === 'win32';

/**
 * `after` names the phases that must SUCCEED first. The coverage checks read
 * `coverage/coverage-summary.json`, which `test` writes — the only real ordering
 * constraint in the gate. Everything else is an independent reader.
 */
const PHASES = [
  { name: 'build:client', after: [] },
  { name: 'typecheck', after: [] },
  { name: 'lint:strict', after: [] },
  { name: 'knip', after: [] },
  { name: 'scan:pii', after: [] },
  { name: 'check:vendor', after: [] },
  { name: 'check:specs', after: [] },
  { name: 'test', after: [] },
  { name: 'check:coverage', after: ['test'] },
  { name: 'check:frontend-coverage', after: ['test'] },
];

/**
 * Phase names in dependency order, which also proves the table is well-formed.
 * Throws on unknown, self-, and cyclic dependencies rather than letting a typo
 * turn into a deadlock or a silently skipped check.
 */
function resolveOrder(phases) {
  const names = new Set(phases.map(p => p.name));
  for (const p of phases) {
    for (const dep of p.after) {
      if (!names.has(dep)) throw new Error(`phase "${p.name}" depends on unknown phase "${dep}"`);
      if (dep === p.name) throw new Error(`phase "${p.name}" depends on itself`);
    }
  }
  const order = [];
  const done = new Set();
  let progress = true;
  while (progress) {
    progress = false;
    for (const p of phases) {
      if (done.has(p.name) || !p.after.every(d => done.has(d))) continue;
      done.add(p.name);
      order.push(p);
      progress = true;
    }
  }
  if (order.length !== phases.length) {
    const stuck = phases.filter(p => !done.has(p.name)).map(p => p.name);
    throw new Error(`cyclic phase dependencies: ${stuck.join(', ')}`);
  }
  return order;
}

/** Run one npm script, capturing output so concurrent phases cannot interleave it. */
function runPhase(name) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const child = spawn('npm', ['run', name], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWindows,
      windowsHide: true,
    });
    let output = '';
    const collect = chunk => { output += chunk; };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', err => {
      resolve({ name, code: 1, ms: Date.now() - startedAt, output: `${output}\nfailed to spawn: ${err.message}` });
    });
    child.on('close', code => {
      // A signal kill delivers code === null; coercing to 1 keeps it a FAILURE and
      // out of the `skipped` bucket, whose sentinel is also a null code.
      resolve({ name, code: code ?? 1, ms: Date.now() - startedAt, output });
    });
  });
}

const results = new Map();
const serial = process.argv.includes('--serial');
const ORDER = resolveOrder(PHASES);

/**
 * A settled-signal per phase, created for EVERY phase before any of them starts.
 * This is what makes the declaration order in PHASES purely cosmetic: a phase can
 * await a dependency declared after it, so adding a phase anywhere in the table
 * can neither deadlock nor silently skip a check.
 */
const settled = new Map(PHASES.map(p => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return [p.name, { promise, resolve }];
}));

/**
 * A phase runs once its `after` set has all SUCCEEDED. If any of them failed the
 * phase is skipped, not silently passed — reporting `check:coverage` as green
 * when `test` never produced a summary would be worse than the failure itself.
 */
async function schedule(phase) {
  await Promise.all(phase.after.map(dep => settled.get(dep).promise));
  const blockedBy = phase.after.filter(dep => results.get(dep)?.code !== 0);
  const r = blockedBy.length > 0
    ? { name: phase.name, code: null, ms: 0, output: '', skipped: blockedBy }
    : await runPhase(phase.name);
  // Record BEFORE signalling, so a dependent that wakes on this signal always
  // observes this phase's result.
  results.set(phase.name, r);
  settled.get(phase.name).resolve();
  process.stdout.write(blockedBy.length > 0
    ? `  SKIP ${phase.name} (needs ${blockedBy.join(', ')})\n`
    : `  ${r.code === 0 ? 'ok  ' : 'FAIL'} ${phase.name} ${(r.ms / 1000).toFixed(1)}s\n`);
  return r;
}

const startedAt = Date.now();
process.stdout.write(`gate: ${PHASES.length} phases (${serial ? 'serial' : 'parallel'})\n`);

if (serial) {
  // Dependency order, not table order, so serial cannot deadlock on a phase
  // declared before its dependency.
  for (const phase of ORDER) await schedule(phase);
} else {
  await Promise.all(PHASES.map(phase => schedule(phase)));
}

const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1);
const outcomes = PHASES.map(p => results.get(p.name));
const failed = outcomes.filter(r => !r.skipped && r.code !== 0);
const skipped = outcomes.filter(r => r.skipped);

// Only failing output is printed: a green gate should be quiet, and a red one
// should show exactly what broke without the reader hunting through 10 logs.
for (const r of failed) {
  process.stdout.write(`\n${'='.repeat(70)}\nFAILED: ${r.name} (exit ${r.code})\n${'='.repeat(70)}\n${r.output.trimEnd()}\n`);
}

if (failed.length === 0 && skipped.length === 0) {
  process.stdout.write(`\ngate: all ${PHASES.length} phases passed in ${totalSec}s\n`);
} else {
  // A skipped phase never ran, so it is reported apart from a real failure — but it
  // is still not a pass, so the gate exits non-zero either way.
  const parts = [`${failed.length} failed`];
  if (skipped.length > 0) parts.push(`${skipped.length} skipped`);
  process.stdout.write(`\ngate: ${parts.join(', ')} of ${PHASES.length} phases in ${totalSec}s`);
  process.stdout.write(failed.length > 0 ? ` — failed: ${failed.map(r => r.name).join(', ')}\n` : '\n');
}

// Set the code and let the process exit on its own once stdout drains. Calling
// process.exit() here would truncate buffered output whenever stdout is a pipe
// rather than a TTY — which is exactly how husky pre-push and CI run this, and
// would discard the failure logs that are the whole point of capturing them.
process.exitCode = failed.length === 0 && skipped.length === 0 ? 0 : 1;
