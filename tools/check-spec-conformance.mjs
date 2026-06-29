#!/usr/bin/env node
/**
 * Spec conformance checker — flags spec docs that diverge from the
 * create-spec-plan skeleton (see ~/.copilot/skills/create-spec-plan).
 *
 * Portable: Node ESM, zero dependencies, no shell builtins. Runs on Windows,
 * macOS, Linux. Usage:
 *   node tools/check-spec-conformance.mjs [docsDir]   (default: docs)
 *   node tools/check-spec-conformance.mjs --json
 *
 * Exit code: number of out-of-conformance specs (0 = all conform), capped at
 * 250 so it stays a valid POSIX status.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

// The fixed skeleton, in order. Trailing Rationale is optional.
const CANONICAL = ['Goals', 'Design', 'Invariants', 'Considerations', 'Risks and Mitigations', 'Acceptance', 'Plan'];
const OPTIONAL_TAIL = 'Rationale';
// The load-bearing four — their absence is a hard miss.
const REQUIRED = ['Goals', 'Design', 'Acceptance', 'Plan'];

// Common heading drift → its canonical section. Lets us flag synonyms while
// still crediting the section as present.
const SYNONYMS = new Map([
  ['goal', 'Goals'],
  ['risks', 'Risks and Mitigations'],
  ['risks & mitigations', 'Risks and Mitigations'],
  ['risks and mitigations', 'Risks and Mitigations'],
  ['risk', 'Risks and Mitigations'],
  ['plan (ordered)', 'Plan'],
  ['acceptance (definition of done)', 'Acceptance'],
  ['acceptance criteria', 'Acceptance'],
  ['definition of done', 'Acceptance'],
  ['considerations & edge cases', 'Considerations'],
]);

const canonLower = new Map(CANONICAL.map(c => [c.toLowerCase(), c]));

/** Resolve a raw H2 heading to its canonical section name, or null if it isn't
 *  a skeleton section (extra section — allowed, not flagged). */
function resolveSection(raw) {
  const key = raw.trim().toLowerCase();
  if (canonLower.has(key)) return { canonical: canonLower.get(key), synonym: false };
  if (key === OPTIONAL_TAIL.toLowerCase()) return { canonical: OPTIONAL_TAIL, synonym: false };
  if (SYNONYMS.has(key)) return { canonical: SYNONYMS.get(key), synonym: true };
  return null;
}

/** A doc is a spec if its filename marks it OR its H1 calls itself one. */
function isSpec(file, h1) {
  const name = basename(file);
  if (name.endsWith('-spec.md') || name.startsWith('spec-')) return true;
  return /^#\s*spec\b/i.test(h1 || '');
}

function analyze(file) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  const h1 = (text.match(/^#\s+.+$/m) || [''])[0];
  // Ordered list of resolved canonical sections as they appear in the doc.
  const seen = [];         // canonical names in document order
  const synonymsUsed = []; // raw headings that drifted
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const r = resolveSection(m[1]);
    if (!r) continue;
    seen.push(r.canonical);
    if (r.synonym) synonymsUsed.push(m[1].trim());
  }

  const present = new Set(seen);
  const missingRequired = REQUIRED.filter(s => !present.has(s));

  // Order check: the canonical sections that ARE present must appear in
  // skeleton order. Compare the doc's canonical sequence (dedup, skeleton-only)
  // against the skeleton's relative order.
  const docCanonSeq = seen.filter((s, i) => CANONICAL.includes(s) && seen.indexOf(s) === i);
  const expectedOrder = CANONICAL.filter(s => docCanonSeq.includes(s));
  const orderOk = JSON.stringify(docCanonSeq) === JSON.stringify(expectedOrder);

  // Title: canonical is `# spec-<slug>` (lowercase slug). Anything else is a
  // soft flag (many legacy specs use `# Spec: Title`).
  const titleCanonical = /^#\s+spec-[a-z0-9][a-z0-9-]*(\s+\(done\))?\s*$/.test(h1.trim());

  const issues = [];
  if (missingRequired.length) issues.push(`missing: ${missingRequired.join(', ')}`);
  if (!orderOk) issues.push(`order: ${docCanonSeq.join(' → ') || '(none)'}`);
  if (synonymsUsed.length) issues.push(`synonyms: ${[...new Set(synonymsUsed)].join(', ')}`);
  if (!titleCanonical) issues.push('title not `# spec-<slug>`');

  // Severity: missing required > broken order > synonym/title drift.
  let severity = 'ok';
  if (missingRequired.length) severity = 'major';
  else if (!orderOk) severity = 'moderate';
  else if (synonymsUsed.length || !titleCanonical) severity = 'minor';

  return {
    file: basename(file),
    severity,
    missingRequired,
    orderOk,
    synonymsUsed: [...new Set(synonymsUsed)],
    titleCanonical,
    issues,
  };
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const dir = args.find(a => !a.startsWith('--')) || 'docs';

  let entries;
  try {
    entries = readdirSync(dir).filter(f => f.endsWith('.md')).sort();
  } catch {
    console.error(`Cannot read directory: ${dir}`);
    process.exit(255);
  }

  const specs = [];
  for (const name of entries) {
    const full = join(dir, name);
    if (!statSync(full).isFile()) continue;
    const text = readFileSync(full, 'utf8');
    const h1 = (text.match(/^#\s+.+$/m) || [''])[0];
    if (!isSpec(full, h1)) continue;
    specs.push(analyze(full));
  }

  const bad = specs.filter(s => s.severity !== 'ok');
  bad.sort((a, b) => {
    const rank = { major: 0, moderate: 1, minor: 2 };
    return rank[a.severity] - rank[b.severity] || a.file.localeCompare(b.file);
  });

  if (asJson) {
    console.log(JSON.stringify({ scanned: specs.length, nonConforming: bad.length, specs: bad }, null, 2));
  } else {
    console.log(`Spec conformance — scanned ${specs.length} spec docs in ${dir}/\n`);
    console.log(`Conforming: ${specs.length - bad.length}   Out of conformance: ${bad.length}\n`);
    const pad = Math.min(40, Math.max(...bad.map(b => b.file.length), 4));
    for (const sev of ['major', 'moderate', 'minor']) {
      const group = bad.filter(b => b.severity === sev);
      if (!group.length) continue;
      console.log(`-- ${sev.toUpperCase()} (${group.length}) --`);
      for (const b of group) console.log(`  ${b.file.padEnd(pad)}  ${b.issues.join(' . ')}`);
      console.log('');
    }
  }
  process.exit(Math.min(bad.length, 250));
}

main();
