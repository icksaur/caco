import { describe, it, expect } from 'vitest';
import { resolveShell, shellGuidance, type ResolveShellOptions } from '../../src/workflow/shell.js';

function fakeExists(present: string[]): (p: string) => boolean {
  const set = new Set(present.map((p) => p.replace(/\\/g, '/')));
  return (p: string) => set.has(p.replace(/\\/g, '/'));
}

function opts(partial: Partial<ResolveShellOptions> & Pick<ResolveShellOptions, 'platform'>): ResolveShellOptions {
  return { env: {}, exists: () => false, ...partial };
}

describe('resolveShell — Windows', () => {
  const winEnv = { Path: 'C:\\Windows\\System32;C:\\Program Files\\PowerShell\\7' };

  it('prefers pwsh when on PATH', () => {
    const spec = resolveShell(opts({
      platform: 'win32',
      env: winEnv,
      exists: fakeExists(['C:/Program Files/PowerShell/7/pwsh.exe', 'C:/Windows/System32/powershell.exe']),
    }));
    expect(spec.file).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
    expect(spec.flagArgs).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(spec.label).toBe('PowerShell');
    expect(spec.dialect).toBe('powershell');
  });

  it('falls back to powershell.exe when pwsh is absent', () => {
    const spec = resolveShell(opts({
      platform: 'win32',
      env: winEnv,
      exists: fakeExists(['C:/Windows/System32/powershell.exe']),
    }));
    expect(spec.file).toBe('C:\\Windows\\System32\\powershell.exe');
    expect(spec.dialect).toBe('powershell');
  });

  it('falls back to a bare powershell.exe when nothing is found on PATH', () => {
    const spec = resolveShell(opts({ platform: 'win32', env: winEnv }));
    expect(spec.file).toBe('powershell.exe');
    expect(spec.flagArgs).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(spec.label).toBe('PowerShell');
  });

  it('uses the deterministic System32 Windows PowerShell before the bare fallback', () => {
    const spec = resolveShell(opts({
      platform: 'win32',
      env: { Path: 'C:\\nope', SystemRoot: 'C:\\Windows' },
      exists: fakeExists(['C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe']),
    }));
    expect(spec.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(spec.dialect).toBe('powershell');
  });

  it('does not resolve a .cmd shim (execFile cannot run it)', () => {
    const spec = resolveShell(opts({
      platform: 'win32',
      env: winEnv,
      exists: fakeExists(['C:/Program Files/PowerShell/7/pwsh.cmd']),
    }));
    expect(spec.file).toBe('powershell.exe');
  });
});

describe('resolveShell — Unix', () => {
  const unixEnv = { PATH: '/usr/local/bin:/usr/bin:/bin' };

  it('uses bash when present', () => {
    const spec = resolveShell(opts({
      platform: 'linux',
      env: unixEnv,
      exists: fakeExists(['/usr/bin/bash']),
    }));
    expect(spec.file).toBe('/usr/bin/bash');
    expect(spec.flagArgs).toEqual(['-c']);
    expect(spec.label).toBe('bash');
    expect(spec.dialect).toBe('bash');
  });

  it('falls back to sh when bash is absent', () => {
    const spec = resolveShell(opts({
      platform: 'darwin',
      env: unixEnv,
      exists: fakeExists(['/bin/sh']),
    }));
    expect(spec.file).toBe('/bin/sh');
    expect(spec.flagArgs).toEqual(['-c']);
    expect(spec.label).toBe('sh');
    expect(spec.dialect).toBe('sh');
  });

  it('falls back to /bin/sh when nothing is found', () => {
    const spec = resolveShell(opts({ platform: 'linux', env: unixEnv }));
    expect(spec.file).toBe('/bin/sh');
    expect(spec.dialect).toBe('sh');
  });
});

describe('shellGuidance', () => {
  it('produces PowerShell dialect snippets', () => {
    const g = shellGuidance({ file: 'pwsh', flagArgs: [], label: 'PowerShell', dialect: 'powershell' });
    expect(g.banner).toContain('PowerShell');
    expect(g.banner).toContain('not bash');
    expect(g.detachExample).toContain('Start-Process');
    expect(g.tailExample).toContain('Select-Object -Last 3');
  });

  it('produces bash dialect snippets', () => {
    const g = shellGuidance({ file: 'bash', flagArgs: [], label: 'bash', dialect: 'bash' });
    expect(g.banner).toContain('bash');
    expect(g.banner).toContain('not PowerShell');
    expect(g.detachExample).toContain('setsid');
    expect(g.tailExample).toContain('tail -3');
  });
});
