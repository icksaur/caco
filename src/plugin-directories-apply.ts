/**
 * Tool-side application of per-session plugin directories (docs/spec-plugin-directories.md).
 *
 * Separate from `plugin-directories.ts`, which is pure (path normalization/validation only).
 * This module owns the single I/O seam the orchestration tools use, so `caco_herd acquire`
 * and `caco_session_delegate` cannot drift from the slash command: all three go through the
 * same PATCH, which owns validation, busy-refusal, the inactive persist-only path, and the
 * active recreate-with-rollback.
 */

export interface ApplyPluginDirectoriesResult {
  ok: boolean;
  error?: string;
  /** True when the target was live and its SDK session was rebuilt to load the plugins. */
  recreated?: boolean;
  /** Non-fatal notes (e.g. a directory with no plugin.json) to relay to the model. */
  warnings?: string[];
}

/**
 * Set (or clear, with `[]`) a target session's plugin directories.
 *
 * Never throws: a plugin-config failure must not abort the surrounding tool action, so the
 * caller decides whether to proceed, and reports the reason to the model.
 */
export async function applyPluginDirectories(
  serverUrl: string,
  sessionId: string,
  dirs: string[],
): Promise<ApplyPluginDirectoriesResult> {
  try {
    const res = await fetch(`${serverUrl}/api/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pluginDirectories: dirs }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({ error: res.statusText }));
      return { ok: false, error: e.error || res.statusText };
    }
    const body = await res.json().catch(() => ({}));
    return { ok: true, recreated: !!body.pluginDirectoriesRecreated, warnings: body.pluginWarnings };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
