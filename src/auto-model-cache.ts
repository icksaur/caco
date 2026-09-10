/**
 * Session-scoped memory of what Auto resolved to.
 *
 * `session.auto_mode_resolved` fires once, for the FIRST prompt of an auto-mode
 * session, so requests 2…N never see it. Holding it here lets every later
 * request's usage record carry the label. Display-only — pricing comes from each
 * turn's own `assistant.usage.model`, never from this.
 *
 * Entries are evicted by `disposeSessionRuntime`, the repo's per-session teardown
 * seam. Deliberately cleared there UNCONDITIONALLY rather than inside
 * `SessionRuntime.dispose()`: nothing outside its own test calls
 * `getSessionRuntime`, so no runtime object exists in practice and `dispose()`
 * never fires. Moving this into `dispose()` would leak every entry.
 */

const autoResolved = new Map<string, string>();

export function setAutoResolvedModel(sessionId: string, model: string): void {
  autoResolved.set(sessionId, model);
}

export function getAutoResolvedModel(sessionId: string): string | undefined {
  return autoResolved.get(sessionId);
}

export function clearAutoResolvedModel(sessionId: string): void {
  autoResolved.delete(sessionId);
}
