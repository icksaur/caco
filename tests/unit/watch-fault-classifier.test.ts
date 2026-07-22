import { describe, it, expect } from 'vitest';
import { isBenignWatcherFault } from '../../src/watch-fault-classifier.js';

function watchErr(code: string, syscall = 'watch'): NodeJS.ErrnoException {
  const e = new Error(`${code}: operation not permitted, ${syscall}`) as NodeJS.ErrnoException;
  e.code = code;
  e.syscall = syscall;
  return e;
}

describe('isBenignWatcherFault', () => {
  it('treats allowlisted watch faults as benign on any platform', () => {
    for (const code of ['EPERM', 'EACCES', 'ENOENT', 'EBADF', 'ENOSPC', 'EMFILE']) {
      expect(isBenignWatcherFault(watchErr(code), 'linux')).toBe(true);
      expect(isBenignWatcherFault(watchErr(code), 'win32')).toBe(true);
    }
  });

  it('accepts UNKNOWN only on win32 (OneDrive quirk)', () => {
    expect(isBenignWatcherFault(watchErr('UNKNOWN'), 'win32')).toBe(true);
    expect(isBenignWatcherFault(watchErr('UNKNOWN'), 'linux')).toBe(false);
  });

  it('rejects non-watch syscalls even with an allowlisted code', () => {
    expect(isBenignWatcherFault(watchErr('EPERM', 'open'), 'win32')).toBe(false);
    expect(isBenignWatcherFault(watchErr('ENOENT', 'stat'), 'linux')).toBe(false);
  });

  it('rejects non-allowlisted watch codes (would-be-fatal)', () => {
    for (const code of ['EINVAL', 'EEXIST', 'ELOOP']) {
      expect(isBenignWatcherFault(watchErr(code), 'win32')).toBe(false);
    }
  });

  it('rejects errors with no code, no syscall, or non-error values', () => {
    const noCode = new Error('x') as NodeJS.ErrnoException;
    noCode.syscall = 'watch';
    expect(isBenignWatcherFault(noCode, 'win32')).toBe(false);
    expect(isBenignWatcherFault(new Error('plain'), 'win32')).toBe(false);
    expect(isBenignWatcherFault(undefined, 'win32')).toBe(false);
    expect(isBenignWatcherFault(null, 'win32')).toBe(false);
    expect(isBenignWatcherFault('EPERM', 'win32')).toBe(false);
  });
});
