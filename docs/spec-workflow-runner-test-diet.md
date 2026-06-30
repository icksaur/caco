# Workflow runner test diet

Mini-spec. Parent: `docs/spec-budget.md` (the workflow runner is the budget's core).

## Problem

`tests/unit/workflow-runner.test.ts` has 12 `runWorkflow` tests plus an
`isWorkflowRunnerAvailable()` test that triggers the cached tsx probe — ~13 subprocess
spawns total (node start + esbuild transform of the generated harness, ~1.3 s cold each).
That is integration cost wearing a unit-test label — "heavy" and "unit" don't match. The
transform floor per spawn can't be shaved; the only lever is **spawning far fewer times**.

## Goals

1. Most of the file's assertions become **true in-process unit tests** (microseconds, no
   spawn), by testing the runner's pure logic directly.
2. Keep a **minimal integration smoke set** (~4 real spawns) for the genuinely
   end-to-end behaviors (spawn→emit, timeout, child reap, log-cap).
3. ~13 spawns → ~4. Target wall time ~5 s, deterministic under load.
4. No production behavior change — pure refactor + test re-layering.

## Code analysis — what needs a subprocess vs. what doesn't

`runWorkflow` (`src/workflow/runner.ts`) embeds two pure concerns that today can only be
exercised by running a child:

- **Harness runtime** (`buildHarness`, lines ~141-198): the generated `emit` / `__write` /
  `__account` logic — emit-once-wins, JSON-serializable check, undefined handling, and the
  `observedBytes` / `commandCount` accounting. Pure functions of (value, prior state),
  currently inlined as a generated string so only a spawn can test them.
- **Envelope classifier** (lines ~310-340): given the parsed result envelope + `timedOut` +
  `exitCode` + file size, produce the `WorkflowRunResult` outcome (ok / error / no-emit /
  oversized / invalid-JSON). Pure, but inlined inside `runWorkflow`.

Subprocess-only (irreducible integration): spawn→emit happy path, wall-clock timeout, child
tree reap, and the stdout log-cap/truncation. ~4 tests.

## Design

### Extraction A — `readEnvelopeFile` + `classifyEnvelope` (pure)
**Review blocker:** the oversized-emit check reads the result file's **size before parsing**
and short-circuits to an error without parsing (`runner.ts:311-315`); also a `null` envelope
must distinguish "no result file" from "invalid JSON". So split into two pure pieces rather
than one classifier taking `envelope | null`:

- `readEnvelopeFile(resultPath, maxBytes)` → a discriminated result:
  `{ kind: 'absent' }` | `{ kind: 'oversized'; size }` | `{ kind: 'invalid' }` |
  `{ kind: 'ok'; envelope }`. Performs exists → size(>maxBytes ⇒ oversized, no parse) →
  parse(fail ⇒ invalid). This preserves **size-guard-before-parse** exactly.
- `classifyEnvelope(input: { file: ReadEnvelopeResult; timedOut: boolean; exitCode: number | null; timeoutMs: number; common })` → `WorkflowRunResult`, preserving the **exact branch
  precedence**: envelope.ok → envelope && !ok (incl. synthesized oversized/invalid errors) →
  timedOut → nonzero exit → no-emit (`runner.ts:328-340`). Oversized/invalid must still beat
  timeout/nonzero-exit, matching today.

`runWorkflow` calls both; unit tests call them directly. Covers oversized guard, invalid
JSON, no-emit, ok, error, timeout precedence — **zero spawns**.

### Extraction B — `src/workflow/harness-runtime.ts` (pure, shared)
Extract the harness's runtime helpers into a real importable module. **Critical semantic
to preserve (review):** today `emit()` validates with `JSON.stringify(value)` and *discards*
the result (`runner.ts:172-175`), then `__write(true, { value })` re-stringifies the **whole
envelope with the original `value`** (`runner.ts:162-183`) — i.e. successful emits stringify
twice, and `write` always receives the original `value`, never a precomputed JSON. The
extraction must keep this exactly (matters for side-effectful `toJSON()`/getters), so:
- `accountBytes(v: unknown): number` — the byte-counting hook body (verbatim).
- `serializeForEmit(value: unknown): { ok: true } | { ok: false; error: string }` —
  **validation-only** (attempt `JSON.stringify`, classify undefined/non-serializable); it
  does NOT return the JSON, so the caller still passes the original `value` to `write`.
- `createEmitController(write: (ok, body) => void): (value) => void` — the emit-once guard
  (`__written`) + `serializeForEmit` + `write(true, { value })` on success, or
  `write(false, { error })` then throw on failure. `write` itself (temp+rename atomic, sets
  `__written`) stays in the generated harness since it does subprocess fs I/O.

`buildHarness` imports these by URL (via the shared helper below) and wires them into the
generated `emit`/`__account` — so the **generated string shrinks** and the logic lives in one
tested place. Unit tests import the same module and assert: top-level `undefined`/function/
symbol → error; object property `undefined` allowed/omitted; `BigInt`/circular → error
envelope then throw; second `emit()` throws without overwriting the first; `accountBytes`
counts strings vs JSON correctly. **Zero spawns.**

### Shared module-URL helper (review)
Factor a generic `moduleUrl('./harness-runtime.js')` from the existing `facadeModuleUrl()`
(`runner.ts:130-134`), which resolves `./x.js` then prefers `./x.ts` when present. The child
runs under tsx, so importing a `.ts` file URL is already proven by `facade.js`; reusing the
**exact** fallback (not a plain `.js` import) is required or dev/test breaks.

### Test re-layering
- `tests/unit/workflow-runner.test.ts` → keep ONLY ~5 integration smokes that genuinely need
  a child: spawn→emit (happy path), wall-clock timeout, child tree reap, stdout log-cap, and
  **one error-path smoke** (`emit({big:1n})` non-serializable OR `throw` uncaught) — kept on
  purpose (review) so a harness *wiring* bug (e.g. the outer catch overwriting a written error
  envelope, `runner.ts:186-195`) is still caught end-to-end, not just the helper in isolation.
  Each gets a generous explicit timeout; add a top-of-file note that these are integration.
- New `tests/unit/workflow-harness-runtime.test.ts` — pure tests for `accountBytes`,
  `serializeForEmit`, `createEmitController` (emit-once-wins, non-serializable, undefined,
  property-undefined-omitted, BigInt/circular).
- New `tests/unit/workflow-classify-envelope.test.ts` — pure tests for `readEnvelopeFile` +
  `classifyEnvelope` (absent / oversized-before-parse / invalid-JSON / ok / error / timeout
  precedence).

## Considerations / risks

- **Behavior parity is the whole risk.** The extracted functions must produce byte-identical
  envelopes/outcomes to today. Mitigation: extract by *moving* the exact expressions (not
  rewriting), and keep the 4 smokes as the end-to-end guarantee that the wired harness still
  works.
- **Harness import wiring.** `buildHarness` already imports `facade.js` by file URL with a
  `.ts`-when-present fallback (`facadeModuleUrl`); reuse that exact mechanism for
  `harness-runtime` so it works both under tsx (dev/test) and compiled.
- **Don't over-extract.** The spawn/timeout/reap orchestration stays in `runWorkflow` —
  it genuinely needs a child. We are not unit-testing the kill path.
- **knip / exports.** New exports must be consumed (by harness + tests) or knip flags them;
  they are.

## Implementation plan

1. Add `src/workflow/harness-runtime.ts` (`accountBytes`, `serializeForEmit` validation-only,
   `createEmitController`). Move logic verbatim; preserve the double-stringify (write gets the
   original `value`).
2. Factor `moduleUrl()` from `facadeModuleUrl`; rewrite `buildHarness` to import + wire both
   the facade and harness-runtime helpers (string shrinks).
3. Extract `readEnvelopeFile` (exists→size→parse, size-before-parse) + `classifyEnvelope`
   (exact branch precedence) in `runner.ts`; call them from `runWorkflow`.
4. Add the two new pure unit-test files.
5. Trim `workflow-runner.test.ts` to ~5 integration smokes (incl. one error-path spawn).
6. `typecheck`/`lint:strict`/`knip`/full test; measure the file's wall time before/after.

## Acceptance

- `workflow-runner.test.ts` spawns ≤ ~5 subprocesses; file wall time roughly a third of
  today; no timeouts under full-suite load.
- New pure suites cover every emit/accounting/classify branch the old spawn tests did, plus
  the double-stringify and size-before-parse semantics the review flagged.
- Full build green; no production behavior change (smokes still pass, incl. the error-path).

## Status
- [x] Spec reviewed (GPT-5.5) — double-stringify + size-before-parse semantics locked in
- [x] Extraction A — readEnvelopeFile + classifyEnvelope
- [x] Extraction B — harness-runtime module + moduleUrl helper
- [x] Test re-layering (2 new pure files + 6 trimmed smokes)
- [x] Build green + wall-time measured

## Outcome

- `workflow-runner.test.ts`: 13 subprocess spawns → **6** (5 smokes + tsx probe); file
  ~17 s → **~12.4 s**. The residual is dominated by two *inherent* timing tests (timeout
  ~4 s, reap ~5.5 s — real wall-clock waits, not transform cost); the ~7 s of pure-transform
  overhead from the removed spawn tests is gone, which is what drove the under-load flake.
- New pure suites run in-process: `workflow-harness-runtime.test.ts` (16 tests, ~28 ms) +
  `workflow-classify-envelope.test.ts` (12 tests, ~240 ms) — 28 assertions that previously
  each cost a subprocess now cost microseconds, and cover the double-stringify and
  size-before-parse semantics the review flagged.
- No production behavior change: `buildHarness` imports the extracted helpers by URL;
  full build green.
