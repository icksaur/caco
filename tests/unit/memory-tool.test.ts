import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, writeFileSync, mkdirSync, rmSync } from 'fs';
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
});
