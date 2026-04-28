import { describe, it, expect } from 'vitest';
import { normalizeFolder, isValidFolder } from '../../src/folder.js';

describe('normalizeFolder', () => {
  it('empty string → root', () => expect(normalizeFolder('')).toBe(''));
  it('"/" → root', () => expect(normalizeFolder('/')).toBe(''));
  it('"root" → root', () => expect(normalizeFolder('root')).toBe(''));
  it('"ROOT" → root (case-insensitive)', () => expect(normalizeFolder('ROOT')).toBe(''));
  it('"work" → "work"', () => expect(normalizeFolder('work')).toBe('work'));
  it('"/work" strips leading slash', () => expect(normalizeFolder('/work')).toBe('work'));
  it('"work/" strips trailing slash', () => expect(normalizeFolder('work/')).toBe('work'));
  it('"work\\\\sub" normalizes backslash + depth 1', () => expect(normalizeFolder('work\\sub')).toBe('work'));
  it('"work/sub/deep" enforces depth 1', () => expect(normalizeFolder('work/sub/deep')).toBe('work'));
  it('"  work  " trims whitespace', () => expect(normalizeFolder('  work  ')).toBe('work'));
  it('"@!#$" all invalid → root', () => expect(normalizeFolder('@!#$')).toBe(''));
  it('"  " whitespace-only → root', () => expect(normalizeFolder('  ')).toBe(''));
  it('"///" all slashes → root', () => expect(normalizeFolder('///')).toBe(''));
  it('"my folder" spaces allowed', () => expect(normalizeFolder('my folder')).toBe('my folder'));
  it('"root/sub" depth enforced, then root reserved', () => expect(normalizeFolder('root/sub')).toBe(''));
  it('"my-project_1" alnum + dash + underscore', () => expect(normalizeFolder('my-project_1')).toBe('my-project_1'));
});

describe('isValidFolder', () => {
  it('"work" is valid', () => expect(isValidFolder('work')).toBe(true));
  it('"work/sub" nested not valid', () => expect(isValidFolder('work/sub')).toBe(false));
  it('"@!#$" all invalid → not valid', () => expect(isValidFolder('@!#$')).toBe(false));
  it('"@invalid" strips @ → valid as "invalid"', () => expect(isValidFolder('@invalid')).toBe(true));
  it('"/" is valid (root move)', () => expect(isValidFolder('/')).toBe(true));
  it('"root" is valid (root move)', () => expect(isValidFolder('root')).toBe(true));
  it('"  " not valid', () => expect(isValidFolder('  ')).toBe(false));
  it('"/work" is valid (leading slash ok)', () => expect(isValidFolder('/work')).toBe(true));
  it('"my folder" is valid', () => expect(isValidFolder('my folder')).toBe(true));
  it('"work/" trailing slash is valid', () => expect(isValidFolder('work/')).toBe(true));
});
