/**
 * Folder-transition stamp semantics — the `movedToRootAt` and
 * `autoArchiveTaggedAt` rules (spec-auto-park-idle-root, Acceptance 7 & 14;
 * spec-soft-archive-folder for the reaper anchor).
 *
 * These tests exercise the REAL `applyFolderChange` production function that
 * the folder PATCH route calls. Any regression in the stamp logic — dropped
 * stamp, wrong transition, wrong clock, wrong order — turns these red.
 *
 * A separate source-shape assertion below verifies the route actually calls
 * `applyFolderChange`, so removing that wiring also turns something red
 * without needing a full Express integration test.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyFolderChange } from '../../src/folder-transitions.js';
import { AUTO_ARCHIVE_FOLDER } from '../../src/config.js';
import type { SessionMeta } from '../../src/session-meta-store.js';

const T_NOW = 1_700_000_000_000;

describe('applyFolderChange — movedToRootAt stamp semantics', () => {
  it('auto-archive → root: stamps movedToRootAt, clears autoArchiveTaggedAt', () => {
    const m: SessionMeta = { name: 'x', folder: AUTO_ARCHIVE_FOLDER, autoArchiveTaggedAt: T_NOW - 1000 };
    applyFolderChange(m, undefined, T_NOW);
    expect(m.folder).toBeUndefined();
    expect(m.autoArchiveTaggedAt).toBeUndefined();
    expect(m.movedToRootAt).toBe(T_NOW);
  });

  it("user folder ('work') → root: also stamps movedToRootAt", () => {
    const m: SessionMeta = { name: 'x', folder: 'work' };
    applyFolderChange(m, undefined, T_NOW);
    expect(m.folder).toBeUndefined();
    expect(m.movedToRootAt).toBe(T_NOW);
  });

  it("user folder → other user folder ('work' → 'reading'): NO movedToRootAt stamp", () => {
    const m: SessionMeta = { name: 'x', folder: 'work' };
    applyFolderChange(m, 'reading', T_NOW);
    expect(m.folder).toBe('reading');
    expect(m.movedToRootAt).toBeUndefined();
  });

  it('root → user folder: NO movedToRootAt stamp (wrong direction)', () => {
    const m: SessionMeta = { name: 'x' };
    applyFolderChange(m, 'work', T_NOW);
    expect(m.folder).toBe('work');
    expect(m.movedToRootAt).toBeUndefined();
  });

  it('root → auto-archive: NO movedToRootAt stamp, stamps autoArchiveTaggedAt', () => {
    const m: SessionMeta = { name: 'x' };
    applyFolderChange(m, AUTO_ARCHIVE_FOLDER, T_NOW);
    expect(m.folder).toBe(AUTO_ARCHIVE_FOLDER);
    expect(m.autoArchiveTaggedAt).toBe(T_NOW);
    expect(m.movedToRootAt).toBeUndefined();
  });

  it('re-stamps movedToRootAt on a subsequent rescue (not write-once)', () => {
    const m: SessionMeta = { name: 'x', folder: AUTO_ARCHIVE_FOLDER, autoArchiveTaggedAt: 1 };
    applyFolderChange(m, undefined, 100);
    expect(m.movedToRootAt).toBe(100);
    m.folder = AUTO_ARCHIVE_FOLDER;
    m.autoArchiveTaggedAt = 200;
    applyFolderChange(m, undefined, 300);
    expect(m.movedToRootAt).toBe(300);
  });

  it('re-entering auto-archive does not overwrite an existing autoArchiveTaggedAt', () => {
    // spec-soft-archive-folder rule preserved: an unrelated PATCH naming the
    // same folder must not silently extend the reaper's window.
    const m: SessionMeta = { name: 'x', folder: AUTO_ARCHIVE_FOLDER, autoArchiveTaggedAt: 42 };
    applyFolderChange(m, AUTO_ARCHIVE_FOLDER, T_NOW);
    expect(m.autoArchiveTaggedAt).toBe(42);
  });
});

// ============================================================================
// Source-shape assertion — the route actually calls applyFolderChange.
// If someone rips the wiring out but leaves the function, unit tests above
// still pass; this assertion turns red instead.
// ============================================================================

describe('folder PATCH route source-shape — calls applyFolderChange', () => {
  it('src/routes/sessions.ts imports and invokes applyFolderChange in the folder-set block', () => {
    const routePath = join(process.cwd(), 'src', 'routes', 'sessions.ts');
    const src = readFileSync(routePath, 'utf8');
    expect(src).toMatch(/import\s*\{\s*applyFolderChange\s*\}\s*from\s*['"]\.\.\/folder-transitions\.js['"]/);
    expect(src).toMatch(/applyFolderChange\(meta,\s*next,\s*Date\.now\(\)\)/);
  });
});
