/**
 * Folder-transition rules shared between the folder PATCH route and unit tests
 * (spec-auto-park-idle-root, spec-soft-archive-folder).
 *
 * The route stamps two anchor fields at specific folder transitions:
 *   - `autoArchiveTaggedAt` when entering the auto-archive folder (fresh grace
 *     window; the reaper's clock).
 *   - `movedToRootAt` when leaving ANY folder for root (the user's most recent
 *     statement of "this belongs at the root"; auto-park's clock, so a dragged
 *     session is not re-parked on the next tick).
 *
 * These rules used to live inline in `sessions.ts:874-895`. Extracting them
 * keeps the route thin, lets herd-tools' acquire branch reuse the same shape,
 * and makes the "movedToRootAt on any → root" contract testable directly
 * against the production function rather than a copy that could drift.
 *
 * The function mutates in place because it is designed to run inside an
 * `updateSessionMeta` callback that receives the meta by reference.
 */

import { AUTO_ARCHIVE_FOLDER } from './config.js';
import type { SessionMeta } from './session-meta-store.js';

/**
 * Apply a folder change to `meta` in place. `next` is the incoming folder
 * value (already normalised — empty/whitespace-only should be passed as
 * undefined by the caller). `now` is injected so tests can pin a clock and
 * so both the folder mutation and the stamp share a single instant.
 */
export function applyFolderChange(meta: SessionMeta, next: string | undefined, now: number): void {
  const prev = meta.folder;
  // Any-folder → root: stamp movedToRootAt so auto-park treats this as a
  // deliberate "keep at root" and defers re-parking for another idle window.
  if (prev && !next) meta.movedToRootAt = now;
  meta.folder = next;
  // Auto-archive schedule anchor: stamp on entry (fresh grace window), clear
  // on exit. The stamp-only-when-absent rule is preserved from the original
  // route so an unrelated PATCH naming the same folder does not silently
  // extend the reaper window (spec-soft-archive-folder).
  if (next === AUTO_ARCHIVE_FOLDER) {
    if (meta.autoArchiveTaggedAt === undefined) meta.autoArchiveTaggedAt = now;
  } else {
    meta.autoArchiveTaggedAt = undefined;
  }
}
