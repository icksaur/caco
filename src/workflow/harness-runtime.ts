/**
 * Workflow harness runtime — the pure pieces of the generated child harness,
 * extracted so they can be unit-tested in-process (no tsx subprocess spawn) and
 * shared by `buildHarness` (which imports this module by URL, like facade.js).
 *
 * Behavior here is byte-for-byte the same as the previously-inlined harness
 * string. Two semantics are load-bearing and must not drift:
 *   1. A successful emit stringifies TWICE — once here for validation (discarded)
 *      and once in the caller's `write` for the whole envelope, which always
 *      receives the ORIGINAL value (never a precomputed JSON). This matters for
 *      side-effectful `toJSON()`/getters.
 *   2. The emit-once guard and the outer-catch "write an error only if nothing
 *      was written yet" both read one shared `written` flag — owned here so the
 *      two readers can't diverge.
 */

/** Bytes a facade return value contributes to observedBytes (0 if unserializable). */
export function accountBytes(v: unknown): number {
  try {
    return Buffer.byteLength(typeof v === 'string' ? v : (JSON.stringify(v) ?? ''), 'utf8');
  } catch {
    return 0;
  }
}

/**
 * Validation-only check of an emit value. Does NOT return the JSON: the caller
 * passes the original value on to `write`, preserving the second envelope-level
 * stringify. `writeError` is what goes in the error envelope; `throwError` is the
 * message thrown back into the user script (the two differ for the non-
 * serializable case, matching the original harness).
 */
export type EmitValidation =
  | { ok: true }
  | { ok: false; writeError: string; throwError: string };

export function serializeForEmit(value: unknown): EmitValidation {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (e) {
    return {
      ok: false,
      writeError: 'emit(): value is not JSON-serializable: ' + (e instanceof Error ? e.message : String(e)),
      throwError: 'emit(): value is not JSON-serializable',
    };
  }
  if (json === undefined) {
    const msg = 'emit(): value is undefined or not JSON-serializable';
    return { ok: false, writeError: msg, throwError: msg };
  }
  return { ok: true };
}

/** Writes a result envelope. `body` carries `value` (success) or `error` (failure). */
export type EnvelopeWriter = (ok: boolean, body: Record<string, unknown>) => void;

export interface EmitController {
  /** The `emit` exposed to the user script. Throws on second call or bad value. */
  emit: (value: unknown) => void;
  /** Outer-catch fallback: write an error envelope iff nothing was written yet. */
  finalizeError: (e: unknown) => void;
}

/**
 * Owns the single `written` flag shared by emit() and the outer catch. `write`
 * does the actual (subprocess) fs temp+rename and reads live byte/command
 * counters; it never tracks `written` itself.
 */
export function createEmitController(write: EnvelopeWriter): EmitController {
  let written = false;
  return {
    emit(value: unknown): void {
      if (written) throw new Error('emit() called more than once');
      const v = serializeForEmit(value);
      if (!v.ok) {
        write(false, { error: v.writeError });
        written = true;
        throw new Error(v.throwError);
      }
      write(true, { value });
      written = true;
    },
    finalizeError(e: unknown): void {
      if (!written) {
        write(false, { error: e instanceof Error ? (e.stack || e.message) : String(e) });
        written = true;
      }
    },
  };
}
