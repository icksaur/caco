/**
 * Files applet card registry (spec-files-applet-cards) — the impossible-state pin.
 *
 * CJS-imports the SAME applets/files/card-registry.js the browser concatenates (UMD
 * tail), so these hand cases pin the shipped logic, not a copy. Oracles: the exact
 * card list per file-type × capability, the derived-id reverse map, the legacy
 * rehydrate mapping + default fallback, and a registry↔viewer drift guard.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// The repo is type:module, so the applet's UMD file exports via its browser-global
// side effect (globalThis.__filesCardRegistry), not module.exports. Require it for the
// side effect, then read the same object the browser would.
const require = createRequire(import.meta.url);
require('../../applets/files/card-registry.js');
const reg = (globalThis as unknown as { __filesCardRegistry: {
  cardsForFile: (rel: string, caps: unknown, ro?: boolean) => Array<{ id: string; verb: string; viewerType: string; mode?: string }>;
  defaultCardId: (rel: string, caps: unknown, ro?: boolean) => string | null;
  cardIdForViewerState: (v: string | undefined, m: string | undefined) => string | null;
  resolvePersistedCardId: (rel: string, caps: unknown, ro: boolean, p: unknown) => string | null;
  editViewerType: (rel: string) => string;
} }).__filesCardRegistry;

const FULL = { canEdit: true, canDiff: true };
const ids = (rel: string, caps: unknown, ro = false) => reg.cardsForFile(rel, caps, ro).map((c) => c.id);

describe('cardsForFile — the reachable card set per file type (impossible-state pin)', () => {
  it('in-cwd writable code file → [source, edit, diff]', () => {
    expect(ids('vitest.config.ts', FULL)).toEqual(['source', 'edit', 'diff']);
  });

  it('external / read-only code file drops edit AND diff → [source]', () => {
    expect(ids('vitest.config.ts', { canEdit: true, canDiff: true }, true)).toEqual(['source']);
    expect(ids('vitest.config.ts', { canEdit: false, canDiff: false })).toEqual(['source']);
  });

  it('canEdit:false drops only edit; canDiff:false drops only diff', () => {
    expect(ids('a.ts', { canEdit: false, canDiff: true })).toEqual(['source', 'diff']);
    expect(ids('a.ts', { canEdit: true, canDiff: false })).toEqual(['source', 'edit']);
  });

  it('markdown → [preview, edit, diff, source]', () => {
    expect(ids('README.md', FULL)).toEqual(['preview', 'edit', 'diff', 'source']);
  });

  it('html → [html, edit, diff, source]', () => {
    expect(ids('page.html', FULL)).toEqual(['html', 'edit', 'diff', 'source']);
  });

  it('image → [image] only (no diff, no edit — binary)', () => {
    expect(ids('logo.png', FULL)).toEqual(['image']);
    expect(ids('icon.svg', FULL)).toEqual(['image']);
  });

  it('audio → [audio] only', () => {
    expect(ids('bell.wav', FULL)).toEqual(['audio']);
  });

  it('binary non-media → [] (no viewer)', () => {
    expect(ids('archive.zip', FULL)).toEqual([]);
  });

  it('the edit card edits through the file-type editable viewer', () => {
    const md = reg.cardsForFile('a.md', FULL).find((c) => c.id === 'edit');
    const ts = reg.cardsForFile('a.ts', FULL).find((c) => c.id === 'edit');
    expect(md?.viewerType).toBe('markdown');
    expect(ts?.viewerType).toBe('source');
    expect(reg.editViewerType('a.md')).toBe('markdown');
    expect(reg.editViewerType('a.ts')).toBe('source');
  });

  it('every non-media file has exactly one edit card (no duplicate Edit verbs)', () => {
    for (const rel of ['a.ts', 'README.md', 'page.html']) {
      const editVerbs = reg.cardsForFile(rel, FULL).filter((c) => c.verb === 'Edit');
      expect(editVerbs).toHaveLength(1);
    }
  });
});

describe('defaultCardId — unchanged default selection', () => {
  it('matches today’s default viewer per type', () => {
    expect(reg.defaultCardId('README.md', FULL)).toBe('preview');
    expect(reg.defaultCardId('logo.png', FULL)).toBe('image');
    expect(reg.defaultCardId('bell.wav', FULL)).toBe('audio');
    expect(reg.defaultCardId('page.html', FULL)).toBe('html');
    expect(reg.defaultCardId('a.ts', FULL)).toBe('diff');
    expect(reg.defaultCardId('a.ts', { canEdit: true, canDiff: false })).toBe('source');
    expect(reg.defaultCardId('archive.zip', FULL)).toBeNull();
  });
});

describe('cardIdForViewerState — derived active id (never diverges)', () => {
  it('maps real (viewerType, mode) to its card id', () => {
    expect(reg.cardIdForViewerState('source', 'edit')).toBe('edit');
    expect(reg.cardIdForViewerState('source', 'view')).toBe('source');
    expect(reg.cardIdForViewerState('markdown', 'edit')).toBe('edit');
    expect(reg.cardIdForViewerState('markdown', 'view')).toBe('preview');
    expect(reg.cardIdForViewerState('diff', undefined)).toBe('diff');
    expect(reg.cardIdForViewerState('image', undefined)).toBe('image');
    expect(reg.cardIdForViewerState('bogus', 'view')).toBeNull();
  });
});

describe('resolvePersistedCardId — rehydrate mapping + default fallback', () => {
  it('prefers an explicit valid activeCard', () => {
    expect(reg.resolvePersistedCardId('a.ts', FULL, false, { activeCard: 'edit' })).toBe('edit');
  });

  it('maps a legacy (activeViewerType, mode) pair', () => {
    expect(reg.resolvePersistedCardId('a.ts', FULL, false, { activeViewerType: 'source', mode: 'edit' })).toBe('edit');
    expect(reg.resolvePersistedCardId('README.md', FULL, false, { activeViewerType: 'markdown', mode: 'view' })).toBe('preview');
    expect(reg.resolvePersistedCardId('a.ts', FULL, false, { activeViewerType: 'diff' })).toBe('diff');
  });

  it('falls back to the default card when the persisted id is not in the current list', () => {
    // edit persisted, but capabilities now forbid editing → default (source, no diff).
    expect(reg.resolvePersistedCardId('a.ts', { canEdit: false, canDiff: false }, false, { activeCard: 'edit' })).toBe('source');
    // A diff card persisted for a file whose session lost git → default source.
    expect(reg.resolvePersistedCardId('a.ts', { canEdit: true, canDiff: false }, false, { activeViewerType: 'diff' })).toBe('source');
  });

  it('empty/unknown persisted → default card', () => {
    expect(reg.resolvePersistedCardId('README.md', FULL, false, {})).toBe('preview');
    expect(reg.resolvePersistedCardId('a.ts', FULL, false, { activeCard: 'nonsense' })).toBe('diff');
  });
});

describe('registry ↔ viewer drift guard', () => {
  // The installed viewer descriptors (script.js buildViewerRegistry) and their canHandle.
  const installed: Record<string, (rel: string) => boolean> = {
    markdown: (rel) => /\.(md|markdown|mdx)$/i.test(rel),
    image: (rel) => /\.(png|jpg|jpeg|gif|webp|svg|ico)$/i.test(rel),
    html: (rel) => /\.html?$/i.test(rel),
    audio: (rel) => /\.(wav|mp3|ogg|oga|m4a|aac|opus|flac)$/i.test(rel),
    diff: (rel) => !/\.(png|jpg|jpeg|gif|webp|svg|ico|pdf|zip|gz|tar|bin|exe|class|jar|wav|mp3|ogg|oga|m4a|aac|opus|flac)$/i.test(rel),
    source: (rel) => !/\.(png|jpg|jpeg|gif|webp|svg|ico|pdf|zip|gz|tar|bin|exe|class|jar|wav|mp3|ogg|oga|m4a|aac|opus|flac)$/i.test(rel),
  };

  it('every emitted card resolves to an installed viewer whose canHandle accepts the file', () => {
    const samples = ['a.ts', 'README.md', 'page.html', 'logo.png', 'icon.svg', 'bell.wav', 'archive.zip', 'noext'];
    for (const rel of samples) {
      for (const card of reg.cardsForFile(rel, FULL)) {
        const canHandle = installed[card.viewerType];
        expect(canHandle, `card ${card.id} names uninstalled viewer ${card.viewerType}`).toBeTruthy();
        expect(canHandle(rel), `viewer ${card.viewerType} cannot handle ${rel} for card ${card.id}`).toBe(true);
      }
    }
  });
});
