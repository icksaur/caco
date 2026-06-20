import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { MIME_TYPES } from '../../src/config.js';

// The viewer .js files are browser IIFEs (no DOM harness in this repo, like
// the other 5 viewers). To make the parity assertions real rather than
// tautological, extract the actual regex literals from source and test those.
// See docs/files-applet-audio.md and its impl review.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const scriptSrc = readFileSync(join(repoRoot, 'applets/files/script.js'), 'utf-8');
const sourceViewerSrc = readFileSync(join(repoRoot, 'applets/files/source-viewer.js'), 'utf-8');

/** Compile a regex literal of the form /.../flags found in source via `marker`. */
function extractRegex(src: string, marker: RegExp, label: string): RegExp {
  const m = src.match(marker);
  if (!m) throw new Error(`could not locate ${label} in source`);
  return new RegExp(m[1], m[2]);
}

// isBinaryExtension's body: `return /<body>/<flags>.test(rel`
const scriptBinaryRe = extractRegex(
  scriptSrc,
  /isBinaryExtension[\s\S]*?return \/([^/]+)\/(\w*)\.test\(rel/,
  'script.js isBinaryExtension regex'
);
// source-viewer.js: `var BINARY_RE = /<body>/<flags>;`
const sourceBinaryRe = extractRegex(
  sourceViewerSrc,
  /var BINARY_RE = \/([^/]+)\/(\w*);/,
  'source-viewer.js BINARY_RE'
);
// AudioViewer descriptor canHandle: the wav|... alternation
const audioRe = extractRegex(
  scriptSrc,
  /return \/(\\\.\(wav[^/]+)\/(\w*)\.test\(rel/,
  'AudioViewer descriptor regex'
);

const AUDIO_EXTS = ['wav', 'mp3', 'ogg', 'oga', 'm4a', 'aac', 'opus', 'flac'];

describe('audio viewer descriptor extension matching (from real source)', () => {
  it('matches every supported audio extension, case-insensitively', () => {
    for (const ext of AUDIO_EXTS) {
      expect(audioRe.test(`synth-out.${ext}`)).toBe(true);
      expect(audioRe.test(`UPPER.${ext.toUpperCase()}`)).toBe(true);
    }
  });

  it('does not match non-audio files', () => {
    for (const name of ['a.png', 'b.txt', 'c.md', 'd.html', 'e.ts', 'wav', 'x.wavy']) {
      expect(audioRe.test(name)).toBe(false);
    }
  });
});

describe('binary guards reject audio (Diff/Source must not claim it)', () => {
  it('both real binary guards reject every audio extension', () => {
    for (const ext of AUDIO_EXTS) {
      const name = `track.${ext}`;
      expect(scriptBinaryRe.test(name)).toBe(true);
      expect(sourceBinaryRe.test(name)).toBe(true);
    }
  });

  it('the two real binary guards are identical (no silent divergence)', () => {
    expect(scriptBinaryRe.source).toBe(sourceBinaryRe.source);
    expect(scriptBinaryRe.flags).toBe(sourceBinaryRe.flags);
  });
});

describe('audio MIME types', () => {
  it('serves correct non-text Content-Type for each audio extension', () => {
    const expected: Record<string, string> = {
      wav: 'audio/wav',
      mp3: 'audio/mpeg',
      ogg: 'audio/ogg',
      oga: 'audio/ogg',
      m4a: 'audio/mp4',
      aac: 'audio/aac',
      opus: 'audio/ogg',
      flac: 'audio/flac',
    };
    for (const [ext, mime] of Object.entries(expected)) {
      expect(MIME_TYPES[ext]).toBe(mime);
    }
  });

  it('audio MIME types are not text (no charset appended by /api/file)', () => {
    for (const ext of AUDIO_EXTS) {
      const mime = MIME_TYPES[ext];
      const isText = mime.startsWith('text/') || mime === 'application/json';
      expect(isText).toBe(false);
    }
  });
});
