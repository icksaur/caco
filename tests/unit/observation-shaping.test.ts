import { describe, expect, it } from 'vitest';
import { genericShaper } from '../../src/observe/shapers/generic.js';
import { tsTestBuildShaper } from '../../src/observe/shapers/ts-test-build.js';
import { selectShaper } from '../../src/observe/registry.js';
import { shapeOutput } from '../../src/observe/shape.js';
import { createObservationHook } from '../../src/observe/hook.js';
import { getThroughput, clearSession } from '../../src/session-throughput.js';
import { createRetrieveOutputTool } from '../../src/observe/retrieve-tool.js';
import { storeOutput, getOutput } from '../../src/output-store.js';
import { getSessionOutputDir } from '../../src/storage-paths.js';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { MAX_FAILURES, SHAPE_THRESHOLD_BYTES, GENERIC_HARD_CAP_BYTES } from '../../src/observe/types.js';

// Independent oracle: a failure-signal detector authored here, NOT imported from
// production. The invariant under test is that the format shaper preserves a
// superset of these signals relative to the generic floor — using production's
// own SIGNAL set would make the test circular.
const FAILURE_SIGNAL: RegExp[] = [
  /error TS\d+/,
  /\bFAIL\b/,
  /[✗✘×]/,
  /AssertionError/,
  /\bnpm ERR!/,
  /\b\d+:\d+\s+error\b/,
  /\bnot ok \d+/,
  /\bExpected\b/,
];

function signalLines(text: string): string[] {
  return text.split('\n').filter(l => FAILURE_SIGNAL.some(re => re.test(l)));
}

function pad(prefix: string, n: number): string {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n');
}

// Golden fixture: a failing vitest run buried in passing noise, padded so the
// generic floor must elide the middle.
const VITEST_FAIL = [
  pad('✓ src/a.test.ts > passes', 200),
  '',
  ' FAIL  src/math.test.ts > adds numbers',
  'AssertionError: expected 4 to be 5',
  '  Expected: 5',
  '  Received: 4',
  '    at src/math.test.ts:12:18',
  '',
  pad('✓ src/b.test.ts > passes', 200),
  '',
  'Test Files  1 failed | 2 passed (3)',
  '     Tests  1 failed | 100 passed (101)',
  '  Duration  1.2s',
].join('\n');

// Golden fixture: tsc + eslint diagnostics among noise.
const TSC_ESLINT_FAIL = [
  pad('checking', 300),
  'src/foo.ts:10:5 - error TS2322: Type \'string\' is not assignable to type \'number\'.',
  '',
  '10   const x: number = "nope";',
  '',
  '/repo/src/bar.ts',
  '  14:7  error  \'unused\' is assigned a value but never used  no-unused-vars',
  '',
  pad('checking more', 300),
  '✖ 2 problems (2 errors, 0 warnings)',
].join('\n');

describe('observation shaping — fixtures pass threshold', () => {
  it('both golden fixtures exceed the shape threshold', () => {
    expect(Buffer.byteLength(VITEST_FAIL, 'utf8')).toBeGreaterThan(SHAPE_THRESHOLD_BYTES);
    expect(Buffer.byteLength(TSC_ESLINT_FAIL, 'utf8')).toBeGreaterThan(SHAPE_THRESHOLD_BYTES);
  });
});

describe('ts-test-build shaper — detection', () => {
  it('detects vitest and tsc/eslint output, ignores plain prose', () => {
    expect(tsTestBuildShaper.detect(VITEST_FAIL, { toolName: 'bash' })).toBeGreaterThan(0);
    expect(tsTestBuildShaper.detect(TSC_ESLINT_FAIL, { toolName: 'bash' })).toBeGreaterThan(0);
    expect(tsTestBuildShaper.detect(pad('hello world line', 200), { toolName: 'bash' })).toBe(0);
  });

  it('registry selects the format shaper for matching shell output', () => {
    expect(selectShaper(VITEST_FAIL, { toolName: 'bash' }).id).toBe('ts-test-build');
    expect(selectShaper(pad('plain', 200), { toolName: 'bash' }).id).toBe('generic');
  });
});

describe('oracle — expected failure spans survive shaping', () => {
  for (const [name, raw, spans] of [
    ['vitest', VITEST_FAIL, ['FAIL  src/math.test.ts', 'AssertionError: expected 4 to be 5', 'src/math.test.ts:12:18', '1 failed | 2 passed']],
    ['tsc/eslint', TSC_ESLINT_FAIL, ['error TS2322', 'no-unused-vars', '2 problems (2 errors']],
  ] as const) {
    it(`${name}: keeps hand-picked failure spans`, () => {
      const { shaped } = tsTestBuildShaper.shape(raw);
      for (const span of spans) expect(shaped).toContain(span);
    });
  }
});

describe('oracle — format shaper preserves a superset of generic failure signals', () => {
  for (const [name, raw] of [['vitest', VITEST_FAIL], ['tsc/eslint', TSC_ESLINT_FAIL]] as const) {
    it(`${name}: every generic-surfaced signal is also in the format output`, () => {
      const genericSignals = signalLines(genericShaper.shape(raw).shaped);
      const formatShaped = tsTestBuildShaper.shape(raw).shaped;
      for (const line of genericSignals) expect(formatShaped).toContain(line.trim());
    });

    it(`${name}: shaped output is smaller than raw`, () => {
      const { shaped, dropped } = tsTestBuildShaper.shape(raw);
      expect(dropped).toBeGreaterThan(0);
      expect(shaped.length).toBeLessThan(raw.length);
    });

    it(`${name}: shaping is deterministic`, () => {
      expect(tsTestBuildShaper.shape(raw).shaped).toBe(tsTestBuildShaper.shape(raw).shaped);
    });
  }
});

describe('oracle — failure set is capped but never silently truncated', () => {
  it('elides beyond MAX_FAILURES and announces the count', () => {
    const many = Array.from({ length: MAX_FAILURES + 25 }, (_, i) => `src/f${i}.ts:1:1 - error TS2322: bad ${i}`).join('\n');
    const { shaped, preserved } = tsTestBuildShaper.shape(many);
    expect(preserved).toBeLessThanOrEqual(MAX_FAILURES + 6); // + trailing summary window
    expect(shaped).toContain('more failure lines elided');
  });
});

describe('orchestrator — thresholds and backstop', () => {
  it('returns null below threshold', () => {
    expect(shapeOutput('bash', 'short output')).toBeNull();
  });

  it('shapes shell output with the format shaper', () => {
    const decision = shapeOutput('bash', VITEST_FAIL);
    expect(decision?.shaperId).toBe('ts-test-build');
  });

  it('passes agent-bounded read output (view) through unshaped', () => {
    expect(shapeOutput('view', VITEST_FAIL)).toBeNull();
    const giantRead = 'x'.repeat(2_000_000);
    expect(shapeOutput('view', giantRead)).toBeNull();
    expect(shapeOutput('read_file', VITEST_FAIL)).toBeNull();
  });

  it('passes agent-directed searches (grep/glob) through unshaped', () => {
    expect(shapeOutput('grep', VITEST_FAIL)).toBeNull();
    expect(shapeOutput('glob', VITEST_FAIL)).toBeNull();
  });

  it('passes retrieve_output through unshaped (never re-hide recovered bytes)', () => {
    // A large retrieve_output response must not be re-shaped by the generic
    // floor — that would re-truncate the very output the agent asked to un-hide.
    const bigRecovered = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n');
    expect(shapeOutput('retrieve_output', bigRecovered)).toBeNull();
    expect(shapeOutput('retrieve_output', VITEST_FAIL)).toBeNull();
  });

  it('uses the generic backstop for unbounded non-shell tools even on test-like text', () => {
    const decision = shapeOutput('web_fetch', VITEST_FAIL);
    expect(decision?.shaperId).toBe('generic');
    expect(decision!.shaped.length).toBeLessThan(VITEST_FAIL.length);
  });
});

describe('orchestrator — byte bounding (C1: hook is the real bounding authority)', () => {
  it('bounds a single multi-megabyte line via the non-shell generic floor', () => {
    const giant = 'x'.repeat(2_000_000);
    const d = shapeOutput('web_fetch', giant);
    expect(d).not.toBeNull();
    expect(d!.shapedBytes).toBeLessThan(GENERIC_HARD_CAP_BYTES + 512);
    expect(d!.shapedBytes).toBeLessThan(d!.rawBytes);
  });

  it('bounds a handful of huge lines through the shell path', () => {
    const raw = Array.from({ length: 5 }, () => 'y'.repeat(300_000)).join('\n');
    const d = shapeOutput('bash', raw);
    expect(d).not.toBeNull();
    expect(d!.shapedBytes).toBeLessThan(GENERIC_HARD_CAP_BYTES + 512);
    expect(d!.shapedBytes).toBeLessThan(d!.rawBytes);
  });
});

describe('orchestrator — generic floor is enforced by construction (H1)', () => {
  // A failure-looking line the ts-test-build SIGNAL set does NOT match, placed in
  // the floor's head region of an otherwise ts-detected run.
  const FLOOR_FIXTURE = [
    'CUSTOM-MARKER-LINE-keep-me',
    pad('✓ passing', 400),
    ' FAIL  src/x.test.ts > boom',
    'AssertionError: nope',
    pad('✓ more', 400),
    'Test Files  1 failed (1)',
  ].join('\n');

  it('the format shaper alone drops the unrecognized head line', () => {
    expect(tsTestBuildShaper.shape(FLOOR_FIXTURE).shaped).not.toContain('CUSTOM-MARKER-LINE-keep-me');
  });

  it('the orchestrator restores it via the generic-floor union', () => {
    const d = shapeOutput('bash', FLOOR_FIXTURE);
    expect(d!.shaperId).toBe('ts-test-build');
    expect(d!.shaped).toContain('CUSTOM-MARKER-LINE-keep-me');
    expect(d!.shaped).toContain('FAIL  src/x.test.ts');
  });
});

describe('hook — field preservation and raw recovery', () => {
  const cwd = '/tmp/obs-test-unregistered';
  const ref = { id: 'obs-hook-session' };

  it('preserves non-text fields and only compacts textResultForLlm', () => {
    const hook = createObservationHook(cwd, ref);
    const result = {
      resultType: 'success' as const,
      textResultForLlm: VITEST_FAIL,
      error: undefined,
      toolTelemetry: { foo: 'bar' },
    };
    const out = hook({ toolName: 'bash', toolResult: result as never });
    expect(out?.modifiedResult).toBeDefined();
    const mod = out!.modifiedResult as unknown as {
      resultType: string;
      toolTelemetry: { foo: string };
      textResultForLlm: string;
    };
    expect(mod.resultType).toBe('success');
    expect(mod.toolTelemetry).toEqual({ foo: 'bar' });
    expect(mod.textResultForLlm).not.toBe(VITEST_FAIL);
    expect(mod.textResultForLlm).toContain('retrieve_output id=');
  });

  it('round-trips the raw output byte-identical through the store', () => {
    const id = storeOutput(ref.id, cwd, VITEST_FAIL, { type: 'raw', command: 'bash' });
    const stored = getOutput(id);
    const data = typeof stored!.data === 'string' ? stored!.data : stored!.data.toString('utf8');
    expect(data).toBe(VITEST_FAIL);
  });

  it('passes through small output unchanged (no shaping)', () => {
    const hook = createObservationHook(cwd, ref);
    const out = hook({ toolName: 'bash', toolResult: { resultType: 'success', textResultForLlm: 'ok' } as never });
    expect(out).toBeUndefined();
  });

  it('records the exact shaping savings (raw minus shaped bytes / 4)', () => {
    const recRef = { id: 'obs-shaping-record-session' };
    clearSession(recRef.id);
    const hook = createObservationHook(cwd, recRef);
    const out = hook({ toolName: 'bash', toolResult: { resultType: 'success', textResultForLlm: VITEST_FAIL } as never });

    const rawBytes = Buffer.byteLength(VITEST_FAIL, 'utf8');
    const shapedBytes = Buffer.byteLength((out!.modifiedResult as { textResultForLlm: string }).textResultForLlm, 'utf8');
    const t = getThroughput(recRef.id)!;
    expect(t.shapingShapeCount).toBe(1);
    // The shaped text the model sees carries the appended handle note, but the
    // recorded saving is measured against the pre-handle shaped bytes, so the
    // recorded value is at least the post-handle delta.
    expect(t.shapingSavedTokens).toBeGreaterThan(0);
    expect(t.shapingSavedTokens).toBeGreaterThanOrEqual(Math.round((rawBytes - shapedBytes) / 4));
    clearSession(recRef.id);
  });
});

describe('retrieve_output — session scoping (M2)', () => {
  type Handler = (args: { id: string; range?: number[]; grep?: string }) => Promise<{ textResultForLlm: string }>;

  it('refuses to return output stored under a different session', async () => {
    const ownerCwd = '/tmp/obs-owner';
    const ownerRef = { id: 'obs-owner-session' };
    const id = storeOutput(ownerRef.id, ownerCwd, 'secret payload', { type: 'raw', command: 'bash' });

    const ownerHandler = createRetrieveOutputTool(ownerCwd, ownerRef)[0].handler as Handler;
    const intruderHandler = createRetrieveOutputTool(ownerCwd, { id: 'obs-intruder-session' })[0].handler as Handler;

    const ok = await ownerHandler({ id });
    expect(ok.textResultForLlm).toContain('secret payload');

    const denied = await intruderHandler({ id });
    expect(denied.textResultForLlm).toContain('no stored output');
    expect(denied.textResultForLlm).not.toContain('secret payload');
  });

  it('authorizes legacy outputs (no sessionId in metadata) by cwd fallback', async () => {
    // Simulate a pre-P6 output: meta.json carries sessionCwd but no sessionId.
    const legacyId = 'out_legacy_' + Date.now();
    const legacySession = 'obs-legacy-session-' + Date.now();
    const legacyCwd = '/tmp/obs-legacy';
    const dir = getSessionOutputDir(legacySession);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${legacyId}.txt`), 'legacy payload');
    writeFileSync(join(dir, `${legacyId}.meta.json`), JSON.stringify({
      type: 'raw', createdAt: new Date().toISOString(), sessionCwd: legacyCwd,
    }));
    try {
      const sameCwd = createRetrieveOutputTool(legacyCwd, { id: 'unrelated-id' })[0].handler as Handler;
      const otherCwd = createRetrieveOutputTool('/tmp/obs-other', { id: 'unrelated-id' })[0].handler as Handler;

      const ok = await sameCwd({ id: legacyId });
      expect(ok.textResultForLlm).toContain('legacy payload');

      const denied = await otherCwd({ id: legacyId });
      expect(denied.textResultForLlm).toContain('no stored output');
    } finally {
      rmSync(getSessionOutputDir(legacySession), { recursive: true, force: true });
    }
  });

  it('grep filters and rejects over-long patterns', async () => {
    const cwd = '/tmp/obs-grep';
    const ref = { id: 'obs-grep-session' };
    const id = storeOutput(ref.id, cwd, 'alpha\nERROR here\nbeta', { type: 'raw', command: 'bash' });
    const handler = createRetrieveOutputTool(cwd, ref)[0].handler as Handler;

    const hit = await handler({ id, grep: 'ERROR' });
    expect(hit.textResultForLlm).toContain('ERROR here');
    expect(hit.textResultForLlm).not.toContain('alpha');

    const tooLong = await handler({ id, grep: 'x'.repeat(201) });
    expect(tooLong.textResultForLlm).toContain('too long');
  });
});
