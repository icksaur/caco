/**
 * Archive round-trip preserves meta.autoName (spec-auto-name-sessions, Oracle 10).
 *
 * The archive path (session-manager.ts:exportToFile) copies the whole
 * ~/.caco/sessions/<id>/ directory into a tarball via `cpSync`, then archives
 * it with `tar.create`. Because the copy is by-directory (not schema-driven),
 * any field in meta.json rides along — including newly-added ones like
 * `autoName`.
 *
 * This test:
 *   1. Replicates the export pipeline in isolation (cpSync → tar → tar.x) so
 *      the assertion runs without booting the SessionManager singleton.
 *   2. Asserts the source of `exportToFile` still uses whole-directory `cpSync`
 *      (not a schema copy), catching a regression where someone reworks export
 *      to filter through a known-fields list and drops `autoName` silently.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'caco-archive-test-'));
});
afterEach(() => {
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('archive round-trip preserves meta.autoName (Oracle 10)', () => {
  it('exports and re-reads meta.autoName byte-for-byte via the whole-directory copy pipeline', async () => {
    const sessionId = 'roundtrip-fixture';
    const originalAutoName = 'plan the migration to Postgres';
    const originalMeta = {
      name: '',
      autoName: originalAutoName,
      currentIntent: 'now writing the schema',
      intentHistory: [{ text: 'plan the migration to Postgres', ts: 1_700_000_000_000 }],
    };

    // Set up a fixture session directory like ~/.caco/sessions/<id>/.
    const sourceDir = join(workDir, 'source-caco-sessions', sessionId);
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'meta.json'), JSON.stringify(originalMeta, null, 2));

    // Replicate the exportToFile pipeline: cpSync into a staging dir, then
    // tar.create over the staging root.
    const staging = join(workDir, 'staging');
    mkdirSync(join(staging, 'caco'), { recursive: true });
    cpSync(sourceDir, join(staging, 'caco', sessionId), { recursive: true });

    const outputTar = join(workDir, `${sessionId}.tar.gz`);
    const tar = await import('tar');
    await new Promise<void>((resolve, reject) => {
      const stream = tar.create({ gzip: true, cwd: staging }, ['.']);
      const out = createWriteStream(outputTar);
      stream.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      stream.pipe(out);
    });
    expect(existsSync(outputTar)).toBe(true);

    // Extract into a fresh directory and read the meta back.
    const extractDir = join(workDir, 'extracted');
    mkdirSync(extractDir, { recursive: true });
    await tar.x({ file: outputTar, cwd: extractDir });

    const restoredMetaPath = join(extractDir, 'caco', sessionId, 'meta.json');
    expect(existsSync(restoredMetaPath)).toBe(true);
    const restored = JSON.parse(readFileSync(restoredMetaPath, 'utf8'));

    // The load-bearing assertion: autoName survives the round trip.
    expect(restored.autoName).toBe(originalAutoName);
    // Other fields also survive — the export is not accidentally autoName-
    // specific, the whole file rides along.
    expect(restored.currentIntent).toBe('now writing the schema');
    expect(restored.intentHistory).toHaveLength(1);
  });

  it('source-shape guard: exportToFile uses whole-directory cpSync (not a schema copy)', () => {
    // Guards against a regression where someone rewires export to filter meta
    // through a schema and silently drops unknown fields like autoName.
    const src = readFileSync(join(process.cwd(), 'src', 'session-manager.ts'), 'utf8');
    // The load-bearing line: cpSync of the whole cacoBase/<id> directory.
    expect(src).toMatch(/cpSync\(join\(cacoBase,\s*sessionId\),\s*join\(staging,\s*'caco',\s*sessionId\),\s*\{\s*recursive:\s*true\s*\}\)/);
  });
});
