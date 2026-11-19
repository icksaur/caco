import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, renameSync, rmSync, statSync, utimesSync, openSync, writeSync, closeSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readSessionTailAsync, readSessionTails, clearTailCache, decodeWindow,
  redactErrorText, clipTail, type TailFileHandle, type TailResult,
} from '../../src/sdk-session-tail.js';

let dir: string;
let file: string;
let ts = Date.parse('2026-11-17T10:00:00Z');
const at = () => new Date((ts += 1000)).toISOString();

const ev = (type: string, data: Record<string, unknown> = {}) => JSON.stringify({ type, data, id: `id${ts}`, timestamp: at(), parentId: null });
const user = (content: string) => ev('user.message', { content, transformedContent: content, interactionId: 'i' });
const assistant = (content: string, toolRequests: unknown[] = []) => ev('assistant.message', { messageId: 'm', content, toolRequests, turnId: '0' });
const turnStart = () => ev('assistant.turn_start', { turnId: '0', interactionId: 'i' });
const turnEnd = () => ev('assistant.turn_end', { turnId: '0' });
const toolStart = () => ev('tool.execution_start', { toolCallId: 't', toolName: 'view', arguments: {} });
const toolDone = () => ev('tool.execution_complete', { toolCallId: 't', success: true, result: { content: 'x' } });
const usage = () => ev('session.usage_record', { usage: {} });
const idle = () => ev('session.idle', {});
const error = (message: string) => ev('session.error', { message });
const write = (lines: string[]) => writeFileSync(file, lines.map(l => `${l}\n`).join(''));

/** A realistic completed turn ending with `final`. */
const turn = (final: string, extra: string[] = []) => [
  user('please check the PR'), turnStart(), assistant('', [{ name: 'view' }]), toolStart(), toolDone(),
  assistant(final), turnEnd(), usage(), ...extra,
];

const read = (maxBytes?: number, opts: { busy?: boolean } = {}) => readSessionTailAsync('s', maxBytes, { path: file, ...opts });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'caco-tail-'));
  file = join(dir, 'events.jsonl');
  clearTailCache();
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('tail reader window (O3)', () => {
  it('reads a small file whole and builds the context', async () => {
    write([...turn('Done. The PR is merged.'), error('boom at https://user:pw@example.com/a?sig=abc')]);
    const r = await read();
    expect(r.context).toMatchObject({
      status: 'ok', windowCoversTurn: true, lastEventType: 'session.error',
      lastUser: { source: 'user', text: 'please check the PR' },
      lastAssistant: { text: 'Done. The PR is merged.' },
      lastError: { text: 'boom at https://example.com' },
    });
  });

  it('bounds the read and drops the partial first line', async () => {
    const big = assistant('x'.repeat(5000));
    write([user('old'), big, user('[scheduler:wake] Scheduled wake.'), assistant('All quiet.'), turnEnd()]);
    const r = await read(1024);
    expect(r.context.lastUser).toMatchObject({ source: 'scheduler', text: 'Scheduled wake.' });
    expect(r.context.lastAssistant!.text).toBe('All quiet.');
  });

  it('drops a trailing line with no newline (mid-append)', async () => {
    write(turn('first answer'));
    appendFileSync(file, assistant('half written').slice(0, 40));
    const r = await read();
    expect(r.context.lastAssistant!.text).toBe('first answer');
    expect(r.context.lastEventType).toBe('session.usage_record');
  });

  it('a line longer than the window yields no events', async () => {
    write([user('q'), assistant('y'.repeat(4000))]);
    const r = await read(1000);
    expect(r).toEqual({ context: { status: 'no-events', windowCoversTurn: false } });
  });

  it('decodes whole lines only: a UTF-8 sequence cut at the window edge is dropped with its line', () => {
    const line1 = Buffer.from(`${assistant('héllo wörld €€€')}\n`, 'utf8');
    const line2 = Buffer.from(`${assistant('ünïcødé ✓')}\n`, 'utf8');
    const all = Buffer.concat([line1, line2]);
    const euro = line1.indexOf(Buffer.from('€'));
    const w = decodeWindow(all.subarray(euro + 1), true); // starts inside a 3-byte char
    expect(w.lines).toHaveLength(1);
    expect(JSON.parse(w.lines[0]).data.content).toBe('ünïcødé ✓');
    const cutEnd = decodeWindow(all.subarray(0, all.length - 3), false); // last line cut inside ✓ and unterminated
    expect(cutEnd.lines).toHaveLength(1);
  });

  it('handles short reads', async () => {
    write(turn('done?'));
    const real = await import('fs');
    const open = async (p: string): Promise<TailFileHandle> => {
      const fh = await real.promises.open(p, 'r');
      return {
        stat: () => fh.stat(),
        read: (b, o, l, pos) => fh.read(b, o, Math.min(l, 7), pos),
        close: () => fh.close(),
      };
    };
    const r = await readSessionTailAsync('s', undefined, { path: file, open });
    expect(r.context.lastAssistant!.text).toBe('done?');
  });

  it('a file that shrinks during the read uses what was read', async () => {
    write(turn('ok'));
    const size = statSync(file).size;
    const open = async (): Promise<TailFileHandle> => {
      let calls = 0;
      const data = Buffer.from(turn('ok').map(l => `${l}\n`).join(''));
      return {
        stat: async () => ({ size, mtimeMs: 1, dev: 1, ino: 1 }),
        read: async (b, o, l) => {
          if (calls++ > 0) return { bytesRead: 0 };
          const n = Math.min(l, Math.floor(data.length / 2));
          data.copy(b, o, 0, n);
          return { bytesRead: n };
        },
        close: async () => {},
      };
    };
    const r = await readSessionTailAsync('s', undefined, { path: file, open });
    expect(r.context.status).toBe('ok');
  });

  it.each(['EBUSY', 'EPERM', 'EACCES'])('%s gives unavailable with the code, never an empty context', async (code) => {
    const open = async (): Promise<TailFileHandle> => { throw Object.assign(new Error('x'), { code }); };
    const r = await readSessionTailAsync('s', undefined, { path: file, open });
    expect(r.context).toEqual({ status: 'unavailable', errorCode: code });
  });

  it('a missing file is unavailable ENOENT', async () => {
    const r = await read();
    expect(r.context).toEqual({ status: 'unavailable', errorCode: 'ENOENT' });
  });

  it('an empty file is no-events', async () => {
    writeFileSync(file, '');
    expect((await read()).context.status).toBe('no-events');
  });

  it('closes the handle even when stat fails', async () => {
    let closed = false;
    const open = async (): Promise<TailFileHandle> => ({
      stat: async () => { throw Object.assign(new Error('x'), { code: 'EBUSY' }); },
      read: async () => ({ bytesRead: 0 }),
      close: async () => { closed = true; },
    });
    expect((await readSessionTailAsync('s', undefined, { path: file, open })).context.errorCode).toBe('EBUSY');
    expect(closed).toBe(true);
  });
});

describe('tail cache (O3)', () => {
  /** Overwrite in place with the same size and mtime: only a cache can return the old text. */
  const FIXED = 1_700_000_000; // whole seconds: mtimeMs round-trips exactly
  const pin = (f: string) => utimesSync(f, FIXED, FIXED);
  const sameIdentityRewrite = (from: string, to: string) => {
    const fd = openSync(file, 'r+');
    const text = turn(from).map(l => `${l}\n`).join('');
    const pos = Buffer.from(text).indexOf(Buffer.from(from));
    writeSync(fd, Buffer.from(to), 0, Buffer.byteLength(to), pos);
    closeSync(fd);
    pin(file);
  };

  it('a hit is served while the identity is unchanged; an append invalidates it', async () => {
    ts = Date.parse('2026-11-17T10:00:00Z');
    write(turn('aaaa'));
    pin(file);
    expect((await read()).context.lastAssistant!.text).toBe('aaaa');
    ts = Date.parse('2026-11-17T10:00:00Z');
    sameIdentityRewrite('aaaa', 'bbbb');
    expect((await read()).context.lastAssistant!.text).toBe('aaaa'); // cached
    appendFileSync(file, `${assistant('cccc')}\n`);
    expect((await read()).context.lastAssistant!.text).toBe('cccc');
  });

  it('busy sessions are not cached', async () => {
    ts = Date.parse('2026-11-17T10:00:00Z');
    write(turn('aaaa'));
    pin(file);
    await read(undefined, { busy: true });
    ts = Date.parse('2026-11-17T10:00:00Z');
    sameIdentityRewrite('aaaa', 'bbbb');
    expect((await read(undefined, { busy: true })).context.lastAssistant!.text).toBe('bbbb');
  });

  it('a rename between calls (rotation) is a different file: not served from cache', async () => {
    ts = Date.parse('2026-11-17T10:00:00Z');
    write(turn('aaaa'));
    pin(file);
    const st = statSync(file);
    expect((await read()).context.lastAssistant!.text).toBe('aaaa');
    const other = join(dir, 'events.jsonl.new');
    ts = Date.parse('2026-11-17T10:00:00Z');
    writeFileSync(other, turn('zzzz').map(l => `${l}\n`).join(''));
    pin(other);
    expect(statSync(other).size).toBe(st.size);
    expect(statSync(other).mtimeMs).toBe(st.mtimeMs);
    renameSync(other, file);
    expect((await read()).context.lastAssistant!.text).toBe('zzzz');
  });

  it('maxBytes is part of the key', async () => {
    write([user('u'), assistant('a'.repeat(3000)), assistant('tail')]);
    await read();
    const small = await read(200);
    expect(small.context.windowCoversTurn).toBe(false);
  });
});

describe('concurrency and deadline (O3)', () => {
  it('runs at most 4 reads at once and returns every session', async () => {
    let inFlight = 0, max = 0;
    const readFn = async (): Promise<TailResult> => {
      inFlight++; max = Math.max(max, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return { context: { status: 'ok' } };
    };
    const items = Array.from({ length: 12 }, (_, i) => ({ sessionId: `s${i}` }));
    const out = await readSessionTails(items, { read: readFn });
    expect(max).toBe(4);
    expect(out.size).toBe(12);
  });

  it('sessions not reached or not finished by the deadline are skipped-deadline', async () => {
    const readFn = async (id: string): Promise<TailResult> => {
      await new Promise(r => setTimeout(r, id === 'slow' ? 200 : 1));
      return { context: { status: 'ok' } };
    };
    const items = [{ sessionId: 'fast' }, { sessionId: 'slow' }, { sessionId: 'later' }];
    const out = await readSessionTails(items, { read: readFn, concurrency: 1, deadlineMs: 50 });
    expect(out.get('fast')!.context.status).toBe('ok');
    expect(out.get('slow')!.context.status).toBe('skipped-deadline');
    expect(out.get('later')!.context.status).toBe('skipped-deadline');
  });

  it('passes busy through so busy sessions bypass the cache', async () => {
    const seen: boolean[] = [];
    await readSessionTails([{ sessionId: 'a', busy: true }, { sessionId: 'b' }], {
      read: async (_id, _mb, busy) => { seen.push(busy); return { context: { status: 'ok' } }; },
    });
    expect(seen.sort()).toEqual([false, true]);
  });
});

describe('excerpts and redaction', () => {
  it('assistant excerpt keeps the end with a leading ...; newlines collapsed', async () => {
    const long = `${'start '.repeat(200)}\n\nShould I merge it?`;
    write(turn(long));
    const t = (await read()).context.lastAssistant!.text;
    expect(t.startsWith('...')).toBe(true);
    expect(t.endsWith('Should I merge it?')).toBe(true);
    expect(t.length).toBe(400);
    expect(t).not.toContain('\n');
    expect(clipTail('short', 400)).toBe('short');
  });

  it('user excerpt is 200 chars; error excerpt is redacted then 200 chars', async () => {
    write([user('u'.repeat(1000)), error(`Bearer abc.def token=s3cr3t ${'k'.repeat(40)} eyJa.eyJb.sig ${'e'.repeat(400)}`)]);
    const c = (await read()).context;
    expect(c.lastUser!.text).toHaveLength(200);
    expect(c.lastError!.text.length).toBeLessThanOrEqual(200);
    expect(c.lastError!.text).not.toMatch(/abc\.def|s3cr3t|kkkk|eyJ/);
  });

  it('redacts URLs to scheme and host and key patterns', () => {
    expect(redactErrorText('GET https://u:p@api.example.com:443/v1/x?code=1 failed')).toBe('GET https://api.example.com:443 failed');
    expect(redactErrorText('api_key: abcd1234 and password=hunter2')).toBe('[redacted] and [redacted]');
    expect(redactErrorText('authorization: Bearer xyz')).not.toContain('xyz');
  });

  it.each([
    ['Bearer "se cret"'],
    ["Bearer 'se cret'"],
    ['Authorization: Bearer "se cret"'],
    ["Authorization: Bearer 'se cret'"],
    ['{"token": "se cret", "ok": 1}'],
    ["{'token': 'se cret'}"],
    ['password="se cret"'],
    ["api_key='se cret'"],
    ['"Authorization":"Bearer se-cret"'],
    ['Bearer "unterminated se cret'],
  ])('redacts the whole quoted value: %s', (input) => {
    const out = redactErrorText(`failed: ${input} end`);
    expect(out).not.toMatch(/se.?cret/);
    expect(out).toContain('[redacted]');
    expect(out.startsWith('failed: ')).toBe(true);
  });
});

describe('no ask verdict; last substantive assistant message (R6)', () => {
  it('returns only the context: no ask field, for every outcome', async () => {
    write(turn('Should we ship it today?'));
    const ok = await read();
    expect(Object.keys(ok)).toEqual(['context']);
    write([user('q'), assistant('y'.repeat(4000))]);
    clearTailCache();
    expect(Object.keys(await read(1000))).toEqual(['context']);
    const open = async (): Promise<TailFileHandle> => { throw Object.assign(new Error('x'), { code: 'EBUSY' }); };
    expect(Object.keys(await readSessionTailAsync('s', undefined, { path: file, open }))).toEqual(['context']);
  });

  it('skips tool-request-only assistant messages and lifecycle events after the message', async () => {
    write([user('go'), turnStart(), assistant('The answer is 42.'), assistant('', [{ name: 'view' }]), toolStart(), toolDone(), turnEnd(), usage(), idle()]);
    const r = await read();
    expect(r.context.lastAssistant!.text).toBe('The answer is 42.');
    expect(r.context.lastEventType).toBe('session.idle');
  });

  it('picks the message even when an error or later user input follows it', async () => {
    write([...turn('Earlier answer.'), error('network down'), user('again?'), turnStart()]);
    const r = await read();
    expect(r.context.lastAssistant!.text).toBe('Earlier answer.');
    expect(r.context.lastUser!.text).toBe('again?');
    expect(r.context.lastError!.text).toBe('network down');
  });

  it('keeps fenced text in the excerpt (no fence logic)', async () => {
    write(turn('Run this:\n```bash\necho hi\n```\nThen tell me.'));
    expect((await read()).context.lastAssistant!.text).toBe('Run this: ```bash echo hi ``` Then tell me.');
  });

  it('a turn with no assistant text has no assistant excerpt', async () => {
    write([user('hi'), turnStart(), assistant('', [{ name: 'x' }]), toolStart()]);
    expect((await read()).context.lastAssistant).toBeUndefined();
  });
});
