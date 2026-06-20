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
  readSessionEventsResult,
  readLastTurns,
  readLastTurnsResult,
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

  describe('readSessionEventsResult', () => {
    it('classifies an absent file as missing', () => {
      const r = readSessionEventsResult('nonexistent');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe('missing');
    });

    it('classifies an empty file as ok with no events', () => {
      const dir = sessDir('res-empty');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'events.jsonl'), '\n  \n');
      const r = readSessionEventsResult('res-empty');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toEqual([]);
    });

    it('classifies an all-malformed non-empty file as corrupt (not empty)', () => {
      const dir = sessDir('res-garbage');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'events.jsonl'), 'not json\nalso not json\n');
      const r = readSessionEventsResult('res-garbage');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe('corrupt');
    });

    it('classifies a partial parse as ok', () => {
      const dir = sessDir('res-partial');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'events.jsonl'), '{"type":"ok"}\nbroken\n');
      const r = readSessionEventsResult('res-partial');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toHaveLength(1);
    });
  });

  describe('readLastTurnsResult', () => {
    it('classifies an absent file as missing', () => {
      const r = readLastTurnsResult('nonexistent', 5, 2000);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe('missing');
    });

    it('classifies an all-malformed file as corrupt', () => {
      const dir = sessDir('lt-garbage');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'events.jsonl'), 'nope\nstill nope\n');
      const r = readLastTurnsResult('lt-garbage', 5, 2000);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe('corrupt');
    });

    it('returns ok with events for a valid file', () => {
      writeEvents('lt-ok', [
        { type: 'user.message', data: { content: 'hi' } },
        { type: 'message', data: { content: 'reply' } },
      ]);
      const r = readLastTurnsResult('lt-ok', 5, 2000);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.events.length).toBeGreaterThan(0);
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

  describe('readLastTurns', () => {
    function makeTurns(n: number, eventsPerTurn = 3): object[] {
      const out: object[] = [];
      for (let i = 0; i < n; i++) {
        out.push({ type: 'user.message', data: { text: `q${i}` } });
        for (let j = 0; j < eventsPerTurn - 1; j++) {
          out.push({ type: 'assistant.message_delta', data: { delta: `r${i}-${j}` } });
        }
      }
      return out;
    }

    it('returns all events when session has fewer turns than the cap', () => {
      writeEvents('s1', makeTurns(3));
      const { events, totalLines, skipped } = readLastTurns('s1', 5, 2000);
      expect(events.length).toBe(9);  // 3 turns * 3 events
      expect(skipped).toBe(0);
      expect(totalLines).toBeGreaterThan(0);
    });

    it('caps to the last N turns when session has more', () => {
      writeEvents('s2', makeTurns(10));
      const { events, skipped } = readLastTurns('s2', 5, 2000);
      const userMessages = events.filter(e => e.type === 'user.message');
      expect(userMessages.length).toBe(5);
      // The most recent 5 user messages: indices 5..9 (text q5..q9)
      const texts = userMessages.map(e => (e.data as { text: string }).text);
      expect(texts).toEqual(['q5', 'q6', 'q7', 'q8', 'q9']);
      expect(skipped).toBeGreaterThan(0);
    });

    it('respects maxEvents safety cap by reducing turns', () => {
      // 10 turns at 100 events each = 1000 events. Cap at maxEvents=120
      // forces the reducer to lower turns from 5 toward 3 (the floor).
      writeEvents('s3', makeTurns(10, 100));
      const { events } = readLastTurns('s3', 5, 120);
      // The reducer stops at turns=3 (300 events still > 120 but turns can't
      // go lower per `turns > 3`).
      const userMessages = events.filter(e => e.type === 'user.message');
      expect(userMessages.length).toBe(3);
    });

    it('returns empty when session has no events file', () => {
      const { events, totalLines, skipped } = readLastTurns('no-such-session', 5, 2000);
      expect(events).toEqual([]);
      expect(totalLines).toBe(0);
      expect(skipped).toBe(0);
    });
  });
});
