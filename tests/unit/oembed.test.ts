/**
 * Tests for oembed.ts - URL detection and provider matching
 */

import { describe, it, expect } from 'vitest';
import { detectProvider, getSupportedProviders } from '../../src/oembed.js';

describe('detectProvider', () => {
  describe('YouTube', () => {
    it('detects youtube.com watch URLs', () => {
      const result = detectProvider('https://youtube.com/watch?v=dQw4w9WgXcQ');
      expect(result?.key).toBe('youtube');
      expect(result?.name).toBe('YouTube');
    });

    it('detects www.youtube.com watch URLs', () => {
      const result = detectProvider('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
      expect(result?.key).toBe('youtube');
    });

    it('detects youtu.be short URLs', () => {
      const result = detectProvider('https://youtu.be/dQw4w9WgXcQ');
      expect(result?.key).toBe('youtube');
    });

    it('detects youtube.com embed URLs', () => {
      const result = detectProvider('https://youtube.com/embed/dQw4w9WgXcQ');
      expect(result?.key).toBe('youtube');
    });

    it('detects youtube.com shorts URLs', () => {
      const result = detectProvider('https://youtube.com/shorts/dQw4w9WgXcQ');
      expect(result?.key).toBe('youtube');
    });
  });

  describe('Vimeo', () => {
    it('detects vimeo.com video URLs', () => {
      const result = detectProvider('https://vimeo.com/123456789');
      expect(result?.key).toBe('vimeo');
      expect(result?.name).toBe('Vimeo');
    });

    it('detects player.vimeo.com URLs', () => {
      const result = detectProvider('https://player.vimeo.com/video/123456789');
      expect(result?.key).toBe('vimeo');
    });
  });

  describe('SoundCloud', () => {
    it('detects soundcloud track URLs', () => {
      const result = detectProvider('https://soundcloud.com/artist-name/track-name');
      expect(result?.key).toBe('soundcloud');
      expect(result?.name).toBe('SoundCloud');
    });
  });

  describe('Spotify', () => {
    it('detects spotify track URLs', () => {
      const result = detectProvider('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC');
      expect(result?.key).toBe('spotify');
      expect(result?.name).toBe('Spotify');
    });

    it('detects spotify album URLs', () => {
      const result = detectProvider('https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3');
      expect(result?.key).toBe('spotify');
    });

    it('detects spotify playlist URLs', () => {
      const result = detectProvider('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M');
      expect(result?.key).toBe('spotify');
    });

    it('detects spotify episode URLs', () => {
      const result = detectProvider('https://open.spotify.com/episode/512ojhOuo1ktJprKbVcKyQ');
      expect(result?.key).toBe('spotify');
    });
  });

  describe('Twitter/X', () => {
    it('detects twitter.com status URLs', () => {
      const result = detectProvider('https://twitter.com/user/status/1234567890');
      expect(result?.key).toBe('twitter');
      expect(result?.name).toBe('Twitter/X');
    });

    it('detects x.com status URLs', () => {
      const result = detectProvider('https://x.com/user/status/1234567890');
      expect(result?.key).toBe('twitter');
    });
  });

  describe('Unsupported URLs', () => {
    it('returns null for unknown URLs', () => {
      expect(detectProvider('https://example.com/video')).toBeNull();
    });

    // Note: Current regex matches 'youtube.com' substring anywhere in URL.
    // This is arguably a bug - 'notyoutube.com' shouldn't match.
    // Documenting current behavior; could tighten regex with ^ anchors later.
    it('matches youtube.com substring (current behavior)', () => {
      // This matches because regex doesn't anchor to start of domain
      expect(detectProvider('https://notyoutube.com/watch?v=123')?.key).toBe('youtube');
    });

    it('returns null for empty string', () => {
      expect(detectProvider('')).toBeNull();
    });

    it('returns null for malformed URLs', () => {
      expect(detectProvider('not a url at all')).toBeNull();
    });
  });
});

describe('getSupportedProviders', () => {
  it('returns array of provider info', () => {
    const providers = getSupportedProviders();
    expect(Array.isArray(providers)).toBe(true);
    expect(providers.length).toBeGreaterThan(0);
  });

  it('includes expected providers', () => {
    const providers = getSupportedProviders();
    const keys = providers.map(p => p.key);
    
    expect(keys).toContain('youtube');
    expect(keys).toContain('vimeo');
    expect(keys).toContain('soundcloud');
    expect(keys).toContain('spotify');
    expect(keys).toContain('twitter');
  });

  it('each provider has required fields', () => {
    const providers = getSupportedProviders();
    
    for (const provider of providers) {
      expect(provider).toHaveProperty('key');
      expect(provider).toHaveProperty('name');
      expect(provider).toHaveProperty('examples');
      expect(Array.isArray(provider.examples)).toBe(true);
    }
  });
});
