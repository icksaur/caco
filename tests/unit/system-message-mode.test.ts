import { describe, it, expect } from 'vitest';
import {
  toSdkSystemMessage, SDK_PROSE_SECTIONS, readSdkSectionIds, verifySdkProseSections,
  diffProseSections,
} from '../../src/prompts.js';

/**
 * Caco means "use my prose instead of the SDK's". Expressing that as the SDK's
 * `mode: 'replace'` also discarded the `custom_instructions` section, so every
 * Caco session ran without the user's AGENTS.md, .github/copilot-instructions.md,
 * and ~/.copilot/copilot-instructions.md -- silently, with no way for the session
 * or its caller to notice. See instruction-loading-results.md.
 */
describe('toSdkSystemMessage', () => {
  it('never sends the SDK replace mode, which destroys custom instructions', () => {
    const sent = toSdkSystemMessage({ mode: 'replace', content: 'caco prose' });
    expect(sent.mode).toBe('customize');
    // Top-level `content` is the append-style escape hatch; customize must not
    // carry one, or the prose would ride along after the sections.
    expect(sent).not.toHaveProperty('content');
  });

  it('leaves custom_instructions unmentioned so the SDK preserves it', () => {
    const sent = toSdkSystemMessage({ mode: 'replace', content: 'caco prose' });
    if (sent.mode !== 'customize') throw new Error('expected customize');
    expect(Object.keys(sent.sections)).not.toContain('custom_instructions');
  });

  it("puts Caco's prose in identity and removes the SDK's own prose", () => {
    const sent = toSdkSystemMessage({ mode: 'replace', content: 'caco prose' });
    if (sent.mode !== 'customize') throw new Error('expected customize');
    expect(sent.sections.identity).toEqual({ action: 'replace', content: 'caco prose' });
    for (const id of SDK_PROSE_SECTIONS) {
      expect(sent.sections[id], `section ${id}`).toEqual({ action: 'remove' });
    }
  });

  it('removes safety, which is content-policy prose rather than enforcement', () => {
    const sent = toSdkSystemMessage({ mode: 'replace', content: 'x' });
    if (sent.mode !== 'customize') throw new Error('expected customize');
    expect(sent.sections.safety).toEqual({ action: 'remove' });
  });

  it('passes append through untouched, since append preserves instructions', () => {
    expect(toSdkSystemMessage({ mode: 'append', content: 'memory block' }))
      .toEqual({ mode: 'append', content: 'memory block' });
  });
});

/**
 * The SDK types every section id but then widens the map with an index
 * signature, so a renamed section is not a compile error -- it is a silent
 * no-op that restores all the prose we removed. Measured: renaming every key
 * took the prompt from 5,466 to 27,107 chars with no error raised. The vendored
 * .d.ts is the only place the real ids live, so assert against it here; this
 * fails the gate on an SDK bump rather than in production. The same check runs
 * at server startup, so a bypassed gate still reports the drift.
 */
describe('SDK_PROSE_SECTIONS matches the vendored SDK', () => {
  it('names only sections the SDK actually defines', () => {
    const known = readSdkSectionIds();
    expect(known, 'vendored sdk/index.d.ts not readable').not.toBeNull();
    for (const id of SDK_PROSE_SECTIONS) expect(known, `unknown section ${id}`).toContain(id);
  });

  it('accounts for every SDK section, so none silently returns', () => {
    const drift = verifySdkProseSections();
    expect(drift).not.toBeNull();
    expect(drift).toEqual({ missing: [], unexpected: [] });
  });

  it('leaves custom_instructions out of the strip list on purpose', () => {
    expect(readSdkSectionIds()).toContain('custom_instructions');
    expect(SDK_PROSE_SECTIONS).not.toContain('custom_instructions');
  });
});

/**
 * Drift detection has to be proven to FIRE, not merely to stay quiet while
 * nothing has drifted. A verifier that always reports clean would satisfy the
 * tests above, so exercise the comparison directly against synthetic drift.
 */
describe('diffProseSections', () => {
  const declared = ['preamble', 'tone', 'safety', 'custom_instructions', 'identity'];

  it('reports clean when every declared section is handled', () => {
    expect(diffProseSections(declared, ['preamble', 'tone', 'safety']))
      .toEqual({ missing: [], unexpected: [] });
  });

  it('flags a section the SDK renamed, whose removal would silently no-op', () => {
    expect(diffProseSections(['preamble', 'tonality', 'safety', 'custom_instructions'],
      ['preamble', 'tone', 'safety']))
      .toEqual({ missing: ['tone'], unexpected: ['tonality'] });
  });

  it('flags a section the SDK added, whose prose would ship unremoved', () => {
    expect(diffProseSections([...declared, 'brand_new_prose'], ['preamble', 'tone', 'safety']))
      .toEqual({ missing: [], unexpected: ['brand_new_prose'] });
  });

  it('never flags custom_instructions, which is preserved deliberately', () => {
    expect(diffProseSections(declared, ['preamble', 'tone', 'safety']).unexpected)
      .not.toContain('custom_instructions');
  });
});
