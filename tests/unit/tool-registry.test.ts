import { describe, it, expect, afterEach } from 'vitest';
import { filterDisabledTools, parseDisabledToolNames, parseExcludedBuiltins, DEFAULT_EXCLUDED_BUILTINS, isDeferEligibleCacoTool, NEVER_DEFER_CACO_TOOLS, isPseudoServer } from '../../src/tool-registry.js';

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

  it('never disables the protected escape hatch, from defaults OR env', () => {
    const fromDefaults = parseDisabledToolNames(['caco_enable_tools', 'a'], undefined);
    expect(fromDefaults.has('caco_enable_tools')).toBe(false);
    expect(fromDefaults.has('a')).toBe(true);
    const fromEnv = parseDisabledToolNames([], 'caco_enable_tools, b');
    expect(fromEnv.has('caco_enable_tools')).toBe(false);
    expect(fromEnv.has('b')).toBe(true);
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

describe('isDeferEligibleCacoTool', () => {
  // The inversion (spec-defer-default-inversion): deferrable is the DEFAULT, and
  // only these four are protected. An allowlist made forgetting cost permanent
  // per-turn rent; a blocklist makes it cost a recoverable enable round-trip.
  it('protects exactly the four named tools', () => {
    expect([...NEVER_DEFER_CACO_TOOLS].sort()).toEqual(
      ['caco_docs', 'caco_enable_tools', 'caco_run_workflow', 'retrieve_output'],
    );
    for (const name of NEVER_DEFER_CACO_TOOLS) {
      expect(isDeferEligibleCacoTool(name)).toBe(false);
    }
  });

  it('caco_docs is protected as a discovery tool, reversing the old allowlist', () => {
    // Deferred ⇒ invisible ⇒ unused ⇒ stale forever: a usage signal cannot govern
    // a tool whose job is to reveal something.
    expect(isDeferEligibleCacoTool('caco_docs')).toBe(false);
  });

  it('every other Caco tool is eligible by default, including ones never listed anywhere', () => {
    for (const name of ['caco_herd', 'caco_herd_state', 'create_caco_session', 'restart_server',
      'get_session_state', 'caco_memory', 'index', 'caco_session_delegate', 'a_tool_shipped_tomorrow']) {
      expect(isDeferEligibleCacoTool(name)).toBe(true);
    }
  });

  it('a hard-disabled tool is never eligible — it already costs zero', () => {
    expect(isDeferEligibleCacoTool('register_mcp_server', { hardDisabled: true })).toBe(false);
    expect(isDeferEligibleCacoTool('register_mcp_server', { hardDisabled: false })).toBe(true);
  });
});

describe('isPseudoServer', () => {
  it('names the synthetic applet groupings, not real MCP servers', () => {
    expect(isPseudoServer('Caco')).toBe(true);
    expect(isPseudoServer('Built-in')).toBe(true);
    expect(isPseudoServer('github-mcp-server')).toBe(false);
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

  it('defaults exclude the unused ask_user tool (per-turn schema tax, never wired up)', () => {
    expect(DEFAULT_EXCLUDED_BUILTINS).toContain('builtin:ask_user');
  });

  it('defaults exclude fetch_copilot_cli_documentation (CLI docs, unused; caco_docs covers project docs)', () => {
    expect(DEFAULT_EXCLUDED_BUILTINS).toContain('builtin:fetch_copilot_cli_documentation');
  });

  it('does NOT exclude str_replace_editor (it is the SDK edit tool — excluding it breaks editing)', () => {
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
