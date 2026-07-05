import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const testDir = join(tmpdir(), 'caco-memory-test-' + Date.now());

// Patch homedir before importing
import { vi } from 'vitest';
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => testDir.replace('/.caco', '') };
});

describe('memory-tool', () => {
  beforeEach(() => {
    const cacoDir = join(testDir, '.caco');
    if (!existsSync(cacoDir)) mkdirSync(cacoDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('formatMemoryForPrompt returns empty for no file', async () => {
    const { formatMemoryForPrompt } = await import('../../src/memory-tool.js');
    expect(formatMemoryForPrompt()).toBe('');
  });

  it('formatMemoryForPrompt formats entries', async () => {
    const cacoDir = join(testDir, '.caco');
    writeFileSync(join(cacoDir, 'memory.json'), JSON.stringify({ 'test-key': 'test value' }));
    const { formatMemoryForPrompt } = await import('../../src/memory-tool.js');
    const result = formatMemoryForPrompt();
    expect(result).toContain('**test-key**');
    expect(result).toContain('test value');
    expect(result).toContain('## User Memory');
  });

  it('formatMemoryForPrompt sorts keys so identical content serializes identically (cache-prefix stability)', async () => {
    const cacoDir = join(testDir, '.caco');
    const { formatMemoryForPrompt } = await import('../../src/memory-tool.js');
    // Same three entries, two different insertion orders (as a set+delete churn would produce).
    writeFileSync(join(cacoDir, 'memory.json'), JSON.stringify({ zebra: '1', apple: '2', mango: '3' }));
    const a = formatMemoryForPrompt();
    writeFileSync(join(cacoDir, 'memory.json'), JSON.stringify({ mango: '3', zebra: '1', apple: '2' }));
    const b = formatMemoryForPrompt();
    expect(a).toBe(b); // byte-identical regardless of insertion order
    expect(a.indexOf('apple')).toBeLessThan(a.indexOf('mango'));
    expect(a.indexOf('mango')).toBeLessThan(a.indexOf('zebra'));
  });

  // The merged caco_memory tool uses an explicit action enum; the critical
  // invariant is that read can never delete (the old arg-presence overloading
  // was the misfire risk flagged in the tool-diet spec review).
  type Handler = (a: { action: string; key?: string; value?: string }) => Promise<{ textResultForLlm: string }>;
  const memFile = () => join(testDir, '.caco', 'memory.json');
  async function handler(): Promise<Handler> {
    const { createMemoryTools } = await import('../../src/memory-tool.js');
    return createMemoryTools()[0].handler as Handler;
  }
  function readFile(): Record<string, string> {
    return JSON.parse(readFileSync(memFile(), 'utf-8'));
  }

  it('read returns entries + capacity and does NOT mutate even with a key', async () => {
    writeFileSync(memFile(), JSON.stringify({ 'preferred-language': 'TypeScript' }));
    const out = JSON.parse((await (await handler())({ action: 'read', key: 'preferred-language' })).textResultForLlm);
    expect(out.entries).toEqual({ 'preferred-language': 'TypeScript' });
    expect(out.capacity).toBe(50);
    expect(readFile()).toEqual({ 'preferred-language': 'TypeScript' });
  });

  it('set stores a slug key; delete removes it', async () => {
    const h = await handler();
    const setOut = JSON.parse((await h({ action: 'set', key: 'git-style', value: 'facts only' })).textResultForLlm);
    expect(setOut.ok).toBe(true);
    expect(readFile()).toEqual({ 'git-style': 'facts only' });
    const delOut = JSON.parse((await h({ action: 'delete', key: 'git-style' })).textResultForLlm);
    expect(delOut.deleted).toBe('git-style');
    expect(readFile()).toEqual({});
  });

  it('set rejects a non-slug key and an empty value', async () => {
    const h = await handler();
    expect((await h({ action: 'set', key: 'Not A Slug', value: 'x' })).textResultForLlm).toContain('Error');
    writeFileSync(memFile(), JSON.stringify({ k: 'v' }));
    expect((await h({ action: 'set', key: 'k', value: '' })).textResultForLlm).toContain('Error');
    expect(readFile()).toEqual({ k: 'v' });
  });

  it('delete without a key errors and does not mutate', async () => {
    writeFileSync(memFile(), JSON.stringify({ k: 'v' }));
    expect((await (await handler())({ action: 'delete' })).textResultForLlm).toContain('Error');
    expect(readFile()).toEqual({ k: 'v' });
  });
});
