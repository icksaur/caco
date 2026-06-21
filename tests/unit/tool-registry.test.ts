import { describe, it, expect, afterEach } from 'vitest';
import { filterDisabledTools, parseDisabledToolNames, parseExcludedBuiltins, DEFAULT_EXCLUDED_BUILTINS } from '../../src/tool-registry.js';

interface FakeTool { name: string; }
const t = (name: string): FakeTool => ({ name });

afterEach(() => { delete process.env.CACO_DISABLED_TOOLS; });

describe('parseDisabledToolNames', () => {
  it('merges the config defaults with the env override', () => {
    const set = parseDisabledToolNames(['embed_media'], 'caco_extensions, caco_session_store_sql');
    expect([...set].sort()).toEqual(['caco_extensions', 'caco_session_store_sql', 'embed_media']);
  });

  it('trims, drops blanks, and ignores case differences in the env list', () => {
    const set = parseDisabledToolNames([], '  foo , ,BAR ');
    expect([...set].sort()).toEqual(['bar', 'foo']);
  });

  it('returns just the defaults when env is unset', () => {
    expect([...parseDisabledToolNames(['a', 'b'], undefined)].sort()).toEqual(['a', 'b']);
  });
});

describe('filterDisabledTools', () => {
  it('removes tools whose name is disabled (case-insensitive)', () => {
    const tools = [t('grep'), t('embed_media'), t('caco_extensions')];
    const { kept, removed } = filterDisabledTools(tools, new Set(['embed_media', 'caco_extensions']));
    expect(kept.map(x => x.name)).toEqual(['grep']);
    expect(removed.sort()).toEqual(['caco_extensions', 'embed_media']);
  });

  it('keeps everything when nothing is disabled', () => {
    const tools = [t('a'), t('b')];
    const { kept, removed } = filterDisabledTools(tools, new Set());
    expect(kept).toHaveLength(2);
    expect(removed).toEqual([]);
  });

  it('only reports removed names that were actually present', () => {
    const { removed } = filterDisabledTools([t('a')], new Set(['a', 'ghost']));
    expect(removed).toEqual(['a']);
  });
});

describe('parseExcludedBuiltins', () => {
  it('defaults exclude the shell built-ins (bash + powershell families)', () => {
    expect(DEFAULT_EXCLUDED_BUILTINS).toContain('builtin:bash');
    expect(DEFAULT_EXCLUDED_BUILTINS).toContain('builtin:powershell');
    // search/read tools are NOT excluded (separate future effort)
    expect(DEFAULT_EXCLUDED_BUILTINS).not.toContain('builtin:grep');
    expect(DEFAULT_EXCLUDED_BUILTINS).not.toContain('builtin:glob');
    expect(DEFAULT_EXCLUDED_BUILTINS).not.toContain('builtin:str_replace_editor');
  });

  it('unions the env override with the defaults, de-duped', () => {
    const out = parseExcludedBuiltins(['builtin:bash'], 'builtin:grep, builtin:bash ,builtin:glob');
    expect(out).toEqual(['builtin:bash', 'builtin:grep', 'builtin:glob']);
  });

  it('returns just the defaults when env is unset', () => {
    expect(parseExcludedBuiltins(['builtin:bash'], undefined)).toEqual(['builtin:bash']);
  });

  it('an empty env string clears nothing but adds nothing', () => {
    expect(parseExcludedBuiltins(['builtin:bash'], '')).toEqual(['builtin:bash']);
  });
});
