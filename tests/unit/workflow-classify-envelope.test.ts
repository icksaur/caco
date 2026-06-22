import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readEnvelopeFile,
  classifyEnvelope,
  type EnvelopeFileResult,
  type ClassifyInput,
} from '../../src/workflow/runner.js';

let dir: string;

beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'wf-envelope-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

const COMMON = { timeoutMs: 5000, maxBytes: 1024, logs: '', logsTruncated: false, durationMs: 1 };
function classify(partial: Partial<ClassifyInput> & { file: EnvelopeFileResult }): ReturnType<typeof classifyEnvelope> {
  return classifyEnvelope({ timedOut: false, exitCode: 0, ...COMMON, ...partial });
}

describe('readEnvelopeFile', () => {
  it('returns absent when the result file does not exist', async () => {
    expect(await readEnvelopeFile(join(dir, 'nope.json'), 1024)).toEqual({ kind: 'absent' });
  });

  it('returns oversized WITHOUT parsing when the file exceeds the cap', async () => {
    const p = join(dir, 'big.json');
    // Deliberately invalid JSON: if it parsed it would be `invalid`, proving size-before-parse.
    await writeFile(p, 'x'.repeat(50));
    const r = await readEnvelopeFile(p, 10);
    expect(r.kind).toBe('oversized');
    if (r.kind === 'oversized') expect(r.size).toBe(50);
  });

  it('returns invalid for a present, under-cap, corrupt file', async () => {
    const p = join(dir, 'bad.json');
    await writeFile(p, 'not json');
    expect(await readEnvelopeFile(p, 1024)).toEqual({ kind: 'invalid' });
  });

  it('returns ok with the parsed envelope for valid JSON', async () => {
    const p = join(dir, 'good.json');
    await writeFile(p, JSON.stringify({ ok: true, value: { a: 1 }, observedBytes: 7, commandCount: 2 }));
    const r = await readEnvelopeFile(p, 1024);
    expect(r).toEqual({ kind: 'ok', envelope: { ok: true, value: { a: 1 }, observedBytes: 7, commandCount: 2 } });
  });
});

describe('classifyEnvelope', () => {
  it('emitted: a successful envelope yields outcome=emitted with value + counters', () => {
    const r = classify({ file: { kind: 'ok', envelope: { ok: true, value: { a: 1 }, observedBytes: 7, commandCount: 2 } } });
    expect(r.outcome).toBe('emitted');
    expect(r.value).toEqual({ a: 1 });
    expect(r.observedBytes).toBe(7);
    expect(r.commandCount).toBe(2);
  });

  it('error: a !ok envelope yields outcome=error with its message', () => {
    const r = classify({ file: { kind: 'ok', envelope: { ok: false, error: 'boom' } } });
    expect(r).toMatchObject({ outcome: 'error', error: 'boom' });
  });

  it('oversized synthesizes the cap error and BEATS timeout (envelope precedes timeout)', () => {
    const r = classify({ file: { kind: 'oversized', size: 99 }, timedOut: true });
    expect(r.outcome).toBe('error');
    expect(r.error).toBe('emitted value too large (99 bytes, cap 1024); emit a compact summary instead');
  });

  it('invalid synthesizes the JSON error and beats a nonzero exit', () => {
    const r = classify({ file: { kind: 'invalid' }, exitCode: 3 });
    expect(r).toMatchObject({ outcome: 'error', error: 'result envelope was not valid JSON' });
  });

  it('timeout: no envelope + timedOut yields the timeout error', () => {
    const r = classify({ file: { kind: 'absent' }, timedOut: true, timeoutMs: 1500 });
    expect(r).toMatchObject({ outcome: 'error', error: 'workflow timed out after 1500 ms' });
  });

  it('nonzero exit: no envelope, not timed out, exit!=0 yields exit error', () => {
    const r = classify({ file: { kind: 'absent' }, exitCode: 7 });
    expect(r).toMatchObject({ outcome: 'error', error: 'workflow process exited with code 7 without calling emit()' });
  });

  it('no-emit: no envelope, exit 0, not timed out', () => {
    const r = classify({ file: { kind: 'absent' }, exitCode: 0 });
    expect(r.outcome).toBe('no-emit');
  });

  it('defaults missing counters to 0', () => {
    const r = classify({ file: { kind: 'ok', envelope: { ok: true, value: 1 } } });
    expect(r.observedBytes).toBe(0);
    expect(r.commandCount).toBe(0);
  });
});
