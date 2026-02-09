#!/usr/bin/env node

/**
 * Scan workspace for personal information and secrets.
 *
 * Collects the current user's identity (OS user, hostname, git author)
 * and searches source files for those strings. Also checks for common
 * secret patterns (API keys, tokens, passwords).
 *
 * Usage: node scripts/scan-pii.js           # scan all files
 *        node scripts/scan-pii.js --staged  # scan only staged files (for git hooks)
 *
 * Exit code: 0 = clean, 1 = findings
 */

import { execSync } from 'child_process';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, extname } from 'path';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { hostname, userInfo } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// ── Collect user identity ───────────────────────────────────────────

function git(cmd) {
  try { return execSync(`git ${cmd}`, { cwd: root, encoding: 'utf8' }).trim(); }
  catch { return ''; }
}

function collectIdentity() {
  const patterns = new Map(); // pattern → label

  // OS identity
  const user = userInfo().username;
  if (user && user !== 'root' && user !== 'user') {
    patterns.set(user.toLowerCase(), 'OS username');
  }

  const host = hostname();
  if (host && host !== 'localhost') {
    patterns.set(host.toLowerCase(), 'hostname');
  }

  // Home directory components  (e.g. "/home/name" → match "name")
  const home = userInfo().homedir;
  if (home) {
    // Full home path
    patterns.set(home.toLowerCase(), 'home directory');
    // On Windows: C:\Users\name → name
    // On Linux:   /home/name   → name
    const parts = home.replace(/\\/g, '/').split('/').filter(Boolean);
    const leaf = parts[parts.length - 1];
    if (leaf && leaf !== 'root' && leaf !== 'user' && leaf.length > 2) {
      // Already covered by OS username usually, but captures Windows cases
      patterns.set(leaf.toLowerCase(), 'home dir username');
    }
  }

  // Git identity
  const gitName = git('config user.name');
  if (gitName) {
    patterns.set(gitName.toLowerCase(), 'git user.name');
    // Also check individual name parts (first/last name)
    for (const part of gitName.split(/\s+/)) {
      if (part.length > 2) patterns.set(part.toLowerCase(), 'git name part');
    }
  }

  const gitEmail = git('config user.email');
  if (gitEmail) {
    patterns.set(gitEmail.toLowerCase(), 'git user.email');
    // Username part of email
    const emailUser = gitEmail.split('@')[0];
    if (emailUser && emailUser.length > 2) {
      patterns.set(emailUser.toLowerCase(), 'email username');
    }
  }

  return patterns;
}

// ── Secret patterns ─────────────────────────────────────────────────

const SECRET_PATTERNS = [
  { re: /ghp_[A-Za-z0-9]{36,}/, label: 'GitHub PAT (classic)' },
  { re: /github_pat_[A-Za-z0-9_]{30,}/, label: 'GitHub PAT (fine-grained)' },
  { re: /gho_[A-Za-z0-9]{36,}/, label: 'GitHub OAuth token' },
  { re: /sk-[A-Za-z0-9]{20,}/, label: 'OpenAI/Stripe secret key' },
  { re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, label: 'Private key' },
  { re: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./, label: 'JWT token' },
];

// ── File discovery ──────────────────────────────────────────────────

const SCAN_EXTENSIONS = new Set([
  '.ts', '.js', '.md', '.css', '.html', '.json', '.yaml', '.yml', '.sh',
]);

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'coverage', '.husky',
]);

const SKIP_FILES = new Set([
  'package-lock.json', 'bundle.js', 'bundle.js.map',
  'highlight.min.js', 'purify.min.js', 'marked.min.js', 'mermaid.min.js',
]);

function walkFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) results.push(...walkFiles(full));
    } else if (SCAN_EXTENSIONS.has(extname(entry)) && !SKIP_FILES.has(entry)) {
      results.push(full);
    }
  }
  return results;
}

function getStagedFiles() {
  const out = git('diff --cached --name-only --diff-filter=ACMR');
  if (!out) return [];
  return out.split('\n')
    .map(f => join(root, f))
    .filter(f => SCAN_EXTENSIONS.has(extname(f)) && !SKIP_FILES.has(f.split('/').pop()));
}

// ── Scan ────────────────────────────────────────────────────────────

function scanFile(filePath, identityPatterns) {
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const rel = relative(root, filePath);
  const findings = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lower = line.toLowerCase();
    const lineNum = i + 1;

    // Identity matches — search for each collected pattern
    for (const [pattern, label] of identityPatterns) {
      if (lower.includes(pattern)) {
        findings.push({ file: rel, line: lineNum, label, text: line.trimStart() });
      }
    }

    // Secret patterns
    for (const { re, label } of SECRET_PATTERNS) {
      if (re.test(line)) {
        findings.push({ file: rel, line: lineNum, label, text: line.trimStart() });
      }
    }
  }

  return findings;
}

// ── Main ────────────────────────────────────────────────────────────

const stagedOnly = process.argv.includes('--staged');
const identity = collectIdentity();

// Show what we're searching for
console.log('Identity patterns collected:');
for (const [pattern, label] of identity) {
  console.log(`  ${label}: "${pattern}"`);
}
console.log();

const files = stagedOnly ? getStagedFiles() : walkFiles(root);
const allFindings = [];

for (const file of files) {
  allFindings.push(...scanFile(file, identity));
}

// Deduplicate (same file+line can match multiple patterns)
const seen = new Set();
const unique = allFindings.filter(f => {
  const key = `${f.file}:${f.line}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

if (unique.length === 0) {
  console.log(`✓ No PII or secrets found (scanned ${files.length} files)`);
  process.exit(0);
} else {
  console.log(`Found ${unique.length} potential PII/secret ${unique.length === 1 ? 'match' : 'matches'}:\n`);
  for (const f of unique) {
    console.log(`  ${f.file}:${f.line} [${f.label}]`);
    console.log(`    ${f.text.substring(0, 120)}`);
    console.log();
  }
  process.exit(1);
}
