/**
 * Instance identity (spec-session-overview): a stable `{id, name}` for this
 * Caco instance, stored in ~/.caco/instance.json and created once on first
 * start. `name` defaults to the hostname; CACO_INSTANCE_NAME overrides it at
 * runtime without rewriting the file. Cross-machine keys are `id:sessionId`.
 */

import { randomUUID } from 'crypto';
import { hostname } from 'os';
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'fs';
import { dirname, join } from 'path';
import { STORAGE_ROOT, ensureDir } from './storage-paths.js';
import { INSTANCE_NAME_OVERRIDE } from './config.js';

export interface InstanceIdentity {
  id: string;
  name: string;
}

export const INSTANCE_FILE = join(STORAGE_ROOT, 'instance.json');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_MAX = 100;

function writeAtomic(file: string, value: unknown): void {
  ensureDir(dirname(file));
  const tmp = `${file}.tmp.${process.pid}`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, JSON.stringify(value, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

const cleanName = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, NAME_MAX) : undefined;

/**
 * Read the identity file, creating it if missing. A file that exists but is
 * not a valid identity is moved aside to `instance.json.corrupt` and replaced.
 * Any other read error (e.g. EBUSY) yields an in-memory identity for this
 * process only, so a transient error never rewrites a good id.
 */
export function loadInstanceIdentity(
  file: string = INSTANCE_FILE,
  opts: { nameOverride?: string; host?: string; log?: (msg: string) => void } = {},
): InstanceIdentity {
  const host = cleanName(opts.host ?? hostname()) ?? 'caco';
  const log = opts.log ?? ((msg: string) => console.warn(msg));
  let stored: InstanceIdentity | null = null;
  let persist = true;
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf-8'));
    const r = raw as { id?: unknown; name?: unknown } | null;
    if (r && typeof r === 'object' && typeof r.id === 'string' && UUID_RE.test(r.id)) {
      stored = { id: r.id.toLowerCase(), name: cleanName(r.name) ?? host };
      persist = false;
    } else {
      log('[INSTANCE] instance.json is not a valid identity; replacing it');
      try { renameSync(file, `${file}.corrupt`); } catch { /* ignore */ }
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (e instanceof SyntaxError) {
      log('[INSTANCE] instance.json is not valid JSON; replacing it');
      try { renameSync(file, `${file}.corrupt`); } catch { /* ignore */ }
    } else if (code !== 'ENOENT') {
      log(`[INSTANCE] cannot read instance.json (${code ?? 'error'}); using a temporary identity`);
      persist = false;
    }
  }
  if (!stored) {
    stored = { id: randomUUID(), name: host };
    if (persist) {
      try { writeAtomic(file, stored); } catch (e) {
        log(`[INSTANCE] cannot write instance.json (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
      }
    }
  }
  const override = cleanName(opts.nameOverride);
  return { id: stored.id, name: override ?? stored.name };
}

let cached: InstanceIdentity | undefined;

/** This instance's identity, loaded (or created) once per process. */
export function getInstanceIdentity(): InstanceIdentity {
  cached ??= loadInstanceIdentity(INSTANCE_FILE, { nameOverride: INSTANCE_NAME_OVERRIDE });
  return { ...cached };
}
