/**
 * How to remove a session, given what actually survives on disk.
 *
 * A session has two halves: the SDK's `~/.copilot/session-state/<id>` and Caco's
 * `~/.caco/sessions/<id>`. Archive used to REFUSE when the SDK half was missing,
 * to avoid writing a partial archive that pretended to be whole. The refusal was
 * a trap: resume also needs the SDK half, so such a session could be neither
 * opened nor deleted and sat in the list forever. That state is reachable in
 * practice — a rotation or archive interrupted mid-way, or an external cleanup
 * of `~/.copilot`, leaves exactly this shape (a sweep of this machine once found
 * 536 Caco meta dirs with no SDK counterpart).
 *
 * So removal always has a plan; only its thoroughness varies. Nothing that still
 * exists is destroyed without first being written to an archive.
 */

export type RemovalPlan =
  /** Both halves present: export both, delete the SDK session, drop everything. */
  | { kind: 'full' }
  /** SDK half already gone: export the Caco half alone, then drop it. The SDK
   *  session must NOT be deleted — it no longer knows this id, and asking would
   *  throw and re-strand the entry. */
  | { kind: 'orphan' }
  /** Nothing on disk: the entry exists only in the in-memory cache, so just
   *  forget it. There is nothing to archive. */
  | { kind: 'cache-only' };

export function planSessionRemoval(facts: { hasSdkData: boolean; hasCacoData: boolean }): RemovalPlan {
  if (facts.hasSdkData) return { kind: 'full' };
  return facts.hasCacoData ? { kind: 'orphan' } : { kind: 'cache-only' };
}
