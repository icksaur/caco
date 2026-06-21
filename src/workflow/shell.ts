import { existsSync } from 'fs';
import { win32, posix } from 'path';

type PathApi = typeof win32;

export type ShellDialect = 'bash' | 'powershell' | 'sh';

export interface ShellSpec {
  /** Executable to spawn (absolute when resolved on PATH, else a bare name execFile resolves). */
  file: string;
  /** Args placed before the command string (the command is a single trailing argv element). */
  flagArgs: string[];
  /** Model-facing dialect label, e.g. 'bash' | 'PowerShell' | 'sh'. */
  label: string;
  dialect: ShellDialect;
}

export interface ResolveShellOptions {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Injected for tests; true when an absolute path is an executable file. */
  exists: (absPath: string) => boolean;
}

function findOnPath(
  names: string[],
  exts: string[],
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean,
  pathApi: PathApi,
): string | null {
  const rawPath = env.PATH ?? env.Path ?? env.path ?? '';
  const dirs = rawPath.split(pathApi.delimiter).filter(Boolean);
  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const full = pathApi.join(dir, name + ext);
        if (exists(full)) return full;
      }
    }
  }
  return null;
}

/**
 * Choose the shell to run `caco.sh` commands in, per platform. Pure and mockable so the
 * Windows path can be unit-tested on a non-Windows host: PATH parsing uses the
 * platform-appropriate path semantics (win32 vs posix) selected from the `platform`
 * argument, not the ambient host. Windows uses PowerShell (pwsh preferred, powershell.exe
 * fallback); other platforms use bash, then sh.
 */
export function resolveShell(opts: ResolveShellOptions): ShellSpec {
  const { platform, env, exists } = opts;
  const pathApi = platform === 'win32' ? win32 : posix;
  if (platform === 'win32') {
    const psFlags = ['-NoProfile', '-NonInteractive', '-Command'];
    const onPath = findOnPath(['pwsh', 'powershell'], ['.exe', ''], env, exists, pathApi);
    if (onPath) return { file: onPath, flagArgs: psFlags, label: 'PowerShell', dialect: 'powershell' };
    const sysRoot = env.SystemRoot ?? env.windir ?? env.WINDIR;
    if (sysRoot) {
      const builtin = win32.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      if (exists(builtin)) return { file: builtin, flagArgs: psFlags, label: 'PowerShell', dialect: 'powershell' };
    }
    return { file: 'powershell.exe', flagArgs: psFlags, label: 'PowerShell', dialect: 'powershell' };
  }
  const bash = findOnPath(['bash'], [''], env, exists, pathApi);
  if (bash) return { file: bash, flagArgs: ['-c'], label: 'bash', dialect: 'bash' };
  const sh = findOnPath(['sh'], [''], env, exists, pathApi) ?? '/bin/sh';
  return { file: sh, flagArgs: ['-c'], label: 'sh', dialect: 'sh' };
}

let cached: ShellSpec | null = null;

/** Resolve the host shell once from the real process/platform. */
export function getHostShell(): ShellSpec {
  if (!cached) cached = resolveShell({ platform: process.platform, env: process.env, exists: existsSync });
  return cached;
}

export interface ShellGuidance {
  label: string;
  /** One-line dialect banner for the model. */
  banner: string;
  /** Detach/background example in the host dialect. */
  detachExample: string;
  /** "last N lines" pipeline example in the host dialect. */
  tailExample: string;
}

/** Dialect-specific snippets so the workflow tool description is correct on the host. */
export function shellGuidance(spec: ShellSpec): ShellGuidance {
  const ps = spec.dialect === 'powershell';
  const other = ps ? 'bash' : 'PowerShell';
  return {
    label: spec.label,
    banner: `caco.sh runs in ${spec.label} on this host — write ${spec.label} syntax, not ${other}.`,
    detachExample: ps
      ? "caco.sh('Start-Process -NoNewWindow -FilePath npm -ArgumentList \\'test\\' -RedirectStandardOutput out.log -RedirectStandardError err.log')"
      : "caco.sh('setsid <cmd> >log 2>&1 < /dev/null &')",
    tailExample: ps ? 'npm test 2>&1 | Select-Object -Last 3' : 'npm test 2>&1 | tail -3',
  };
}
