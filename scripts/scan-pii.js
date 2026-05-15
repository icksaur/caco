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

// Common short words / programming terms that frequently overlap with names,
// hostnames, or email usernames. Any identity fragment matching one of these
// is ignored to avoid false-positive matches against every file in the repo.
const COMMON_WORD_STOPLIST = new Set([
  'dev', 'devops', 'prod', 'test', 'tests', 'app', 'web', 'api', 'src',
  'lib', 'bin', 'tmp', 'log', 'logs', 'home', 'work', 'main', 'master',
  'admin', 'system', 'service', 'server', 'client', 'desktop', 'laptop',
  'workstation', 'computer', 'pc', 'mac', 'win', 'linux', 'ubuntu',
  'fedora', 'arch', 'debian', 'and', 'the', 'for', 'with', 'from',
  'data', 'user', 'users', 'name', 'host', 'node', 'box',
]);

// Reject identity fragments that are too short (most false positives) or
// match a common word. Length floor of 5 covers cases like "dev1" but
// keeps real names like "carl".
function isUsableIdentityFragment(text) {
  if (!text) return false;
  if (text.length < 5) return false;
  if (COMMON_WORD_STOPLIST.has(text)) return false;
  return true;
}

function collectIdentity() {
  const patterns = new Map(); // pattern → label

  const add = (text, label) => {
    if (isUsableIdentityFragment(text.toLowerCase())) {
      patterns.set(text.toLowerCase(), label);
    }
  };

  // Full strings (paths, emails, hostnames) always go in — they're specific
  // enough that a stoplist match would never cover them.
  const addExact = (text, label) => {
    if (text && text.length > 0) patterns.set(text.toLowerCase(), label);
  };

  // OS identity
  const user = userInfo().username;
  if (user && user !== 'root' && user !== 'user') {
    add(user, 'OS username');
  }

  const host = hostname();
  if (host && host !== 'localhost') {
    addExact(host, 'hostname');
    // Also try host components separated by '-' or '.' so that "carl-dev"
    // contributes "carl" but not "dev".
    for (const part of host.split(/[-.]/)) {
      add(part, 'hostname part');
    }
  }

  // Home directory components  (e.g. "/home/name" → match "name")
  const home = userInfo().homedir;
  if (home) {
    addExact(home, 'home directory');
    const parts = home.replace(/\\/g, '/').split('/').filter(Boolean);
    const leaf = parts[parts.length - 1];
    if (leaf && leaf !== 'root' && leaf !== 'user') {
      add(leaf, 'home dir username');
    }
  }

  // Git identity
  const gitName = git('config user.name');
  if (gitName) {
    addExact(gitName, 'git user.name');
    for (const part of gitName.split(/\s+/)) {
      add(part, 'git name part');
    }
  }

  const gitEmail = git('config user.email');
  if (gitEmail) {
    addExact(gitEmail, 'git user.email');
    const emailUser = gitEmail.split('@')[0];
    if (emailUser) add(emailUser, 'email username');
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

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build a word-boundary regex for each identity fragment so "dev" doesn't
// match "development", and a short surname like "Lee" doesn't match every
// occurrence of "lee" (e.g. "sleeve"). For path-like fragments containing
// special characters (slashes, @), we fall back to substring match because
// they're specific enough not to false-positive.
function buildIdentityMatcher(pattern) {
  // Path-ish or email-ish: literal substring is fine.
  if (/[/\\@.]/.test(pattern)) {
    return (lower) => lower.includes(pattern);
  }
  const re = new RegExp(`\\b${escapeRegex(pattern)}\\b`);
  return (lower) => re.test(lower);
}

function scanFile(filePath, identityMatchers) {
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const rel = relative(root, filePath);
  const findings = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lower = line.toLowerCase();
    const lineNum = i + 1;

    // Identity matches — word-boundary regex (or substring for path-like).
    for (const { match, label } of identityMatchers) {
      if (match(lower)) {
        findings.push({ file: rel, line: lineNum, label, text: line.trimStart() });
      }
    }

    // Secret patterns — keep substring/regex matching as authored.
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

const identityMatchers = Array.from(identity, ([pattern, label]) => ({
  match: buildIdentityMatcher(pattern),
  label,
}));

const files = stagedOnly ? getStagedFiles() : walkFiles(root);
const allFindings = [];

for (const file of files) {
  allFindings.push(...scanFile(file, identityMatchers));
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
