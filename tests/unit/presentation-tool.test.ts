import { describe, it, expect } from 'vitest';
import { applyPresentationUpdate } from '../../src/presentation-tool.js';

describe('applyPresentationUpdate', () => {
  it('creates new presentation from null', () => {
    const result = applyPresentationUpdate(null, { title: 'Test', slides: ['# Slide 1'] });
    expect(result).toEqual({ title: 'Test', slides: ['# Slide 1'] });
  });

  it('sets title on existing presentation', () => {
    const result = applyPresentationUpdate({ title: 'Old', slides: ['a'] }, { title: 'New' });
    expect(result!.title).toBe('New');
    expect(result!.slides).toEqual(['a']);
  });

  it('replaces entire slide list', () => {
    const result = applyPresentationUpdate({ title: 'T', slides: ['a', 'b'] }, { slides: ['x', 'y', 'z'] });
    expect(result!.slides).toEqual(['x', 'y', 'z']);
  });

  it('appends a slide', () => {
    const result = applyPresentationUpdate({ title: 'T', slides: ['a'] }, { addSlide: 'b' });
    expect(result!.slides).toEqual(['a', 'b']);
  });

  it('inserts a slide at index', () => {
    const result = applyPresentationUpdate({ title: 'T', slides: ['a', 'c'] }, { addSlide: 'b', addSlideIndex: 1 });
    expect(result!.slides).toEqual(['a', 'b', 'c']);
  });

  it('updates a slide by index', () => {
    const result = applyPresentationUpdate({ title: 'T', slides: ['a', 'b', 'c'] }, { updateSlideIndex: 1, updateSlide: 'B' });
    expect(result!.slides).toEqual(['a', 'B', 'c']);
  });

  it('ignores update with out-of-bounds index', () => {
    const result = applyPresentationUpdate({ title: 'T', slides: ['a'] }, { updateSlideIndex: 5, updateSlide: 'X' });
    expect(result!.slides).toEqual(['a']);
  });

  it('removes a slide by index', () => {
    const result = applyPresentationUpdate({ title: 'T', slides: ['a', 'b', 'c'] }, { removeSlideIndex: 1 });
    expect(result!.slides).toEqual(['a', 'c']);
  });

  it('ignores remove with out-of-bounds index', () => {
    const result = applyPresentationUpdate({ title: 'T', slides: ['a'] }, { removeSlideIndex: 5 });
    expect(result!.slides).toEqual(['a']);
  });

  it('returns null on removeAll', () => {
    const result = applyPresentationUpdate({ title: 'T', slides: ['a'] }, { removeAll: true });
    expect(result).toBeNull();
  });

  it('enforces max slides on replace', () => {
    const slides = Array.from({ length: 150 }, (_, i) => `slide ${i}`);
    const result = applyPresentationUpdate(null, { slides });
    expect(result!.slides.length).toBe(100);
  });

  it('throws when adding beyond max slides', () => {
    const slides = Array.from({ length: 100 }, (_, i) => `slide ${i}`);
    expect(() => applyPresentationUpdate({ title: 'T', slides }, { addSlide: 'extra' }))
      .toThrow('maximum 100 slides');
  });

  it('creates from null with just addSlide', () => {
    const result = applyPresentationUpdate(null, { addSlide: '# First' });
    expect(result!.slides).toEqual(['# First']);
    expect(result!.title).toBe('');
  });
});
