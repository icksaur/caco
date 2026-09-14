/**
 * Workaround for SDK bundled-CLI-path resolution regressing on
 * @github/copilot@1.0.83.
 *
 * The SDK's getBundledCliPath() (in @github/copilot-sdk@1.0.8) calls
 * `import.meta.resolve('@github/copilot-<plat>-<arch>/sdk')`. In 1.0.83 the
 * platform package's `exports` map no longer publishes the `./sdk` subpath
 * (only `.` -> `./copilot.exe` on Windows / `./copilot` on POSIX), so every
 * resolve attempt throws `ERR_PACKAGE_PATH_NOT_EXPORTED` and the SDK bails
 * with:
 *
 *   "Could not resolve a @github/copilot platform package (tried
 *    @github/copilot-<plat>-<arch>). Ensure @github/copilot is installed,
 *    or pass cliPath/cliUrl to CopilotClient."
 *
 * The SDK's constructor accepts `connection: { kind: 'stdio', path }` and,
 * when present, uses `path` verbatim as `resolvedCliPath` -- skipping the
 * broken resolver entirely. So this module resolves the platform package's
 * DEFAULT export (`.`), which is guaranteed to be in the exports map (it's
 * the native binary the package exists to ship), and hands that to
 * CopilotClient.
 *
 * Using `import.meta.resolve(packageName)` -- with no subpath -- goes through
 * Node's real ESM resolver, so it correctly handles hoisting, dedupe, pnpm,
 * workspaces, and non-standard `NODE_PATH` layouts. This is why we prefer it
 * over the previous approach of manually walking `require.resolve.paths()`
 * and existsSync-ing `<platformPkg>/index.js` -- the latter was fragile and
 * silently returned null when the install layout differed from expectations
 * (observed in the 2026-09-14 failing run on Windows: paths were correct but
 * `index.js` was not at that location).
 *
 * The SDK spawns `resolvedCliPath` as a native binary unless it ends in `.js`
 * (client.js line 1745-1760), so pointing at `copilot.exe` / `copilot` is
 * exactly what it expects on this code path.
 *
 * If resolution fails (platform package genuinely not installed), returns
 * null; callers should omit the `connection` option so the SDK's own error
 * message surfaces to the user unchanged.
 *
 * Upstream: fix must land in either @github/copilot-sdk (resolve `.` instead
 * of `/sdk`, or fall back to `.` on ERR_PACKAGE_PATH_NOT_EXPORTED) or
 * @github/copilot-<plat>-<arch> (re-add "./sdk" to the exports map).
 */

import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

/**
 * Diagnostic detail from the resolver: which package names were tried,
 * where each resolved to, and (on failure) the errors from each attempt.
 * Emitted at startup so a failed resolve can be diagnosed from server.log
 * without needing a repro build.
 */
export interface CliPathDiagnostic {
  found: string | null;
  packageNames: string[];
  attempts: Array<{
    name: string;
    resolvedUrl?: string;
    resolvedPath?: string;
    exists?: boolean;
    error?: string;
  }>;
}

/**
 * Locate the platform CLI binary via `import.meta.resolve(<platformPkg>)`,
 * which routes through Node's real ESM resolver and honors the package's
 * `exports` map. On 1.0.83 the `.` export is `./copilot.exe` (Windows) or
 * `./copilot` (POSIX), i.e. the native runtime.
 */
export function resolveBundledCliPath(): string | null {
  return resolveBundledCliPathDiagnostic().found;
}

/**
 * Same as {@link resolveBundledCliPath} but returns per-attempt detail.
 * Called from ensureClient() to emit a one-line summary at startup.
 */
export function resolveBundledCliPathDiagnostic(): CliPathDiagnostic {
  const arch = process.arch;
  const variants = process.platform === 'linux' ? ['linux', 'linuxmusl'] : [process.platform];
  const packageNames = variants.map((v) => `@github/copilot-${v}-${arch}`);
  const attempts: CliPathDiagnostic['attempts'] = [];
  for (const name of packageNames) {
    try {
      // Node ships `import.meta.resolve` as sync on modern versions; TS's
      // libdef still types it Promise<string>|string, so cast defensively.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = (import.meta as any).resolve(name);
      if (typeof raw !== 'string') {
        attempts.push({ name, error: `import.meta.resolve returned non-string (${typeof raw}); this Node version may still expose the async form -- upgrade or await` });
        continue;
      }
      const resolvedPath = raw.startsWith('file:') ? fileURLToPath(raw) : raw;
      const exists = existsSync(resolvedPath);
      attempts.push({ name, resolvedUrl: raw, resolvedPath, exists });
      if (exists) {
        return { found: resolvedPath, packageNames, attempts };
      }
    } catch (e) {
      attempts.push({
        name,
        error: e instanceof Error ? `${(e as { code?: string }).code ?? e.name}: ${e.message}` : String(e),
      });
    }
  }
  return { found: null, packageNames, attempts };
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
  const d = resolveBundledCliPathDiagnostic();
  return d.found ? { kind: 'stdio', path: d.found } : null;
}
