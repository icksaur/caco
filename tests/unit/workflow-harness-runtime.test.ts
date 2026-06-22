import { describe, it, expect, vi } from 'vitest';
import {
  accountBytes,
  serializeForEmit,
  createEmitController,
  type EnvelopeWriter,
} from '../../src/workflow/harness-runtime.js';

describe('accountBytes', () => {
  it('counts a string by its utf8 byte length', () => {
    expect(accountBytes('abc')).toBe(3);
    expect(accountBytes('é')).toBe(2); // 2 utf8 bytes
  });

  it('counts a non-string by its JSON byte length', () => {
    expect(accountBytes({ a: 1 })).toBe(Buffer.byteLength('{"a":1}', 'utf8'));
    expect(accountBytes([1, 2])).toBe(Buffer.byteLength('[1,2]', 'utf8'));
  });

  it('treats JSON-undefined values as zero bytes', () => {
    expect(accountBytes(undefined)).toBe(0);
    expect(accountBytes(() => 1)).toBe(0); // JSON.stringify -> undefined
  });

  it('returns 0 for an unserializable value instead of throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(accountBytes(circular)).toBe(0);
  });
});

describe('serializeForEmit (validation-only)', () => {
  it('accepts a serializable value', () => {
    expect(serializeForEmit({ a: 1 })).toEqual({ ok: true });
    expect(serializeForEmit('x')).toEqual({ ok: true });
    expect(serializeForEmit(null)).toEqual({ ok: true });
  });

  it('rejects a non-serializable value with distinct write/throw messages', () => {
    const r = serializeForEmit(1n);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.writeError).toMatch(/^emit\(\): value is not JSON-serializable: /);
      expect(r.throwError).toBe('emit(): value is not JSON-serializable');
    }
  });

  it('rejects undefined (and JSON-undefined) with one shared message', () => {
    for (const v of [undefined, () => 1, Symbol('s')]) {
      const r = serializeForEmit(v);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        const msg = 'emit(): value is undefined or not JSON-serializable';
        expect(r.writeError).toBe(msg);
        expect(r.throwError).toBe(msg);
      }
    }
  });

  it('allows an object property that is undefined (omitted by JSON)', () => {
    expect(serializeForEmit({ a: 1, b: undefined })).toEqual({ ok: true });
  });
});

describe('createEmitController', () => {
  function makeWriter(): { write: EnvelopeWriter; calls: Array<{ ok: boolean; body: Record<string, unknown> }> } {
    const calls: Array<{ ok: boolean; body: Record<string, unknown> }> = [];
    const write: EnvelopeWriter = (ok, body) => { calls.push({ ok, body }); };
    return { write, calls };
  }

  it('writes a success envelope with the ORIGINAL value (no precomputed json)', () => {
    const { write, calls } = makeWriter();
    const value = { a: 1 };
    createEmitController(write).emit(value);
    expect(calls).toEqual([{ ok: true, body: { value } }]);
    expect(calls[0].body.value).toBe(value); // same reference — caller re-stringifies
  });

  it('throws on a second emit without writing again (first wins)', () => {
    const { write, calls } = makeWriter();
    const ctl = createEmitController(write);
    ctl.emit({ a: 1 });
    expect(() => ctl.emit({ a: 2 })).toThrow(/emit\(\) called more than once/);
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ value: { a: 1 } });
  });

  it('writes an error envelope and throws for a non-serializable value', () => {
    const { write, calls } = makeWriter();
    expect(() => createEmitController(write).emit(1n)).toThrow('emit(): value is not JSON-serializable');
    expect(calls).toHaveLength(1);
    expect(calls[0].ok).toBe(false);
    expect(calls[0].body.error).toMatch(/^emit\(\): value is not JSON-serializable: /);
  });

  it('writes an error envelope and throws for undefined', () => {
    const { write, calls } = makeWriter();
    expect(() => createEmitController(write).emit(undefined)).toThrow('emit(): value is undefined or not JSON-serializable');
    expect(calls[0]).toEqual({ ok: false, body: { error: 'emit(): value is undefined or not JSON-serializable' } });
  });

  it('finalizeError writes an error envelope with the stack when nothing was emitted', () => {
    const { write, calls } = makeWriter();
    createEmitController(write).finalizeError(new Error('boom'));
    expect(calls).toHaveLength(1);
    expect(calls[0].ok).toBe(false);
    expect(String(calls[0].body.error)).toMatch(/boom/);
  });

  it('finalizeError is a no-op once a value was emitted (does not overwrite)', () => {
    const { write, calls } = makeWriter();
    const ctl = createEmitController(write);
    ctl.emit({ a: 1 });
    ctl.finalizeError(new Error('late'));
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ value: { a: 1 } });
  });

  it('finalizeError does not overwrite after a failed emit either', () => {
    const { write, calls } = makeWriter();
    const ctl = createEmitController(write);
    expect(() => ctl.emit(1n)).toThrow();
    ctl.finalizeError(new Error('outer-catch'));
    expect(calls).toHaveLength(1);
    expect(calls[0].ok).toBe(false);
    expect(String(calls[0].body.error)).toMatch(/not JSON-serializable/);
  });

  it('re-stringifies the original value (locks double-stringify; side-effectful toJSON runs again)', () => {
    const { write } = makeWriter();
    const toJSON = vi.fn(() => ({ marshalled: true }));
    const value = { toJSON };
    createEmitController(write).emit(value);
    // once for validation in serializeForEmit; the caller's write does the 2nd.
    expect(toJSON).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(value)).toEqual('{"marshalled":true}');
    expect(toJSON).toHaveBeenCalledTimes(2); // proves write receives the original value
  });
});
