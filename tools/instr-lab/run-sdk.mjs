#!/usr/bin/env node
// Isolate WHICH createSession option suppresses custom-instruction loading.
//
// Runs the same canary probe against the raw SDK under several option sets,
// changing one thing at a time. Caco's own options are the baseline; each
// variant removes or adds a single field.
//
// Usage: node run-sdk.mjs <labroot> <model> [variant...]
import { CopilotClient } from '@github/copilot-sdk';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
const [, , LAB, MODEL, ...only] = process.argv;
if (!LAB || !MODEL) { console.error('usage: run-sdk.mjs <labroot> <model> [variant...]'); process.exit(2); }

const tokens = Object.fromEntries(
  readFileSync(join(LAB, 'tokens.env'), 'utf8').trim().split('\n').map((l) => l.split('=')),
);
const PROMPT = readFileSync(new URL('./probe.txt', import.meta.url), 'utf8');
const CWD = join(LAB, 'proj');

// Caco's shape, reduced to the fields that could plausibly affect instruction
// assembly. Each variant differs from `caco-baseline` by exactly one field.
// `clientWd` is the CopilotClient's workingDirectory, which Caco sets to the
// SERVER's cwd rather than the session's — a candidate cause on its own.
const SYS = 'You are a helpful assistant. Marker SYSPROBE9137.';
const CACO = { configDirectory: join(homedir(), '.copilot'), enableConfigDiscovery: true };
const PROSE_SECTIONS = ['preamble', 'tone', 'tool_efficiency', 'environment_context',
  'code_change_rules', 'guidelines', 'runtime_instructions', 'last_instructions'];
const removeAll = (extra = []) => Object.fromEntries(
  [...PROSE_SECTIONS, ...extra].map((s) => [s, { action: 'remove' }]));

// The candidate fix: swap Caco's prose into the identity section and leave
// `custom_instructions` alone, so AGENTS.md and the user's global file still
// compile in. Sections not mentioned are preserved by default.
const CUSTOMIZE = {
  mode: 'customize',
  sections: { identity: { action: 'replace', content: SYS },
    guidelines: { action: 'replace', content: 'Follow the operator instructions.' } },
};
// How much of the SDK's prose is actually removable? Everything except
// `custom_instructions` is struck out here; whatever remains is the floor.
const CUSTOMIZE_MINIMAL = {
  mode: 'customize',
  sections: { identity: { action: 'replace', content: SYS }, ...removeAll(['tool_instructions']) },
};
const CUSTOMIZE_STRIP_ALL = {
  mode: 'customize',
  sections: { identity: { action: 'replace', content: SYS }, ...removeAll(['tool_instructions', 'safety']) },
};
// Does a misspelled or renamed section fail loudly or silently? The type's
// index signature accepts any string, so the compiler cannot catch it. If a
// typo silently no-ops, an SDK upgrade that renames a section would quietly
// restore all the prose we removed -- which argues for a runtime assertion
// rather than trusting the types.
const CUSTOMIZE_TYPO = {
  mode: 'customize',
  sections: { identity: { action: 'replace', content: SYS },
    ...Object.fromEntries([...PROSE_SECTIONS, 'tool_instructions', 'safety']
      .map((s) => [`${s}_RENAMED`, { action: 'remove' }])) },
};
const VARIANTS = {
  'no-systemMessage': { session: { ...CACO } },
  'sysmsg-replace': { session: { systemMessage: { mode: 'replace', content: SYS }, ...CACO } },
  'sysmsg-append': { session: { systemMessage: { mode: 'append', content: SYS }, ...CACO } },
  'sysmsg-customize': { session: { systemMessage: CUSTOMIZE, ...CACO } },
  'customize-minimal': { session: { systemMessage: CUSTOMIZE_MINIMAL, ...CACO } },
  'customize-strip-all': { session: { systemMessage: CUSTOMIZE_STRIP_ALL, ...CACO } },
  'customize-typo': { session: { systemMessage: CUSTOMIZE_TYPO, ...CACO } },
  'replace-plus-ondemand': { session: { systemMessage: { mode: 'replace', content: SYS }, ...CACO, enableOnDemandInstructionDiscovery: true } },
  // Rival causes, kept so the claim that they were ruled out stays reproducible.
  // Caco builds one shared client rooted at the SERVER's cwd and overrides
  // workingDirectory per session; and it creates sessions with streaming on.
  'client-rooted-elsewhere': { clientWd: process.env.INSTRLAB_OTHER_CWD ?? homedir(), session: { ...CACO } },
  'streaming-true': { session: { streaming: true, ...CACO } },
};

// Note: ALPHA (the user-global file) is not exercised here. It lives outside
// the fixture and mutating it is opt-in, in run-caco.sh only. The bisect needs
// just one eagerly-loaded marker to separate the modes; BRAVO and FOXTROT both
// serve, and reporting all of them keeps a partial load visible.
const results = [];
for (const [name, spec] of Object.entries(VARIANTS)) {
  if (only.length && !only.includes(name)) continue;
  const client = new CopilotClient({ workingDirectory: spec.clientWd ?? CWD });
  let text = '', err = null, applied = 'n/a', chars = 0, headings = '';
  try {
    const session = await client.createSession({
      model: MODEL, streaming: false, workingDirectory: CWD, ...spec.session,
    });
    const res = await session.sendAndWait({ prompt: PROMPT }, 180000);
    text = typeof res === 'string' ? res : (res?.content ?? res?.text ?? res?.message ?? JSON.stringify(res));
    // An option passed in the wrong shape is dropped silently. Confirm from the
    // recorded prompt that systemMessage actually took effect, so a no-op
    // variant can never masquerade as evidence. The prompt's size is recorded
    // too: keeping the instruction files is only useful if the SDK prose that
    // rides along can be removed.
    if (spec.session.systemMessage) {
      const log = join(homedir(), '.copilot', 'session-state', session.sessionId, 'events.jsonl');
      const sys = readFileSync(log, 'utf8').split('\n')
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .find((e) => e?.type === 'system.message')?.data?.content ?? '';
      applied = sys.includes('SYSPROBE9137') ? 'applied' : 'IGNORED';
      chars = sys.length;
      headings = (sys.match(/^#+ .*/gm) ?? []).map((h) => h.trim()).join(' | ');
    }
    await session.destroy?.();
  } catch (e) { err = String(e?.message ?? e); }
  await client.stop?.().catch?.(() => {});

  const found = {};
  for (const k of ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT']) {
    found[k] = text.includes(tokens[k]) ? 'LOADED' : 'absent';
  }
  found.GOLF = /GOLF\s*=\s*ABSENT/.test(text) ? 'control-ok' : 'CONTROL-FAILED';
  results.push({ variant: name, err, systemMessage: applied, promptChars: chars, headings, ...found });
  console.log(name.padEnd(24), `sysmsg:${applied}`, String(chars).padStart(6), 'chars',
    JSON.stringify(found), err ? `ERR:${err}` : '');
}

mkdirSync(join(LAB, 'results'), { recursive: true });
writeFileSync(join(LAB, 'results', `sdk-${MODEL}.json`), JSON.stringify(results, null, 2));
