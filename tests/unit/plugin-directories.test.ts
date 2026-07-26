import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  normalizePluginDirectories,
  samePluginDirectories,
  PluginDirectoryError,
  MAX_PLUGIN_DIRECTORIES,
} from '../../src/plugin-directories.js';

let base: string;
let pluginA: string;
let pluginB: string;
let noManifest: string;
let aFile: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'plugin-dirs-'));
  pluginA = join(base, 'plugin-a');
  pluginB = join(base, 'nested', 'plugin-b');
  noManifest = join(base, 'plain-dir');
  aFile = join(base, 'a-file.txt');

  await mkdir(pluginA, { recursive: true });
  await writeFile(join(pluginA, 'plugin.json'), '{"name":"a"}');

  // manifest in the .plugin/ subdir (one of the runtime's known locations)
  await mkdir(join(pluginB, '.plugin'), { recursive: true });
  await writeFile(join(pluginB, '.plugin', 'plugin.json'), '{"name":"b"}');

  await mkdir(noManifest, { recursive: true });
  await writeFile(aFile, 'not a directory');
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('normalizePluginDirectories', () => {
  it('resolves a relative path against the session cwd and stores it absolute', () => {
    const { directories } = normalizePluginDirectories(base, ['plugin-a']);
    expect(directories).toEqual([pluginA]);
  });

  it('accepts an absolute path unchanged', () => {
    const { directories } = normalizePluginDirectories(process.cwd(), [pluginA]);
    expect(directories).toEqual([pluginA]);
  });

  it('finds the manifest in .plugin/ as well as the root (no warning)', () => {
    const { directories, warnings } = normalizePluginDirectories(base, [pluginB]);
    expect(directories).toEqual([pluginB]);
    expect(warnings).toEqual([]);
  });

  it('warns (but accepts) a directory with no plugin.json — never a hard block', () => {
    const { directories, warnings } = normalizePluginDirectories(base, [noManifest]);
    expect(directories).toEqual([noManifest]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/no plugin\.json/i);
  });

  it('de-duplicates while preserving input order', () => {
    const { directories } = normalizePluginDirectories(base, ['plugin-a', pluginB, 'plugin-a']);
    expect(directories).toEqual([pluginA, pluginB]);
  });

  it('returns an empty list for an empty input (the explicit clear)', () => {
    expect(normalizePluginDirectories(base, [])).toEqual({ directories: [], warnings: [] });
  });

  it('rejects a path that does not exist', () => {
    expect(() => normalizePluginDirectories(base, ['nope'])).toThrow(PluginDirectoryError);
    expect(() => normalizePluginDirectories(base, ['nope'])).toThrow(/does not exist/i);
  });

  it('rejects a file (not a directory)', () => {
    expect(() => normalizePluginDirectories(base, [aFile])).toThrow(/not a directory/i);
  });

  it('rejects an empty path entry', () => {
    expect(() => normalizePluginDirectories(base, ['   '])).toThrow(/empty/i);
  });

  it('rejects a list over the cap after de-duplication', async () => {
    const { mkdir } = await import('fs/promises');
    const dirs: string[] = [];
    for (let i = 0; i <= MAX_PLUGIN_DIRECTORIES; i++) {
      const d = join(base, `cap-${i}`);
      await mkdir(d, { recursive: true });
      dirs.push(d);
    }
    expect(() => normalizePluginDirectories(base, dirs)).toThrow(/max 16/i);
  });

  it('does NOT count duplicates toward the cap (they load once)', () => {
    const many = Array.from({ length: MAX_PLUGIN_DIRECTORIES + 5 }, () => pluginA);
    const { directories } = normalizePluginDirectories(base, many);
    expect(directories).toEqual([pluginA]);
  });
});

describe('samePluginDirectories', () => {
  it('treats undefined and empty as equivalent', () => {
    expect(samePluginDirectories(undefined, [])).toBe(true);
    expect(samePluginDirectories([], undefined)).toBe(true);
  });

  it('is order-sensitive', () => {
    expect(samePluginDirectories(['/a', '/b'], ['/b', '/a'])).toBe(false);
    expect(samePluginDirectories(['/a', '/b'], ['/a', '/b'])).toBe(true);
  });

  it('detects length changes', () => {
    expect(samePluginDirectories(['/a'], ['/a', '/b'])).toBe(false);
    expect(samePluginDirectories(['/a'], undefined)).toBe(false);
  });
});
