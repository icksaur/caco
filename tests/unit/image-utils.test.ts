import { describe, it, expect } from 'vitest';
import { parseImageDataUrl } from '../../src/image-utils.js';

describe('parseImageDataUrl', () => {
  describe('valid image data URLs', () => {
    it('parses PNG data URL', () => {
      const result = parseImageDataUrl('data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==');
      expect(result).toEqual({
        extension: 'png',
        base64Data: 'iVBORw0KGgoAAAANSUhEUg=='
      });
    });

    it('parses JPEG data URL', () => {
      const result = parseImageDataUrl('data:image/jpeg;base64,/9j/4AAQSkZJRg==');
      expect(result).toEqual({
        extension: 'jpeg',
        base64Data: '/9j/4AAQSkZJRg=='
      });
    });

    it('parses GIF data URL', () => {
      const result = parseImageDataUrl('data:image/gif;base64,R0lGODlhAQAB');
      expect(result).toEqual({
        extension: 'gif',
        base64Data: 'R0lGODlhAQAB'
      });
    });

    it('parses WebP data URL', () => {
      const result = parseImageDataUrl('data:image/webp;base64,UklGRh4AAABXRUJQVlA4');
      expect(result).toEqual({
        extension: 'webp',
        base64Data: 'UklGRh4AAABXRUJQVlA4'
      });
    });

    it('handles large base64 data', () => {
      const largeBase64 = 'A'.repeat(100000);
      const result = parseImageDataUrl(`data:image/png;base64,${largeBase64}`);
      expect(result).toEqual({
        extension: 'png',
        base64Data: largeBase64
      });
    });
  });

  describe('invalid inputs', () => {
    it('returns null for undefined', () => {
      expect(parseImageDataUrl(undefined)).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(parseImageDataUrl('')).toBeNull();
    });

    it('returns null for plain text', () => {
      expect(parseImageDataUrl('hello world')).toBeNull();
    });

    it('returns null for non-image data URL', () => {
      expect(parseImageDataUrl('data:text/plain;base64,SGVsbG8=')).toBeNull();
    });

    it('returns null for data URL without base64 encoding', () => {
      expect(parseImageDataUrl('data:image/png,raw-data-here')).toBeNull();
    });

    it('returns null for malformed data URL (missing base64 marker)', () => {
      expect(parseImageDataUrl('data:image/png;iVBORw0KGgo')).toBeNull();
    });

    it('returns null for URL without data', () => {
      expect(parseImageDataUrl('data:image/png;base64,')).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('handles extensions with numbers', () => {
      const result = parseImageDataUrl('data:image/jp2;base64,ABC123');
      expect(result).toEqual({
        extension: 'jp2',
        base64Data: 'ABC123'
      });
    });

    it('handles base64 with special characters (+, /, =)', () => {
      const result = parseImageDataUrl('data:image/png;base64,abc+def/ghi==');
      expect(result).toEqual({
        extension: 'png',
        base64Data: 'abc+def/ghi=='
      });
    });
  });
});
