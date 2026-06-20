import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const testState = vi.hoisted(() => ({ homeDir: '' }));

vi.mock('os', async (importOriginal) => {
  const original = await importOriginal<typeof import('os')>();
  return { ...original, homedir: () => testState.homeDir };
});

import { repairSessionEvents } from '../../src/session-auto-repair.js';

let tempDir: string;

function sessDir(sessionId: string): string {
  return join(tempDir, '.copilot', 'session-state', sessionId);
}

function eventsPath(sessionId: string): string {
  return join(sessDir(sessionId), 'events.jsonl');
}

function writeRaw(sessionId: string, content: string): void {
  mkdirSync(sessDir(sessionId), { recursive: true });
  writeFileSync(eventsPath(sessionId), content);
}

function backupFiles(sessionId: string): string[] {
  return readdirSync(sessDir(sessionId)).filter(f => f.startsWith('events.jsonl.bak-'));
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'auto-repair-test-'));
  testState.homeDir = tempDir;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('repairSessionEvents backup + validate boundary', () => {
  it('repairs the ephemeral flag and writes valid JSONL', () => {
    const original = [
      '{"type":"session.start","data":{"selectedModel":"gpt-4"}}',
      '{"type":"session.shutdown","data":{"reason":"done"}}',
    ].join('\n');
    writeRaw('s1', original);

    const result = repairSessionEvents('s1', 'missing ephemeral on session.shutdown');
    expect(result).toBe('Fixed missing ephemeral flag on shutdown events');

    const repaired = readFileSync(eventsPath('s1'), 'utf-8');
    expect(repaired).toContain('"ephemeral":true');
    for (const line of repaired.split('\n')) {
      if (line.trim()) expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('backs up the ORIGINAL content before overwriting (once)', () => {
    const original = [
      '{"type":"session.start","data":{}}',
      '{"type":"session.shutdown","data":{"reason":"done"}}',
    ].join('\n');
    writeRaw('s2', original);

    repairSessionEvents('s2', 'ephemeral');

    const backups = backupFiles('s2');
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(sessDir('s2'), backups[0]), 'utf-8')).toBe(original);
  });

  it('returns null and does not back up when no repair applies', () => {
    writeRaw('s3', '{"type":"session.start","data":{}}');
    const result = repairSessionEvents('s3', 'some unrelated error');
    expect(result).toBeNull();
    expect(backupFiles('s3')).toHaveLength(0);
  });
});
