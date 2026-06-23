import { describe, it, expect } from 'vitest';
import { RingBuffer, interactiveShellArgs, resolveInteractiveShell } from '../../src/terminal-manager.js';
import type { ShellSpec } from '../../src/workflow/shell.js';

function spec(dialect: ShellSpec['dialect']): ShellSpec {
  return { file: 'x', flagArgs: ['-c'], label: dialect, dialect };
}

describe('interactiveShellArgs', () => {
  it('launches PowerShell with -NoLogo (not exec flags)', () => {
    expect(interactiveShellArgs(spec('powershell'))).toEqual(['-NoLogo']);
  });

  it('passes no args for bash/sh (interactive on a tty)', () => {
    expect(interactiveShellArgs(spec('bash'))).toEqual([]);
    expect(interactiveShellArgs(spec('sh'))).toEqual([]);
  });
});

describe('resolveInteractiveShell', () => {
  const exists = (present: string[]) => (p: string) => present.includes(p);

  it('honors $SHELL (e.g. fish) on POSIX when it exists', () => {
    const r = resolveInteractiveShell({
      platform: 'linux',
      env: { SHELL: '/usr/bin/fish', PATH: '/usr/bin' },
      exists: exists(['/usr/bin/fish', '/usr/bin/bash']),
    });
    expect(r).toEqual({ file: '/usr/bin/fish', args: [] });
  });

  it('falls back to bash when $SHELL is unset', () => {
    const r = resolveInteractiveShell({
      platform: 'linux',
      env: { PATH: '/bin' },
      exists: exists(['/bin/bash']),
    });
    expect(r.file).toBe('/bin/bash');
    expect(r.args).toEqual([]);
  });

  it('falls back when $SHELL points to a missing file', () => {
    const r = resolveInteractiveShell({
      platform: 'linux',
      env: { SHELL: '/no/such/shell', PATH: '/bin' },
      exists: exists(['/bin/bash']),
    });
    expect(r.file).toBe('/bin/bash');
  });

  it('ignores $SHELL on Windows and uses PowerShell with -NoLogo', () => {
    const r = resolveInteractiveShell({
      platform: 'win32',
      env: { SHELL: '/usr/bin/fish', PATH: 'C:\\PS', Path: 'C:\\PS' },
      exists: exists(['C:\\PS\\pwsh.exe']),
    });
    expect(r.file).toBe('C:\\PS\\pwsh.exe');
    expect(r.args).toEqual(['-NoLogo']);
  });
});

describe('RingBuffer', () => {
  it('retains content under the cap', () => {
    const ring = new RingBuffer(100);
    ring.push('hello');
    ring.push(' world');
    expect(ring.snapshot()).toBe('hello world');
  });

  it('evicts oldest chunks once the byte cap is exceeded', () => {
    const ring = new RingBuffer(10);
    ring.push('aaaa');
    ring.push('bbbb');
    expect(ring.snapshot()).toBe('aaaabbbb');
    ring.push('cccc');
    expect(ring.snapshot()).toBe('bbbbcccc');
  });

  it('keeps a single oversized final chunk rather than emptying', () => {
    const ring = new RingBuffer(4);
    ring.push('this is much longer than the cap');
    expect(ring.snapshot()).toBe('this is much longer than the cap');
  });

  it('ignores empty pushes', () => {
    const ring = new RingBuffer(10);
    ring.push('');
    ring.push('x');
    expect(ring.snapshot()).toBe('x');
  });
});
