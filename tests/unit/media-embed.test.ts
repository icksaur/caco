import { describe, it, expect } from 'vitest';
import { mediaEmbed } from '../../public/ts/media-embed.js';

/**
 * Oracle = an independent table of (input URL → expected fixed-template src). The
 * mapping is hand-authored here, NOT derived from the implementation, so a scrambled
 * id-extraction or a widened host match fails a concrete case.
 */
const EMBEDDABLE: Array<[string, string]> = [
  // YouTube — every accepted shape maps to the nocookie /embed/ template
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'],
  ['https://youtube.com/watch?v=dQw4w9WgXcQ&t=42', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'],
  ['https://youtu.be/dQw4w9WgXcQ', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'],
  ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'],
  ['https://www.youtube.com/shorts/abc123_-XYZ', 'https://www.youtube-nocookie.com/embed/abc123_-XYZ'],
  ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'],
  // Vimeo
  ['https://vimeo.com/123456789', 'https://player.vimeo.com/video/123456789'],
  ['https://player.vimeo.com/video/123456789', 'https://player.vimeo.com/video/123456789'],
  // Spotify — type preserved, id templated
  ['https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT', 'https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT'],
  ['https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3', 'https://open.spotify.com/embed/album/1DFixLWuPkv3KT3TnV35m3'],
  ['https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M', 'https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M'],
];

const NOT_EMBEDDABLE: string[] = [
  // Lookalike / suffix hosts must NOT match (exact-host allowlist)
  'https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ',
  'https://evilyoutube.com/watch?v=dQw4w9WgXcQ',
  'https://notvimeo.com/123456789',
  'https://open.spotify.com.evil.com/track/x',
  // Wrong/again unsupported providers
  'https://soundcloud.com/artist/track',
  'https://twitter.com/user/status/123',
  'https://example.com/watch?v=dQw4w9WgXcQ',
  // Dangerous schemes
  'javascript:alert(1)//youtube.com',
  'data:text/html,<script>alert(1)</script>',
  'file:///etc/passwd',
  // Malformed / missing id
  'not a url',
  'https://www.youtube.com/watch',
  'https://www.youtube.com/watch?v=',
  'https://vimeo.com/notanumber',
  'https://open.spotify.com/bogus/4cOdK2wGLETKBW3PvgPWqT',
  'https://open.spotify.com/track/',
];

describe('mediaEmbed', () => {
  for (const [url, src] of EMBEDDABLE) {
    it(`maps ${url}`, () => {
      const r = mediaEmbed(url);
      expect(r).not.toBeNull();
      expect(r!.src).toBe(src);
    });
  }

  for (const url of NOT_EMBEDDABLE) {
    it(`rejects ${url}`, () => {
      expect(mediaEmbed(url)).toBeNull();
    });
  }

  it('every embeddable src host is itself an allowlisted embed host', () => {
    const allowed = new Set(['www.youtube-nocookie.com', 'player.vimeo.com', 'open.spotify.com']);
    for (const [url] of EMBEDDABLE) {
      const r = mediaEmbed(url);
      expect(r).not.toBeNull();
      expect(allowed.has(new URL(r!.src).hostname)).toBe(true);
    }
  });
});
