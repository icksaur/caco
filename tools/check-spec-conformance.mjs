#!/usr/bin/env node
/**
 * Spec conformance checker — flags spec docs that diverge from the
 * create-spec-plan skeleton (see ~/.copilot/skills/create-spec-plan).
 *
 * Portable: Node ESM, zero dependencies, no shell builtins. Runs on Windows,
 * macOS, Linux. Usage:
 *   node tools/check-spec-conformance.mjs [docsDir]   (default: docs)
 *   node tools/check-spec-conformance.mjs --json
 *   node tools/check-spec-conformance.mjs --inventory [--json]
 *
 * --inventory classifies EVERY doc (spec / spec(unmarked) / guide / research /
 * other), with cluster size, inbound-reference count, last-commit age (git,
 * optional), conformance (specs), an obsolete flag, and a suggested disposition.
 *
 * Exit code (conformance mode): number of out-of-conformance specs (0 = all
 * conform), capped at 250 so it stays a valid POSIX status. Inventory exits 0.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

// ── Inventory classification (Phase 0) ──────────────────────────────────────

const GUIDE_RE = /\b(usage|quickstart|getting started|setup|install|how to|reference|shortcuts?|cookbook|tutorial|walkthrough)\b/i;
const RESEARCH_RE = /\b(findings?|investigation|research|hypothesis|experiment|benchmark|measurements?|techniques?|analysis|notes)\b/i;
const OBSOLETE_RE = /\b(superseded|obsolete|deprecated|replaced by|archived|abandoned|no longer|defunct)\b/i;
const SPECISH = ['Goals', 'Goal', 'Design', 'Plan', 'Acceptance', 'Invariants', 'Considerations'];

/** Last-commit date (YYYY-MM-DD) for a file, or null if git is unavailable. */
function gitDate(file) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cs', '--', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function ageDays(dateStr) {
  if (!dateStr) return null;
  const t = Date.parse(dateStr + 'T00:00:00Z');
  if (Number.isNaN(t)) return null;
  return Math.round((Date.now() - t) / 86_400_000);
}

/** Classify ANY doc into: spec | spec(unmarked) | guide | research | other,
 *  plus an obsolete flag. Marker filenames win; otherwise infer from structure. */
function classify(file, text, h1, h2s) {
  const name = basename(file);
  const marked = name.endsWith('-spec.md') || name.startsWith('spec-') || /^#\s*spec\b/i.test(h1 || '');
  const heads = h2s.map(s => s.toLowerCase());
  const specishCount = SPECISH.filter(s => heads.includes(s.toLowerCase())).length;
  const hay = `${h1}\n${h2s.join('\n')}`;
  const statusLine = (text.match(/^\s*(?:>?\s*)?status\s*:\s*.+$/im) || [''])[0];
  const obsolete = OBSOLETE_RE.test(statusLine) || OBSOLETE_RE.test(h1 || '');

  let cls;
  if (marked) cls = 'spec';
  else if (specishCount >= 2 && (heads.includes('goals') || heads.includes('goal')) && (heads.includes('plan') || heads.includes('design'))) cls = 'spec(unmarked)';
  else if (RESEARCH_RE.test(name) || RESEARCH_RE.test(hay)) cls = 'research';
  else if (GUIDE_RE.test(name) || GUIDE_RE.test(hay)) cls = 'guide';
  else cls = 'other';
  return { cls, obsolete };
}

function h2List(text) {
  return (text.match(/^##\s+(.+?)\s*$/gm) || []).map(s => s.replace(/^##\s+/, '').trim());
}

function disposition(rec) {
  if (rec.obsolete) return 'ARCHIVE';
  switch (rec.cls) {
    case 'spec': return rec.conforms ? 'KEEP' : 'CONFORM';
    case 'spec(unmarked)': return 'RENAME+CONFORM';
    case 'guide': return 'MOVE→guides';
    case 'research': return 'MOVE→research';
    default: return 'REVIEW';
  }
}

function runInventory(dir, entries, asJson) {
  // Inbound-reference counts: how many OTHER docs mention this basename.
  const texts = new Map();
  for (const name of entries) texts.set(name, readFileSync(join(dir, name), 'utf8'));
  const inbound = new Map();
  for (const name of entries) {
    const stem = name.replace(/\.md$/, '');
    let count = 0;
    for (const [other, t] of texts) {
      if (other === name) continue;
      if (t.includes(name) || t.includes(stem)) count++;
    }
    inbound.set(name, count);
  }

  const clusterSize = new Map();
  for (const name of entries) {
    const p = name.split('-')[0];
    clusterSize.set(p, (clusterSize.get(p) || 0) + 1);
  }

  const recs = [];
  for (const name of entries) {
    const full = join(dir, name);
    if (!statSync(full).isFile()) continue;
    const text = texts.get(name);
    const h1 = (text.match(/^#\s+.+$/m) || [''])[0];
    const h2s = h2List(text);
    const { cls, obsolete } = classify(full, text, h1, h2s);
    const conforms = cls.startsWith('spec') ? analyze(full).severity === 'ok' : null;
    const cluster = name.split('-')[0];
    const date = gitDate(full);
    const rec = {
      file: name,
      cls,
      cluster: clusterSize.get(cluster) > 1 ? `${cluster}(${clusterSize.get(cluster)})` : '-',
      inbound: inbound.get(name),
      ageDays: ageDays(date),
      obsolete,
      conforms,
    };
    rec.disposition = disposition(rec);
    recs.push(rec);
  }

  const order = { spec: 0, 'spec(unmarked)': 1, research: 2, guide: 3, other: 4 };
  recs.sort((a, b) => (order[a.cls] - order[b.cls]) || a.cluster.localeCompare(b.cluster) || a.file.localeCompare(b.file));

  if (asJson) {
    console.log(JSON.stringify({ total: recs.length, recs }, null, 2));
    return;
  }

  const counts = {};
  for (const r of recs) counts[r.cls] = (counts[r.cls] || 0) + 1;
  const dispo = {};
  for (const r of recs) dispo[r.disposition] = (dispo[r.disposition] || 0) + 1;

  console.log(`Doc inventory — ${recs.length} docs in ${dir}/\n`);
  console.log('class:       ' + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  '));
  console.log('disposition: ' + Object.entries(dispo).map(([k, v]) => `${k}=${v}`).join('  ') + '\n');
  const fp = Math.min(42, Math.max(...recs.map(r => r.file.length)));
  console.log(`${'file'.padEnd(fp)}  ${'class'.padEnd(14)} ${'cluster'.padEnd(10)} ${'in'.padStart(3)} ${'age'.padStart(5)} ${'conf'.padStart(4)}  disposition`);
  for (const r of recs) {
    const age = r.ageDays == null ? '   -' : `${r.ageDays}d`;
    const conf = r.conforms == null ? '  -' : (r.conforms ? ' ok' : 'BAD');
    const obs = r.obsolete ? ' ⚑obsolete' : '';
    console.log(`${r.file.padEnd(fp)}  ${r.cls.padEnd(14)} ${r.cluster.padEnd(10)} ${String(r.inbound).padStart(3)} ${age.padStart(5)} ${conf.padStart(4)}  ${r.disposition}${obs}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const inventory = args.includes('--inventory');
  const dir = args.find(a => !a.startsWith('--')) || 'docs';

  let entries;
  try {
    entries = readdirSync(dir).filter(f => f.endsWith('.md')).sort();
  } catch {
    console.error(`Cannot read directory: ${dir}`);
    process.exit(255);
  }

  if (inventory) {
    runInventory(dir, entries, asJson);
    process.exit(0);
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
