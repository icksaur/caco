import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const testState = vi.hoisted(() => ({ homeDir: '' }));

vi.mock('os', async (importOriginal) => {
  const original = await importOriginal<typeof import('os')>();
  return { ...original, homedir: () => testState.homeDir };
});

import {
  readSessionWorkspace,
  readSessionEvents,
  parseSessionModel,
  listSessionIds,
} from '../../src/sdk-session-store.js';

let tempDir: string;

function stateDir(): string {
  return join(tempDir, '.copilot', 'session-state');
}

function sessDir(sessionId: string): string {
  return join(stateDir(), sessionId);
}

function writeEvents(sessionId: string, events: object[]): void {
  const dir = sessDir(sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n'));
}

function writeWorkspace(sessionId: string, yaml: string): void {
  const dir = sessDir(sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'workspace.yaml'), yaml);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'sdk-store-test-'));
  testState.homeDir = tempDir;
  mkdirSync(stateDir(), { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('sdk-session-store', () => {
  describe('readSessionWorkspace', () => {
    it('parses updatedAt and summary from workspace.yaml', () => {
      writeWorkspace('sess-1', 'updated_at: "2025-01-15T10:00:00Z"\nsummary: "Fix the parser"');
      const result = readSessionWorkspace('sess-1');
      expect(result).toEqual({
        updatedAt: '2025-01-15T10:00:00Z',
        summary: 'Fix the parser',
        cwd: undefined,
      });
    });

    it('returns null for missing workspace.yaml', () => {
      mkdirSync(sessDir('sess-2'), { recursive: true });
      expect(readSessionWorkspace('sess-2')).toBeNull();
    });

    it('returns null for nonexistent session', () => {
      expect(readSessionWorkspace('nonexistent')).toBeNull();
    });

    it('handles partial fields gracefully', () => {
      writeWorkspace('sess-3', 'summary: "Just a summary"');
      const result = readSessionWorkspace('sess-3');
      expect(result).toEqual({
        updatedAt: undefined,
        summary: 'Just a summary',
        cwd: undefined,
      });
    });

    it('handles corrupt yaml gracefully', () => {
      writeWorkspace('sess-4', ':::invalid:::yaml:::');
      const result = readSessionWorkspace('sess-4');
      expect(result).toEqual({ updatedAt: undefined, summary: undefined, cwd: undefined });
    });
  });

  describe('readSessionEvents', () => {
    it('parses all events from events.jsonl', () => {
      const events = [
        { type: 'session.start', data: { selectedModel: 'gpt-4' } },
        { type: 'message', data: { content: 'hello' } },
        { type: 'message', data: { content: 'world' } },
      ];
      writeEvents('sess-10', events);
      const result = readSessionEvents('sess-10');
      expect(result).toHaveLength(3);
      expect(result[0].type).toBe('session.start');
      expect(result[2].data?.content).toBe('world');
    });

    it('returns empty array for missing file', () => {
      expect(readSessionEvents('nonexistent')).toEqual([]);
    });

    it('skips malformed lines', () => {
      const dir = sessDir('sess-11');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'events.jsonl'), '{"type":"ok"}\nnot json\n{"type":"also ok"}');
      const result = readSessionEvents('sess-11');
      expect(result).toHaveLength(2);
      expect(result[0].type).toBe('ok');
      expect(result[1].type).toBe('also ok');
    });

    it('handles empty file', () => {
      const dir = sessDir('sess-12');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'events.jsonl'), '');
      expect(readSessionEvents('sess-12')).toEqual([]);
    });
  });

  describe('parseSessionModel', () => {
    it('extracts model from session.start event', () => {
      writeEvents('sess-20', [
        { type: 'session.start', data: { selectedModel: 'claude-sonnet-4' } },
        { type: 'message', data: { content: 'hi' } },
      ]);
      expect(parseSessionModel('sess-20')).toBe('claude-sonnet-4');
    });

    it('returns latest model after model_change', () => {
      writeEvents('sess-21', [
        { type: 'session.start', data: { selectedModel: 'gpt-4' } },
        { type: 'message', data: { content: 'hi' } },
        { type: 'session.model_change', data: { model: 'claude-sonnet-4' } },
      ]);
      expect(parseSessionModel('sess-21')).toBe('claude-sonnet-4');
    });

    it('returns null for missing events', () => {
      expect(parseSessionModel('nonexistent')).toBeNull();
    });

    it('returns null when no model events exist', () => {
      writeEvents('sess-22', [
        { type: 'message', data: { content: 'hi' } },
      ]);
      expect(parseSessionModel('sess-22')).toBeNull();
    });

    it('returns null for empty events file', () => {
      const dir = sessDir('sess-23');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'events.jsonl'), '');
      expect(parseSessionModel('sess-23')).toBeNull();
    });
  });

  describe('listSessionIds', () => {
    it('lists subdirectories', () => {
      mkdirSync(sessDir('aaa'), { recursive: true });
      mkdirSync(sessDir('bbb'), { recursive: true });
      const ids = listSessionIds();
      expect(ids.sort()).toEqual(['aaa', 'bbb']);
    });

    it('returns empty array when state dir missing', () => {
      testState.homeDir = join(tempDir, 'nonexistent');
      expect(listSessionIds()).toEqual([]);
    });
  });
});
