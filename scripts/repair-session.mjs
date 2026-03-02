#!/usr/bin/env node

// Repair corrupted Copilot SDK session files.
//
// The SDK's internal JSON parser sometimes rejects lines that standard
// JSON parsers accept. This script removes those lines so the session
// can be resumed.
//
// Usage:
//   node scripts/repair-session.mjs <session-id>   # repair specific session
//   node scripts/repair-session.mjs --scan          # find all corrupt sessions
//   node scripts/repair-session.mjs --fix-all       # repair all corrupt sessions

import { readFileSync, writeFileSync, readdirSync, existsSync, copyFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';

const STATE_DIR = join(homedir(), '.copilot', 'session-state');

function getEventsPath(sessionId) {
  return join(STATE_DIR, sessionId, 'events.jsonl');
}

function getCwd(sessionId) {
  try {
    const path = getEventsPath(sessionId);
    const firstLine = readFileSync(path, 'utf-8').split('\n')[0];
    const event = JSON.parse(firstLine);
    return event?.data?.context?.cwd || '?';
  } catch {
    return '?';
  }
}

function tryResumeViaSDK(sessionId) {
  try {
    const result = execSync(
      `node -e "const{CopilotClient}=require('@github/copilot-sdk');` +
      `(async()=>{const c=new CopilotClient({cwd:process.cwd()});await c.start();` +
      `try{await c.resumeSession('${sessionId}',{streaming:true});` +
      `console.log('OK')}catch(e){console.log('FAIL:'+e.message)}` +
      `finally{await c.stop()}})()"`,
      { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    return result.startsWith('OK');
  } catch {
    return false;
  }
}

function scanSession(sessionId) {
  const path = getEventsPath(sessionId);
  if (!existsSync(path)) return null;

  const content = readFileSync(path, 'utf-8');
  const lines = content.split('\n');
  const corrupt = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      JSON.parse(line);
    } catch (e) {
      corrupt.push({ line: i + 1, error: e.message });
    }
  }

  return corrupt.length > 0 ? corrupt : null;
}

function repairSession(sessionId, dryRun = false) {
  const path = getEventsPath(sessionId);
  if (!existsSync(path)) {
    console.error(`  Session ${sessionId} not found`);
    return false;
  }

  const content = readFileSync(path, 'utf-8');
  const lines = content.split('\n');
  const validLines = [];
  const removed = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      validLines.push(line);
      continue;
    }
    try {
      JSON.parse(line);
      validLines.push(line);
    } catch (e) {
      removed.push({ line: i + 1, error: e.message, type: extractType(line) });
    }
  }

  if (removed.length === 0) {
    // JSON parses clean — but SDK parser may still reject it.
    // Try removing lines that the SDK might choke on (very long lines, 
    // lines with unusual unicode, tool.execution_complete with large content).
    console.log(`  No JSON errors found. Trying SDK-level validation...`);
    return repairSDKLevel(sessionId, lines, dryRun);
  }

  console.log(`  Found ${removed.length} corrupt line(s):`);
  for (const r of removed) {
    console.log(`    Line ${r.line}: [${r.type}] ${r.error}`);
  }

  if (dryRun) return true;

  const backupPath = path + '.bak';
  copyFileSync(path, backupPath);
  console.log(`  Backed up to ${backupPath}`);

  writeFileSync(path, validLines.join('\n'));
  console.log(`  Removed ${removed.length} line(s), ${validLines.filter(l => l.trim()).length} remaining`);
  return true;
}

function repairSDKLevel(sessionId, lines, dryRun) {
  // The SDK sometimes rejects lines that Node's JSON.parse accepts.
  // Binary search: remove one line at a time and try SDK resume.
  // Start with the line mentioned in the error (if known), otherwise
  // try removing tool.execution_complete events (most common culprit).
  
  const candidates = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'tool.execution_complete') {
        candidates.push(i);
      }
    } catch {
      candidates.push(i);
    }
  }

  if (candidates.length === 0) {
    console.log(`  No candidate lines to remove`);
    return false;
  }

  console.log(`  ${candidates.length} tool.execution_complete events to check`);
  
  if (dryRun) {
    console.log(`  Run without --scan to attempt repair`);
    return true;
  }

  // Try removing each candidate and testing via SDK
  for (const idx of candidates) {
    const testLines = [...lines];
    testLines.splice(idx, 1);
    const testPath = getEventsPath(sessionId);
    const backupPath = testPath + '.bak';
    
    if (!existsSync(backupPath)) {
      copyFileSync(testPath, backupPath);
    }
    
    writeFileSync(testPath, testLines.join('\n'));
    
    if (tryResumeViaSDK(sessionId)) {
      console.log(`  Fixed! Removed line ${idx + 1} (tool.execution_complete)`);
      return true;
    }
    
    // Restore and try next
    copyFileSync(backupPath, testPath);
  }

  console.log(`  Could not identify the corrupt line via SDK validation`);
  return false;
}

function extractType(line) {
  const match = line.match(/"type"\s*:\s*"([^"]+)"/);
  return match ? match[1] : '?';
}

function scanAll() {
  if (!existsSync(STATE_DIR)) {
    console.log('No session state directory found');
    return;
  }

  const sessions = readdirSync(STATE_DIR);
  let found = 0;

  for (const sid of sessions) {
    const corrupt = scanSession(sid);
    if (corrupt) {
      const cwd = getCwd(sid);
      console.log(`${sid}  cwd=${cwd}`);
      for (const c of corrupt) {
        console.log(`  Line ${c.line}: ${c.error}`);
      }
      found++;
    }
  }

  if (found === 0) {
    console.log(`Scanned ${sessions.length} sessions — no JSON corruption found`);
    console.log(`(SDK-level corruption requires --fix-all or specifying a session ID)`);
  } else {
    console.log(`\n${found} corrupt session(s) found. Run with --fix-all to repair.`);
  }
}

function fixAll() {
  if (!existsSync(STATE_DIR)) {
    console.log('No session state directory found');
    return;
  }

  const sessions = readdirSync(STATE_DIR);
  let fixed = 0;

  for (const sid of sessions) {
    const corrupt = scanSession(sid);
    if (corrupt) {
      const cwd = getCwd(sid);
      console.log(`\nRepairing ${sid} (${cwd}):`);
      if (repairSession(sid)) fixed++;
    }
  }

  console.log(`\nRepaired ${fixed} session(s)`);
}

// CLI
const args = process.argv.slice(2);

if (args.length === 0) {
  console.log('Usage:');
  console.log('  node scripts/repair-session.mjs <session-id>   Repair specific session');
  console.log('  node scripts/repair-session.mjs --scan          Find corrupt sessions');
  console.log('  node scripts/repair-session.mjs --fix-all       Repair all corrupt sessions');
  process.exit(0);
}

if (args[0] === '--scan') {
  scanAll();
} else if (args[0] === '--fix-all') {
  fixAll();
} else {
  const sessionId = args[0];
  const cwd = getCwd(sessionId);
  console.log(`Repairing session ${sessionId} (${cwd}):`);
  const result = repairSession(sessionId);
  process.exit(result ? 0 : 1);
}
