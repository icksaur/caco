import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, openSync, closeSync, ftruncateSync, statSync, existsSync, readFileSync, appendFileSync } from 'fs';
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
  readSessionHeadResult,
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

    describe('large file (tail path, exceeds single-string limit surrogate)', () => {
      const realTail = process.env.CACO_TAIL_READ_BYTES;
      afterEach(() => {
        if (realTail === undefined) delete process.env.CACO_TAIL_READ_BYTES;
        else process.env.CACO_TAIL_READ_BYTES = realTail;
      });

      function bigSession(sid: string, turns: number): void {
        const lines: string[] = [];
        for (let t = 0; t < turns; t++) {
          lines.push(JSON.stringify({ type: 'user.message', data: { content: `ask ${t} ${'x'.repeat(200)}` } }));
          lines.push(JSON.stringify({ type: 'assistant.message', data: { content: `reply ${t} ${'y'.repeat(200)}` } }));
        }
        const dir = sessDir(sid);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'events.jsonl'), lines.join('\n') + '\n');
      }

      it('loads the last turns from the tail without reading the whole file as one string', () => {
        process.env.CACO_TAIL_READ_BYTES = '1500'; // force the tail branch
        bigSession('lt-big', 40);
        const r = readLastTurnsResult('lt-big', 5, 2000);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        // The most recent user message must be present...
        const contents = r.value.events.map(e => (e.data as { content?: string })?.content ?? '');
        expect(contents.some(c => c.startsWith('ask 39'))) .toBe(true);
        // ...older turns are skipped, and the count is reported.
        expect(r.value.skipped).toBeGreaterThan(0);
        expect(r.value.totalLines).toBe(81); // 40*2 lines + trailing empty from final \n
        // No corrupt partial JSON leaked in (partial first line was dropped).
        expect(r.value.events.every(e => typeof e.type === 'string')).toBe(true);
      });

      it('matches whole-file semantics when the file fits under the threshold', () => {
        delete process.env.CACO_TAIL_READ_BYTES; // default 64MB → whole-file path
        bigSession('lt-small', 3);
        const r = readLastTurnsResult('lt-small', 5, 2000);
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.value.skipped).toBe(0); // all 3 turns fit in 5-turn window
          expect(r.value.events.length).toBe(6);
        }
      });
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

    it('returns the newModel of the last of several model_change events', () => {
      writeEvents('sess-21b', [
        { type: 'session.start', data: { selectedModel: 'gpt-4' } },
        { type: 'session.model_change', data: { newModel: 'claude-sonnet-4' } },
        { type: 'message', data: { content: 'hi' } },
        { type: 'session.model_change', data: { newModel: 'claude-opus-4' } },
      ]);
      expect(parseSessionModel('sess-21b')).toBe('claude-opus-4');
    });

    it('ignores model strings appearing in message content (substring guard)', () => {
      writeEvents('sess-21c', [
        { type: 'session.start', data: { selectedModel: 'gpt-4' } },
        { type: 'message', data: { content: 'the "session.model_change" wording is just text' } },
      ]);
      expect(parseSessionModel('sess-21c')).toBe('gpt-4');
    });

    it('skips malformed lines without throwing', () => {
      const dir = sessDir('sess-21d');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'events.jsonl'),
        '{"type":"session.start","data":{"selectedModel":"gpt-4"}}\n' +
        '{"type":"session.model_change","data":{ broken json\n' +
        '{"type":"session.model_change","data":{"newModel":"claude-opus-4"}}\n');
      expect(parseSessionModel('sess-21d')).toBe('claude-opus-4');
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

describe('readSessionHeadResult', () => {
  function writeRaw(sessionId: string, content: string): void {
    const dir = sessDir(sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'events.jsonl'), content);
  }

  /**
   * The reference answer, computed independently of production code: read the
   * whole file and apply the classification rules by hand. A reference derived
   * from the module under test would only prove it agrees with itself.
   */
  function fromFullRead(sessionId: string): unknown {
    const p = join(sessDir(sessionId), 'events.jsonl');
    if (!existsSync(p)) return { ok: false, kind: 'missing' };
    const parsed: unknown[] = [];
    let nonEmpty = 0;
    for (const line of readFileSync(p, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      nonEmpty++;
      try { parsed.push(JSON.parse(line)); } catch { /* malformed */ }
    }
    if (nonEmpty > 0 && parsed.length === 0) return { ok: false, kind: 'corrupt' };
    return { ok: true, value: { start: parsed[0] ?? null, hasMore: parsed.length > 1 } };
  }

  function normalize(r: ReturnType<typeof readSessionHeadResult>): unknown {
    return r.ok ? { ok: true, value: r.value } : { ok: false, kind: r.kind };
  }

  const start = JSON.stringify({ type: 'session.start', data: { context: { cwd: '/w' } } });
  const msg = JSON.stringify({ type: 'user.message', data: { content: 'hi' } });

  const shapes: Array<[string, string]> = [
    ['empty', ''],
    ['blank lines only', '\n\n\n'],
    ['start only', start],
    ['start + one', `${start}\n${msg}`],
    ['start + many', [start, msg, msg, msg, msg].join('\n')],
    ['trailing newline', `${start}\n${msg}\n`],
    ['blank lines between', `${start}\n\n\n${msg}`],
    ['garbage first line', `{not json\n${start}\n${msg}`],
    ['all garbage', '{not json\nalso not json'],
    // Window=64 cuts inside line 2. Its 39-byte prefix is a valid JSON number
    // while the whole line is not, so keeping the partial line would report a
    // second event that does not exist. This is the case lines.pop() guards.
    ['partial line parses but whole line does not', `{"type":"session.start"}\n${'1'.repeat(60)}abc`],
    ['long first line', `${JSON.stringify({ type: 'session.start', data: { context: { cwd: '/w', pad: 'x'.repeat(5000) } } })}\n${msg}`],
  ];

  // The property that makes the bounded read safe: it must answer exactly what
  // reading the whole file would answer, for every shape AND every window size —
  // including windows far too small to hold a line, which force the fallback.
  for (const windowBytes of ['64', '512', '']) {
    for (const [label, content] of shapes) {
      it(`matches the full read for "${label}" (window=${windowBytes || 'default'})`, () => {
        const id = `head-${label.replace(/\W+/g, '-')}-${windowBytes || 'def'}`;
        writeRaw(id, content);
        if (windowBytes) process.env.CACO_HEAD_READ_BYTES = windowBytes;
        else delete process.env.CACO_HEAD_READ_BYTES;
        try {
          expect(normalize(readSessionHeadResult(id))).toEqual(fromFullRead(id));
        } finally {
          delete process.env.CACO_HEAD_READ_BYTES;
        }
      });
    }
  }

  it('reports a missing events file as missing, not empty', () => {
    const r = readSessionHeadResult('head-absent');
    expect(r).toEqual({ ok: false, kind: 'missing' });
  });

  it('exposes the session.start event so discovery can read cwd', () => {
    writeRaw('head-cwd', `${start}\n${msg}`);
    const r = readSessionHeadResult('head-cwd');
    expect(r.ok && r.value.start?.type).toBe('session.start');
    expect(r.ok && r.value.hasMore).toBe(true);
  });

  it('reports hasMore false for a session that only ever started', () => {
    writeRaw('head-lonely', start);
    const r = readSessionHeadResult('head-lonely');
    expect(r.ok && r.value.hasMore).toBe(false);
  });

  // A session being appended to is the normal case at discovery time. The race
  // itself (a write landing between a stat and the read) is closed by
  // construction — there is no stat — rather than by this test, which can only
  // check the weaker property that the answer reflects the file as it is now.
  it('sees events appended after the size was last observed', () => {
    const id = 'head-appended';
    writeRaw(id, `${start}\n`);
    const path = join(sessDir(id), 'events.jsonl');
    statSync(path); // observe the one-event size, as a stat-first implementation would
    appendFileSync(path, `${msg}\n`);

    const r = readSessionHeadResult(id);
    expect(r.ok && r.value.hasMore).toBe(true);
    expect(normalize(r)).toEqual(fromFullRead(id));
  });

  // Boundedness, proven without timing: the file is 600 MiB logical (a few KiB on
  // disk, sparse) which is past Node's ~512 MiB string cap, so ANY implementation
  // that reads the whole file throws and reports corrupt. Passing means the tail
  // was never touched.
  it.skipIf(process.platform === 'win32')('answers from the head without reading a file too large to read whole', () => {
    const id = 'head-huge';
    writeRaw(id, `${start}\n${msg}\n`);
    const path = join(sessDir(id), 'events.jsonl');
    const fd = openSync(path, 'r+');
    try { ftruncateSync(fd, 600 * 1024 * 1024); } finally { closeSync(fd); }

    expect(statSync(path).size).toBeGreaterThan(0x1fffffe8);
    expect(() => readFileSync(path, 'utf-8')).toThrow(); // reading it whole is impossible

    const r = readSessionHeadResult(id);
    expect(r.ok && r.value.start?.type).toBe('session.start');
    expect(r.ok && r.value.hasMore).toBe(true);
  });
});
