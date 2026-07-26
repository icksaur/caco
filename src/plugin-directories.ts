/**
 * Per-session plugin directories (docs/spec-plugin-directories.md).
 *
 * Pure normalization/validation for the Open-Plugins directories a session loads via the
 * SDK's `pluginDirectories`. Kept separate from I/O-heavy session code so the contract is
 * unit-testable and has exactly one implementation shared by every setter (slash command,
 * PATCH route, create_caco_session, caco_herd, caco_session_delegate).
 *
 * Two rules the whole feature rests on:
 *   - omitted  => don't touch the existing value
 *   - empty [] => make it empty (the explicit clear)
 * Callers distinguish those before calling here; this module only sees a concrete list.
 */

import { existsSync, statSync } from 'fs';
import { isAbsolute, resolve, normalize } from 'path';
import { toPosix } from './path-utils.js';

/** Max directories per session. Every entry is re-loaded on every resume, so this is bounded. */
export const MAX_PLUGIN_DIRECTORIES = 16;

/** The Open-Plugins manifest, and the locations the runtime looks for it in. */
const MANIFEST = 'plugin.json';
const MANIFEST_DIRS = ['.plugin', '.', '.github/plugin', '.claude-plugin'];

export interface PluginDirectoriesResult {
  /** Absolute, normalized, de-duplicated directories, input order preserved. */
  directories: string[];
  /**
   * Non-fatal notes (e.g. no plugin.json found). Surfaced to the user rather than
   * swallowed: the SDK itself only "logs and skips", which is invisible inside Caco.
   */
  warnings: string[];
}

/** Bad input the caller should surface verbatim; never thrown for a merely unusual layout. */
export class PluginDirectoryError extends Error {}

function hasManifest(dir: string): boolean {
  return MANIFEST_DIRS.some(sub => existsSync(resolve(dir, sub, MANIFEST)));
}

/**
 * Resolve and validate plugin directories for a session.
 *
 * Relative paths resolve against `sessionCwd` and the result is stored absolute: the SDK
 * resolves relative paths against the session's workingDirectory, so a later cwd change
 * would silently re-target which plugins load.
 *
 * Hard errors (throw): a path that does not exist, is not a directory, or a list over the
 * cap. These are user mistakes the SDK would otherwise skip silently.
 * Soft warning: a directory with no `plugin.json` in any known location — reported, but
 * accepted, so a future/looser layout is never blocked by Caco.
 */
export function normalizePluginDirectories(sessionCwd: string, input: string[]): PluginDirectoriesResult {
  const directories: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const raw of input) {
    const trimmed = raw.trim();
    if (!trimmed) throw new PluginDirectoryError('Plugin directory path is empty.');

    const abs = normalize(isAbsolute(trimmed) ? trimmed : resolve(sessionCwd, trimmed));
    if (!existsSync(abs)) throw new PluginDirectoryError(`Plugin directory does not exist: ${toPosix(abs)}`);
    if (!statSync(abs).isDirectory()) throw new PluginDirectoryError(`Not a directory: ${toPosix(abs)}`);

    if (seen.has(abs)) continue;
    seen.add(abs);
    directories.push(abs);

    if (!hasManifest(abs)) warnings.push(`No ${MANIFEST} found in ${toPosix(abs)}`);
  }

  // Cap the DE-DUPLICATED result: the bound exists to limit what is loaded on every
  // resume, and duplicates load once. Checking raw input would reject a harmless
  // repeated path.
  if (directories.length > MAX_PLUGIN_DIRECTORIES) {
    throw new PluginDirectoryError(`Too many plugin directories (${directories.length}); max ${MAX_PLUGIN_DIRECTORIES}.`);
  }

  return { directories, warnings };
}

/** True when two plugin-directory lists are equivalent (order-sensitive, as stored). */
export function samePluginDirectories(a: string[] | undefined, b: string[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((v, i) => v === right[i]);
}
