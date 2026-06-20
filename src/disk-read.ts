/**
 * Typed disk-read result.
 *
 * Distinguishes a legitimately-absent file (`missing` → safe to default) from a
 * read/parse failure (`corrupt` → must NOT trigger a destructive default or a
 * silent drop). Collapsing these two into a single `null`/`[]` sentinel is the
 * root of the session-disappearance and metadata-clobber bugs this module fixes.
 */

import { readFileSync, existsSync } from 'fs';
import { readFile } from 'fs/promises';

export type DiskRead<T> =
  | { ok: true; value: T }
  | { ok: false; kind: 'missing' }
  | { ok: false; kind: 'corrupt'; error: Error };

function isMissingError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/** Synchronous JSON read. Absent file → missing; read or parse throw → corrupt. */
export function readJsonFileSync<T>(path: string): DiskRead<T> {
  if (!existsSync(path)) return { ok: false, kind: 'missing' };
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf-8')) as T };
  } catch (err) {
    if (isMissingError(err)) return { ok: false, kind: 'missing' };
    return { ok: false, kind: 'corrupt', error: err as Error };
  }
}

/** Asynchronous JSON read. ENOENT → missing; any other read/parse throw → corrupt. */
export async function readJsonFile<T>(path: string): Promise<DiskRead<T>> {
  try {
    return { ok: true, value: JSON.parse(await readFile(path, 'utf-8')) as T };
  } catch (err) {
    if (isMissingError(err)) return { ok: false, kind: 'missing' };
    return { ok: false, kind: 'corrupt', error: err as Error };
  }
}
