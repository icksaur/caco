/**
 * Workaround for SDK bundled-CLI-path resolution regressing on
 * @github/copilot@1.0.83.
 *
 * The SDK's getBundledCliPath() (in @github/copilot-sdk@1.0.8) calls
 * `import.meta.resolve('@github/copilot-<plat>-<arch>/sdk')`. In 1.0.83 the
 * platform package's `exports` map no longer publishes the `./sdk` subpath
 * (only `.` -> `./copilot.exe`), so every resolve attempt throws
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` and the SDK bails with:
 *
 *   "Could not resolve a @github/copilot platform package (tried
 *    @github/copilot-<plat>-<arch>). Ensure @github/copilot is installed,
 *    or pass cliPath/cliUrl to CopilotClient."
 *
 * The SDK has a CJS-style fallback below the throw (walk the resolve paths of
 * `@github/copilot` and existsSync `<platformPkg>/index.js`) that would work
 * today -- but it is only reached when `import.meta.resolve` is NOT a function,
 * i.e. never on Node 20+. This module runs that same fallback in Caco and
 * hands the result to `CopilotClient` via `RuntimeConnection.forStdio({ path })`,
 * sidestepping the broken resolver.
 *
 * If the platform CLI index.js cannot be located, returns null. Callers should
 * omit the `connection` option in that case so the SDK's own resolver runs
 * (which may succeed on a fixed future version, or fail with the exact same
 * error you would have gotten anyway).
 *
 * Upstream: fix must land in either @github/copilot-sdk (call the correct
 * subpath, or the CJS fallback unconditionally) or @github/copilot-<plat>-<arch>
 * (re-add "./sdk" to the exports map).
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Locate the platform package's CLI entry (`<platformPkg>/index.js`) using
 * Node's CJS resolve paths, which are unaffected by the platform package's
 * `exports` map. Returns null when none of the candidate paths exist.
 */
export function resolveBundledCliPath(): string | null {
  try {
    const arch = process.arch;
    const variants = process.platform === 'linux' ? ['linux', 'linuxmusl'] : [process.platform];
    const packageNames = variants.map((v) => `@github/copilot-${v}-${arch}`);
    const req = createRequire(import.meta.url);
    const searchPaths = req.resolve.paths('@github/copilot') ?? [];
    for (const base of searchPaths) {
      for (const name of packageNames) {
        const candidate = join(base, ...name.split('/'), 'index.js');
        if (existsSync(candidate)) return candidate;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Build a StdioRuntimeConnection literal for `CopilotClient({ connection })`.
 *
 * Returned as a plain object rather than via the SDK's
 * `RuntimeConnection.forStdio()` factory so tests that mock `@github/copilot-sdk`
 * don't need to also mock `RuntimeConnection`. The shape (`kind: 'stdio'`, plus
 * an optional `path`) is a stable public interface in the SDK's `types.d.ts`.
 *
 * Returns null when no bundled CLI could be located, so callers can omit
 * `connection` and let the SDK try its own resolver instead.
 */
export function buildBundledStdioConnection(): { kind: 'stdio'; path: string } | null {
  const path = resolveBundledCliPath();
  return path ? { kind: 'stdio', path } : null;
}
